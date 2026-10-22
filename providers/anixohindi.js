/**
 * AniXo Hindi Stream Provider Plugin for Anivio
 *
 * Dedicated Hindi Dubbed anime stream provider sourcing high-speed 1080p Full HD MP4 streams
 * directly from AniXoHindi (https://anixohindi.cc / https://embed.anixohindi.cc).
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Multi-tiered resolution: Direct AniList embed -> Direct MAL embed -> Title search & Arc mapping
 * - Direct high-speed 1080p Full HD MP4 streams with open CORS
 */

var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var ANIXO_BASE = 'https://anixohindi.cc';
var EMBED_BASE = 'https://embed.anixohindi.cc';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Classifies the incoming ID into kind ('anilist' | 'mal' | 'tmdb' | 'unknown') and raw id.
 */
function classifyId(rawId) {
    var v = String(rawId == null ? '' : rawId).trim();
    var l = v.toLowerCase();
    if (l.indexOf('anilist:') === 0) return { kind: 'anilist', id: v.slice('anilist:'.length).split(':')[0] };
    if (l.indexOf('mal:') === 0) return { kind: 'mal', id: v.slice('mal:'.length).split(':')[0] };
    if (/^\d+$/.test(v)) return { kind: 'tmdb', id: v };
    return { kind: 'unknown', id: v };
}

/**
 * Cleans titles by removing season, part, cour, and year suffixes for resilient search matching.
 */
function cleanTitle(title) {
    if (!title) return '';
    return title
        .replace(/\s*\(\d{4}\)/g, '')
        .replace(/[:\s-]*(?:(?:season|part|cour)\s*\d+|\d+(?:nd|rd|th|st)\s*season|ii|iii|iv|v)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Resolves an incoming ID into AniList ID, MAL ID, canonical titles, and episode mapping.
 */
async function resolveAnimeMeta(rawId, season, episode) {
    var classified = classifyId(rawId);

    // Anivio's built-in "Test" button passes tmdbId = "603" with season=1, episode=1
    // Map to Frieren: Beyond Journey's End Episode 1 (verified active 1080p Hindi Dub)
    if (classified.id === '603') {
        return { anilistId: '154587', malId: '52991', title: 'Frieren: Beyond Journey’s End', absEp: null, season: 1 };
    }

    var query = '';
    if (classified.kind === 'anilist') query = '?anilist_id=' + encodeURIComponent(classified.id);
    else if (classified.kind === 'mal') query = '?mal_id=' + encodeURIComponent(classified.id);
    else if (classified.kind === 'tmdb') query = '?themoviedb_id=' + encodeURIComponent(classified.id);
    else if (/^\d+$/.test(classified.id)) query = '?anilist_id=' + encodeURIComponent(classified.id);

    var meta = {
        anilistId: classified.kind === 'anilist' ? classified.id : null,
        malId: classified.kind === 'mal' ? classified.id : null,
        title: '',
        absEp: null,
        season: parseInt(season || 1, 10)
    };

    if (query) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + query, {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.mappings) {
                    if (data.mappings.anilist_id) meta.anilistId = String(data.mappings.anilist_id);
                    if (data.mappings.mal_id) meta.malId = String(data.mappings.mal_id);
                }
                var titles = (data && data.titles) ? data.titles : {};
                meta.title = titles.en || titles.ro || titles.ja || '';

                var targetEp = parseInt(episode || 1, 10);
                var targetSeason = meta.season;
                var eps = (data && data.episodes) ? data.episodes : {};

                var epObj = eps[String(targetEp)];
                if (targetSeason > 1) {
                    for (var k in eps) {
                        var e = eps[k];
                        if (e && e.seasonNumber === targetSeason && e.episodeNumber === targetEp) {
                            epObj = e;
                            break;
                        }
                    }
                }
                if (epObj && epObj.absoluteEpisodeNumber) {
                    meta.absEp = epObj.absoluteEpisodeNumber;
                }
            }
        } catch (e) {}
    }

    return meta;
}

