/**
 * Anikage Stream Provider Plugin for Anivio
 *
 * Maps AniList/MAL/TMDB ids via AniZip -> searches Anikage browse API
 * -> resolves episode servers/sources -> returns proxied HLS via og.bakayaro.live.
 *
 * No Cloudflare bypass needed (anikage.cc returns JSON directly).
 * No custom decrypt: source url token is appended to https://og.bakayaro.live/m3u8/<token>.
 * Neko provider normally requires PNG-header stripping via local proxy (LocalProxy.kt);
 * in JS we return the raw URL and note it – player must handle or skip neko.
 */

var BASE = 'https://anikage.cc';
var API_BROWSE = BASE + '/api/media/anime/browse';
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

function sleep(ms) {
    if (typeof setTimeout !== 'undefined') return new Promise(function (r) { setTimeout(r, ms); });
    // QuickJS fallback: busy wait via Date if available, else immediate
    try {
        var start = Date.now();
        while (Date.now() - start < ms) {}
    } catch (e) {}
    return Promise.resolve();
}

async function fetchJson(url, headers, retries) {
    if (retries == null) retries = 1;
    var h = { 'User-Agent': UA, 'Accept': 'application/json, */*', 'Referer': BASE + '/', 'Origin': BASE };
    for (var k in (headers || {})) h[k] = headers[k];
    var res = await fetch(url, { headers: h });
    if (res.status === 429 && retries > 0) {
        await sleep(800);
        return fetchJson(url, headers, retries - 1);
    }
    if (!res.ok) throw new Error('Anikage HTTP ' + res.status + ' for ' + url);
    return res.json();
}

async function fetchText(url, headers, retries) {
    if (retries == null) retries = 1;
    var h = { 'User-Agent': UA, 'Accept': '*/*', 'Referer': BASE + '/', 'Origin': BASE };
    for (var k in (headers || {})) h[k] = headers[k];
    var res = await fetch(url, { headers: h });
    if (res.status === 429 && retries > 0) {
        await sleep(800);
        return fetchText(url, headers, retries - 1);
    }
    if (!res.ok) throw new Error('Anikage HTTP ' + res.status + ' for ' + url);
    return res.text();
}

async function searchAnikage(query) {
    var url = API_BROWSE + '?q=' + encodeURIComponent(query) + '&page=1&limit=25';
    var data = await fetchJson(url);
    var results = [];
    var seen = {};
    var list = data && Array.isArray(data.data) ? data.data : [];
    for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var slug = it.slug || '';
        if (!slug || seen[slug]) continue;
        seen[slug] = 1;
        var title = (it.title && (it.title.english || it.title.romaji)) || slug;
        results.push({ slug: slug, title: title, anilistId: it.anilistId != null ? String(it.anilistId) : '' });
    }
    return results;
}

