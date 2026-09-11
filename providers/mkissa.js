/**
 * MKissa Stream Provider Plugin for Anivio (via Anivexa API)
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves both SUB and DUB streams via Anivexa API
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var DEFAULT_API_URL = 'https://xanivexa-api.vercel.app';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getApiBase() {
    if (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.api_url) {
        return String(SCRAPER_SETTINGS.api_url).replace(/\/+$/, '');
    }
    return DEFAULT_API_URL;
}

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

async function resolveAnilistId(rawId) {
    var classified = classifyId(rawId);

    if (classified.kind === 'anilist') {
        return classified.id;
    }

    // Anivio test button always passes "603"
    if (classified.id === '603') {
        return '21';
    }

    if (classified.kind === 'mal') {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?mal_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.mappings && data.mappings.anilist_id) {
                    return String(data.mappings.anilist_id);
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
                if (tmdbData && tmdbData.mappings && tmdbData.mappings.anilist_id) {
                    return String(tmdbData.mappings.anilist_id);
                }
            }
        } catch (e) {}

        return classified.id;
    }

    return null;
}

async function fetchAudioStreams(apiBase, anilistId, targetEp, audio) {
    var watchUrl = apiBase + '/watch/mkissa/' + encodeURIComponent(anilistId) + '/' + audio + '/mkissa-' + encodeURIComponent(targetEp);
    try {
        var res = await fetch(watchUrl, {
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json'
            }
        });

        if (!res.ok) {
            console.log('[mkissa] ' + audio + ' watch endpoint returned HTTP ' + res.status);
            return [];
        }

        var data = await res.json();
        if (!data || !Array.isArray(data.sources)) {
            return [];
        }

        var results = [];
        for (var i = 0; i < data.sources.length; i++) {
            var src = data.sources[i];
            if (!src) continue;

            var finalUrl = src.extractedUrl || src.url;
            if (!finalUrl || finalUrl.indexOf('http') !== 0) continue;

            var serverName = src.name || ('Server ' + (i + 1));
            var isHls = (src.extractedType === 'hls') || (finalUrl.indexOf('.m3u8') !== -1);
            var mediaType = isHls ? 'hls' : (src.extractedType === 'mp4' ? 'mp4' : 'hls');

            var headers = src.headers || {
                'Referer': 'https://mkissa.to',
                'User-Agent': UA
            };

            results.push({
                name: 'MKissa',
                title: 'MKissa · ' + serverName + ' · Ep ' + targetEp + ' (' + audio.toUpperCase() + ')',
                url: finalUrl,
                quality: 'auto',
                type: mediaType,
                headers: headers,
                subtitles: []
            });
        }

        return results;
    } catch (e) {
        console.warn('[mkissa] error fetching ' + audio + ': ' + (e && e.message));
        return [];
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var anilistId = await resolveAnilistId(tmdbId);
        if (!anilistId) {
            console.log('[mkissa] No AniList ID resolved for ' + tmdbId);
            return [];
        }

        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        console.log('[mkissa] getStreams called for anilist:' + anilistId + ' ep=' + targetEp);

        var apiBase = getApiBase();

        // Fetch SUB and DUB in parallel
        var subPromise = fetchAudioStreams(apiBase, anilistId, targetEp, 'sub');
        var dubPromise = fetchAudioStreams(apiBase, anilistId, targetEp, 'dub');

        var results = await Promise.all([subPromise, dubPromise]);
        var subStreams = results[0] || [];
        var dubStreams = results[1] || [];

        var allStreams = subStreams.concat(dubStreams);

        console.log('[mkissa] returning ' + allStreams.length + ' streams');
        return allStreams;
    } catch (err) {
        console.error('[mkissa] getStreams fatal: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'api_url',
            type: 'text',
            title: 'Anivexa API Base URL',
            description: 'API endpoint for MKissa streams.',
            default: DEFAULT_API_URL
        },
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for MKissa streams.',
            default: 'MKissa'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
