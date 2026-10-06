/**
 * MeguAnime Stream Provider Plugin for Anivio
 *
 * MeguAnime uses a unified API resolver (/api/miruro) that natively queries AniList IDs
 * and proxies multiple upstream sources (Kiwi/AnimePahe, Bee/HiAnime, Hop/Aniwaves)
 * through its own CDN edge endpoints.
 */

var BASE = 'https://meguanime.com';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function classifyId(rawId) {
    var value = String(rawId == null ? '' : rawId).trim();
    var lower = value.toLowerCase();
    if (lower.indexOf('anilist:') === 0) return { kind: 'anilist', id: value.slice(8).split(':')[0] };
    if (lower.indexOf('mal:') === 0) return { kind: 'mal', id: value.slice(4).split(':')[0] };
    if (/^\d+$/.test(value)) return { kind: 'tmdb', id: value };
    return { kind: 'unknown', id: value };
}

// Convert MAL/TMDB to AniList using AniZip
async function getAnilistId(meta) {
    if (meta.kind === 'anilist') return meta.id;
    if (meta.kind === 'unknown') return null; // We need a database ID for MeguAnime

    // Try AniZip
    var query = '';
    if (meta.kind === 'mal') query = 'mal_id=' + encodeURIComponent(meta.id);
    else if (meta.kind === 'tmdb') query = 'themoviedb_id=' + encodeURIComponent(meta.id);
    
    try {
        var res = await fetch('https://api.ani.zip/mappings?' + query, { headers: { 'Accept': 'application/json', 'User-Agent': UA } });
        if (res.ok) {
            var d = await res.json();
            if (d.mappings && d.mappings.anilist_id) {
                return String(d.mappings.anilist_id);
            }
        }
    } catch (e) {}
    
    return null;
}

async function getStreams(rawId, mediaType, season, episode) {
    try {
        var c = classifyId(rawId);
        var anilistId = await getAnilistId(c);
        if (!anilistId) {
            console.warn('[meguanime] Could not resolve AniList ID for ' + rawId);
            return [];
        }

        var n = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(n) || n < 1) n = 1;

        var streams = [];
        var headers = { 'User-Agent': UA, 'Referer': BASE + '/' };
        var langs = ['sub', 'dub'];

        for (var i = 0; i < langs.length; i++) {
            var lang = langs[i];
            try {
                // all=1 requests all available upstream provider links
                var res = await fetch(BASE + '/api/miruro?al=' + anilistId + '&ep=' + n + '&lang=' + lang + '&all=1', { headers: headers });
                if (!res.ok) continue;
                
                var data = await res.json();
                
                // MeguAnime might return an array of providers, or a single source object
                var providers = data.providers || (data.sources ? data.sources : []);
                if (!providers.length && data.source) {
                    // Fallback if it just returned a single source object
                    providers = [{ id: 'default', label: 'Default', source: data.source, tracks: data.tracks, intro: data.intro, outro: data.outro }];
                }

                for (var j = 0; j < providers.length; j++) {
                    var p = providers[j];
                    if (!p.source) continue;

                    var subtitles = [];
                    var tracks = p.tracks || data.tracks || [];
                    for (var k = 0; k < tracks.length; k++) {
                        var t = tracks[k];
                        if (t.kind === 'subtitles' || t.label) {
                            subtitles.push({
                                url: t.file,
                                language: t.label || 'en',
                                name: t.label || 'English'
                            });
                        }
                    }

                    streams.push({
                        name: 'MeguAnime (' + lang.toUpperCase() + ') - ' + (p.label || p.name || 'Auto'),
                        title: 'MeguAnime · ' + (p.label || p.name || 'Auto') + ' · ' + lang.toUpperCase() + ' · Ep ' + n,
                        url: p.source,
                        quality: '1080p',
                        type: 'hls',
                        headers: { 'User-Agent': UA, 'Referer': BASE + '/' },
                        subtitles: subtitles,
                        intro: p.intro || data.intro || null,
                        outro: p.outro || data.outro || null
                    });
                }
            } catch (e) {
                console.warn('[meguanime] ' + lang + ' fetch failed:', e.message);
            }
        }

        return streams;
    } catch (e) {
        console.warn('[meguanime] failed: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [{ key: 'label', type: 'text', title: 'Provider Name', description: 'Display name for MeguAnime streams.', default: 'MeguAnime' }];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
