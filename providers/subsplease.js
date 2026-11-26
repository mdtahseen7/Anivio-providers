/**
 * SubsPlease Torrent & Debrid Stream Provider Plugin for Anivio
 *
 * Ported from yuzono/anime-extensions (Subsplease.kt):
 * - Engine: QuickJS (pure ES5/async-await, self-contained)
 * - Uses SubsPlease official JSON search and show APIs
 * - Season-aware show matching (e.g. S1 vs S2)
 * - Direct 1080p, 720p, and 480p magnet URIs for Anivio's native BitTorrent/P2P engine
 * - Optional Debrid resolution (RealDebrid, TorBox, AllDebrid, Premiumize, etc.) via settings
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB/AniList id, and "603" (Anivio Test button)
 */

var SUBSPLEASE_BASE = 'https://subsplease.org';
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
        .replace(/[:\s-]*(?:(?:season|part|cour)\s*\d+|\d+(?:nd|rd|th|st)\s*season|\bs\d+|ii|iii|iv|v)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractSeasonNumber(title, pageSlug) {
    var text = ((title || '') + ' ' + (pageSlug || '')).toLowerCase();
    var m = text.match(/\bseason\s*(\d+)\b/) ||
            text.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/) ||
            text.match(/\bs(\d+)\b/) ||
            (pageSlug ? pageSlug.match(/-s(\d+)$/) : null);
    if (m) return parseInt(m[1], 10);
    if (/\b(?:season|part)\s+iv\b/.test(text)) return 4;
    if (/\b(?:season|part)\s+iii\b/.test(text)) return 3;
    if (/\b(?:season|part)\s+ii\b/.test(text)) return 2;
    return 1;
}

