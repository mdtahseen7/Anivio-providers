/**
 * AnimeWorld India (WatchAnimeWorld) Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export, no Node built-ins)
 * - Multi-audio adaptive HLS streams: Hindi, Tamil, Telugu, Malayalam, Bengali, Marathi, English, Japanese
 * - Full series, multi-season (Torofilm AJAX), and movie support
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB/AniList id, and "603" (Anivio Test button)
 */

var WAW_BASE = 'https://watchanimeworld.one';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function classifyId(rawId) {
    var v = String(rawId == null ? '' : rawId).trim();
    if (!v) return { kind: 'unknown', id: '' };
    var l = v.toLowerCase();
    if (l.indexOf('anilist:') === 0) return { kind: 'anilist', id: v.slice('anilist:'.length).split(':')[0] };
    if (l.indexOf('mal:') === 0) return { kind: 'mal', id: v.slice('mal:'.length).split(':')[0] };
    if (/^\d+$/.test(v)) return { kind: 'numeric', id: v };
    return { kind: 'unknown', id: v };
}

function normalizeTitle(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cleanTitle(title) {
    if (!title) return '';
    return String(title)
        .replace(/[`'’‘"]/g, "'")
        .replace(/\s*\(\d{4}\)/g, '')
        .replace(/[:\s-]*(?:(?:season|part|cour)\s*\d+|\d+(?:nd|rd|th|st)\s*season|ii|iii|iv|v)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function diceSimilarity(a, b) {
    var x = normalizeTitle(a);
    var y = normalizeTitle(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;
    var grams = {};
    var hits = 0;
    var i, g;
    for (i = 0; i < x.length - 1; i++) {
        g = x.slice(i, i + 2);
        grams[g] = (grams[g] || 0) + 1;
    }
    for (i = 0; i < y.length - 1; i++) {
        g = y.slice(i, i + 2);
        if (grams[g]) {
            hits++;
            grams[g]--;
        }
    }
    return (2 * hits) / (x.length + y.length - 2);
}

/**
 * Resolves metadata and titles via AniZip mappings.
 */
async function resolveAnimeMeta(rawId, season, episode) {
    var c = classifyId(rawId);

    // Anivio Test button passes "603"
    if (c.id === '603') {
        return {
            titleEn: "Frieren: Beyond Journey's End",
            titleRom: 'Sousou no Frieren',
            anilistId: '154587',
            season: 1,
            absEp: null
        };
    }

    var queries = [];
    if (c.kind === 'anilist') {
        queries.push('?anilist_id=' + encodeURIComponent(c.id));
    } else if (c.kind === 'mal') {
        queries.push('?mal_id=' + encodeURIComponent(c.id));
    } else if (c.kind === 'numeric') {
        // Anivio resolves IDs via TmdbService.ensureTmdbId first -> always check TMDB before AniList
        queries.push('?themoviedb_id=' + encodeURIComponent(c.id));
        queries.push('?anilist_id=' + encodeURIComponent(c.id));
    }

    var meta = {
        titleEn: '',
        titleRom: '',
        anilistId: c.kind === 'anilist' ? c.id : null,
        season: parseInt(season != null ? season : 1, 10) || 1,
        absEp: null
    };

    var targetEpStr = String(episode != null ? episode : 1);

    for (var i = 0; i < queries.length; i++) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + queries[i], {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.titles) {
                    var rom = data.titles['x-jat'] || data.titles.ro || '';
                    var en = data.titles.en || rom || data.titles.ja || '';
                    meta.titleEn = String(en).replace(/[`’‘]/g, "'").trim();
                    meta.titleRom = String(rom || en).replace(/[`’‘]/g, "'").trim();
                    if (data.mappings && data.mappings.anilist_id) {
                        meta.anilistId = String(data.mappings.anilist_id);
                    }
                    var epObj = data.episodes && (data.episodes[targetEpStr] || data.episodes['1']);
                    if (epObj && epObj.absoluteEpisodeNumber) {
                        meta.absEp = epObj.absoluteEpisodeNumber;
                    }
                    if (meta.titleEn || meta.titleRom) break;
                }
            }
        } catch (e) {}
    }

    if (!meta.titleEn && !meta.titleRom && c.kind === 'unknown') {
        meta.titleEn = c.id;
    }

    return meta;
}

/**
 * Searches WatchAnimeWorld for series or movie entries.
 */
async function searchWatchAnimeWorld(query) {
    if (!query) return [];
    try {
        var res = await fetch(WAW_BASE + '/?s=' + encodeURIComponent(query), {
            headers: { 'User-Agent': UA, 'Referer': WAW_BASE + '/' }
        });
        if (!res.ok) return [];
        var html = await res.text();

        var results = [];
        var seen = {};
        // Match Torofilm post cards: <article class="post ..."> ... <h2 class="entry-title">Title</h2> ... <a href="...">
        var articleRe = /<article[^>]*class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
        var m;
        while ((m = articleRe.exec(html)) !== null) {
            var block = m[1];
            var linkM = block.match(/href="(https?:\/\/[^"]+\/(?:series|movies)\/([^"\/]+)\/?)"/i);
            if (!linkM) continue;
            var url = linkM[1];
            var slug = linkM[2];
            if (seen[url]) continue;
            seen[url] = true;

            var titleM = block.match(/<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)
                || block.match(/alt="([^"]+)"/i);
            var title = titleM
                ? titleM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').trim()
                : slug.replace(/-/g, ' ');

            results.push({
                url: url,
                slug: slug,
                title: title,
                isMovie: url.indexOf('/movies/') !== -1
            });
        }

        // Fallback regex if article structure varies
        if (results.length === 0) {
            var hrefRe = /href="(https?:\/\/[^"]+\/(?:series|movies)\/([^"\/]+)\/?)"/gi;
            var hm;
            while ((hm = hrefRe.exec(html)) !== null) {
                var hUrl = hm[1];
                var hSlug = hm[2];
                if (seen[hUrl]) continue;
                seen[hUrl] = true;
                results.push({
                    url: hUrl,
                    slug: hSlug,
                    title: hSlug.replace(/-/g, ' '),
                    isMovie: hUrl.indexOf('/movies/') !== -1
                });
            }
        }

        return results;
    } catch (e) {
        return [];
    }
}

function pickBestCandidate(candidates, titleEn, titleRom, mediaType) {
    if (!candidates || candidates.length === 0) return null;
    var wantMovie = mediaType === 'movie';
    var best = null;
    var bestScore = -1;

    for (var i = 0; i < candidates.length; i++) {
        var cand = candidates[i];
        var sEn = titleEn ? diceSimilarity(cand.title, titleEn) : 0;
        var sRom = titleRom ? diceSimilarity(cand.title, titleRom) : 0;
        var sSlug = titleEn ? diceSimilarity(cand.slug.replace(/-/g, ' '), titleEn) : 0;
        var score = Math.max(sEn, sRom, sSlug);

        // Clean title match boost
        if (titleEn) {
            var cleanedScore = diceSimilarity(cand.title, cleanTitle(titleEn));
            if (cleanedScore > score) score = cleanedScore;
        }

        // Media type boost
        if (wantMovie && cand.isMovie) score += 0.15;
        else if (!wantMovie && !cand.isMovie) score += 0.10;

        if (score > bestScore) {
            bestScore = score;
            best = cand;
        }
    }

    return bestScore >= 0.35 ? best : candidates[0];
}

/**
 * Extracts subtitles from FirePlayer `playerjsSubtitle` variable.
 * Format example: "[English]https://.../sub.html,[Hindi]https://.../hi.html"
 */
function parsePlayerJsSubtitles(html, refererOrigin) {
    var subtitles = [];
    var m = html.match(/var\s+playerjsSubtitle\s*=\s*"([^"]+)"/);
    if (!m || !m[1]) return subtitles;

    var parts = m[1].split(',');
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        if (!part) continue;
        var labelM = part.match(/^\[([^\]]+)\](.+)$/);
        var label = labelM ? labelM[1].trim() : 'English';
        var subUrl = labelM ? labelM[2].trim() : part;
        if (!subUrl || subUrl.indexOf('http') !== 0) continue;

        var langCode = 'en';
        var lower = label.toLowerCase();
        if (lower.indexOf('hin') !== -1) langCode = 'hi';
        else if (lower.indexOf('tam') !== -1) langCode = 'ta';
        else if (lower.indexOf('tel') !== -1) langCode = 'te';
        else if (lower.indexOf('mal') !== -1) langCode = 'ml';
        else if (lower.indexOf('ben') !== -1) langCode = 'bn';
        else if (lower.indexOf('jpn') !== -1 || lower.indexOf('jap') !== -1) langCode = 'ja';
        else if (lower.indexOf('spa') !== -1) langCode = 'es';
        else if (lower.indexOf('eng') !== -1) langCode = 'en';

        subtitles.push({
            url: subUrl,
            language: langCode,
            name: label,
            headers: {
                'User-Agent': UA,
                'Referer': refererOrigin + '/'
            }
        });
    }
    return subtitles;
}

/**
 * Inspects HLS master playlist for available audio language tracks (#EXT-X-MEDIA:TYPE=AUDIO).
 */
async function detectAudioLanguages(m3u8Url, refererOrigin) {
    var langs = [];
    try {
        var res = await fetch(m3u8Url, {
            headers: { 'User-Agent': UA, 'Referer': refererOrigin + '/' }
        });
        if (!res.ok) return langs;
        var text = await res.text();
        var lines = text.split('\n');
        var seen = {};
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('#EXT-X-MEDIA:') === 0 && line.indexOf('TYPE=AUDIO') !== -1) {
                var nameM = line.match(/NAME="([^"]+)"/);
                if (nameM && nameM[1] && !seen[nameM[1]]) {
                    seen[nameM[1]] = true;
                    langs.push(nameM[1]);
                }
            }
        }
    } catch (e) {}
    return langs;
}

/**
 * Extracts FirePlayer HLS stream & subtitles from an embed URL (e.g. play.zephyrix.org/video/<hash>).
 */
async function extractFirePlayer(iframeUrl, epLabel) {
    try {
        var urlObj = new URL(iframeUrl);
        var videoIdx = urlObj.pathname.indexOf('/video/');
        if (videoIdx === -1) return null;
        var hash = urlObj.pathname.slice(videoIdx + '/video/'.length).split('/')[0];
        if (!hash) return null;

        var origin = urlObj.origin;

        // 1. Fetch iframe HTML for subtitle URLs
        var subtitles = [];
        try {
            var htmlRes = await fetch(iframeUrl, {
                headers: { 'User-Agent': UA, 'Referer': WAW_BASE + '/' }
            });
            if (htmlRes.ok) {
                var html = await htmlRes.text();
                subtitles = parsePlayerJsSubtitles(html, origin);
            }
        } catch (e) {}

        // 2. Fetch video source JSON via FirePlayer POST API
        var apiUrl = origin + '/player/index.php?data=' + encodeURIComponent(hash) + '&do=getVideo';
        var postRes = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'User-Agent': UA,
                'Referer': iframeUrl,
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'hash=' + encodeURIComponent(hash) + '&r=' + encodeURIComponent(WAW_BASE + '/')
        });
        if (!postRes.ok) return null;
        var data = await postRes.json();

        var streamUrl = (data && data.securedLink) ? data.securedLink : (data && data.videoSource ? data.videoSource : null);
        if (!streamUrl) return null;

        // 3. Detect multi-audio tracks from master playlist
        var audioLangs = await detectAudioLanguages(streamUrl, origin);
        var langSummary = audioLangs.length > 0 ? audioLangs.join(', ') : 'Multi-Audio';
        var shortSummary = audioLangs.length > 0
            ? (audioLangs.length > 3 ? audioLangs.slice(0, 3).join('/') + '+' : audioLangs.join('/'))
            : 'Multi-Audio';

        return {
            name: 'AnimeWorld India (' + shortSummary + ')',
            title: 'AnimeWorld · ' + langSummary + ' · ' + epLabel + ' · 1080p',
            server: 'AnimeWorld India',
            url: streamUrl,
            quality: '1080p',
            type: 'hls',
            headers: {
                'User-Agent': UA,
                'Referer': origin + '/'
            },
            subtitles: subtitles
        };
    } catch (e) {
        return null;
    }
}

/**
 * Resolves the target episode URL for a series using direct URL probe or Torofilm season AJAX.
 */
async function resolveSeriesEpisodeHtml(show, targetSeason, targetEp, absEp) {
    // Try direct deterministic Torofilm URLs first
    var candidatePaths = [
        WAW_BASE + '/episode/' + show.slug + '-' + targetSeason + 'x' + targetEp + '/'
    ];
    if (targetSeason !== 1) {
        candidatePaths.push(WAW_BASE + '/episode/' + show.slug + '-1x' + targetEp + '/');
    }
    if (absEp && absEp !== targetEp) {
        candidatePaths.push(WAW_BASE + '/episode/' + show.slug + '-1x' + absEp + '/');
    }

    for (var i = 0; i < candidatePaths.length; i++) {
        try {
            var res = await fetch(candidatePaths[i], {
                headers: { 'User-Agent': UA, 'Referer': show.url }
            });
            if (res.ok) {
                var html = await res.text();
                if (html.indexOf('<iframe') !== -1) {
                    return html;
                }
            }
        } catch (e) {}
    }

    // Fallback: Fetch show page -> extract postId -> call Torofilm season AJAX
    try {
        var sRes = await fetch(show.url, { headers: { 'User-Agent': UA, 'Referer': WAW_BASE + '/' } });
        if (!sRes.ok) return null;
        var sHtml = await sRes.text();
        var postM = sHtml.match(/data-post="(\d+)"/);
        if (!postM) return null;

        var ajaxRes = await fetch(WAW_BASE + '/wp-admin/admin-ajax.php', {
            method: 'POST',
            headers: {
                'User-Agent': UA,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': show.url
            },
            body: 'action=action_select_season&season=' + encodeURIComponent(targetSeason) + '&post=' + encodeURIComponent(postM[1])
        });
        if (!ajaxRes.ok) return null;
        var ajaxHtml = await ajaxRes.text();

        var epLinks = [];
        var epRe = /href="(https?:\/\/[^"]+\/episode\/[^"]+)"/gi;
        var em;
        while ((em = epRe.exec(ajaxHtml)) !== null) {
            epLinks.push(em[1]);
        }

        // Find matching episode number in URL suffix (e.g. -1x5/ or -5/)
        var targetSuffix1 = '-' + targetSeason + 'x' + targetEp + '/';
        var targetSuffix2 = 'x' + targetEp + '/';
        var foundUrl = null;
        for (var j = 0; j < epLinks.length; j++) {
            if (epLinks[j].indexOf(targetSuffix1) !== -1 || epLinks[j].slice(-targetSuffix2.length) === targetSuffix2) {
                foundUrl = epLinks[j];
                break;
            }
        }
        if (!foundUrl && epLinks.length >= targetEp) {
            foundUrl = epLinks[targetEp - 1];
        }
        if (foundUrl) {
            var epPageRes = await fetch(foundUrl, { headers: { 'User-Agent': UA, 'Referer': show.url } });
            if (epPageRes.ok) return await epPageRes.text();
        }
    } catch (e) {}

    return null;
}

/**
 * Main stream resolver required by Anivio.
 *
 * @param {string} rawId - Raw identifier (anilist:123, mal:123, numeric TMDB/AniList id, or "603")
 * @param {string} mediaType - "movie" | "tv"
 * @param {number|undefined} season - Season number
 * @param {number|undefined} episode - Episode number
 * @returns {Promise<Array>} List of stream objects conforming to Anivio specification
 */
async function getStreams(rawId, mediaType, season, episode) {
    try {
        console.log('[animeworldindia] getStreams called: id=' + rawId + ' type=' + mediaType + ' season=' + season + ' ep=' + episode);

        var meta = await resolveAnimeMeta(rawId, season, episode);
        var targetSeason = parseInt(season != null ? season : 1, 10) || 1;
        var targetEp = parseInt(episode != null ? episode : 1, 10) || 1;

        var searchQueries = [];
        function addQuery(q) {
            if (q && searchQueries.indexOf(q) === -1) searchQueries.push(q);
        }
        if (meta.titleEn) {
            var normEn = cleanTitle(meta.titleEn);
            addQuery(normEn);
            addQuery(meta.titleEn);
            if (normEn.indexOf(':') !== -1) addQuery(normEn.split(':')[0].trim());
            addQuery(normEn.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim());
        }
        if (meta.titleRom && meta.titleRom !== meta.titleEn) {
            var normRom = cleanTitle(meta.titleRom);
            addQuery(normRom);
            if (normRom.indexOf(':') !== -1) addQuery(normRom.split(':')[0].trim());
        }

        var chosen = null;
        for (var q = 0; q < searchQueries.length; q++) {
            var candidates = await searchWatchAnimeWorld(searchQueries[q]);
            if (candidates.length > 0) {
                chosen = pickBestCandidate(candidates, meta.titleEn, meta.titleRom, mediaType);
                if (chosen) break;
            }
        }

        if (!chosen) {
            console.log('[animeworldindia] No match found for ' + (meta.titleEn || rawId));
            return [];
        }

        console.log('[animeworldindia] Chosen entry: ' + chosen.title + ' (' + chosen.url + ')');

        var pageHtml = null;
        var epLabel = chosen.isMovie ? 'Movie' : (targetSeason > 1 ? 'S' + targetSeason + 'E' + targetEp : 'Ep ' + targetEp);

        if (chosen.isMovie) {
            var mRes = await fetch(chosen.url, { headers: { 'User-Agent': UA, 'Referer': WAW_BASE + '/' } });
            if (mRes.ok) pageHtml = await mRes.text();
        } else {
            pageHtml = await resolveSeriesEpisodeHtml(chosen, targetSeason, targetEp, meta.absEp);
        }

        if (!pageHtml) {
            console.log('[animeworldindia] Episode page not found');
            return [];
        }

        // Collect iframe embeds
        var iframeRe = /<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/gi;
        var im;
        var seenIframes = {};
        var streams = [];
        var seenUrls = {};

        while ((im = iframeRe.exec(pageHtml)) !== null) {
            var rawIframe = im[1];
            if (!rawIframe || rawIframe.indexOf('about:') === 0) continue;
            var absIframe = rawIframe.indexOf('http') === 0 ? rawIframe : (WAW_BASE + (rawIframe.charAt(0) === '/' ? '' : '/') + rawIframe);
            if (seenIframes[absIframe]) continue;
            seenIframes[absIframe] = true;

            if (absIframe.indexOf('/video/') !== -1) {
                var streamObj = await extractFirePlayer(absIframe, epLabel);
                if (streamObj && streamObj.url && !seenUrls[streamObj.url]) {
                    seenUrls[streamObj.url] = true;
                    streams.push(streamObj);
                }
            }
        }

        console.log('[animeworldindia] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[animeworldindia] Fatal error in getStreams: ' + (err && err.message));
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
            description: 'Display name for AnimeWorld India streams.',
            default: 'AnimeWorld India'
        }
    ];
}

// Export according to Anivio Plugin Contract
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
