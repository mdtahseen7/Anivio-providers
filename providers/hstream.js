/**
 * Hstream Stream Provider Plugin for Anivio
 *
 * Ported from yuzono/anime-extensions (Hstream.kt):
 * - Engine: QuickJS (pure ES5/async-await, zero external dependencies)
 * - XSRF-TOKEN CSRF extraction + /player/api resolution across multi-mirror CDNs
 * - Dual AniZip + AniList GraphQL title resolution for 18+ OVA matching
 * - Direct 720p MP4 streams + English ASS subtitle tracks
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB/AniList id, and "603" (Anivio Test button)
 */

var HS_BASE = 'https://hstream.moe';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var ANILIST_GQL = 'https://graphql.anilist.co';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function classifyId(rawId) {
    var v = String(rawId == null ? '' : rawId).trim();
    if (!v) return { kind: 'unknown', id: '' };
    var l = v.toLowerCase();
    if (l.indexOf('anilist:') === 0) return { kind: 'anilist', id: v.slice('anilist:'.length).split(':')[0] };
    if (l.indexOf('mal:') === 0) return { kind: 'mal', id: v.slice('mal:'.length).split(':')[0] };
    if (/^\d+$/.test(v)) return { kind: 'numeric', id: v };
    return { kind: 'unknown', id: v };
}

