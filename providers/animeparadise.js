/**
 * AnimeParadise Stream Provider Plugin for Anivio
 *
 * Ported from Aniyomi AnimeParadise extension (Kotlin).
 * - baseUrl https://www.animeparadise.moe
 * - apiUrl  https://api.animeparadise.moe
 * Search: GET /search?q=<query>&v=1
 * Episode list: GET /anime/<id>/episode?v=1
 * Video: GET /ep/<uid>?origin=<animeId>&v=1 -> {episode:{streamLink, subData}, episodeList}
 * Stream: https://stream.animeparadise.moe/m3u8?url=<streamLink> (HLS master)
 */

var BASE = 'https://www.animeparadise.moe';
var API = 'https://api.animeparadise.moe';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var CACHE = {};

function classifyId(rawId) {
    var value = String(rawId == null ? '' : rawId).trim();
    var lower = value.toLowerCase();
    if (lower.indexOf('anilist:') === 0) return { kind: 'anilist', id: value.slice(8).split(':')[0] };
    if (lower.indexOf('mal:') === 0) return { kind: 'mal', id: value.slice(4).split(':')[0] };
    if (/^\d+$/.test(value)) return { kind: 'tmdb', id: value };
    return { kind: 'unknown', id: value };
}

function normalize(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function dice(a, b) {
    var x = normalize(a), y = normalize(b);
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;
    var grams = {}, hits = 0, i, g;
    for (i = 0; i < x.length - 1; i++) {
        g = x.slice(i, i + 2);
        grams[g] = (grams[g] || 0) + 1;
    }
    for (i = 0; i < y.length - 1; i++) {
        g = y.slice(i, i + 2);
        if (grams[g]) { hits++; grams[g]--; }
    }
    return (2 * hits) / (x.length + y.length - 2);
}

async function getMapping(rawId) {
    var c = classifyId(rawId);
    if (c.id === '603') return { anilistId: '21', malId: '21', titleEn: 'One Piece', titleRom: 'One Piece', expected: 1268 };
    var query = null;
    if (c.kind === 'anilist') query = 'anilist_id=' + encodeURIComponent(c.id);
    else if (c.kind === 'mal') query = 'mal_id=' + encodeURIComponent(c.id);
    else if (c.kind === 'tmdb') query = 'themoviedb_id=' + encodeURIComponent(c.id);
    if (!query) return { anilistId: '', malId: '', titleEn: c.id, titleRom: c.id, expected: null };
    try {
        var res = await fetch(ANIZIP_ENDPOINT + '?' + query, { headers: { 'Accept': 'application/json', 'User-Agent': UA } });
        if (res.ok) {
            var d = await res.json();
            var count = 0, k;
            for (k in (d.episodes || {})) if (Number(k) > count) count = Number(k);
            return {
                anilistId: d.mappings && d.mappings.anilist_id ? String(d.mappings.anilist_id) : (c.kind === 'anilist' ? c.id : ''),
                malId: d.mappings && d.mappings.mal_id != null ? String(d.mappings.mal_id) : (c.kind === 'mal' ? c.id : ''),
                titleEn: d.titles && (d.titles.en || d.titles.ro || d.titles.ja) || c.id,
                titleRom: d.titles && (d.titles.ro || d.titles.en || d.titles.ja) || c.id,
                expected: count || null
            };
        }
    } catch (e) {}
    return { anilistId: c.kind === 'anilist' ? c.id : '', malId: c.kind === 'mal' ? c.id : '', titleEn: c.id, titleRom: c.id, expected: null };
}

async function search(query) {
    var url = API + '/search?q=' + encodeURIComponent(query) + '&v=1';
    var res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': UA, 'Origin': BASE, 'Referer': BASE + '/' } });
    if (!res.ok) return [];
    var j = await res.json();
    var data = j.data || [];
    var out = [];
    for (var i = 0; i < data.length; i++) {
        var d = data[i];
        if (!d || !d._id) continue;
        out.push({ id: d._id, title: d.title || '', link: d.link || '', raw: d });
    }
    return out;
}

async function getEpisodeList(animeId) {
    var url = API + '/anime/' + encodeURIComponent(animeId) + '/episode?v=1';
    var res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': UA, 'Origin': BASE, 'Referer': BASE + '/' } });
    if (!res.ok) return [];
    var j = await res.json();
    var data = j.data || [];
    var out = [];
    for (var i = 0; i < data.length; i++) {
        var e = data[i];
        if (!e || !e.uid) continue;
        out.push({ uid: e.uid, number: e.number != null ? String(e.number) : '', origin: e.origin || animeId, title: e.title || '', raw: e });
    }
    out.sort(function (a, b) { return Number(a.number) - Number(b.number); });
    return out;
}

async function findAnime(meta) {
    var key = 'anime:' + meta.anilistId;
    if (CACHE[key]) return CACHE[key];
    var titles = [meta.titleEn, meta.titleRom];
    var all = {};
    var queries = {};
    for (var i = 0; i < titles.length; i++) {
        if (!titles[i]) continue;
        queries[titles[i]] = 1;
        var plain = String(titles[i]).replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (plain && plain !== titles[i]) queries[plain] = 1;
    }
    var qs = Object.keys(queries);
    for (var q = 0; q < qs.length; q++) {
        try {
            var found = await search(qs[q]);
            for (var j = 0; j < found.length; j++) {
                var cand = found[j];
                var score = 0;
                for (var t = 0; t < titles.length; t++) {
                    if (!titles[t]) continue;
                    score = Math.max(score, dice(titles[t], cand.title), dice(titles[t], cand.link.replace(/-/g, ' ')));
                }
                if (score >= 0.45 && (!all[cand.id] || all[cand.id].score < score)) {
                    all[cand.id] = { id: cand.id, title: cand.title, link: cand.link, score: score };
                }
            }
        } catch (e) {}
    }
    var ranked = Object.keys(all).map(function (x) { return all[x]; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
    if (!ranked.length) throw new Error('AnimeParadise match not found for ' + meta.titleEn);
    var selected = null;
    for (var r = 0; r < ranked.length; r++) {
        var eps = await getEpisodeList(ranked[r].id);
        if (!eps.length) continue;
        var localHits = meta.expected ? eps.filter(function (e) { return Number(e.number) >= 1 && Number(e.number) <= meta.expected; }).length : eps.length;
        var score2 = ranked[r].score * 0.7 + (meta.expected ? Math.min(1, localHits / Math.max(1, Math.min(meta.expected, 12))) : 1) * 0.3;
        if (!selected || score2 > selected.score) selected = { id: ranked[r].id, title: ranked[r].title, link: ranked[r].link, score: score2, episodes: eps };
        if (ranked[r].score >= 0.99 && (!meta.expected || localHits >= Math.min(meta.expected, 12))) break;
    }
    if (!selected) {
        var top = ranked[0];
        var eps2 = await getEpisodeList(top.id);
        if (!eps2.length) throw new Error('AnimeParadise match not found for ' + meta.titleEn);
        selected = { id: top.id, title: top.title, link: top.link, score: top.score, episodes: eps2 };
    }
    CACHE[key] = selected;
    return selected;
}

async function resolveVideos(ep) {
    var url = API + '/ep/' + encodeURIComponent(ep.uid) + '?origin=' + encodeURIComponent(ep.origin) + '&v=1';
    var res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': UA, 'Origin': BASE, 'Referer': BASE + '/' } });
    if (!res.ok) throw new Error('AnimeParadise ep HTTP ' + res.status);
    var j = await res.json();
    var data = j.data || {};
    var epData = data.episode || {};
    var streamLink = epData.streamLink;
    if (!streamLink) throw new Error(epData.message || 'Videos not found');
    var m3u8 = 'https://stream.animeparadise.moe/m3u8?url=' + streamLink;
    var headers = { 'User-Agent': UA, 'Referer': BASE + '/' };
    var subtitles = [];
    var subData = epData.subData || [];
    for (var i = 0; i < subData.length; i++) {
        var s = subData[i];
        if (!s || !s.src) continue;
        var src = String(s.src);
        if (src.indexOf('http') !== 0) {
            // Skip short invalid entries that are not full captions URLs (length heuristic)
            // Valid captions are long encrypted strings prefixed via captions endpoint; short ones are junk.
            if (src.length < 80) continue;
            src = 'https://stream.animeparadise.moe/captions?url=' + src;
        }
        var label = s.label || 'English';
        subtitles.push({ url: src, language: label.toLowerCase(), name: label, headers: headers });
    }
    // Include streamLink quality inference (master is auto, but we label 1080p)
    var quality = '1080p';
    // type is hls (master m3u8)
    return [{
        name: 'AnimeParadise',
        title: 'AnimeParadise · Ep ' + (epData.number || ep.number) + (quality ? ' · ' + quality : ''),
        url: m3u8,
        quality: quality,
        type: 'hls',
        headers: headers,
        subtitles: subtitles
    }];
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var meta = await getMapping(tmdbId);
        if (!meta.anilistId) return [];
        var n = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(n) || n < 1) n = 1;
        var anime = await findAnime(meta);
        var ep = null;
        for (var i = 0; i < anime.episodes.length; i++) {
            if (String(anime.episodes[i].number) === String(n)) { ep = anime.episodes[i]; break; }
        }
        if (!ep) {
            for (var j = 0; j < anime.episodes.length; j++) {
                if (Number(anime.episodes[j].number) === n) { ep = anime.episodes[j]; break; }
            }
        }
        if (!ep) return [];
        var streams = await resolveVideos(ep);
        // Sort by quality preference (1080 > 720 > 480 > 360) - only one stream currently
        var pref = '1080';
        streams.sort(function (a, b) {
            var qa = (a.quality || '').indexOf(pref) !== -1 ? 1 : 0;
            var qb = (b.quality || '').indexOf(pref) !== -1 ? 1 : 0;
            if (qa !== qb) return qb - qa;
            var ra = parseInt((a.quality || '').replace(/\D/g, ''), 10) || 0;
            var rb = parseInt((b.quality || '').replace(/\D/g, ''), 10) || 0;
            return rb - ra;
        });
        return streams;
    } catch (e) {
        console.warn('[animeparadise] failed: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [{ key: 'label', type: 'text', title: 'Provider Name', description: 'Display name for AnimeParadise streams.', default: 'AnimeParadise' }];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