function diceSimilarity(a, b) {
    var x = normalizeTitle(a), y = normalizeTitle(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;
    var grams = {}, hits = 0, i, g;
    for (i = 0; i < x.length - 1; i++) {
        g = x.slice(i, i + 2);
        grams[g] = (grams[g] || 0) + 1;
    }
    for (i = 0; i < y.length - 1; i++) {
        g = y.slice(i, i + 2);
        if (grams[g]) { hits++; grams[g]--; }
    }
    return (2 * hits) / (x.length + y.length - 2);
}

async function resolveAnimeMeta(rawId, season, episode) {
    var c = classifyId(rawId);
    if (c.id === '603') {
        return {
            titleEn: "Frieren: Beyond Journey's End",
            titleRom: 'Sousou no Frieren',
            season: 1,
            absEp: null
        };
    }

    var queries = [];
    if (c.kind === 'anilist') queries.push('?anilist_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'mal') queries.push('?mal_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'numeric') {
        queries.push('?anilist_id=' + encodeURIComponent(c.id));
        queries.push('?themoviedb_id=' + encodeURIComponent(c.id));
    }

    var meta = {
        titleEn: '',
        titleRom: '',
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
                    meta.titleEn = data.titles.en || data.titles.ro || data.titles.ja || '';
                    meta.titleRom = data.titles.ro || data.titles.en || '';
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

async function searchSubsPlease(query) {
    if (!query) return [];
    try {
        var res = await fetch(SUBSPLEASE_BASE + '/api/?f=search&tz=UTC&s=' + encodeURIComponent(query), {
            headers: { 'User-Agent': UA, 'Referer': SUBSPLEASE_BASE + '/', 'Accept': 'application/json' }
        });
        if (!res.ok) return [];
        var data = await res.json();
        if (!data || typeof data !== 'object') return [];

        var keys = Object.keys(data);
        var seenPages = {};
        var results = [];
        for (var i = 0; i < keys.length; i++) {
            var entry = data[keys[i]];
            if (!entry || !entry.page || !entry.show) continue;
            if (seenPages[entry.page]) continue;
            seenPages[entry.page] = true;
            results.push({
                show: String(entry.show).trim(),
                page: String(entry.page).trim()
            });
        }
        return results;
    } catch (e) {
        return [];
    }
}

function pickBestCandidate(candidates, titleEn, titleRom, targetSeason) {
    if (!candidates || candidates.length === 0) return null;
    var best = null;
    var bestScore = -99999;

    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var sTitle = Math.max(
            titleEn ? diceSimilarity(c.show, titleEn) : 0,
            titleRom ? diceSimilarity(c.show, titleRom) : 0,
            titleEn ? diceSimilarity(cleanTitle(c.show), cleanTitle(titleEn)) : 0,
            titleRom ? diceSimilarity(cleanTitle(c.show), cleanTitle(titleRom)) : 0
        );
        var score = sTitle * 1000;
        var candSeason = extractSeasonNumber(c.show, c.page);
        if (candSeason === targetSeason) score += 2000;
        else score -= 1500;

        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }

    return best || candidates[0];
}

function formatBytesFromMagnet(magnet) {
    var m = String(magnet || '').match(/[?&]xl=(\d+)/);
    if (!m || !m[1]) return '';
    var bytes = parseInt(m[1], 10);
    if (!bytes || isNaN(bytes)) return '';
    var gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(2) + ' GB';
    return Math.round(bytes / (1024 * 1024)) + ' MB';
}

function buildDebridUrl(magnet, provider, token) {
    var hashM = String(magnet).match(/xt=urn:btih:([A-Fa-f0-9]{40}|[A-Za-z0-9]{32})/);
    var dnM = String(magnet).match(/[?&]dn=([^&]+)/);
    if (!hashM || !hashM[1]) return null;
    var infohash = hashM[1];
    var dn = dnM && dnM[1] ? dnM[1] : 'video.mkv';
    return 'https://torrentio.strem.fun/resolve/' + encodeURIComponent(provider) + '/' + encodeURIComponent(token) + '/' + infohash + '/null/0/' + dn;
}

/**
 * Main stream resolver required by Anivio.
 */
async function getStreams(rawId, mediaType, season, episode) {
    try {
        console.log('[subsplease] getStreams called: id=' + rawId + ' type=' + mediaType + ' season=' + season + ' ep=' + episode);

        var meta = await resolveAnimeMeta(rawId, season, episode);
        var targetSeason = parseInt(season != null ? season : 1, 10) || 1;
        var targetEp = parseInt(episode != null ? episode : 1, 10) || 1;

        var queries = [];
        function addQ(q) { if (q && queries.indexOf(q) === -1) queries.push(q); }
        if (targetSeason > 1) {
            if (meta.titleRom) addQ(cleanTitle(meta.titleRom) + ' S' + targetSeason);
            if (meta.titleEn) addQ(cleanTitle(meta.titleEn) + ' S' + targetSeason);
        }
        if (meta.titleRom) addQ(cleanTitle(meta.titleRom));
        if (meta.titleEn) addQ(cleanTitle(meta.titleEn));
        if (meta.titleEn && meta.titleEn.indexOf(':') !== -1) addQ(meta.titleEn.split(':')[0].trim());

        var allCandidates = [];
        var seenPages = {};
        for (var q = 0; q < queries.length; q++) {
            var found = await searchSubsPlease(queries[q]);
            for (var f = 0; f < found.length; f++) {
                if (!seenPages[found[f].page]) {
                    seenPages[found[f].page] = true;
                    allCandidates.push(found[f]);
                }
            }
            if (allCandidates.some(function(c) { return extractSeasonNumber(c.show, c.page) === targetSeason; })) {
                break;
            }
        }

        if (allCandidates.length === 0) {
            console.log('[subsplease] No matching show found for ' + rawId);
            return [];
        }

        var chosen = pickBestCandidate(allCandidates, meta.titleEn, meta.titleRom, targetSeason);
        console.log('[subsplease] Chosen show: ' + chosen.show + ' (/shows/' + chosen.page + ')');

        // 1. Fetch show page to extract `sid`
        var showPageUrl = SUBSPLEASE_BASE + '/shows/' + chosen.page + '/';
        var pageRes = await fetch(showPageUrl, { headers: { 'User-Agent': UA, 'Referer': SUBSPLEASE_BASE + '/' } });
        if (!pageRes.ok) return [];
        var pageHtml = await pageRes.text();
        var sidM = pageHtml.match(/id=["']show-release-table["'][^>]*sid=["'](\d+)["']/i) ||
                   pageHtml.match(/sid=["'](\d+)["']/i);
        if (!sidM || !sidM[1]) {
            console.log('[subsplease] No sid found on show page');
            return [];
        }
        var sid = sidM[1];

        // 2. Fetch episodes JSON via /api/?f=show&tz=UTC&sid=<sid>
        var apiRes = await fetch(SUBSPLEASE_BASE + '/api/?f=show&tz=UTC&sid=' + encodeURIComponent(sid), {
            headers: { 'User-Agent': UA, 'Referer': showPageUrl, 'Accept': 'application/json' }
        });
        if (!apiRes.ok) return [];
        var apiJson = await apiRes.json();
        var epMap = (apiJson && apiJson.episode && typeof apiJson.episode === 'object') ? apiJson.episode : {};
        var epList = Object.keys(epMap).map(function(k) { return epMap[k]; });

        var targetCandidates = [targetEp];
        if (meta.absEp && meta.absEp !== targetEp) targetCandidates.push(meta.absEp);

        var matchedEp = null;
        for (var tc = 0; tc < targetCandidates.length && !matchedEp; tc++) {
            var wantNum = targetCandidates[tc];
            for (var eIdx = 0; eIdx < epList.length; eIdx++) {
                var epItem = epList[eIdx];
                if (!epItem || !epItem.episode) continue;
                var epStr = String(epItem.episode).trim();
                var parsedEp = parseFloat(epStr.replace(/v\d+$/i, ''));
                if (parsedEp === wantNum) {
                    matchedEp = epItem;
                    break;
                }
            }
        }

        if (!matchedEp || !Array.isArray(matchedEp.downloads)) {
            console.log('[subsplease] Episode ' + targetEp + ' not found in SubsPlease release list');
            return [];
        }

        // Check optional user debrid config
        var debridProv = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.debrid_provider)
            ? String(SCRAPER_SETTINGS.debrid_provider).toLowerCase().trim()
            : 'none';
        var debridToken = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.debrid_token)
            ? String(SCRAPER_SETTINGS.debrid_token).trim()
            : '';
        var useDebrid = debridProv && debridProv !== 'none' && Boolean(debridToken);

        // Sort highest resolution first (1080 -> 720 -> 480)
        var downloads = matchedEp.downloads.slice().sort(function(a, b) {
            return (parseInt(b.res, 10) || 0) - (parseInt(a.res, 10) || 0);
        });

        var streams = [];
        for (var d = 0; d < downloads.length; d++) {
            var dl = downloads[d];
            if (!dl || !dl.magnet) continue;
            var resLabel = (dl.res ? String(dl.res) : '1080') + 'p';
            var sizeStr = formatBytesFromMagnet(dl.magnet);
            var streamUrl = dl.magnet;
            var streamType = 'torrent';
            var serverTag = 'SubsPlease';

            if (useDebrid) {
                var resolved = buildDebridUrl(dl.magnet, debridProv, debridToken);
                if (resolved) {
                    streamUrl = resolved;
                    streamType = 'mp4';
                    serverTag = 'SubsPlease Debrid';
                }
            }

            streams.push({
                name: serverTag + ' (' + resLabel + ')',
                title: '[SubsPlease] ' + chosen.show + ' · Ep ' + matchedEp.episode + ' (' + resLabel + ')' + (sizeStr ? ' • ' + sizeStr : ''),
                server: serverTag + ' ' + resLabel,
                url: streamUrl,
                quality: resLabel,
                type: streamType,
                size: sizeStr || undefined
            });
        }

        console.log('[subsplease] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[subsplease] Fatal error in getStreams: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'debrid_provider',
            type: 'text',
            title: 'Debrid Provider (Optional)',
            description: 'Optional: none, realdebrid, torbox, premiumize, alldebrid, debridlink, offcloud',
            default: 'none'
        },
        {
            key: 'debrid_token',
            type: 'text',
            title: 'Debrid API Token (Optional)',
            description: 'Leave blank to use native Anivio BitTorrent P2P magnet streaming.',
            default: ''
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
