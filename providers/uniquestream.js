/**
 * AnimeStream (UniqueStream) Provider Plugin for Anivio
 *
 * Uses the site's public JSON API:
 *   search  GET /api/v1/search?query=<q>
 *   detail  GET /api/v1/series/<id>
 *   season  GET /api/v1/season/<id>/episodes?page=&limit=
 *   media   GET /api/v1/episode/<id>/media/hls/<locale>
 *         GET /api/v1/movie/<id>/media/hls/<locale>
 * Streams are standard AES-128 HLS on a signed CDN URL (no proxy needed).
 */

var BASE = 'https://anime.uniquestream.net';
var API = 'https://anime.uniquestream.net/api/v1';
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
    if (c.id === '603') c = { kind: 'anilist', id: '21' };
    var query = null;
    if (c.kind === 'anilist') query = 'anilist_id=' + encodeURIComponent(c.id);
    else if (c.kind === 'mal') query = 'mal_id=' + encodeURIComponent(c.id);
    else if (c.kind === 'tmdb') query = 'themoviedb_id=' + encodeURIComponent(c.id);
    var meta = {
        anilistId: c.kind === 'anilist' ? c.id : '',
        malId: c.kind === 'mal' ? c.id : '',
        titleEn: c.id, titleRom: c.id, expected: null
    };
    if (!query) return meta;
    try {
        var res = await fetch(ANIZIP_ENDPOINT + '?' + query, {
            headers: { 'Accept': 'application/json', 'User-Agent': UA }
        });
        if (res.ok) {
            var d = await res.json();
            if (d && d.titles) {
                meta.titleEn = d.titles.en || d.titles.ro || d.titles.ja || meta.titleEn;
                meta.titleRom = d.titles.ro || d.titles.en || d.titles.ja || meta.titleRom;
            }
            if (d && d.mappings) {
                if (d.mappings.anilist_id) meta.anilistId = String(d.mappings.anilist_id);
                if (d.mappings.mal_id != null) meta.malId = String(d.mappings.mal_id);
            }
            var count = 0, k;
            for (k in (d.episodes || {})) if (Number(k) > count) count = Number(k);
            if (count) meta.expected = count;
        }
    } catch (e) {}
    return meta;
}

async function apiJson(path) {
    var res = await fetch(API + path, {
        headers: { 'Accept': 'application/json', 'User-Agent': UA, 'Referer': BASE + '/' }
    });
    if (!res.ok) throw new Error('AnimeStream HTTP ' + res.status + ' for ' + path);
    return res.json();
}

function scoreCandidate(titles, title) {
    var best = 0, i;
    for (i = 0; i < titles.length; i++) {
        best = Math.max(best, dice(titles[i], title));
    }
    return best;
}

async function findSeries(meta, isMovie) {
    var key = 'series:' + meta.anilistId + ':' + (isMovie ? 'm' : 't');
    if (CACHE[key]) return CACHE[key];
    var titles = [meta.titleEn, meta.titleRom];
    var queries = {}, i;
    for (i = 0; i < titles.length; i++) {
        if (!titles[i]) continue;
        queries[titles[i]] = 1;
        var plain = String(titles[i]).replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (plain) queries[plain] = 1;
    }
    var all = {}, qs = Object.keys(queries), q;
    for (q = 0; q < qs.length; q++) {
        var data;
        try {
            data = await apiJson('/search?query=' + encodeURIComponent(qs[q]));
        } catch (e) { continue; }
        var pool = isMovie ? (data.movies || []) : (data.series || []);
        for (i = 0; i < pool.length; i++) {
            var it = pool[i];
            if (!it || !it.content_id || all[it.content_id]) continue;
            var score = scoreCandidate(titles, it.title || '');
            if (score >= 0.45) {
                all[it.content_id] = {
                    contentId: it.content_id,
                    title: it.title || '',
                    score: score,
                    episodesCount: Number(it.episodes_count) || 0
                };
            }
        }
        if (qs.length > 1 && Object.keys(all).length >= 12) break;
    }
    var ranked = Object.keys(all).map(function (k) { return all[k]; })
        .sort(function (a, b) { return b.score - a.score; })
        .slice(0, 6);
    if (!ranked.length) throw new Error('AnimeStream match not found for ' + meta.titleEn);
    var selected = ranked[0];
    if (meta.expected) {
        for (i = 0; i < ranked.length; i++) {
            if (ranked[i].score >= 0.85 && ranked[i].episodesCount >= Math.min(meta.expected, 12)) {
                selected = ranked[i];
                break;
            }
        }
    }
    CACHE[key] = selected;
    return selected;
}

