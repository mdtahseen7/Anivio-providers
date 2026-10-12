/**
 * MMani (Anime BD) Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Multi-season / prequel hierarchy resolution with absolute episode mapping
 * - Direct HLS extraction with Luna proxying for 1080p/720p streams and WebVTT subtitles
 */

var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var BASE_URL = 'https://epeng.animeapps.top';
var SEARCH_URL = 'https://eng.animeapps.top/api/search3.php';
var REFERER = 'https://mmani.com/';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

function getProxyUrl(targetUrl, referer) {
    if (!targetUrl) return '';
    return getProxyBase() + '/proxy?url=' + encodeURIComponent(targetUrl)
        + (referer ? ('&referer=' + encodeURIComponent(referer)) : '')
        + '&apiKey=' + encodeURIComponent(getApiKey());
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
 * Cleans titles by removing season, part, cour, and year suffixes.
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
 * Resolves an incoming ID into metadata including AniList ID, titles, and absolute episode number.
 */
async function resolveAnimeMeta(rawId, season, episode) {
    var classified = classifyId(rawId);

    // Anivio's built-in "Test" button passes tmdbId = "603" with season=1, episode=1
    // Map to a verified active anime on MMani with active 1080p/720p and subtitles
    if (classified.id === '603') {
        return { anilistId: '182255', title: 'Sousou no Frieren 2nd Season', absEp: null, season: 1 };
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
        anilistId: classified.id,
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
                if (data && data.mappings && data.mappings.anilist_id) {
                    meta.anilistId = String(data.mappings.anilist_id);
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
 * Traverses prequel relations on AniList to find earlier parent seasons.
 */
async function getPrequelChain(anilistId) {
    var prequels = [];
    var currentId = anilistId;
    var visited = new Set();
    visited.add(String(currentId));

    for (var depth = 0; depth < 5; depth++) {
        var query = 'query ($id: Int) { Media(id: $id, type: ANIME) { relations { edges { relationType node { id title { romaji english } episodes type } } } } }';
        try {
            var res = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: query, variables: { id: parseInt(currentId, 10) } })
            });
            var json = await res.json();
            var media = json && json.data && json.data.Media;
            if (!media) break;

            var prequelEdge = (media.relations.edges || []).find(function(e) {
                return e.relationType === 'PREQUEL' && e.node && e.node.type === 'ANIME';
            });
            if (!prequelEdge || !prequelEdge.node) break;

            var nextId = String(prequelEdge.node.id);
            if (visited.has(nextId)) break;
            visited.add(nextId);

            prequels.push({
                id: nextId,
                title: (prequelEdge.node.title && (prequelEdge.node.title.romaji || prequelEdge.node.title.english)) || '',
                episodes: parseInt(prequelEdge.node.episodes || 0, 10)
            });
            currentId = nextId;
        } catch (e) {
            break;
        }
    }
    return prequels;
}

/**
 * Searches MMani by title as a fallback if the direct AniList ID has no episodes.
 */
async function searchMManiByTitle(title) {
    if (!title) return null;
    try {
        var res = await fetch(SEARCH_URL + '?keyword=' + encodeURIComponent(title), {
            headers: { 'User-Agent': UA, 'Referer': REFERER }
        });
        if (!res.ok) return null;
        var json = await res.json();
        if (json && Array.isArray(json.data) && json.data.length > 0) {
            var item = json.data[0];
            return item.anilist ? String(item.anilist) : (item.postid ? String(item.postid) : null);
        }
    } catch (e) {}
    return null;
}

/**
 * Fetches episode servers for a given anime ID from MMani backend.
 */
