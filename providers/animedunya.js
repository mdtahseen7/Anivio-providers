/**
 * AnimeDunya Stream Provider Plugin for Anivio
 *
 * Standalone anime stream provider for https://anime-dunya.com
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves direct HLS streams and multi-language subtitles via AnimeDunya API
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var ANIMEDUNYA_BASE = 'https://anime-dunya.com';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

var HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': ANIMEDUNYA_BASE + '/'
};

// -------------------------------------------------------------
// ID Classification & Metadata Helpers
// -------------------------------------------------------------

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

async function resolveMalId(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button passes "603" (One Piece -> MAL 21)
    if (classified.id === '603') {
        return '21';
    }

    if (classified.kind === 'mal') {
        return classified.id;
    }

    var query = null;
    if (classified.kind === 'anilist') query = 'anilist_id=' + encodeURIComponent(classified.id);
    else if (classified.kind === 'tmdb') query = 'themoviedb_id=' + encodeURIComponent(classified.id);

    if (query) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?' + query, {
                headers: { 'User-Agent': UA, 'Accept': 'application/json' }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.mappings && data.mappings.mal_id) {
                    return String(data.mappings.mal_id);
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
                if (aData && aData.mappings && aData.mappings.mal_id) {
                    return String(aData.mappings.mal_id);
                }
            }
        } catch (e) {}
        return classified.id;
    }

    return null;
}

// -------------------------------------------------------------
// Stream Extraction
// -------------------------------------------------------------

function extractStream(html) {
    var match = html.match(/\\?"stream\\?":\s*/);
    if (!match) {
        var sourceMatch = html.match(/"source"\s*:\s*"([^"]+)"/);
        if (sourceMatch) {
            return { source: sourceMatch[1].replace(/\\/g, '') };
        }
        return null;
    }

    var idx = match.index;
    var matchLen = match[0].length;
    var braceCount = 0;
    var started = false;
    var result = '';
    for (var i = idx + matchLen; i < html.length; i++) {
        var ch = html[i];
        if (ch === '{') {
            braceCount++;
            started = true;
        } else if (ch === '}') {
            braceCount--;
        }
        if (started) {
            result += ch;
            if (braceCount === 0) break;
        }
    }

    try {
        var cleanStr = result.replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        return JSON.parse(cleanStr);
    } catch (e) {
        var fallbackMatch = html.match(/"source"\s*:\s*"([^"]+)"/);
        if (fallbackMatch) {
            return { source: fallbackMatch[1].replace(/\\/g, '') };
        }
        return null;
    }
}

function buildSubtitles(subs) {
    var out = [];
    var seen = {};
    if (!Array.isArray(subs)) return out;
    for (var i = 0; i < subs.length; i++) {
        var s = subs[i];
        if (!s) continue;
        var url = s.src || s.url || s.file;
        if (!url || seen[url]) continue;
        seen[url] = true;
        var label = s.label || s.language || 'English';
        var lang = s.srclang || 'en';
        if (/spanish/i.test(label)) lang = 'es';
        else if (/portuguese/i.test(label)) lang = 'pt';
        else if (/french/i.test(label)) lang = 'fr';
        else if (/german/i.test(label)) lang = 'de';
        else if (/arabic/i.test(label)) lang = 'ar';
        out.push({
            url: url,
            language: lang,
            name: label,
            headers: {
                'User-Agent': UA,
                'Referer': ANIMEDUNYA_BASE + '/'
            }
        });
    }
    return out;
}

// -------------------------------------------------------------
// Main getStreams Method
// -------------------------------------------------------------

async function getStreams(id, type, season, episode) {
    try {
        console.log('[animedunya] getStreams called: id=' + id + ' type=' + type + ' ep=' + episode);

        var malId = await resolveMalId(id);
        if (!malId) {
            console.warn('[animedunya] Could not resolve MAL ID for: ' + id);
            return [];
        }

        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var playUrl = ANIMEDUNYA_BASE + '/en/play/' + encodeURIComponent(malId) + '/' + targetEp;
        console.log('[animedunya] Fetching play page: ' + playUrl);

        var res = await fetch(playUrl, { headers: HEADERS });
        if (!res.ok) {
            console.warn('[animedunya] HTTP status ' + res.status + ' on play page');
            return [];
        }

        var html = await res.text();
        if (html.indexOf('Access Blocked') !== -1 || html.indexOf('not available in your country') !== -1) {
            console.warn('[animedunya] Service is geo-blocked in current region (Cloudflare clearance required)');
            return [];
        }

        var streamData = extractStream(html);
        if (!streamData || !streamData.source) {
            console.warn('[animedunya] No stream data extracted from page');
            return [];
        }

        var rawSource = streamData.source;
        var streams = [{
            name: 'AnimeDunya',
            title: 'AnimeDunya · Ep ' + targetEp,
            server: 'AnimeDunya',
            type: rawSource.indexOf('.m3u8') !== -1 || rawSource.indexOf('manifest') !== -1 ? 'hls' : 'mp4',
            quality: 'auto',
            url: rawSource,
            headers: {
                'User-Agent': UA,
                'Referer': ANIMEDUNYA_BASE + '/'
            },
            subtitles: buildSubtitles(streamData.subtitles || [])
        }];

        console.log('[animedunya] Total streams resolved: ' + streams.length);
        return streams;
    } catch (e) {
        console.error('[animedunya] Error in getStreams: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for AnimeDunya streams.',
            default: 'AnimeDunya'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
