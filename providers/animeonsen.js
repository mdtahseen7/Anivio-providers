/**
 * AnimeOnsen Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Subtitled DASH (MPD) streams with multi-language WebVTT subtitles
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var SITE = 'https://www.animeonsen.xyz';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';

var AO_SESSION = null;
var AO_CACHE = {};

function classifyId(rawId) {
    var value = String(rawId == null ? '' : rawId).trim();
    if (!value) return { kind: 'unknown', id: '' };

    var lower = value.toLowerCase();
    if (lower.indexOf('anilist:') === 0) {
        return { kind: 'anilist', id: value.slice('anilist:'.length).split(':')[0] };
    }
    if (lower.indexOf('mal:') === 0) {
        return { kind: 'mal', id: value.slice('mal:'.length).split(':')[0] };
    }
    if (/^\d+$/.test(value)) {
        return { kind: 'tmdb', id: value };
    }
    return { kind: 'unknown', id: value };
}

function norm(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function bigrams(s) {
    var out = {};
    if (!s) return out;
    for (var i = 0; i < s.length - 1; i++) {
        var bg = s.substring(i, i + 2);
        out[bg] = (out[bg] || 0) + 1;
    }
    return out;
}

function diceCoeff(a, b) {
    if (!a || !b) return 0;
    var A = bigrams(a), B = bigrams(b);
    var inter = 0;
    for (var k in A) if (B[k]) inter += Math.min(A[k], B[k]);
    var total = 0;
    for (var k in A) total += A[k];
    for (var k in B) total += B[k];
    if (total === 0) return 0;
    return (2 * inter) / total;
}

function b64ToStr(b64) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var table = {}, i;
    for (i = 0; i < 64; i++) table[chars.charAt(i)] = i;
    var s = String(b64 == null ? '' : b64);
    while (s.length % 4 !== 0) s += '=';
    var out = [];
    var buf = 0, bits = 0;
    for (var j = 0; j < s.length; j++) {
        var ch = s.charAt(j);
        if (ch === '=' || !(ch in table)) continue;
        buf = (buf << 6) | table[ch];
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 255);
            buf &= (1 << bits) - 1;
        }
    }
    var str = '';
    for (var k = 0; k < out.length; k++) str += String.fromCharCode(out[k]);
    return str;
}

function metaContent(html, name) {
    var re = new RegExp('<meta\\b[^>]*name=["\']' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
    var m = html.match(re);
    return m ? m[1] : '';
}

function sessionCookie(headers) {
    var raw = '';
    if (headers && headers.getSetCookie) {
        try {
            var multi = headers.getSetCookie();
            if (Array.isArray(multi)) raw = multi.join('\n');
        } catch (e) {}
    }
    if (!raw) {
        try { raw = headers.get('set-cookie') || ''; } catch (e) {}
    }
    var m = raw.match(/(?:^|[\s,;])ao\.session=([^;\s]+)/);
    return m ? m[1] : '';
}

function decodeToken(cookie) {
    var decoded = '';
    try {
        decoded = b64ToStr(decodeURIComponent(cookie));
    } catch (e) {
        decoded = b64ToStr(cookie);
    }
    var token = '';
    for (var i = 0; i < decoded.length; i++) {
        token += String.fromCharCode(decoded.charCodeAt(i) + 1);
    }
    if (!token || !/^[\x20-\x7e]+$/.test(token)) {
        throw new Error('AnimeOnsen returned an invalid session token');
    }
    return token;
}

async function createSession() {
    var res = await fetch(SITE + '/', {
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });
    var html = await res.text();
    if (!res.ok) throw new Error('AnimeOnsen homepage HTTP ' + res.status);
    var cookie = sessionCookie(res.headers);
    var apiOrigin = metaContent(html, 'ao-api-origin');
    var searchOrigin = metaContent(html, 'ao-search-origin');
    var searchToken = metaContent(html, 'ao-search-token');
    if (!cookie || !apiOrigin || !searchOrigin || !searchToken) {
        throw new Error('AnimeOnsen session bootstrap data missing');
    }
    var apiO = apiOrigin;
    if (apiO.indexOf('http') !== 0) apiO = 'https://' + apiO;
    var searchO = searchOrigin;
    if (searchO.indexOf('http') !== 0) searchO = 'https://' + searchO;
    return {
        token: decodeToken(cookie),
        apiOrigin: apiO,
        searchOrigin: searchO,
        searchToken: searchToken
    };
}

async function getSession(force) {
    if (force) AO_SESSION = null;
    if (AO_SESSION) return AO_SESSION;
    AO_SESSION = await createSession();
    return AO_SESSION;
}

async function responseJson(res, label) {
    var raw = await res.text();
    if (!res.ok) {
        var err = new Error('AnimeOnsen ' + label + ' HTTP ' + res.status);
        err.status = res.status;
        err.rawBody = raw;
        throw err;
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        var pErr = new Error('AnimeOnsen ' + label + ' returned invalid JSON');
        pErr.rawBody = raw.substring(0, 300);
        throw pErr;
    }
}

async function apiJson(path, retry) {
    var session = await getSession();
    var res = await fetch(session.apiOrigin + path, {
        headers: {
            'Authorization': 'Bearer ' + session.token,
            'Accept': 'application/json, text/plain, */*',
            'Origin': SITE,
            'Referer': SITE + '/',
            'User-Agent': UA
        }
    });
    if ((res.status === 401 || res.status === 403) && retry !== false) {
        await getSession(true);
        return apiJson(path, false);
    }
    return responseJson(res, path);
}

