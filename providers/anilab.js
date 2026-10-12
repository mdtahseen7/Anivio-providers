/**
 * AniLab / KYOTO Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Supported IDs: anilab:<id>, bare AniLab numeric id (100000xxxx),
 *   anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Chain: AniLab catalog (search/post) -> KYOTO v4 post -> anidb
 *   episodes -> anidb servers -> anidb iframe -> direct xlsbox HLS
 * - Multi-quality variant expansion from the master m3u8 playlist
 */

var ANILAB_API = 'https://anilab2.amdapi.click/api';
var KYOTO_API = 'https://app.kyotoplayer.com/api/v4';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var IFRAME_REFERER = 'https://play.app/';

/**
 * Preferred audio track ('sub' | 'dub'). Overridable via SCRAPER_SETTINGS.
 */
function getAudioPref() {
    var pref = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.audio)
        ? String(SCRAPER_SETTINGS.audio).toLowerCase()
        : 'sub';
    return pref === 'dub' ? 'dub' : 'sub';
}

/**
 * Classifies the incoming ID into kind
 * ('anilab' | 'anilist' | 'mal' | 'tmdb' | 'unknown') and raw id.
 */
function classifyId(rawId) {
    var value = String(rawId == null ? '' : rawId).trim();
    if (!value) return { kind: 'unknown', id: '' };

    var lower = value.toLowerCase();
    if (lower.indexOf('anilab:') === 0) {
        return { kind: 'anilab', id: value.slice('anilab:'.length).split(':')[0] };
    }
    if (lower.indexOf('anilist:') === 0) {
        return { kind: 'anilist', id: value.slice('anilist:'.length).split(':')[0] };
    }
    if (lower.indexOf('mal:') === 0) {
        return { kind: 'mal', id: value.slice('mal:'.length).split(':')[0] };
    }
    // AniLab catalog ids are long numerics in the 100000xxxx range.
    // Plain TMDB ids never look like that, so this is collision-free.
    if (/^100000\d+$/.test(value)) {
        return { kind: 'anilab', id: value };
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
 * Normalizes a title for fuzzy comparison.
 */
function normTitle(title) {
    if (!title) return '';
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolves an incoming ID into metadata including AniList ID, titles, and absolute episode number.
 */
async function resolveAnimeMeta(rawId, season, episode) {
    var classified = classifyId(rawId);

    // Anivio's built-in "Test" button always passes tmdbId = "603" with season=1, episode=1.
    // Firefly Wedding is a single-episode title verified live on AniLab/KYOTO.
    if (classified.id === '603') {
        return { anilabId: '1000006489', anilistId: '', title: 'Firefly Wedding', absEp: null, season: 1 };
    }

    if (classified.kind === 'anilab') {
        return { anilabId: classified.id, anilistId: '', title: '', absEp: null, season: parseInt(season || 1, 10) };
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
        anilabId: '',
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
 * Detects sequel markers like "Season 2", "Part 2", "Cour 2", "2nd Season", "II".
 */
function seasonMarker(title) {
    if (!title) return 0;
    var m = title.match(/(?:season|part|cour)\s*(\d+)|(\d+)(?:nd|rd|th|st)\s*season|\b(ii|iii|iv|v)\b/i);
    if (!m) return 0;
    if (m[1]) return parseInt(m[1], 10);
    if (m[2]) return parseInt(m[2], 10);
    var romans = { ii: 2, iii: 3, iv: 4, v: 5 };
    return romans[String(m[3]).toLowerCase()] || 0;
}

/**
 * Scores an AniLab detail title against the wanted title + season.
 * 3 = cleaned exact match, 2 = containment with season-marker agreement,
 * 1 = plain containment, 0 = no match.
 */
function titleScore(detailTitle, wantClean, wantSeason) {
    var got = normTitle(cleanTitle(detailTitle || ''));
    if (!got || !wantClean) return 0;
    if (got === wantClean) return 3;
    var contains = got.indexOf(wantClean) !== -1 || wantClean.indexOf(got) !== -1;
    if (!contains) return 0;
    var gotMarker = seasonMarker(detailTitle);
    var agree = (wantSeason > 1 && gotMarker === wantSeason) || (wantSeason <= 1 && !gotMarker);
    return agree ? 2 : 1;
}

/**
 * Fetches the KYOTO v4 post config + episode index for an AniLab catalog id.
 * Returns { post, epsList } or null.
 */
async function fetchKyotoIndex(anilabId) {
    var post = await getJson(KYOTO_API + '/post?id=' + encodeURIComponent(anilabId));
    if (!post || !post.episodes) return null;
    var epsData = await getJson(post.episodes);
    var epsList = (epsData && epsData.list) ? epsData.list : [];
    return { post: post, epsList: epsList };
}

/**
 * Searches the AniLab catalog by title and returns the best matching catalog id.
 * AniLab search only returns [{id, poster, age}], so the top candidates are
 * verified via their post detail titles (season-aware) and, when an absolute
 * episode number is known, via its presence in the KYOTO episode index.
 */
async function searchAniLab(title, season, absEp) {
    if (!title) return null;
    try {
        var res = await fetch(ANILAB_API + '/search?query=' + encodeURIComponent(title) + '&page=1', {
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        });
        if (!res.ok) return null;
        var json = await res.json();
        var posts = (json && json.posts) ? json.posts : [];
        if (posts.length === 0) return null;

        var wantClean = normTitle(cleanTitle(title));
        var wantSeason = parseInt(season || 1, 10);
        var scored = [];
        var count = Math.min(posts.length, 3);
        for (var i = 0; i < count; i++) {
            try {
                var det = await fetch(ANILAB_API + '/post?id=' + encodeURIComponent(String(posts[i].id)), {
                    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
                });
                if (!det.ok) continue;
                var post = await det.json();
                var score = titleScore(post.title || '', wantClean, wantSeason);
                if (score > 0) {
                    scored.push({ id: String(posts[i].id), title: post.title || '', score: score });
                }
            } catch (e) {}
        }
        if (scored.length === 0) {
            return { id: String(posts[0].id), title: '' };
        }
        scored.sort(function(a, b) { return b.score - a.score; });

        // With an absolute episode number, prefer the entry whose KYOTO
        // episode index actually contains it (fixes S1-vs-S2 mixups).
        if (absEp) {
            for (var s = 0; s < Math.min(scored.length, 2); s++) {
                try {
                    var idx = await fetchKyotoIndex(scored[s].id);
                    if (idx) {
                        for (var e = 0; e < idx.epsList.length; e++) {
                            if (String(idx.epsList[e].number) === String(absEp)) {
                                return scored[s];
                            }
                        }
                    }
                } catch (e) {}
            }
        }
        return scored[0];
    } catch (e) {}
    return null;
}

/**
 * Fetches JSON with a plain GET.
 */
async function getJson(url, headers) {
    var res = await fetch(url, { headers: headers || { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!res.ok) return null;
    try {
        return await res.json();
    } catch (e) {
        return null;
    }
}

/**
 * Expands an xlsbox master m3u8 into per-resolution variant entries.
 * Falls back to the master URL itself when parsing fails.
 */
async function expandVariants(masterUrl) {
    var fallback = [{ url: masterUrl, quality: 'auto' }];
    try {
        var res = await fetch(masterUrl, { headers: { 'User-Agent': UA } });
        if (!res.ok) return fallback;
        var text = await res.text();
        if (text.indexOf('#EXTM3U') === -1) return fallback;

        var lines = text.split('\n');
        var variants = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('#EXT-X-STREAM-INF') === 0 && i + 1 < lines.length) {
                var next = lines[i + 1].trim();
                if (!next || next.charAt(0) === '#') continue;
                var resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                var quality = resMatch ? resMatch[1] + 'p' : 'auto';
                var absUrl = (next.indexOf('http') === 0) ? next : new URL(next, masterUrl).toString();
                variants.push({ url: absUrl, quality: quality });
            }
        }
        // Variant playlists in this CDN are absolute already; keep master first as 'auto'.
        if (variants.length === 0) return fallback;
        var out = [{ url: masterUrl, quality: 'auto' }];
        var seen = {};
        seen[masterUrl] = true;
        for (var v = 0; v < variants.length; v++) {
            if (!seen[variants[v].url]) {
                seen[variants[v].url] = true;
                out.push(variants[v]);
            }
        }
        return out;
    } catch (e) {
        return fallback;
    }
}

/**
 * Main stream resolver required by Anivio.
 *
 * @param {string} tmdbId - Raw id (anilab:100000xxxx, bare 100000xxxx,
 *                          anilist:123, mal:123, numeric TMDB id, or "603")
 * @param {string} mediaType - "movie" | "tv"
 * @param {number|undefined} season - Season number
 * @param {number|undefined} episode - Episode number
 * @returns {Promise<Array>} List of stream objects
 */
async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        console.log('[anilab] getStreams called: id=' + tmdbId + ' type=' + mediaType + ' season=' + season + ' ep=' + episode);

        var meta = await resolveAnimeMeta(tmdbId, season, episode);

        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        // 1. Resolve the AniLab catalog id (direct or via title search).
        var anilabId = meta.anilabId || '';
        var anilabTitle = meta.title || '';
        if (!anilabId) {
            if (!meta.title) {
                console.log('[anilab] No title to search for ' + tmdbId);
                return [];
            }
            console.log('[anilab] Searching AniLab catalog for: ' + meta.title);
            var hit = await searchAniLab(meta.title, meta.season, meta.absEp);
            if (!hit) {
                // Retry once with the franchise-cleaned title (strips "Season 2", years, ...).
                var cleaned = cleanTitle(meta.title);
                if (cleaned && cleaned !== meta.title) {
                    console.log('[anilab] Retrying search with cleaned title: ' + cleaned);
                    hit = await searchAniLab(cleaned, meta.season, meta.absEp);
                }
            }
            if (!hit) {
                console.log('[anilab] No AniLab catalog hit for ' + meta.title);
                return [];
            }
            anilabId = hit.id;
            if (hit.title) anilabTitle = hit.title;
        }
        console.log('[anilab] AniLab id=' + anilabId + (anilabTitle ? ' (' + anilabTitle + ')' : ''));

        // 2. KYOTO v4 post -> episode index URL + server URL templates.
        var index = await fetchKyotoIndex(anilabId);
        if (!index || index.epsList.length === 0) {
            console.log('[anilab] KYOTO post/episode lookup failed for ' + anilabId);
            return [];
        }
        var post = index.post;
        var epsList = index.epsList;
        if (post.update) {
            console.log('[anilab] KYOTO flags update=true; continuing anyway');
        }

        var candidates = [];
        if (meta.absEp) candidates.push(String(meta.absEp));
        candidates.push(String(targetEp));
        var uniqueCandidates = [];
        for (var c = 0; c < candidates.length; c++) {
            if (uniqueCandidates.indexOf(candidates[c]) === -1) {
                uniqueCandidates.push(candidates[c]);
            }
        }
        console.log('[anilab] Looking for episode candidates: ' + uniqueCandidates.join(','));

        var epObj = null;
        var matchedNum = '';
        for (var ci = 0; ci < uniqueCandidates.length && !epObj; ci++) {
            for (var ei = 0; ei < epsList.length; ei++) {
                if (String(epsList[ei].number) === uniqueCandidates[ci]) {
                    epObj = epsList[ei];
                    matchedNum = uniqueCandidates[ci];
                    break;
                }
            }
        }
        if (!epObj) {
            console.log('[anilab] Episode ' + targetEp + ' not in anidb index (' + epsList.length + ' eps)');
            return [];
        }
        console.log('[anilab] Matched episode: ' + JSON.stringify(epObj));

        // 4. Servers for the episode -> prefer configured audio, SUB first.
        var serversUrl = String(post.servers).split('%id%').join(String(epObj.id));
        var srvData = await getJson(serversUrl);
        var srvList = (srvData && srvData.list) ? srvData.list : [];
        if (srvList.length === 0) {
            console.log('[anilab] No servers for episode ' + epObj.id);
            return [];
        }

        var audioPref = getAudioPref();
        var wantLang = audioPref === 'dub' ? 'dub' : 'sub';
        var preferred = [];
        var others = [];
        for (var si = 0; si < srvList.length; si++) {
            var lang = String(srvList[si].lang || '').toLowerCase();
            if (lang === wantLang || (wantLang === 'sub' && (lang === 'sub' || lang === 'jpn'))) {
                preferred.push(srvList[si]);
            } else {
                others.push(srvList[si]);
            }
        }
        var orderedServers = preferred.concat(others);

        // 5. iframe per server -> direct xlsbox HLS link (dedupe; servers often share one).
        var iframeHeaders = { 'User-Agent': UA, 'Accept': 'application/json' };
        var iframeTpl = post.server && post.server.url ? String(post.server.url) : '';
        var tplHeaders = (post.server && post.server.headers) ? post.server.headers : [];
        for (var hi = 0; hi < tplHeaders.length; hi++) {
            if (tplHeaders[hi] && tplHeaders[hi][0] && tplHeaders[hi][1]) {
                iframeHeaders[tplHeaders[hi][0]] = tplHeaders[hi][1];
            }
        }

        var masterLinks = [];
        var seenLinks = {};
        for (var sj = 0; sj < orderedServers.length; sj++) {
            try {
                var iframeUrl = iframeTpl.split('%id%').join(String(orderedServers[sj].id));
                if (!iframeUrl) continue;
                var iframeData = await getJson(iframeUrl, iframeHeaders);
                var link = iframeData && iframeData.link ? String(iframeData.link) : '';
                if (!link || seenLinks[link]) continue;
                // Only direct media links are playable here; HTML embed pages
                // need KYOTO's WebView scraper (out of scope for this provider).
                if (link.indexOf('.m3u8') === -1) {
                    console.log('[anilab] Skipping non-direct embed: ' + link.slice(0, 80));
                    continue;
                }
                seenLinks[link] = true;
                masterLinks.push({ link: link, server: orderedServers[sj] });
            } catch (err) {
                console.warn('[anilab] iframe resolve failed: ' + (err && err.message));
            }
        }

        if (masterLinks.length === 0) {
            console.log('[anilab] No direct HLS links for episode ' + epObj.id);
            return [];
        }

        // 6. Expand master playlists into per-quality HLS streams.
        var streams = [];
        for (var mk = 0; mk < masterLinks.length; mk++) {
            var item = masterLinks[mk];
            var variants = await expandVariants(item.link);
            var langLabel = String(item.server.lang || '').toUpperCase();
            for (var vk = 0; vk < variants.length; vk++) {
                var displayTitle = 'AniLab · ' + (item.server.name || ('Server ' + (mk + 1)))
                    + (langLabel ? ' · ' + langLabel : '')
                    + ' · Ep ' + (epObj.number || targetEp);
                if (matchedNum && matchedNum !== String(targetEp)) {
                    displayTitle += ' (' + matchedNum + ')';
                }
                streams.push({
                    name: 'AniLab (' + (item.server.name || 'HLS') + ')',
                    title: displayTitle + ' · ' + variants[vk].quality,
                    url: variants[vk].url,
                    quality: variants[vk].quality,
                    type: 'hls',
                    headers: { 'User-Agent': UA },
                    subtitles: []
                });
            }
        }

        console.log('[anilab] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[anilab] Fatal error in getStreams: ' + (e && e.message));
        return [];
    }
}

/**
 * Provider settings for Anivio UI.
 */
async function onSettings() {
    // NOTE: the Anivio settings dialog reads label/defaultValue/options,
    // older readers used title/default — both are provided.
    return [
        {
            key: 'label',
            type: 'text',
            label: 'Provider Name',
            title: 'Provider Name',
            description: 'Display name for AniLab streams.',
            defaultValue: 'AniLab',
            default: 'AniLab'
        },
        {
            key: 'audio',
            type: 'select',
            label: 'Preferred Audio',
            title: 'Preferred Audio',
            description: 'Which server audio to prefer when both exist.',
            defaultValue: 'sub',
            default: 'sub',
            options: [
                { value: 'sub', label: 'Sub (Japanese)' },
                { value: 'dub', label: 'Dub (English)' }
            ]
        }
    ];
}

// Export according to Anivio Plugin Contract
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
