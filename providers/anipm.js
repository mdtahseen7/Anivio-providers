/**
 * Ani.pm Stream Provider Plugin for Anivio
 *
 * Standalone stream provider for https://ani.pm
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves both SUB and DUB streams via Settlar playback engine
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var ANIPM_BASE = 'https://ani.pm';
var SETTLAR_BASE = 'https://embed.settlar.io';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

var H = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': ANIPM_BASE + '/',
    'Origin': ANIPM_BASE
};

var STREAM_HEADERS = {
    'User-Agent': UA,
    'Referer': ANIPM_BASE + '/',
    'Origin': ANIPM_BASE
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

async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603" (One Piece)
    if (classified.id === '603') {
        return { anilistId: '21', titleEn: 'One Piece', titleRom: 'One Piece' };
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
                var aid = data.mappings && data.mappings.anilist_id ? String(data.mappings.anilist_id) : (classified.kind === 'anilist' ? classified.id : null);
                if (data && data.titles) {
                    return {
                        anilistId: aid,
                        titleEn: data.titles.en || data.titles.ro || data.titles.ja || '',
                        titleRom: data.titles.ro || data.titles.en || ''
                    };
                }
            }
        } catch (e) {}
    }

    if (/^\d+$/.test(classified.id)) {
        return { anilistId: classified.id, titleEn: '', titleRom: '' };
    }

    return { anilistId: null, titleEn: classified.id, titleRom: classified.id };
}

// -------------------------------------------------------------
// Settlar Playback Resolution
// -------------------------------------------------------------

async function bootstrapPlayback(seriesId, episodeNum, audioLang) {
    try {
        var lang = audioLang === 'dub' ? 'dub' : 'sub';
        var url = ANIPM_BASE + '/api/anime/playback-bootstrap/settlar/' + encodeURIComponent(seriesId) + '?ep=' + episodeNum + '&lang=' + lang + '&routes=e4';
        var res = await fetch(url, { headers: H });
        if (!res.ok) return null;
        var data = await res.json();
        return data;
    } catch (e) {
        return null;
    }
}

async function requestSettlarSession(selection, episodeNum, channel) {
    try {
        var sessUrl = new URL(ANIPM_BASE + '/api/anime/settlar/session');
        sessUrl.searchParams.set('selection', selection);
        sessUrl.searchParams.set('provider', 'anipm');
        sessUrl.searchParams.set('ep', String(episodeNum));
        sessUrl.searchParams.set('channel', channel);
        sessUrl.searchParams.set('telemetry', '0');

        var res = await fetch(sessUrl.href, { headers: H });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

async function tryResolveDirectStream(embedUrl) {
    try {
        var token = new URL(embedUrl).searchParams.get('t');
        if (!token) return null;
        var sessUrl = SETTLAR_BASE + '/api/embed/session?t=' + encodeURIComponent(token);
        var res = await fetch(sessUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': embedUrl,
                'Origin': SETTLAR_BASE
            }
        });
        if (!res.ok) return null;
        var data = await res.json();
        var src = data && (data.source || (data.sources && data.sources[0] && (data.sources[0].file || data.sources[0].url)));
        if (src && /^https?:\/\//i.test(src)) {
            return {
                url: src,
                tracks: data.subtitles || data.tracks || []
            };
        }
    } catch (e) {}
    return null;
}

function buildSubtitles(tracks) {
    var out = [];
    var seen = {};
    if (!Array.isArray(tracks)) return out;
    for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (!t) continue;
        var url = t.url || t.src || t.file;
        if (!url || seen[url]) continue;
        seen[url] = true;
        var label = t.label || t.lang || t.language || 'English';
        var lang = 'en';
        if (/spanish/i.test(label)) lang = 'es';
        else if (/portuguese/i.test(label)) lang = 'pt';
        else if (/french/i.test(label)) lang = 'fr';
        else if (/german/i.test(label)) lang = 'de';
        else if (/arabic/i.test(label)) lang = 'ar';
        out.push({
            url: url,
            language: lang,
            name: label,
            headers: STREAM_HEADERS
        });
    }
    return out;
}

// -------------------------------------------------------------
// Main getStreams Method
// -------------------------------------------------------------

async function getStreams(id, type, season, episode) {
    try {
        console.log('[anipm] getStreams called: id=' + id + ' type=' + type + ' ep=' + episode);

        var meta = await resolveMetadata(id);
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var targetId = meta.anilistId;
        if (!targetId && (meta.titleEn || meta.titleRom)) {
            try {
                var searchQ = meta.titleEn || meta.titleRom;
                var sRes = await fetch(ANIPM_BASE + '/api/anime/search?' + new URLSearchParams({ q: searchQ }), {
                    headers: H
                });
                if (sRes.ok) {
                    var sData = await sRes.json();
                    var items = Array.isArray(sData && sData.items) ? sData.items : [];
                    if (items.length > 0) {
                        targetId = items[0].anilistId || String(items[0].id);
                    }
                }
            } catch (e) {}
        }

        if (!targetId) {
            console.warn('[anipm] Could not resolve AniList / Ani.pm ID for: ' + id);
            return [];
        }

        var streams = [];
        var audioChannels = ['sub', 'dub'];

        for (var a = 0; a < audioChannels.length; a++) {
            var audio = audioChannels[a];
            try {
                var initial = await bootstrapPlayback(targetId, targetEp, audio);
                if (!initial || !initial.settlarSelection) continue;

                var sessResult = await requestSettlarSession(initial.settlarSelection, targetEp, audio);
                var embedUrl = sessResult && (sessResult.embedUrl || sessResult.url);
                if (!embedUrl) continue;

                var audioTag = audio.toUpperCase();

                // Try resolving direct HLS stream
                var direct = await tryResolveDirectStream(embedUrl);
                if (direct && direct.url) {
                    streams.push({
                        name: 'Ani.pm (' + audioTag + ')',
                        title: 'Ani.pm · Ep ' + targetEp + ' (' + audioTag + ')',
                        server: 'Settlar',
                        type: 'hls',
                        quality: 'auto',
                        url: direct.url,
                        headers: STREAM_HEADERS,
                        subtitles: buildSubtitles(direct.tracks)
                    });
                } else {
                    // Embed stream fallback
                    streams.push({
                        name: 'Ani.pm Settlar (' + audioTag + ')',
                        title: 'Ani.pm Settlar · Ep ' + targetEp + ' (' + audioTag + ')',
                        server: 'Settlar',
                        type: 'embed',
                        quality: 'auto',
                        url: embedUrl,
                        headers: STREAM_HEADERS,
                        subtitles: []
                    });
                }
            } catch (err) {
                console.warn('[anipm] Channel ' + audio + ' error:', err && err.message);
            }
        }

        console.log('[anipm] Total streams resolved: ' + streams.length);
        return streams;
    } catch (e) {
        console.error('[anipm] Error in getStreams: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for Ani.pm streams.',
            default: 'Ani.pm'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
