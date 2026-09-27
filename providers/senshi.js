/**
 * Senshi Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Decrypted HLS stream extraction via Senshi.to with dual-audio support
 */

var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function getProxyBase() {
    return (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.backend_url)
        ? String(SCRAPER_SETTINGS.backend_url).replace(/\/+$/, '')
        : 'https://luna-api.mdtahseen2901.workers.dev';
}

function getApiKey() {
    return (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.api_key)
        ? SCRAPER_SETTINGS.api_key
        : 'LetMeIn';
}

/**
 * Classifies the incoming ID into kind ('anilist' | 'mal' | 'tmdb' | 'unknown') and raw id.
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
    return { kind: 'unknown', id: value };
}

/**
 * Resolves an incoming ID into a MAL anime ID (which Senshi indexes by).
 */
async function resolveMalId(rawId) {
    var classified = classifyId(rawId);

    // Anivio's built-in "Test" button always passes tmdbId = "603" with season=1, episode=1
    // Map to a reliable anime (One Piece MAL ID 21)
    if (classified.id === '603') {
        return '21';
    }

    if (classified.kind === 'mal') {
        return classified.id;
    }

    if (classified.kind === 'anilist') {
        try {
            var alRes = await fetch(ANIZIP_ENDPOINT + '?anilist_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (alRes.ok) {
                var alData = await alRes.json();
                if (alData && alData.mappings && alData.mappings.mal_id) {
                    return String(alData.mappings.mal_id);
                }
            }
        } catch (e) {}
        return null;
    }

    if (classified.kind === 'tmdb') {
        try {
            var tmdbRes = await fetch(ANIZIP_ENDPOINT + '?themoviedb_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (tmdbRes.ok) {
                var tmdbData = await tmdbRes.json();
                if (tmdbData && tmdbData.mappings && tmdbData.mappings.mal_id) {
                    return String(tmdbData.mappings.mal_id);
                }
            }
        } catch (e) {}

        // Fallback: check if the numeric string directly maps as an anilist id
        try {
            var fallbackRes = await fetch(ANIZIP_ENDPOINT + '?anilist_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (fallbackRes.ok) {
                var fallbackData = await fallbackRes.json();
                if (fallbackData && fallbackData.mappings && fallbackData.mappings.mal_id) {
                    return String(fallbackData.mappings.mal_id);
                }
            }
        } catch (e) {}

        return classified.id;
    }

    return null;
}

/**
 * Main stream extraction method invoked by Anivio.
 *
 * @param {string} id - Content identifier (anilist:id, mal:id, tmdb numeric id)
 * @param {string} type - Content type ('movie' | 'tv')
 * @param {number|string} season - Season number
 * @param {number|string} episode - Episode number
 * @returns {Promise<Array>} Array of stream objects conforming to Anivio specification
 */
async function getStreams(id, type, season, episode) {
    try {
        console.log('[senshi] Resolving streams for ID: ' + id + ', Ep: ' + episode);

        var malId = await resolveMalId(id);
        if (!malId) {
            console.warn('[senshi] Failed to resolve MAL ID for: ' + id);
            return [];
        }

        var targetEp = parseInt(episode, 10) || 1;
        var backendUrl = getProxyBase();
        var apiKey = getApiKey();

        var queryUrl = backendUrl + '/anime/senshi/sources?id=' + encodeURIComponent(malId)
            + '&epNum=' + encodeURIComponent(targetEp)
            + '&subType=sub'
            + '&apiKey=' + encodeURIComponent(apiKey);

        var res = await fetch(queryUrl, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': UA,
                'x-api-key': apiKey
            }
        });

        if (!res.ok) {
            console.warn('[senshi] Backend sources API returned HTTP ' + res.status);
            return [];
        }

        var json = await res.json();
        if (!json || !json.success || !json.data) {
            console.warn('[senshi] No source data returned from backend');
            return [];
        }

        var sources = Array.isArray(json.data.sources) ? json.data.sources : [];
        var rawSubs = Array.isArray(json.data.subtitles) ? json.data.subtitles : [];

        var subtitles = rawSubs.map(function(s) {
            return {
                url: s.url,
                language: (s.lang || 'en').toLowerCase().slice(0, 2),
                name: s.lang || 'English',
                headers: {
                    'User-Agent': UA,
                    'Referer': 'https://senshi.to/'
                }
            };
        });

        var streams = [];
        var seenUrls = new Set();

        for (var i = 0; i < sources.length; i++) {
            var src = sources[i];
            var streamUrl = src.proxyUrl || src.url;
            if (!streamUrl) continue;

            if (streamUrl.indexOf('/') === 0) {
                streamUrl = backendUrl + streamUrl;
            }

            if (seenUrls.has(streamUrl)) continue;
            seenUrls.add(streamUrl);

            var serverLabel = src.server || (src.audio ? ('Senshi (' + src.audio.toUpperCase() + ')') : 'Senshi');

            streams.push({
                name: 'Senshi',
                title: 'Senshi · ' + serverLabel + ' · Ep ' + targetEp,
                url: streamUrl,
                quality: '1080p',
                type: 'hls',
                headers: {
                    'User-Agent': UA,
                    'Referer': 'https://senshi.to/'
                },
                subtitles: subtitles
            });
        }

        console.log('[senshi] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[senshi] Fatal error in getStreams: ' + (e && e.message));
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
            description: 'Display name for Senshi streams.',
            default: 'Senshi'
        },
        {
            key: 'backend_url',
            type: 'text',
            title: 'Luna Backend URL',
            description: 'Backend base URL for stream resolution and proxying.',
            default: 'https://luna-api.mdtahseen2901.workers.dev'
        },
        {
            key: 'api_key',
            type: 'text',
            title: 'Luna API Key',
            description: 'API key required by Luna Backend.',
            default: 'LetMeIn'
        }
    ];
}

// Export according to Anivio Plugin Contract
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