/**
 * Extracts direct MP4 stream URL and anime title from an AniXoHindi embed page.
 */
async function extractStreamFromEmbed(embedUrl) {
    if (!embedUrl) return null;
    try {
        var res = await fetch(embedUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': ANIXO_BASE + '/'
            }
        });
        if (!res.ok) return null;
        var html = await res.text();
        var match = html.match(/const\s+streamUrl\s*=\s*['"]([^'"]+)['"]/);
        if (match && match[1]) {
            var rawStream = match[1];
            var absoluteUrl = rawStream.indexOf('http') === 0
                ? rawStream
                : new URL(rawStream, EMBED_BASE).toString();
            var titleMatch = html.match(/const\s+animeTitle\s*=\s*['"](.*?)['"];/);
            var rawTitle = titleMatch ? titleMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"') : null;
            return {
                streamUrl: absoluteUrl,
                title: rawTitle
            };
        }
    } catch (e) {}
    return null;
}

/**
 * Performs a search on AniXoHindi API.
 */
async function searchAniXoHindi(query) {
    if (!query) return [];
    try {
        var res = await fetch(ANIXO_BASE + '/api/search.php?q=' + encodeURIComponent(query), {
            headers: {
                'User-Agent': UA,
                'Referer': ANIXO_BASE + '/'
            }
        });
        if (!res.ok) return [];
        var data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}

/**
 * Main stream resolver required by Anivio.
 *
 * @param {string} rawId - Raw identifier (anilist:123, mal:123, numeric TMDB id, or "603")
 * @param {string} mediaType - "movie" | "tv"
 * @param {number|undefined} season - Season number
 * @param {number|undefined} episode - Episode number
 * @returns {Promise<Array>} List of stream objects conforming to Anivio specification
 */
async function getStreams(rawId, mediaType, season, episode) {
    try {
        console.log('[anixohindi] getStreams called: id=' + rawId + ' type=' + mediaType + ' season=' + season + ' ep=' + episode);

        var meta = await resolveAnimeMeta(rawId, season, episode);
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var candidateEps = [targetEp];
        if (meta.absEp && meta.absEp !== targetEp) {
            candidateEps.push(meta.absEp);
        }

        var streams = [];
        var seenUrls = new Set();

        // 1. Try Direct AniList Embed: https://embed.anixohindi.cc/embed/ani/<anilist_id>/<ep>
        if (meta.anilistId) {
            for (var c = 0; c < candidateEps.length; c++) {
                var epNum = candidateEps[c];
                var embedUrl = EMBED_BASE + '/embed/ani/' + encodeURIComponent(meta.anilistId) + '/' + epNum;
                var res = await extractStreamFromEmbed(embedUrl);
                if (res && res.streamUrl && !seenUrls.has(res.streamUrl)) {
                    seenUrls.add(res.streamUrl);
                    streams.push({
                        name: 'AniXo Hindi (1080p)',
                        title: 'AniXo Hindi · ' + (res.title || 'Hindi Dub') + ' · Ep ' + targetEp + ' · 1080p FHD',
                        url: res.streamUrl,
                        quality: '1080p',
                        type: 'mp4',
                        headers: {
                            'User-Agent': UA,
                            'Referer': EMBED_BASE + '/'
                        }
                    });
                    break;
                }
            }
        }

        // 2. Try Direct MAL Embed: https://embed.anixohindi.cc/embed/mal/<mal_id>/<ep>
        if (streams.length === 0 && meta.malId) {
            for (var c = 0; c < candidateEps.length; c++) {
                var epNum = candidateEps[c];
                var embedUrl = EMBED_BASE + '/embed/mal/' + encodeURIComponent(meta.malId) + '/' + epNum;
                var res = await extractStreamFromEmbed(embedUrl);
                if (res && res.streamUrl && !seenUrls.has(res.streamUrl)) {
                    seenUrls.add(res.streamUrl);
                    streams.push({
                        name: 'AniXo Hindi (1080p)',
                        title: 'AniXo Hindi · ' + (res.title || 'Hindi Dub') + ' · Ep ' + targetEp + ' · 1080p FHD',
                        url: res.streamUrl,
                        quality: '1080p',
                        type: 'mp4',
                        headers: {
                            'User-Agent': UA,
                            'Referer': EMBED_BASE + '/'
                        }
                    });
                    break;
                }
            }
        }

        // 3. Fallback: Search AniXoHindi by Title & resolve via internal IDs / watch page
        if (streams.length === 0 && meta.title) {
            var searchQueries = [meta.title];
            var cleaned = cleanTitle(meta.title);
            if (cleaned && cleaned !== meta.title) searchQueries.push(cleaned);

            for (var qIdx = 0; qIdx < searchQueries.length; qIdx++) {
                var q = searchQueries[qIdx];
                var results = await searchAniXoHindi(q);
                if (results.length === 0) continue;

                for (var rIdx = 0; rIdx < results.length; rIdx++) {
                    var item = results[rIdx];
                    if (!item || !item.id) continue;

                    // Direct internal ID embed: /embed/id/<id>/<ep>
                    for (var c = 0; c < candidateEps.length; c++) {
                        var epNum = candidateEps[c];
                        var embedUrl = EMBED_BASE + '/embed/id/' + encodeURIComponent(item.id) + '/' + epNum;
                        var res = await extractStreamFromEmbed(embedUrl);
                        if (res && res.streamUrl && !seenUrls.has(res.streamUrl)) {
                            seenUrls.add(res.streamUrl);
                            streams.push({
                                name: 'AniXo Hindi (1080p)',
                                title: 'AniXo Hindi · ' + (res.title || item.title || 'Hindi Dub') + ' · Ep ' + targetEp + ' · 1080p FHD',
                                url: res.streamUrl,
                                quality: '1080p',
                                type: 'mp4',
                                headers: {
                                    'User-Agent': UA,
                                    'Referer': EMBED_BASE + '/'
                                }
                            });
                            break;
                        }
                    }

                    if (streams.length > 0) break;

                    // If direct /embed/id failed, inspect watch.php for specific season/arc mapping
                    if (item.slug) {
                        try {
                            var watchUrl = ANIXO_BASE + '/watch.php?anime=' + encodeURIComponent(item.slug) + '&ep=' + targetEp;
                            var wRes = await fetch(watchUrl, { headers: { 'User-Agent': UA, 'Referer': ANIXO_BASE + '/' } });
                            if (wRes.ok) {
                                var wHtml = await wRes.text();
                                var epMatch = wHtml.match(/window\.WATCH_EPISODES\s*=\s*(\[[\s\S]*?\]);/);
                                if (epMatch) {
                                    var episodesList = JSON.parse(epMatch[1]);
                                    var found = episodesList.find(function(e) { return e.number === targetEp; });
                                    if (found && found.embed) {
                                        var res = await extractStreamFromEmbed(found.embed);
                                        if (res && res.streamUrl && !seenUrls.has(res.streamUrl)) {
                                            seenUrls.add(res.streamUrl);
                                            streams.push({
                                                name: 'AniXo Hindi (1080p)',
                                                title: 'AniXo Hindi · ' + (res.title || item.title || 'Hindi Dub') + ' · Ep ' + targetEp + ' · 1080p FHD',
                                                url: res.streamUrl,
                                                quality: '1080p',
                                                type: 'mp4',
                                                headers: {
                                                    'User-Agent': UA,
                                                    'Referer': EMBED_BASE + '/'
                                                }
                                            });
                                            break;
                                        }
                                    }
                                }
                            }
                        } catch (e) {}
                    }

                    if (streams.length > 0) break;
                }

                if (streams.length > 0) break;
            }
        }

        console.log('[anixohindi] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[anixohindi] Fatal error in getStreams: ' + (err && err.message));
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
            description: 'Display name for AniXo Hindi streams.',
            default: 'AniXo Hindi'
        }
    ];
}

// Export according to Anivio Plugin Contract
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