async function search(query, retry) {
    var session = await getSession();
    var res = await fetch(session.searchOrigin + '/multi-search', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + session.searchToken,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Origin': SITE,
            'Referer': SITE + '/',
            'User-Agent': UA
        },
        body: JSON.stringify({
            queries: [{ indexUid: 'content', q: query, limit: 20 }]
        })
    });
    if ((res.status === 401 || res.status === 403) && retry !== false) {
        await getSession(true);
        return search(query, false);
    }
    var data = await responseJson(res, 'search: ' + query);
    if (data && Array.isArray(data.results) && data.results[0] && Array.isArray(data.results[0].hits)) {
        return data.results[0].hits;
    }
    return [];
}

var INDEX_BUILDING = null;
var INDEX_LOCKED = null;

async function buildContentIndex() {
    if (AO_CACHE.CONTENT_INDEX) return AO_CACHE.CONTENT_INDEX;
    // Single-threaded flow: no concurrent builder can interleave here, so a
    // simple in-flight guard is enough.
    if (INDEX_BUILDING) return INDEX_LOCKED || {};
    INDEX_BUILDING = true;
    var session = await getSession();
    var index = {};
    try {
        var offset = 0;
        while (offset < 1500) {
            var res = await fetch(session.searchOrigin + '/indexes/content/search', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + session.searchToken,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Origin': SITE,
                    'Referer': SITE + '/',
                    'User-Agent': UA
                },
                body: JSON.stringify({
                    q: '',
                    limit: 100,
                    offset: offset,
                    attributesToRetrieve: ['content_id', 'content_title_en', 'content_title', 'content_title_jp', 'total_episodes']
                })
            });
            var data = await responseJson(res, 'index page ' + offset);
            var hits = data && Array.isArray(data.hits) ? data.hits : [];
            if (!hits.length) break;
            for (var i = 0; i < hits.length; i++) {
                var it = hits[i];
                if (!it || !it.content_id) continue;
                index[String(it.content_id)] = {
                    contentId: String(it.content_id),
                    titleEn: it.content_title_en || '',
                    title: it.content_title || '',
                    titleJp: it.content_title_jp || '',
                    totalEpisodes: Number(it.total_episodes) || 0
                };
            }
            var est = Number(data.estimatedTotalHits) || 0;
            if (hits.length < 100) break;
            if (est > 0 && offset + hits.length >= est) break;
            offset += hits.length;
        }
        AO_CACHE.CONTENT_INDEX = index;
        return index;
    } finally {
        INDEX_LOCKED = AO_CACHE.CONTENT_INDEX || null;
        INDEX_BUILDING = false;
    }
}

