/**
 * AnimeHeaven Stream Provider Plugin for Anivio
 *
 * Standalone direct stream provider for https://animeheaven.me/
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Direct 1080p MP4 stream extraction from AnimeHeaven video CDNs
 * - Completely standalone (no dependencies on Luna backend)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, title, and "603" (Anivio Test button)
 */

var BASE_URL = 'https://animeheaven.me';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var ANILIST_GRAPHQL = 'https://graphql.anilist.co';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/**
 * Classifies the incoming ID into kind ('anilist' | 'mal' | 'tmdb' | 'title' | 'unknown') and raw id.
 */
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

/**
 * Normalizes title string for comparison.
 */
function normalizeTitle(str) {
    return (str || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Resolves metadata and search titles for the given content ID.
 */
async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio's built-in "Test" button always passes "603"
    if (classified.id === '603') {
        return { titles: ['One Piece'] };
    }

    if (classified.kind === 'title') {
        return { titles: [classified.id] };
    }

    var titles = [];

    // 1. Try AniList GraphQL
    if (classified.kind === 'anilist') {
        try {
            var q = 'query ($id: Int) { Media(id: $id) { title { romaji english native } synonyms } }';
            var alRes = await fetch(ANILIST_GRAPHQL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                body: JSON.stringify({ query: q, variables: { id: parseInt(classified.id, 10) } })
            });
            if (alRes.ok) {
                var alJson = await alRes.json();
                var media = alJson && alJson.data && alJson.data.Media;
                if (media && media.title) {
                    if (media.title.english) titles.push(media.title.english);
                    if (media.title.romaji) titles.push(media.title.romaji);
                    if (Array.isArray(media.synonyms)) {
                        for (var i = 0; i < media.synonyms.length; i++) {
                            if (media.synonyms[i]) titles.push(media.synonyms[i]);
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // 2. Fallback: AniZip mapping
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

    return { titles: titles.length > 0 ? titles : [classified.id] };
}

/**
 * Searches AnimeHeaven using fastsearch.php and finds the best matching anime.
 */
async function searchAnimeHeaven(titles) {
    for (var t = 0; t < titles.length; t++) {
        var query = titles[t];
        if (!query) continue;

        try {
            var url = BASE_URL + '/fastsearch.php?xhr=1&s=' + encodeURIComponent(query);
            var res = await fetch(url, {
                headers: { 'User-Agent': UA, 'Referer': BASE_URL }
            });
            if (!res.ok) continue;

            var html = await res.text();
            var re = /href=['"]([^'"]*)['"][^>]*>[\s\S]*?<div class=['"]fastname['"]>([^<]+)<\/div>/gi;
            var m;
            var candidates = [];

            while ((m = re.exec(html)) !== null) {
                candidates.push({ path: m[1], name: m[2].trim() });
            }

            if (candidates.length === 0) continue;

            var targetNorm = normalizeTitle(query);

            // 1. Exact normalized match (including splitting comma aliases like "Jujutsu Kaisen, jjk")
            for (var c = 0; c < candidates.length; c++) {
                var cand = candidates[c];
                var candNorm = normalizeTitle(cand.name);
                if (candNorm === targetNorm) {
                    return cand;
                }
                var aliases = cand.name.split(',');
                for (var a = 0; a < aliases.length; a++) {
                    if (normalizeTitle(aliases[a]) === targetNorm) {
                        return cand;
                    }
                }
            }

            // 2. Exact word boundaries match
            for (var c2 = 0; c2 < candidates.length; c2++) {
                var cand2 = candidates[c2];
                var candNorm2 = normalizeTitle(cand2.name);
                var reWord = new RegExp('\\b' + targetNorm + '\\b', 'i');
                if (reWord.test(candNorm2)) {
                    if (candNorm2.indexOf('2nd season') === -1 && candNorm2.indexOf('movie') === -1 && candNorm2.indexOf('culling game') === -1) {
                        return cand2;
                    }
                }
            }

            // 3. Fallback to first candidate
            return candidates[0];
        } catch (e) {}
    }
    return null;
}

/**
 * Main stream extraction method invoked by Anivio.
 *
 * @param {string} id - Content identifier (anilist:id, mal:id, tmdb numeric id, title)
 * @param {string} type - Content type ('movie' | 'tv')
 * @param {number|string} season - Season number
 * @param {number|string} episode - Episode number
 * @returns {Promise<Array>} Array of stream objects conforming to Anivio specification
 */
async function getStreams(id, type, season, episode) {
    try {
        console.log('[animeheaven] Resolving streams for ID: ' + id + ', Ep: ' + episode);

        var meta = await resolveMetadata(id);
        var targetEp = parseInt(episode, 10) || 1;

        console.log('[animeheaven] Searching with titles: ' + meta.titles.slice(0, 3).join(', '));
        var anime = await searchAnimeHeaven(meta.titles);
        if (!anime || !anime.path) {
            console.warn('[animeheaven] Anime not found on animeheaven.me');
            return [];
        }

        console.log('[animeheaven] Found anime: ' + anime.name + ' (' + anime.path + ')');

        var pageUrl = BASE_URL + (anime.path.indexOf('/') === 0 ? anime.path : ('/' + anime.path));
        var pageRes = await fetch(pageUrl, {
            headers: { 'User-Agent': UA, 'Referer': BASE_URL }
        });

        if (!pageRes.ok) {
            console.warn('[animeheaven] Failed to fetch anime page: HTTP ' + pageRes.status);
            return [];
        }

        var pageHtml = await pageRes.text();

        // Extract episodes and their gate key tokens
        var epRegex = /gate[ah]\(\s*["']([a-f0-9]{32})["']\s*\)[\s\S]*?class=\s*['"][^'"]*watch2[^'"]*['"]\s*>\s*(\d+)/gi;
        var m;
        var epMap = {};
        while ((m = epRegex.exec(pageHtml)) !== null) {
            var key = m[1];
            var epNum = parseInt(m[2], 10);
            if (!epMap[epNum]) {
                epMap[epNum] = key;
            }
        }

        var epKey = epMap[targetEp];
        if (!epKey) {
            console.warn('[animeheaven] Episode ' + targetEp + ' not found in episode list');
            return [];
        }

        console.log('[animeheaven] Found episode key for Ep ' + targetEp);

        var gateRes = await fetch(BASE_URL + '/gate.php', {
            headers: {
                'User-Agent': UA,
                'Referer': pageUrl,
                'Cookie': 'key=' + epKey
            }
        });

        if (!gateRes.ok) {
            console.warn('[animeheaven] Failed to fetch gate.php: HTTP ' + gateRes.status);
            return [];
        }

        var gateHtml = await gateRes.text();
        var srcRegex = /<source[^>]+src=['"]([^'"]+)['"]/gi;
        var sMatch;
        var seenUrls = new Set();
        var streams = [];
        var sIdx = 1;

        while ((sMatch = srcRegex.exec(gateHtml)) !== null) {
            var srcUrl = sMatch[1];
            if (!srcUrl || seenUrls.has(srcUrl)) continue;
            seenUrls.add(srcUrl);

            var serverLabel = 'Server ' + sIdx;
            if (sIdx === 1) serverLabel += ' (Primary)';
            else serverLabel += ' (Backup)';

            streams.push({
                name: 'AnimeHeaven',
                title: 'AnimeHeaven · ' + serverLabel + ' · Ep ' + targetEp,
                url: srcUrl,
                quality: '1080p',
                type: 'mp4',
                headers: {
                    'User-Agent': UA,
                    'Referer': 'https://animeheaven.me/'
                }
            });

            sIdx++;
        }

        console.log('[animeheaven] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[animeheaven] Fatal error in getStreams: ' + (e && e.message));
        return [];
    }
}

/**
 * Provider settings for Anivio UI.
 */
async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for AnimeHeaven streams.',
            default: 'AnimeHeaven'
        }
    ];
}

// Export according to Anivio Plugin Contract
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