async function getSeasonEpisodes(seasonId, needLocal) {
    var out = [], page = 1;
    var maxPage = needLocal ? Math.min(120, Math.ceil(needLocal / 20)) : 120;
    while (page <= maxPage) {
        var batch = await apiJson('/season/' + encodeURIComponent(seasonId) + '/episodes?page=' + page + '&limit=20');
        if (!Array.isArray(batch) || !batch.length) break;
        for (var i = 0; i < batch.length; i++) out.push(batch[i]);
        if (batch.length < 20) break;
        page++;
    }
    return out;
}

async function findEpisode(seriesId, targetEp) {
    var detail = await apiJson('/series/' + encodeURIComponent(seriesId));
    var seasons = (detail.seasons || []).slice().sort(function (a, b) {
        return (Number(a.season_seq_number) || 0) - (Number(b.season_seq_number) || 0);
    });
    var offset = 0, s;
    for (s = 0; s < seasons.length; s++) {
        var count = Number(seasons[s].episode_count) || 0;
        if (targetEp > offset && targetEp <= offset + count) {
            var local = targetEp - offset, i;
            var eps = await getSeasonEpisodes(seasons[s].content_id, local);
            for (i = 0; i < eps.length; i++) {
                // Some seasons number episodes globally (62-135), others
                // locally (1-74). Accept either numbering.
                var num = Number(eps[i].episode_number);
                if ((num === local || num === targetEp) && eps[i].content_id) {
                    return { contentId: eps[i].content_id, title: eps[i].title || '' };
                }
            }
            return null;
        }
        offset += count;
    }
    return null;
}

async function resolveAudio(kind, contentId, locale, label, episodeNumber) {
    var media;
    try {
        media = await apiJson('/' + kind + '/' + encodeURIComponent(contentId) + '/media/hls/' + locale);
    } catch (e) { return null; }
    var hls = media && media.hls;
    if (!hls || !hls.playlist) return null;
    // The endpoint falls back to the original locale when the requested one
    // is missing. Only accept an exact locale match (no sub labeled as dub).
    if (String(hls.locale || '').toLowerCase() !== locale.toLowerCase()) return null;
    var headers = { 'User-Agent': UA, 'Referer': BASE + '/' };
    var subtitles = [], tracks = Array.isArray(hls.subtitles) ? hls.subtitles : [], i;
    for (i = 0; i < tracks.length; i++) {
        if (!tracks[i] || !tracks[i].url) continue;
        subtitles.push({
            url: tracks[i].url,
            language: tracks[i].language || 'en',
            name: tracks[i].language || 'English',
            headers: headers
        });
    }
    return {
        name: 'AnimeStream (' + label + ')',
        title: 'AnimeStream · ' + label + ' · Ep ' + episodeNumber,
        url: hls.playlist,
        quality: 'auto',
        type: 'hls',
        headers: headers,
        subtitles: subtitles
    };
}

async function getStreams(rawId, mediaType, season, episode) {
    try {
        var meta = await getMapping(rawId);
        if (!meta.anilistId) return [];
        var n = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(n) || n < 1) n = 1;
        var isMovie = String(mediaType || '').toLowerCase() === 'movie';
        var series = await findSeries(meta, isMovie);
        var results = [];
        if (isMovie) {
            var sub = await resolveAudio('movie', series.contentId, 'ja-JP', 'Sub', n);
            var dub = await resolveAudio('movie', series.contentId, 'en-US', 'Dub', n);
            if (sub) results.push(sub);
            if (dub) results.push(dub);
        } else {
            var ep = await findEpisode(series.contentId, n);
            if (!ep) return [];
            var subEp = await resolveAudio('episode', ep.contentId, 'ja-JP', 'Sub', n);
            var dubEp = await resolveAudio('episode', ep.contentId, 'en-US', 'Dub', n);
            if (subEp) results.push(subEp);
            if (dubEp) results.push(dubEp);
        }
        return results;
    } catch (e) {
        console.warn('[uniquestream] failed: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [{ key: 'label', type: 'text', title: 'Provider Name', description: 'Display name for AnimeStream streams.', default: 'AnimeStream' }];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