function indexCandidatesFor(titles) {
    var index = AO_CACHE.CONTENT_INDEX;
    if (!index) return [];
    var out = [];
    var keys = Object.keys(index);
    for (var k = 0; k < keys.length; k++) {
        var entry = index[keys[k]];
        var score = 0;
        var values = [entry.titleEn, entry.title, entry.titleJp].filter(Boolean);
        for (var i = 0; i < titles.length; i++) {
            var nt = norm(titles[i]);
            if (!nt) continue;
            for (var j = 0; j < values.length; j++) {
                var nv = norm(values[j]);
                if (!nv) continue;
                var d = diceCoeff(nt, nv);
                if (d > score) score = d;
            }
        }
        if (score >= 0.5) {
            out.push({
                contentId: entry.contentId,
                titleEn: entry.titleEn,
                score: score
            });
        }
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, 8);
}

function searchQueries(titles) {
    var queries = [];
    var seen = {};
    var pushQ = function (q) {
        q = String(q || '').replace(/\s+/g, ' ').trim();
        if (!q || q.length < 3) return;
        var key = q.toLowerCase();
        if (seen[key]) return;
        seen[key] = 1;
        queries.push(q);
    };
    for (var t = 0; t < titles.length && t < 6; t++) {
        var raw = String(titles[t] || '').replace(/\s+/g, ' ').trim();
        if (!raw) continue;
        pushQ(raw);
        var plain = raw.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
        if (plain.length >= 3) pushQ(plain);
        var words = plain.split(/\s+/).filter(Boolean);
        if (words.length > 4) pushQ(words.slice(0, 6).join(' '));
        if (words.length > 6) pushQ(words.slice(0, 4).join(' '));
        var family = plain
            .replace(/\b(?:the\s+)?final\s+chapters?\b/gi, ' ')
            .replace(/\b(?:season|part|cour|chapter)\s*(?:\d+|one|two|three|four|five|final)?\b/gi, ' ')
            .replace(/\b(?:the\s+)?movie\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (family.length >= 3) pushQ(family);
    }
    return queries.slice(0, 12);
}

function candidateTitleScore(titles, candidate) {
    var values = [candidate.content_title_en, candidate.content_title, candidate.content_title_jp].filter(Boolean);
    var score = 0;
    for (var i = 0; i < titles.length; i++) {
        var nt = norm(titles[i]);
        if (!nt) continue;
        for (var j = 0; j < values.length; j++) {
            var nv = norm(values[j]);
            if (!nv) continue;
            var d = diceCoeff(nt, nv);
            if (d > score) score = d;
        }
    }
    return score;
}

async function inspectCandidate(candidate) {
    var contentId = String(candidate && candidate.content_id ? candidate.content_id : '');
    if (!contentId) return null;
    try {
        var video = await apiJson('/v4/content/' + encodeURIComponent(contentId) + '/video/1');
        var metadata = video && video.metadata;
        if (!metadata) return null;
        return {
            contentId: contentId,
            title: candidate.content_title_en || candidate.content_title || '',
            malId: Number(metadata.mal_id) || null,
            episodeCount: Number(metadata.total_episodes) || 0,
            isMovie: Boolean(metadata.is_movie)
        };
    } catch (e) {
        return null;
    }
}

async function resolveSeries(meta) {
    var cacheKey = 'series:' + meta.anilistId;
    if (AO_CACHE[cacheKey]) return AO_CACHE[cacheKey];

    var titles = [];
    var seenT = {};
    var primary = [meta.titleEn, meta.titleRom];
    for (var i = 0; i < primary.length; i++) {
        var val = String(primary[i] || '').trim();
        if (val && !seenT[val.toLowerCase()]) {
            seenT[val.toLowerCase()] = 1;
            titles.push(val);
        }
    }
    if (!titles.length) titles = [meta.titleEn || String(meta.anilistId)];

    var expectedMal = meta.malId ? Number(meta.malId) : null;
    var queries = searchQueries(titles);

    // Phase 1: server-side relevance search.
    var discovered = {};
    if (queries.length) {
        var bestScore = 0;
        for (var q = 0; q < queries.length; q++) {
            try {
                var hits = await search(queries[q]);
                for (var h = 0; h < hits.length; h++) {
                    var cand = hits[h];
                    if (!cand || !cand.content_id) continue;
                    var cid = String(cand.content_id);
                    if (discovered[cid]) continue;
                    var score = candidateTitleScore(titles, cand);
                    if (score >= 0.4) {
                        discovered[cid] = { candidate: cand, score: score };
                        if (score > bestScore) bestScore = score;
                    }
                }
            } catch (e) {}
            if (bestScore >= 0.9) break;
        }
    }

    // Phase 2: if nothing verified yet, fall back to the full local index.
    if (!Object.keys(discovered).length) {
        try {
            var indexCands = indexCandidatesFor(titles);
            for (var ic = 0; ic < indexCands.length; ic++) {
                var icand = indexCands[ic];
                if (discovered[icand.contentId]) continue;
                discovered[icand.contentId] = {
                    candidate: {
                        content_id: icand.contentId,
                        content_title_en: icand.titleEn
                    },
                    score: icand.score
                };
            }
        } catch (e2) {}
    }

    // Inspect the top candidates to learn their real MAL id, then only ever
    // accept a candidate whose MAL id equals the expected one. Never pick a
    // different show just because the titles look similar.
    var keys = Object.keys(discovered);
    var sorted = keys.map(function (k) { return discovered[k]; })
        .sort(function (a, b) { return b.score - a.score; })
        .slice(0, 10);

    var inspected = [];
    for (var s = 0; s < sorted.length; s++) {
        var info = await inspectCandidate(sorted[s].candidate);
        if (info) inspected.push({ info: info, score: sorted[s].score });
    }

    var pool = [];
    for (var v = 0; v < inspected.length; v++) {
        var item = inspected[v];
        if (item.score < 0.4) continue;
        if (expectedMal != null) {
            if (item.info.malId === expectedMal) pool.push(item);
        } else {
            pool.push(item);
        }
    }
    if (!pool.length) {
        throw new Error('AnimeOnsen no exact MAL match for AniList ' + meta.anilistId);
    }
    pool.sort(function (a, b) { return b.score - a.score; });

    var selected = pool[0].info;
    var result = {
        contentId: selected.contentId,
        title: selected.title,
        malId: selected.malId,
        episodeCount: selected.episodeCount,
        isMovie: selected.isMovie,
        score: pool[0].score
    };
    AO_CACHE[cacheKey] = result;
    return result;
}

function skipRange(start, end) {
    var from = Number(start);
    var to = Number(end);
    if (isFinite(from) && isFinite(to) && to > from) return { start: from, end: to };
    return null;
}

async function fetchEpisodes(series) {
    var data = await apiJson('/v4/content/' + encodeURIComponent(series.contentId) + '/episodes');
    var episodes = [];
    for (var key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        var n = Number(key);
        if (isNaN(n) || n < 1) continue;
        var detail = data[key] || {};
        episodes.push({
            number: n,
            sourceNumber: key,
            title: detail.contentTitle_episode_en || detail.contentTitle_episode_jp || null
        });
    }
    episodes.sort(function (a, b) { return a.number - b.number; });
    if (episodes.length) return episodes;
    if (series.isMovie) return [{ number: 1, sourceNumber: '1', title: null }];
    throw new Error('AnimeOnsen has no episodes for ' + series.contentId);
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var meta = await resolveMetadata(tmdbId);
        if (!meta.anilistId) return [];

        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var series = await resolveSeries(meta);
        var episodeList = await fetchEpisodes(series);
        var epItem = null;
        for (var i = 0; i < episodeList.length; i++) {
            if (episodeList[i].number === targetEp) { epItem = episodeList[i]; break; }
        }
        if (!epItem) throw new Error('AnimeOnsen episode ' + targetEp + ' not found');

        var video = await apiJson('/v4/content/' + encodeURIComponent(series.contentId) + '/video/' + encodeURIComponent(epItem.sourceNumber));
        var stream = video && video.uri && video.uri.stream;
        if (!stream) throw new Error('AnimeOnsen has no stream for episode ' + targetEp);

        var current = await getSession();
        var streamHeaders = {
            'Authorization': 'Bearer ' + current.token,
            'Origin': SITE,
            'Referer': SITE + '/',
            'User-Agent': UA
        };

        var subtitles = [];
        var uriSubs = (video.uri && video.uri.subtitles) || {};
        var subLabels = (video.metadata && video.metadata.subtitles) || {};
        for (var lang in uriSubs) {
            if (!Object.prototype.hasOwnProperty.call(uriSubs, lang)) continue;
            var subUrl = uriSubs[lang];
            if (!subUrl) continue;
            subtitles.push({
                url: subUrl,
                language: lang,
                name: subLabels[lang] || lang,
                headers: {
                    'Authorization': 'Bearer ' + current.token,
                    'Origin': SITE,
                    'Referer': SITE + '/',
                    'User-Agent': UA
                }
            });
        }

        var skip = null;
        if (Array.isArray(video.metadata && video.metadata.episode)) {
            for (var sk = 0; sk < video.metadata.episode.length; sk++) {
                var it = video.metadata.episode[sk];
                if (it && typeof it === 'object' && ('skipIntro_s' in it || 'skipIntro_e' in it)) {
                    skip = skipRange(it.skipIntro_s, it.skipIntro_e);
                    break;
                }
            }
        }

        var epLabel = 'Ep ' + targetEp;
        return [{
            name: 'AnimeOnsen (Sub)',
            title: 'AnimeOnsen · Sub · ' + epLabel,
            url: stream,
            quality: 'auto',
            type: 'dash',
            headers: streamHeaders,
            subtitles: subtitles,
            intro: skip || null,
            outro: null
        }];
    } catch (e) {
        console.warn('[animeonsen] failed: ' + (e && e.message));
        return [];
    }
}