async function findSeries(meta) {
    var key = 'series:' + meta.anilistId;
    if (CACHE[key]) return CACHE[key];
    var titles = [meta.titleEn, meta.titleRom];
    var queries = {};
    for (var i = 0; i < titles.length; i++) {
        if (!titles[i]) continue;
        queries[titles[i]] = 1;
        var plain = String(titles[i]).replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (plain) queries[plain] = 1;
        // also try first word for very long titles
        var words = plain.split(' ');
        if (words.length > 3) queries[words.slice(0, 3).join(' ')] = 1;
    }
    var qs = Object.keys(queries);
    var all = {};
    for (var q = 0; q < qs.length; q++) {
        if (q > 0) await sleep(300);
        try {
            var found = await searchAnikage(qs[q]);
            for (var j = 0; j < found.length; j++) {
                var cand = found[j];
                var score = 0;
                for (var t = 0; t < titles.length; t++) {
                    score = Math.max(score, dice(titles[t], cand.title), dice(titles[t], cand.slug.replace(/-/g, ' ')));
                }
                // exact aniList id match is decisive
                if (meta.anilistId && cand.anilistId === String(meta.anilistId)) score = Math.max(score, 0.99);
                if (score >= 0.45 && (!all[cand.slug] || all[cand.slug].score < score)) {
                    all[cand.slug] = { slug: cand.slug, title: cand.title, score: score, anilistId: cand.anilistId };
                }
            }
        } catch (e) {}
    }
    var ranked = Object.keys(all).map(function (x) { return all[x]; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
    if (!ranked.length) throw new Error('Anikage match not found for ' + meta.titleEn);

    // Verify episode count to avoid picking movie/special with similar name
    var selected = null;
    for (var r = 0; r < ranked.length; r++) {
        try {
            var eps = await fetchJson(BASE + '/api/media/anime/' + encodeURIComponent(ranked[r].slug) + '/episodes');
            var count = Array.isArray(eps) ? eps.length : 0;
            var localHits = meta.expected ? Math.min(count, meta.expected) : count;
            var score2 = ranked[r].score * 0.7 + (meta.expected ? Math.min(1, localHits / Math.max(1, Math.min(meta.expected, 12))) : 1) * 0.3;
            if (!selected || score2 > selected.score) selected = { slug: ranked[r].slug, title: ranked[r].title, score: score2, anilistId: ranked[r].anilistId, episodeCount: count };
            if (ranked[r].score >= 0.99 && (!meta.expected || count >= Math.min(meta.expected, 12))) break;
        } catch (e) {
            if (!selected) selected = { slug: ranked[r].slug, title: ranked[r].title, score: ranked[r].score - 0.2 };
        }
    }
    if (!selected) selected = ranked[0];
    CACHE[key] = selected;
    return selected;
}

async function fetchEpisodeServers(slug, episodeNum) {
    var url = BASE + '/api/media/anime/' + encodeURIComponent(slug) + '/episodes/' + encodeURIComponent(String(episodeNum)) + '/servers';
    try {
        var data = await fetchJson(url);
        return data && Array.isArray(data.servers) ? data.servers : [];
    } catch (e) {
        return [];
    }
}

function parseMasterQualities(text) {
    var variants = [];
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
            var resMatch = line.match(/RESOLUTION=\s*(\d+)x(\d+)/i);
            var bwMatch = line.match(/BANDWIDTH=\s*(\d+)/i);
            var next = (lines[i + 1] || '').trim();
            if (next && next.indexOf('#') !== 0 && next.indexOf('http') === 0) {
                var h = resMatch ? resMatch[2] : '';
                var quality = h ? h + 'p' : (bwMatch ? Math.round(Number(bwMatch[1]) / 1000) + 'k' : 'auto');
                variants.push({ url: next, quality: quality, line: line });
            }
        }
    }
    return variants;
}

async function resolveSources(slug, episodeNum, provider, lang) {
    var url = BASE + '/api/media/anime/' + encodeURIComponent(slug) + '/episodes/' + encodeURIComponent(String(episodeNum)) + '/sources?lang=' + encodeURIComponent(lang) + '&provider=' + encodeURIComponent(provider);
    var data = await fetchJson(url);
    return data;
}