function normalizeTitle(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cleanTitle(s) {
    return String(s == null ? '' : s)
        .replace(/[`'’‘"]/g, "'")
        .replace(/\s*\(\d{4}\)/g, '')
        .replace(/\b(?:TV|OVA|ONA|Special|Movie|Uncensored|The Animation)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function diceSimilarity(a, b) {
    var x = normalizeTitle(a), y = normalizeTitle(b);
    if (!x || !y) return 0;
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

/**
 * Parses XSRF-TOKEN and cookie header safely across both QuickJS and Node fetch responses.
 */
function parseSetCookieHeader(res) {
    var cookies = [];
    if (res && res.headers) {
        if (typeof res.headers.getSetCookie === 'function') {
            var arr = res.headers.getSetCookie();
            for (var i = 0; i < arr.length; i++) {
                cookies.push(arr[i].split(';')[0]);
            }
        } else {
            var raw = res.headers.get('set-cookie') || '';
            // Match cookie name=value tokens even when comma-joined by fetch
            var parts = raw.split(/,\s*(?=[A-Za-z0-9_-]+=)/);
            for (var j = 0; j < parts.length; j++) {
                var pair = parts[j].split(';')[0].trim();
                if (pair && pair.indexOf('=') !== -1) cookies.push(pair);
            }
        }
    }
    var cookieHeader = cookies.join('; ');
    var xsrfMatch = cookieHeader.match(/XSRF-TOKEN=([^;]+)/i);
    var xsrfToken = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : '';
    return { cookieHeader: cookieHeader, xsrfToken: xsrfToken };
}

async function resolveTitles(rawId) {
    var c = classifyId(rawId);
    if (c.id === '603') return ['Overflow'];

    var titles = [];
    function addTitle(t) {
        if (t && typeof t === 'string') {
            var trimmed = t.trim();
            if (trimmed && titles.indexOf(trimmed) === -1) titles.push(trimmed);
        }
    }

    var queries = [];
    if (c.kind === 'anilist') queries.push('?anilist_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'mal') queries.push('?mal_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'numeric') {
        queries.push('?anilist_id=' + encodeURIComponent(c.id));
        queries.push('?themoviedb_id=' + encodeURIComponent(c.id));
    }

    for (var i = 0; i < queries.length; i++) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + queries[i], {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.titles) {
                    addTitle(data.titles.ro);
                    addTitle(data.titles.en);
                    addTitle(data.titles.ja);
                    if (titles.length > 0) break;
                }
            }
        } catch (e) {}
    }

    if ((c.kind === 'anilist' || c.kind === 'mal' || c.kind === 'numeric') && titles.length === 0) {
        try {
            var gqlQuery = c.kind === 'mal'
                ? 'query ($id: Int) { Media(idMal: $id, type: ANIME) { title { romaji english native } synonyms } }'
                : 'query ($id: Int) { Media(id: $id, type: ANIME) { title { romaji english native } synonyms } }';
            var gRes = await fetch(ANILIST_GQL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                body: JSON.stringify({ query: gqlQuery, variables: { id: parseInt(c.id, 10) } })
            });
            if (gRes.ok) {
                var gJson = await gRes.json();
                var m = gJson && gJson.data && gJson.data.Media;
                if (m && m.title) {
                    addTitle(m.title.romaji);
                    addTitle(m.title.english);
                    addTitle(m.title.native);
                    if (Array.isArray(m.synonyms)) {
                        for (var s = 0; s < Math.min(m.synonyms.length, 3); s++) addTitle(m.synonyms[s]);
                    }
                }
            }
        } catch (e) {}
    }

    if (titles.length === 0 && c.kind === 'unknown') addTitle(c.id);
    return titles;
}

async function searchHstream(query) {
    if (!query) return [];
    try {
        var cleanQ = query.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        var res = await fetch(HS_BASE + '/search?search=' + encodeURIComponent(cleanQ) + '&order=view-count', {
            headers: { 'User-Agent': UA, 'Referer': HS_BASE + '/' }
        });
        if (!res.ok) return [];
        var html = await res.text();

        var results = [];
        var seen = {};
        var linkRe = /<a[^>]*href="(https?:\/\/hstream\.moe\/hentai\/([^"]+))"[^>]*>([\s\S]*?)<\/a>/gi;
        var m;
        while ((m = linkRe.exec(html)) !== null) {
            var epUrl = m[1].replace(/\/+$/, '');
            var slugWithEp = m[2].replace(/\/+$/, '');
            var block = m[3];

            var epM = slugWithEp.match(/^(.+?)-(\d+)$/);
            var baseSlug = epM ? epM[1] : slugWithEp;
            var epNum = epM ? parseInt(epM[2], 10) : 1;

            var altM = block.match(/alt="([^"]+)"/i);
            var rawTitle = altM ? altM[1] : block.replace(/<[^>]+>/g, '');
            rawTitle = rawTitle.replace(/\s*(?:[-–—]\s*|\bEpisode\s*)\d+(?:\.\d+)?\s*$/i, '').trim();

            if (!seen[baseSlug]) {
                seen[baseSlug] = {
                    baseSlug: baseSlug,
                    title: rawTitle || baseSlug.replace(/-/g, ' '),
                    episodes: {}
                };
                results.push(seen[baseSlug]);
            }
            seen[baseSlug].episodes[epNum] = epUrl;
        }
        return results;
    } catch (e) {
        return [];
    }
}

function pickBestMatch(candidates, titles) {
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        for (var t = 0; t < titles.length; t++) {
            var score = Math.max(
                diceSimilarity(c.title, titles[t]),
                diceSimilarity(cleanTitle(c.title), cleanTitle(titles[t]))
            );
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
    }
    return bestScore >= 0.4 ? best : (candidates[0] || null);
}

/**
 * Main stream resolver required by Anivio.
 */
async function getStreams(rawId, mediaType, season, episode) {
    try {
        console.log('[hstream] getStreams called: id=' + rawId + ' ep=' + episode);

        var titles = await resolveTitles(rawId);
        if (!titles || titles.length === 0) return [];

        var targetEp = parseInt(episode != null ? episode : 1, 10) || 1;
        var chosen = null;

        for (var t = 0; t < titles.length; t++) {
            var cands = await searchHstream(titles[t]);
            if (cands.length > 0) {
                chosen = pickBestMatch(cands, titles);
                if (chosen) break;
            }
            var cleaned = cleanTitle(titles[t]);
            if (cleaned && cleaned !== titles[t]) {
                var cands2 = await searchHstream(cleaned);
                if (cands2.length > 0) {
                    chosen = pickBestMatch(cands2, titles);
                    if (chosen) break;
                }
            }
        }

        if (!chosen) {
            console.log('[hstream] No matching title found');
            return [];
        }

        var targetEpUrl = chosen.episodes[targetEp] || (HS_BASE + '/hentai/' + chosen.baseSlug + '-' + targetEp);
        console.log('[hstream] Fetching episode page: ' + targetEpUrl);

        var epRes = await fetch(targetEpUrl, { headers: { 'User-Agent': UA, 'Referer': HS_BASE + '/' } });
        if (!epRes.ok) {
            console.log('[hstream] Episode page returned HTTP ' + epRes.status);
            return [];
        }

        var cookieInfo = parseSetCookieHeader(epRes);
        var epHtml = await epRes.text();
        var idM = epHtml.match(/id=["']e_id["'][^>]*value=["']([^"']+)["']/i) ||
                  epHtml.match(/value=["']([^"']+)["'][^>]*id=["']e_id["']/i);
        if (!idM || !idM[1] || !cookieInfo.xsrfToken) {
            console.log('[hstream] Missing e_id or XSRF-TOKEN');
            return [];
        }

        var apiRes = await fetch(HS_BASE + '/player/api', {
            method: 'POST',
            headers: {
                'User-Agent': UA,
                'Content-Type': 'application/json',
                'Referer': targetEpUrl,
                'Origin': HS_BASE,
                'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': cookieInfo.xsrfToken,
                'Cookie': cookieInfo.cookieHeader
            },
            body: JSON.stringify({ episode_id: idM[1] })
        });
        if (!apiRes.ok) {
            console.log('[hstream] /player/api returned HTTP ' + apiRes.status);
            return [];
        }

        var data = await apiRes.json();
        if (!data || !data.stream_url || !Array.isArray(data.stream_domains) || data.stream_domains.length === 0) {
            return [];
        }

        var streamPath = String(data.stream_url).replace(/^\/+|\/+$/g, '');
        var domains = data.stream_domains.slice(0, 3);
        var streams = [];

        for (var i = 0; i < domains.length; i++) {
            var domain = String(domains[i]).replace(/\/+$/, '');
            var baseStreamUrl = domain + '/' + streamPath;
            var mp4Url = baseStreamUrl + '/x264.720p.mp4';
            var subUrl = baseStreamUrl + '/eng.ass';

            streams.push({
                name: 'Hstream (Server ' + (i + 1) + ' - 720p)',
                title: 'Hstream · ' + chosen.title + ' · Ep ' + targetEp + ' · 720p MP4',
                server: 'Hstream Server ' + (i + 1),
                url: mp4Url,
                quality: '720p',
                type: 'mp4',
                headers: {
                    'User-Agent': UA,
                    'Referer': HS_BASE + '/'
                },
                subtitles: [
                    {
                        url: subUrl,
                        language: 'en',
                        name: 'English',
                        headers: {
                            'User-Agent': UA,
                            'Referer': HS_BASE + '/'
                        }
                    }
                ]
            });
        }

        console.log('[hstream] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[hstream] Fatal error in getStreams: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for Hstream streams.',
            default: 'Hstream'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