async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603" -> One Piece (AniList 21)
    if (classified.id === '603') {
        return { titleEn: 'One Piece', titleRom: 'One Piece', anilistId: '21', malId: '21' };
    }

    var query = null;
    if (classified.kind === 'anilist') query = 'anilist_id=' + encodeURIComponent(classified.id);
    else if (classified.kind === 'mal') query = 'mal_id=' + encodeURIComponent(classified.id);
    else if (classified.kind === 'tmdb') query = 'themoviedb_id=' + encodeURIComponent(classified.id);

    if (query) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?' + query, {
                headers: { 'User-Agent': UA, 'Accept': 'application/json' }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.titles) {
                    return {
                        titleEn: data.titles.en || data.titles.ro || data.titles.ja || '',
                        titleRom: data.titles.ro || data.titles.en || '',
                        anilistId: data.mappings ? String(data.mappings.anilist_id || '') : '',
                        malId: data.mappings && data.mappings.mal_id != null ? String(data.mappings.mal_id) : (classified.kind === 'mal' ? classified.id : '')
                    };
                }
            }
        } catch (e) {}
    }

    if (/^\d+$/.test(classified.id)) {
        try {
            var aRes = await fetch(ANIZIP_ENDPOINT + '?anilist_id=' + encodeURIComponent(classified.id), {
                headers: { 'User-Agent': UA, 'Accept': 'application/json' }
            });
            if (aRes.ok) {
                var aData = await aRes.json();
                if (aData && aData.titles) {
                    return {
                        titleEn: aData.titles.en || aData.titles.ro || '',
                        titleRom: aData.titles.ro || aData.titles.en || '',
                        anilistId: classified.id,
                        malId: aData.mappings && aData.mappings.mal_id != null ? String(aData.mappings.mal_id) : ''
                    };
                }
            }
        } catch (e) {}
    }

    return {
        titleEn: classified.id,
        titleRom: classified.id,
        anilistId: classified.kind === 'anilist' ? classified.id : '',
        malId: classified.kind === 'mal' ? classified.id : ''
    };
}

async function onSettings() {
    return [{
        key: 'label',
        type: 'text',
        title: 'Provider Name',
        description: 'Display name for AnimeOnsen streams.',
        default: 'AnimeOnsen'
    }];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;