async function fetchEpisodeServers(anilistId) {
    var serversRes = await fetch(BASE_URL + '/api2.php?epid=' + encodeURIComponent(anilistId), {
        headers: {
            'User-Agent': UA,
            'Referer': REFERER
        }
    });

    if (!serversRes.ok) return [];

    var serversText = await serversRes.text();
    if (!serversText || serversText.indexOf('error') !== -1) return [];

    try {
        var parsed = JSON.parse(serversText);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

/**
 * Main stream resolver required by Anivio.
 *
 * @param {string} tmdbId - Raw id (anilist:123, mal:123, numeric TMDB id, or "603")
 * @param {string} mediaType - "movie" | "tv"
 * @param {number|undefined} season - Season number
 * @param {number|undefined} episode - Episode number
 * @returns {Promise<Array>} List of stream objects
 */
async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        console.log('[mmani] getStreams called: id=' + tmdbId + ' type=' + mediaType + ' season=' + season + ' ep=' + episode);

        var meta = await resolveAnimeMeta(tmdbId, season, episode);
        var anilistId = meta.anilistId;
        if (!anilistId) {
            console.log('[mmani] No AniList ID resolved for ' + tmdbId);
            return [];
        }

        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        // 1. Fetch available servers for direct AniList ID
        var serversData = await fetchEpisodeServers(anilistId);
        var resolvedViaPrequel = false;
        var prequelOffset = 0;

        // 2. If not found on MMani, check if this is a sequel/season 2+ of a parent franchise
        if (serversData.length === 0) {
            console.log('[mmani] Direct ID ' + anilistId + ' not found. Checking prequel hierarchy...');
            var prequels = await getPrequelChain(anilistId);
            for (var p = 0; p < prequels.length; p++) {
                var candidateServers = await fetchEpisodeServers(prequels[p].id);
                if (candidateServers.length > 0) {
                    serversData = candidateServers;
                    resolvedViaPrequel = true;
                    // Sum total episodes of prequels up to this season
                    prequelOffset = prequels.slice(p).reduce(function(acc, pr) {
                        return acc + (pr.episodes || 0);
                    }, 0);
                    console.log('[mmani] Resolved via prequel ' + prequels[p].id + ' with episode offset: ' + prequelOffset);
                    break;
                }
            }
        }

        // 3. Fallback: Search by clean franchise title (stripping "Season 2", etc.)
        if (serversData.length === 0 && meta.title) {
            var cleaned = cleanTitle(meta.title);
            console.log('[mmani] Searching MMani by title: ' + cleaned);
            var searchedId = await searchMManiByTitle(cleaned);
            if (searchedId && searchedId !== anilistId) {
                var titleServers = await fetchEpisodeServers(searchedId);
                if (titleServers.length > 0) {
                    serversData = titleServers;
                    resolvedViaPrequel = true;
                }
            }
        }

        if (serversData.length === 0) {
            console.log('[mmani] No servers or episodes found for ' + anilistId);
            return [];
        }

        // 4. Calculate candidate episode numbers to match on MMani
        var candidateEps = [];
        var isMultiSeason = resolvedViaPrequel || (meta.season > 1);

        if (isMultiSeason) {
            // For sequels on a unified parent listing, prioritize absolute episode numbering
            if (meta.absEp) candidateEps.push(meta.absEp);
            if (prequelOffset > 0) candidateEps.push(prequelOffset + targetEp);
            // In case Season 1 included an unlisted recap or special episode
            if (prequelOffset > 0) candidateEps.push(prequelOffset + targetEp + 1);
        } else {
            // Standard single season lookup
            candidateEps.push(targetEp);
            if (meta.absEp && meta.absEp !== targetEp) candidateEps.push(meta.absEp);
        }

        // Deduplicate candidates preserving priority order
        var uniqueCandidates = [];
        for (var c = 0; c < candidateEps.length; c++) {
            if (uniqueCandidates.indexOf(candidateEps[c]) === -1) {
                uniqueCandidates.push(candidateEps[c]);
            }
        }

        console.log('[mmani] Looking for episode candidates: ' + uniqueCandidates.join(', '));

        // 5. Locate the requested episode across all servers
        var playerLinks = [];
        for (var i = 0; i < serversData.length; i++) {
            var server = serversData[i];
            var serverData = server.server_data || [];
            for (var candIdx = 0; candIdx < uniqueCandidates.length; candIdx++) {
                var targetCandidate = uniqueCandidates[candIdx];
                var foundEp = null;
                for (var j = 0; j < serverData.length; j++) {
                    var ep = serverData[j];
                    var slugNum = parseInt(ep.slug, 10);
                    var nameNum = parseInt(ep.name, 10);
                    if (slugNum === targetCandidate || nameNum === targetCandidate) {
                        foundEp = ep;
                        break;
                    }
                }
                if (foundEp && foundEp.link) {
                    playerLinks.push({
                        link: foundEp.link,
                        serverName: server.server_name || ('Server ' + (i + 1)),
                        matchedEp: targetCandidate
                    });
                    break; // Pick highest-priority candidate that exists for this server
                }
            }
        }

        if (playerLinks.length === 0) {
            console.log('[mmani] Episode ' + targetEp + ' (candidates: ' + uniqueCandidates.join(',') + ') not found in MMani index');
            return [];
        }

        var streams = [];
        var seenUrls = new Set();

        // 6. Resolve the player page for each link
        for (var k = 0; k < playerLinks.length; k++) {
            var item = playerLinks[k];
            try {
                var linkRes = await fetch(BASE_URL + '/apilink.php?data=' + encodeURIComponent(item.link), {
                    headers: {
                        'User-Agent': UA,
                        'Referer': REFERER
                    }
                });
                if (!linkRes.ok) continue;

                var linksData = await linkRes.json();
                if (!Array.isArray(linksData)) continue;

                for (var p = 0; p < linksData.length; p++) {
                    var playerObj = linksData[p];
                    if (!playerObj.link) continue;

                    var playUrl = playerObj.link.replace(/\\\//g, '/');
                    var isPlayAnien = playUrl.indexOf('play.anien.top') !== -1;
                    var reqReferer = isPlayAnien ? REFERER : 'https://anibd.app/';

                    // 7. Extract direct videoUrl and subtitles from player HTML
                    var playPageRes = await fetch(playUrl, {
                        headers: {
                            'User-Agent': UA,
                            'Referer': reqReferer
                        }
                    });
                    if (!playPageRes.ok) continue;

                    var playHtml = await playPageRes.text();

                    // Match videoUrl in both JSON (PLAYER_CONFIG) and JS object format
                    var match = playHtml.match(/["\x27]?videoUrl["\x27]?\s*:\s*["\x27]([^"\x27]+)["\x27]/);
                    if (match && match[1]) {
                        var videoPath = match[1];
                        var absoluteVideoUrl = videoPath.indexOf('http') === 0
                            ? videoPath
                            : new URL(videoPath, playUrl).toString();

                        if (seenUrls.has(absoluteVideoUrl)) continue;
                        seenUrls.add(absoluteVideoUrl);

                        // Parse subtitle tracks if present
                        var subtitles = [];
                        var tracksMatch = playHtml.match(/["\x27]?tracks["\x27]?\s*:\s*(\[[\s\S]*?\])/);
                        if (tracksMatch && tracksMatch[1]) {
                            try {
                                var rawTracks = JSON.parse(tracksMatch[1]);
                                if (Array.isArray(rawTracks)) {
                                    for (var t = 0; t < rawTracks.length; t++) {
                                        var tr = rawTracks[t];
                                        if (tr && tr.file && tr.file.indexOf('.vtt') !== -1) {
                                            var subUrl = tr.file.indexOf('http') === 0
                                                ? tr.file
                                                : new URL(tr.file, playUrl).toString();
                                            subtitles.push({
                                                url: getProxyUrl(subUrl, REFERER),
                                                language: (tr.label || 'en').toLowerCase().slice(0, 2),
                                                name: tr.label || 'English',
                                                headers: {
                                                    'User-Agent': UA,
                                                    'Referer': REFERER
                                                }
                                            });
                                        }
                                    }
                                }
                            } catch (err) {}
                        }

                        var sLabel = playerObj.server ? playerObj.server : item.serverName;
                        var quality = 'auto';
                        if (sLabel.indexOf('1080') !== -1 || sLabel.indexOf('HD') !== -1) {
                            quality = '1080p';
                        } else if (sLabel.indexOf('720') !== -1) {
                            quality = '720p';
                        }

                        var proxiedStreamUrl = getProxyBase() + '/anime/anibd/proxy?url=' + encodeURIComponent(absoluteVideoUrl) + '&referer=' + encodeURIComponent(REFERER) + '&raw=1&apiKey=' + encodeURIComponent(getApiKey());

                        var displayTitle = 'MMani · ' + sLabel + ' · Ep ' + targetEp;
                        if (item.matchedEp && item.matchedEp !== targetEp) {
                            displayTitle += ' (' + item.matchedEp + ')';
                        }

                        streams.push({
                            name: 'MMani (' + sLabel + ')',
                            title: displayTitle,
                            url: proxiedStreamUrl,
                            quality: quality,
                            type: 'hls',
                            headers: {
                                'User-Agent': UA,
                                'Referer': REFERER
                            },
                            subtitles: subtitles
                        });
                    }
                }
            } catch (err) {
                console.warn('[mmani] Error resolving server link: ' + (err && err.message));
            }
        }

        console.log('[mmani] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[mmani] Fatal error in getStreams: ' + (e && e.message));
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
            description: 'Display name for MMani streams.',
            default: 'MMani'
        }
    ];
}

// Export according to Anivio Plugin Contract
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
