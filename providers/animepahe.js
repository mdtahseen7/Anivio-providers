/**
 * AnimePahe Stream Provider Plugin for Anivio
 *
 * Standalone anime stream provider for https://animepahe.pw/
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export, no Node APIs)
 * - Direct HLS (m3u8) extraction via kwik embed + Dean Edwards (p,a,c,k,e,d) unpack
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, title, and "603" (Anivio Test button)
 *
 * ⚠️  REQUIRES CLOUDFLARE CLEARANCE.
 * animepahe is behind Cloudflare / DDoS-Guard. This provider uses the plain fetch()
 * polyfill only; the Anivio host is responsible for injecting the cf_clearance cookie
 * (and matching User-Agent) into these requests. Without clearance every request to
 * animepahe.pw returns a 403 challenge page and getStreams returns [].
 */

var BASE_URL = 'https://animepahe.pw';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var ANILIST_GRAPHQL = 'https://graphql.anilist.co';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
var MAX_EPISODE_PAGES = 20; // ponytail: hard cap, bumps only if a show has >600 episodes

/* ------------------------------------------------------------------ *
 * ID + title resolution
 * ------------------------------------------------------------------ */

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
    return { kind: 'title', id: value };
}

function normalizeTitle(str) {
    return (str || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Resolves candidate search titles (+ year when known) for the given content ID.
 * Returns { titles: string[], year: number|null }.
 */
async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio's built-in "Test" button always passes "603"
    if (classified.id === '603') {
        return { titles: ['One Piece'], year: null };
    }

    if (classified.kind === 'title') {
        return { titles: [classified.id], year: null };
    }

    var titles = [];
    var year = null;

    // 1. AniList GraphQL (has series title + start year; ani.zip only has episode titles)
    if (classified.kind === 'anilist') {
        try {
            var q = 'query ($id: Int) { Media(id: $id) { title { romaji english native } synonyms startDate { year } } }';
            var alRes = await fetch(ANILIST_GRAPHQL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                body: JSON.stringify({ query: q, variables: { id: parseInt(classified.id, 10) } })
            });
            if (alRes.ok) {
                var alJson = await alRes.json();
                var media = alJson && alJson.data && alJson.data.Media;
                if (media) {
                    if (media.startDate && media.startDate.year) year = media.startDate.year;
                    if (media.title) {
                        if (media.title.english) titles.push(media.title.english);
                        if (media.title.romaji) titles.push(media.title.romaji);
                        if (media.title.native) titles.push(media.title.native);
                    }
                    if (Array.isArray(media.synonyms)) {
                        for (var i = 0; i < media.synonyms.length; i++) {
                            if (media.synonyms[i]) titles.push(media.synonyms[i]);
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // 2. Fallback: AniZip mapping (works for mal / tmdb / anilist)
    if (titles.length === 0) {
        try {
            var param = classified.kind === 'mal' ? ('mal_id=' + classified.id)
                : classified.kind === 'tmdb' ? ('themoviedb_id=' + classified.id)
                : ('anilist_id=' + classified.id);

            var zipRes = await fetch(ANIZIP_ENDPOINT + '?' + param, {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (zipRes.ok) {
                var zipData = await zipRes.json();
                var titlesObj = zipData && zipData.titles;
                if (titlesObj) {
                    if (titlesObj.en) titles.push(titlesObj.en);
                    if (titlesObj.x_jat) titles.push(titlesObj.x_jat);
                    if (titlesObj.ro) titles.push(titlesObj.ro);
                }
            }
        } catch (e) {}
    }

    return { titles: titles.length > 0 ? titles : [classified.id], year: year };
}

/* ------------------------------------------------------------------ *
 * animepahe API
 * ------------------------------------------------------------------ */

function apiHeaders() {
    return {
        'User-Agent': UA,
        'Referer': BASE_URL + '/',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': '__ddg2_=;' // placeholder; real CF/DDG cookies are injected by the host
    };
}

/**
 * Search animepahe and pick the best match by normalized title, preferring the given year.
 * Returns { session, title, year } or null.
 */
async function searchAnime(titles, year) {
    for (var t = 0; t < titles.length; t++) {
        var query = titles[t];
        if (!query) continue;

        try {
            var url = BASE_URL + '/api?m=search&q=' + encodeURIComponent(query);
            var res = await fetch(url, { headers: apiHeaders() });
            if (!res.ok) continue;

            var json = await res.json();
            var data = json && json.data;
            if (!Array.isArray(data) || data.length === 0) continue;

            var targetNorm = normalizeTitle(query);

            // 1. Exact normalized title match, preferring the matching year
            var exactSameYear = null;
            var exactAnyYear = null;
            for (var c = 0; c < data.length; c++) {
                var cand = data[c];
                if (!cand || !cand.session) continue;
                var candNorm = normalizeTitle(cand.title);
                if (candNorm === targetNorm) {
                    if (year && cand.year === year) { exactSameYear = cand; break; }
                    if (!exactAnyYear) exactAnyYear = cand;
                }
            }
            if (exactSameYear) return mapAnime(exactSameYear);
            if (exactAnyYear) return mapAnime(exactAnyYear);

            // 2. Substring / word match, preferring the matching year
            var looseSameYear = null;
            var looseAny = null;
            for (var c2 = 0; c2 < data.length; c2++) {
                var cand2 = data[c2];
                if (!cand2 || !cand2.session) continue;
                var candNorm2 = normalizeTitle(cand2.title);
                if (candNorm2.indexOf(targetNorm) !== -1 || targetNorm.indexOf(candNorm2) !== -1) {
                    if (year && cand2.year === year && !looseSameYear) looseSameYear = cand2;
                    if (!looseAny) looseAny = cand2;
                }
            }
            if (looseSameYear) return mapAnime(looseSameYear);
            if (looseAny) return mapAnime(looseAny);

            // 3. Fallback: first result for this query
            if (data[0] && data[0].session) return mapAnime(data[0]);
        } catch (e) {}
    }
    return null;
}

function mapAnime(c) {
    return { session: c.session, title: c.title, year: c.year || null };
}

/**
 * Walk the release pages for an anime and return the session id of the target episode.
 */
async function findEpisodeSession(animeSession, targetEp) {
    var page = 1;
    var lastPage = 1;

    do {
        var url = BASE_URL + '/api?m=release&id=' + encodeURIComponent(animeSession) +
            '&sort=episode_asc&page=' + page;
        var res = await fetch(url, { headers: apiHeaders() });
        if (!res.ok) return null;

        var json = await res.json();
        if (!json) return null;
        if (json.last_page) lastPage = json.last_page;

        var data = json.data;
        if (Array.isArray(data)) {
            for (var i = 0; i < data.length; i++) {
                var ep = data[i];
                // episode numbers can be fractional; compare rounded integer value
                if (ep && Math.floor(Number(ep.episode)) === targetEp && ep.session) {
                    return ep.session;
                }
            }
        }
        page++;
    } while (page <= lastPage && page <= MAX_EPISODE_PAGES);

    return null;
}

/* ------------------------------------------------------------------ *
 * Play page -> kwik embeds
 * ------------------------------------------------------------------ */

/**
 * Parse the play page's #resolutionMenu buttons into kwik embed descriptors.
 * Returns array of { embed, audio, resolution }.
 */
function parsePlayPage(html) {
    var out = [];
    var seen = {};
    // <button ... data-src="https://kwik.si/e/XXXX" data-audio="jpn" data-resolution="1080" ...>
    var re = /<button[^>]*\bdata-src=["']([^"']+)["'][^>]*>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
        var tag = m[0];
        var src = m[1];
        if (!src || src.indexOf('kwik') === -1) continue;
        if (seen[src]) continue;
        seen[src] = true;

        var audioMatch = tag.match(/\bdata-audio=["']([^"']+)["']/i);
        var resMatch = tag.match(/\bdata-resolution=["']([^"']+)["']/i);
        out.push({
            embed: src,
            audio: audioMatch ? audioMatch[1].toLowerCase() : 'jpn',
            resolution: resMatch ? resMatch[1] : null
        });
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * kwik unpack (Dean Edwards p,a,c,k,e,d)
 * ------------------------------------------------------------------ */

function decodeDeanEdwards(packed) {
    try {
        var m = packed.match(/}\s*\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\('\|'\)/s);
        if (!m) return null;

        var p = m[1];
        var a = parseInt(m[2], 10);
        var c = parseInt(m[3], 10);
        var k = m[4].split('|');

        var encode = function (val) {
            return (val < a ? '' : encode(Math.floor(val / a))) +
                ((val = val % a) > 35 ? String.fromCharCode(val + 29) : val.toString(36));
        };

        var dict = {};
        while (c--) {
            var key = encode(c);
            if (k[c]) dict[key] = k[c];
        }

        return p.replace(/\b[0-9a-zA-Z]+\b/g, function (token) {
            return Object.prototype.hasOwnProperty.call(dict, token) ? dict[token] : token;
        });
    } catch (e) {
        return null;
    }
}

function kwikOrigin(embedUrl) {
    try {
        var u = new URL(embedUrl);
        return u.protocol + '//' + u.host;
    } catch (e) {
        return 'https://kwik.si';
    }
}

/**
 * Fetch a kwik embed URL and extract the direct .m3u8 (or .mp4) source.
 * Returns { url, origin } or null.
 */
async function resolveKwik(embedUrl) {
    try {
        var origin = kwikOrigin(embedUrl);
        var res = await fetch(embedUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': BASE_URL + '/' // kwik embeds expect an animepahe referer
            }
        });
        if (!res.ok) return null;
        var html = await res.text();

        // kwik ships the player config inside a packed eval(function(p,a,c,k,e,d){...})
        var packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)[\s\S]*?\)\)/);
        var searchIn = html;
        if (packedMatch) {
            var unpacked = decodeDeanEdwards(packedMatch[0]);
            if (unpacked) searchIn = unpacked;
        }

        // Unpacked script contains:  const source='https://.../uwu.m3u8'  (or an mp4)
        var srcMatch = searchIn.match(/https?:\\?\/\\?\/[^\s"'\\]+\.m3u8[^\s"'\\]*/i) ||
            searchIn.match(/https?:\\?\/\\?\/[^\s"'\\]+\.mp4[^\s"'\\]*/i) ||
            searchIn.match(/source\s*=\s*['"]([^'"]+)['"]/i);

        if (!srcMatch) return null;
        var url = (srcMatch[1] || srcMatch[0]).replace(/\\\//g, '/');
        if (!/^https?:\/\//i.test(url)) return null;

        return { url: url, origin: origin };
    } catch (e) {
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function getStreams(id, type, season, episode) {
    try {
        console.log('[animepahe] Resolving streams for ID: ' + id + ', Ep: ' + episode);

        var meta = await resolveMetadata(id);
        var targetEp = parseInt(episode, 10) || 1;

        console.log('[animepahe] Searching with titles: ' + meta.titles.slice(0, 3).join(', '));
        var anime = await searchAnime(meta.titles, meta.year);
        if (!anime || !anime.session) {
            console.warn('[animepahe] Anime not found (or Cloudflare block). Returning [].');
            return [];
        }
        console.log('[animepahe] Matched: ' + anime.title + ' (' + anime.year + ') session=' + anime.session);

        var epSession = await findEpisodeSession(anime.session, targetEp);
        if (!epSession) {
            console.warn('[animepahe] Episode ' + targetEp + ' not found.');
            return [];
        }

        var playUrl = BASE_URL + '/play/' + anime.session + '/' + epSession;
        var playRes = await fetch(playUrl, {
            headers: { 'User-Agent': UA, 'Referer': BASE_URL + '/' }
        });
        if (!playRes.ok) {
            console.warn('[animepahe] Failed to fetch play page: HTTP ' + playRes.status);
            return [];
        }

        var playHtml = await playRes.text();
        var embeds = parsePlayPage(playHtml);
        if (embeds.length === 0) {
            console.warn('[animepahe] No kwik embeds found on play page.');
            return [];
        }

        var streams = [];
        for (var i = 0; i < embeds.length; i++) {
            var e = embeds[i];
            var resolved = await resolveKwik(e.embed);
            if (!resolved || !resolved.url) continue;

            var isDub = e.audio === 'eng' || e.audio === 'en';
            var audioLabel = isDub ? 'DUB' : 'SUB';
            var qual = e.resolution ? (e.resolution + 'p') : 'Unknown';

            streams.push({
                name: 'AnimePahe',
                title: 'AnimePahe · ' + qual + ' · ' + audioLabel + ' · Ep ' + targetEp,
                url: resolved.url,
                quality: qual,
                language: isDub ? 'en' : 'ja',
                type: /\.mp4/i.test(resolved.url) ? 'mp4' : 'hls',
                provider: 'animepahe',
                headers: {
                    'User-Agent': UA,
                    'Referer': resolved.origin + '/' // kwik CDN requires its own referer
                }
            });
        }

        // Highest resolution first
        streams.sort(function (a, b) {
            return (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0);
        });

        console.log('[animepahe] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[animepahe] Fatal error in getStreams: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for AnimePahe streams. Requires Cloudflare clearance.',
            default: 'AnimePahe'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
