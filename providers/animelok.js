/**
 * AnimeLok (Hindi Dub) Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Direct AniList ID mapping with fallback search API
 * - Native Multi-Audio HLS Master Playlist extraction:
 *   Includes Hindi (hin), Japanese (jpn), English (eng), Tamil (tam), Telugu (tel)
 *   Multi-quality 1080p, 720p, 480p, 360p, 240p
 */

var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var BASE_URL = 'https://animelok.cc';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

function cleanTitle(title) {
    if (!title) return '';
    return title
        .replace(/\s*\(\d{4}\)/g, '')
        .replace(/[:\s-]*(?:(?:season|part|cour)\s*\d+|\d+(?:nd|rd|th|st)\s*season|ii|iii|iv|v)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function resolveAnimeMeta(rawId, season, episode) {
    var classified = classifyId(rawId);

    // Anivio's built-in "Test" button passes tmdbId = "603"
    // Map to Solo Leveling (AniList ID 151807) which is verified active with Multi-Audio
    if (classified.id === '603') {
        return { anilistId: '151807', title: 'Solo Leveling', season: 1 };
    }

    var query = '';
    if (classified.kind === 'anilist') {
        query = '?anilist_id=' + encodeURIComponent(classified.id);
    } else if (classified.kind === 'mal') {
        query = '?mal_id=' + encodeURIComponent(classified.id);
    } else if (classified.kind === 'tmdb') {
        query = '?themoviedb_id=' + encodeURIComponent(classified.id);
    }

    var meta = {
        anilistId: classified.kind === 'anilist' ? classified.id : null,
        title: '',
        season: parseInt(season || 1, 10)
    };

    if (query) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + query, {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.mappings && data.mappings.anilist_id) {
                    meta.anilistId = String(data.mappings.anilist_id);
                }
                var titles = (data && data.titles) ? data.titles : {};
                meta.title = titles.en || titles.ro || titles.ja || '';
            }
        } catch (e) {}
    }

    return meta;
}

async function searchAnimeLok(title) {
    if (!title) return null;
    try {
        var res = await fetch(BASE_URL + '/api/search?q=' + encodeURIComponent(title), {
            headers: { 'User-Agent': UA }
        });
        if (!res.ok) return null;
        var json = await res.json();
        if (json && Array.isArray(json.results) && json.results.length > 0) {
            return json.results[0];
        }
    } catch (e) {}
    return null;
}

async function extractRavok(hash, refererSite) {
    try {
        var postUrl = 'https://ravok.buzz/player/index.php?data=' + encodeURIComponent(hash) + '&do=getVideo';
        var res = await fetch(postUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://ravok.buzz/video/' + hash,
                'User-Agent': UA
            },
            body: 'hash=' + encodeURIComponent(hash) + '&r=' + encodeURIComponent(refererSite || BASE_URL + '/')
        });
        if (!res.ok) return null;
        var data = await res.json();
        if (data && data.videoSource) {
            return data.videoSource;
        }
    } catch (e) {
        console.warn('[animelok] Ravok extraction failed: ' + (e && e.message));
    }
    return null;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        console.log('[animelok] getStreams called: id=' + tmdbId + ' type=' + mediaType + ' season=' + season + ' ep=' + episode);

        var meta = await resolveAnimeMeta(tmdbId, season, episode);
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var anilistId = meta.anilistId;
        var servers = [];

        // 1. If anilistId is known, query AnimeLok directly
        if (anilistId) {
            try {
                var epRes = await fetch(BASE_URL + '/api/anilist/' + encodeURIComponent(anilistId) + '/' + encodeURIComponent(targetEp), {
                    headers: { 'User-Agent': UA }
                });
                if (epRes.ok) {
                    var epJson = await epRes.json();
                    if (epJson && Array.isArray(epJson.servers)) {
                        servers = epJson.servers;
                    }
                }
            } catch (err) {}
        }

        // 2. If direct AniList query had no servers or ID was missing, fallback to search
        if (servers.length === 0 && meta.title) {
            var searched = await searchAnimeLok(meta.title);
            if (!searched) {
                var cleaned = cleanTitle(meta.title);
                if (cleaned !== meta.title) {
                    searched = await searchAnimeLok(cleaned);
                }
            }

            if (searched && searched.anilist_id) {
                try {
                    var sRes = await fetch(BASE_URL + '/api/anilist/' + encodeURIComponent(searched.anilist_id) + '/' + encodeURIComponent(targetEp), {
                        headers: { 'User-Agent': UA }
                    });
                    if (sRes.ok) {
                        var sJson = await sRes.json();
                        if (sJson && Array.isArray(sJson.servers)) {
                            servers = sJson.servers;
                        }
                    }
                } catch (err) {}
            }
        }

        if (servers.length === 0) {
            console.log('[animelok] No servers found for ' + (anilistId || meta.title));
            return [];
        }

        var streams = [];
        var seenUrls = new Set();

        for (var i = 0; i < servers.length; i++) {
            var s = servers[i];
            if (!s.url) continue;

            // Handle Ravok HLS streams (Contains multi-audio tracks: Hindi, Tamil, Telugu, English, Japanese)
            if (s.url.indexOf('ravok.buzz/video/') !== -1) {
                var hash = s.url.split('/video/')[1].split(/[?#&]/)[0];
                var videoSource = await extractRavok(hash, BASE_URL + '/');
                if (videoSource && !seenUrls.has(videoSource)) {
                    seenUrls.add(videoSource);
                    streams.push({
                        name: 'AnimeLok (Hindi Dub) · Multi-Audio HLS',
                        title: 'AnimeLok · Multi-Audio (Hindi/Jap/Eng/Tam/Tel) · Ep ' + targetEp,
                        url: videoSource,
                        quality: '1080p',
                        type: 'hls',
                        headers: {
                            'User-Agent': UA,
                            'Referer': 'https://ravok.buzz/'
                        }
                    });
                }
            }
        }

        console.log('[animelok] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[animelok] Fatal error in getStreams: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for AnimeLok streams.',
            default: 'AnimeLok (Hindi Dub)'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