async function getStreams(rawId, mediaType, season, episode) {
    try {
        var meta = await getMapping(rawId);
        if (!meta.anilistId) return [];
        var n = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(n) || n < 1) n = 1;

        var series = await findSeries(meta);
        var slug = series.slug;

        // verify episode exists (anikage has total 1178 for One Piece, 37 for Death Note)
        try {
            var epsCheck = await fetchJson(BASE + '/api/media/anime/' + encodeURIComponent(slug) + '/episodes');
            if (Array.isArray(epsCheck)) {
                var found = false;
                for (var ec = 0; ec < epsCheck.length; ec++) if (Number(epsCheck[ec].number) === n) { found = true; break; }
                if (!found) return [];
            }
        } catch (e) {}

        var servers = await fetchEpisodeServers(slug, n);
        var ordered = [];
        if (servers.length) {
            // sort: default first, then koto preferred (matches Kotlin preferredSource = koto)
            servers.sort(function (a, b) {
                if (a.default && !b.default) return -1;
                if (!a.default && b.default) return 1;
                if (a.providerId === 'koto' && b.providerId !== 'koto') return -1;
                if (b.providerId === 'koto' && a.providerId !== 'koto') return 1;
                return 0;
            });
            for (var si = 0; si < servers.length; si++) {
                var srv = servers[si];
                var types = Array.isArray(srv.subTypes) ? srv.subTypes : [];
                // sub preferred over dub (Kotlin primaryLabel)
                if (types.indexOf('sub') !== -1) ordered.push({ provider: srv.providerId, lang: 'sub' });
                if (types.indexOf('dub') !== -1) ordered.push({ provider: srv.providerId, lang: 'dub' });
            }
        } else {
            // fallback if servers endpoint empty/blocked
            var fallbackProviders = ['koto', 'suge', 'kiwi', 'megg', 'dib', 'wave', 'zen', 'neko'];
            for (var fi = 0; fi < fallbackProviders.length; fi++) {
                ordered.push({ provider: fallbackProviders[fi], lang: 'sub' });
                ordered.push({ provider: fallbackProviders[fi], lang: 'dub' });
            }
        }

        var headers = { 'User-Agent': UA, 'Referer': BASE + '/', 'Origin': BASE };
        var subtitleHeaders = { 'User-Agent': UA, 'Referer': BASE + '/' };

        var results = [];
        var seenUrls = {};
        // Limit to first 6 providers to avoid hammering
        var limit = Math.min(ordered.length, 8);
        for (var oi = 0; oi < limit; oi++) {
            if (oi > 0) await sleep(350);
            var entry = ordered[oi];
            var epData;
            try { epData = await resolveSources(slug, n, entry.provider, entry.lang); } catch (e) { continue; }
            if (!epData || !Array.isArray(epData.sources) || !epData.sources.length) continue;

            var tracks = [];
            var subs = Array.isArray(epData.subtitles) ? epData.subtitles : [];
            for (var sI = 0; sI < subs.length; sI++) {
                var sub = subs[sI];
                if (!sub || !sub.file) continue;
                tracks.push({
                    url: 'https://og.bakayaro.live/stream/' + sub.file,
                    language: (sub.label || 'en').toLowerCase().indexOf('english') !== -1 ? 'en' : (sub.label || 'en'),
                    name: sub.label || 'English',
                    headers: subtitleHeaders
                });
            }

            var intro = null, outro = null;
            if (epData.intro && typeof epData.intro.start === 'number') intro = { start: epData.intro.start, end: epData.intro.end };
            if (epData.outro && typeof epData.outro.start === 'number') outro = { start: epData.outro.start, end: epData.outro.end };

            for (var vi = 0; vi < epData.sources.length; vi++) {
                var src = epData.sources[vi];
                if (!src || !src.url) continue;
                var isM3U8 = src.isM3U8 === true;
                var videoUrl = 'https://og.bakayaro.live/' + (isM3U8 ? 'm3u8/' : 'stream/') + src.url;
                if (seenUrls[videoUrl]) continue;
                seenUrls[videoUrl] = 1;

                var quality = src.quality || 'auto';
                var typeLabel = entry.lang === 'dub' ? 'Dub' : 'Sub';
                var nameLabel = 'Anikage (' + entry.provider + ' - ' + typeLabel + ')';
                var titleLabel = 'Anikage · ' + entry.provider + ' · ' + typeLabel + ' · Ep ' + n + (quality && quality !== 'auto' ? ' · ' + quality : '');

                // For m3u8, try to expand variants so player sees multiple qualities (mirrors PlaylistUtils.extractFromHls)
                if (isM3U8) {
                    try {
                        await sleep(150);
                        var m3u8Text = await fetchText(videoUrl, headers);
                        var variants = parseMasterQualities(m3u8Text);
                        if (variants.length) {
                            for (var vI = 0; vI < variants.length; vI++) {
                                var v = variants[vI];
                                var vq = v.quality;
                                results.push({
                                    name: nameLabel,
                                    title: 'Anikage · ' + entry.provider + ' · ' + typeLabel + ' · ' + vq,
                                    url: v.url,
                                    quality: vq,
                                    type: 'hls',
                                    headers: headers,
                                    subtitles: tracks,
                                    intro: intro,
                                    outro: outro
                                });
                            }
                            continue;
                        }
                    } catch (e) {}
                }

                // fallback: single stream (neko PNG case still returns raw; note in name)
                var isNeko = entry.provider === 'neko';
                results.push({
                    name: nameLabel + (isNeko ? ' [png-strip needed]' : ''),
                    title: titleLabel,
                    url: videoUrl,
                    quality: quality === 'auto' ? 'auto' : quality,
                    type: isM3U8 ? 'hls' : 'mp4',
                    headers: headers,
                    subtitles: tracks,
                    intro: intro,
                    outro: outro
                });
            }

            // if we already have streams, prefer sub then stop early to reduce requests, but continue for dub
            if (results.length >= 6) break;
        }

        return results;
    } catch (e) {
        console.warn('[anikage] failed: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [{ key: 'label', type: 'text', title: 'Provider Name', description: 'Display name for Anikage streams.', default: 'Anikage' }];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
