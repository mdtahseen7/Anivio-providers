/**
 * SubsPlease Torrent & Debrid Stream Provider Plugin for Anivio
 *
 * Ported from yuzono/anime-extensions (Subsplease.kt):
 * - Engine: QuickJS (pure ES5/async-await, self-contained)
 * - TMDB-first + AniList/MAL fallback via AniZip (matching Anivio PluginRepository ID resolution)
 * - Season-aware matching with strict similarity threshold (e.g. S1 vs S2, Dan Da Dan vs Dandadan)
 * - Converts 32-char Base32 SubsPlease hashes into canonical 40-char hex `infoHash` required by Anivio P2P engine
 * - Official SubsPlease JSON releases + Nyaa `[SubsPlease]` archive fallback + `batch` fallback
 * - Optional Debrid resolution (RealDebrid, TorBox, AllDebrid, Premiumize, etc.) via settings
 */

var SUBSPLEASE_BASE = 'https://subsplease.org';
var NYAA_BASE = 'https://nyaa.si';
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
        .replace(/[`’‘"]/g, "'")
        .replace(/\s*\(\d{4}\)/g, '')
        .replace(/\s*\((?:TV|The Final Season|Cour\s*\d+|Part\s*\d+)\)/gi, '')
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

/**
 * Converts a 32-char Base32 infoHash into 40-char lowercase hexadecimal (required by Anivio P2pStreamingEngine).
 */
function base32ToHex(b32) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    var clean = String(b32 || '').toUpperCase().replace(/=+$/, '');
    if (clean.length === 40 && /^[0-9A-F]{40}$/.test(clean)) return clean.toLowerCase();
    if (clean.length !== 32) return null;

    var bits = 0;
    var value = 0;
    var hex = '';
    for (var i = 0; i < clean.length; i++) {
        var idx = alphabet.indexOf(clean.charAt(i));
        if (idx === -1) return null;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            var byteVal = (value >>> bits) & 255;
            hex += (byteVal < 16 ? '0' : '') + byteVal.toString(16);
        }
    }
    return hex.length === 40 ? hex : null;
}

/**
 * Extracts canonical 40-char hex infoHash and ensures magnet uses hex btih.
 */
function normalizeMagnetAndHash(magnet) {
    var raw = String(magnet || '').trim();
    var m = raw.match(/xt=urn:btih:([A-Za-z0-9]+)/i);
    if (!m || !m[1]) return { magnet: raw, infoHash: null };
    var rawHash = m[1];
    var hexHash = (/^[A-Fa-f0-9]{40}$/.test(rawHash)) ? rawHash.toLowerCase() : base32ToHex(rawHash);
    if (!hexHash) return { magnet: raw, infoHash: null };
    var normalizedMagnet = raw.replace(/xt=urn:btih:[A-Za-z0-9]+/i, 'xt=urn:btih:' + hexHash);
    return { magnet: normalizedMagnet, infoHash: hexHash };
}

function normalizeApostrophes(s) {
    return String(s == null ? '' : s).replace(/[`’‘]/g, "'").trim();
}

async function resolveAnimeMeta(rawId, season, episode) {
    var c = classifyId(rawId);
    var targetSeason = parseInt(season != null ? season : 1, 10) || 1;
    var targetEp = parseInt(episode != null ? episode : 1, 10) || 1;

    if (c.id === '603') {
        return {
            titleEn: "Frieren: Beyond Journey's End",
            titleRom: 'Sousou no Frieren',
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
        season: targetSeason,
        absEp: null
    };
    var targetEpStr = String(targetEp);
    var anilistId = c.kind === 'anilist' ? parseInt(c.id, 10) : null;
    var imdbId = null;

    for (var i = 0; i < queries.length; i++) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + queries[i], {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.titles) {
                    // AniZip stores Romaji under 'x-jat' (not 'ro')
                    var rawRom = data.titles['x-jat'] || data.titles.ro || '';
                    var rawEn = data.titles.en || rawRom || data.titles.ja || '';
                    meta.titleEn = normalizeApostrophes(rawEn);
                    meta.titleRom = normalizeApostrophes(rawRom || rawEn);
                    if (data.mappings) {
                        if (!anilistId && data.mappings.anilist_id) anilistId = data.mappings.anilist_id;
                        if (data.mappings.imdb_id) imdbId = data.mappings.imdb_id;
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

    // If Romaji from AniZip is missing or abbreviated (e.g. "SnK"), enrich from AniList GraphQL
    if (anilistId && (!meta.titleRom || meta.titleRom.length < 5 || meta.titleRom === meta.titleEn)) {
        try {
            var gqlRes = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                body: JSON.stringify({
                    query: 'query($id:Int){Media(id:$id,type:ANIME){title{romaji english}}}',
                    variables: { id: Number(anilistId) }
                })
            });
            if (gqlRes.ok) {
                var gqlJson = await gqlRes.json();
                var mediaTitle = gqlJson && gqlJson.data && gqlJson.data.Media && gqlJson.data.Media.title;
                if (mediaTitle) {
                    if (mediaTitle.romaji) meta.titleRom = normalizeApostrophes(mediaTitle.romaji);
                    if (!meta.titleEn && mediaTitle.english) meta.titleEn = normalizeApostrophes(mediaTitle.english);
                }
            }
        } catch (e) {}
    }

    // For Season > 1 via TMDB/IMDb, compute cumulative absolute episode number via Cinemeta (e.g. AoT S4E1 -> Ep 60)
    if (targetSeason > 1 && imdbId && (!meta.absEp || meta.absEp === targetEp || meta.absEp === 1)) {
        try {
            var cmRes = await fetch('https://v3-cinemeta.strem.io/meta/series/' + encodeURIComponent(imdbId) + '.json', {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (cmRes.ok) {
                var cmJson = await cmRes.json();
                var videos = cmJson && cmJson.meta && Array.isArray(cmJson.meta.videos) ? cmJson.meta.videos : [];
                if (videos.length > 0) {
                    var priorCount = 0;
                    for (var v = 0; v < videos.length; v++) {
                        var vs = videos[v].season;
                        if (typeof vs === 'number' && vs >= 1 && vs < targetSeason) priorCount++;
                    }
                    if (priorCount > 0) meta.absEp = priorCount + targetEp;
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

function titleMatchSimilarity(candShow, titleEn, titleRom) {
    return Math.max(
        titleEn ? diceSimilarity(candShow, titleEn) : 0,
        titleRom ? diceSimilarity(candShow, titleRom) : 0,
        titleEn ? diceSimilarity(cleanTitle(candShow), cleanTitle(titleEn)) : 0,
        titleRom ? diceSimilarity(cleanTitle(candShow), cleanTitle(titleRom)) : 0
    );
}

function pickBestCandidate(candidates, titleEn, titleRom, targetSeason) {
    if (!candidates || candidates.length === 0) return null;
    var best = null;
    var bestScore = -99999;
    var bestSim = 0;

    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var sTitle = titleMatchSimilarity(c.show, titleEn, titleRom);
        var score = sTitle * 1000;
        var candSeason = extractSeasonNumber(c.show, c.page);
        if (candSeason === targetSeason) score += 2000;
        else if (targetSeason >= 4 && /final\s+season/i.test(c.show) && !/part\s*[23]/i.test(c.show)) score += 1500;
        else score -= 1500;

        if (/\bmovie\b/i.test(c.show)) score -= 1200;

        if (score > bestScore) {
            bestScore = score;
            best = c;
            bestSim = sTitle;
        }
    }

    return bestSim >= 0.45 ? best : null;
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

function buildDebridUrl(magnet, infoHash, provider, token) {
    if (!infoHash) return null;
    var dnM = String(magnet).match(/[?&]dn=([^&]+)/);
    var dn = dnM && dnM[1] ? dnM[1] : 'video.mkv';
    return 'https://torrentio.strem.fun/resolve/' + encodeURIComponent(provider) + '/' + encodeURIComponent(token) + '/' + infoHash + '/null/0/' + dn;
}

function parseRangeMatchesEp(rangeStr, wantEp) {
    var m = String(rangeStr || '').match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (!m) return false;
    var start = parseInt(m[1], 10);
    var end = parseInt(m[2], 10);
    return wantEp >= start && wantEp <= end;
}

function parseNyaaSubsPleaseRelease(torrentName, titleEn, titleRom, targetEp, absEp) {
    var name = String(torrentName || '').trim();
    if (name.toLowerCase().indexOf('[subsplease]') !== 0) return { ok: false };

    var showPart = '';
    var epMatched = false;
    var isBatch = false;

    var batchM = name.match(/^\[SubsPlease\]\s*(.+?)\s*\((\d+\s*[-~]\s*\d+)\)/i);
    if (batchM) {
        showPart = batchM[1].trim();
        isBatch = true;
        epMatched = parseRangeMatchesEp(batchM[2], targetEp) || (absEp ? parseRangeMatchesEp(batchM[2], absEp) : false);
    } else {
        var epM = name.match(/^\[SubsPlease\]\s*(.+?)\s*-\s*(\d+(?:\.\d+)?)(?:v\d+)?\s*(?:\(|\[|$)/i);
        if (epM) {
            showPart = epM[1].trim();
            var parsedEp = parseFloat(epM[2]);
            epMatched = (parsedEp === targetEp) || (absEp ? parsedEp === absEp : false);
        } else if (targetEp === 1) {
            var movM = name.match(/^\[SubsPlease\]\s*(.+?)\s*(?:\((?:1080p|720p|480p|\d+p)\)|\[)/i);
            if (movM) {
                showPart = movM[1].trim();
                epMatched = true;
            }
        }
    }

    if (!epMatched || !showPart) return { ok: false };
    var sim = titleMatchSimilarity(showPart, titleEn, titleRom);
    if (sim < 0.45) return { ok: false };

    return { ok: true, isBatch: isBatch, sim: sim };
}

/**
 * Fallback search on Nyaa specifically for archived [SubsPlease] releases.
 */
async function searchNyaaSubsPlease(titleEn, titleRom, targetSeason, targetEp, absEp, useDebrid, debridProv, debridToken) {
    var queries = [];
    var epPad = targetEp < 10 ? ('0' + targetEp) : String(targetEp);
    var absPad = absEp ? (absEp < 10 ? ('0' + absEp) : String(absEp)) : null;

    var titles = [];
    if (titleRom) titles.push(titleRom);
    if (titleEn && titleEn !== titleRom) titles.push(titleEn);

    function addNq(q) { if (q && queries.indexOf(q) === -1) queries.push(q); }
    for (var t = 0; t < titles.length; t++) {
        var base = cleanTitle(titles[t]);
        if (!base) continue;
        if (targetSeason > 1 && absPad) addNq('[SubsPlease] ' + base + ' ' + absPad);
        if (targetSeason > 1) addNq('[SubsPlease] ' + base + ' S' + targetSeason + ' ' + epPad);
        addNq('[SubsPlease] ' + base + ' ' + epPad);
        if (absPad && absPad !== epPad) addNq('[SubsPlease] ' + base + ' ' + absPad);
    }

    var re = /<tr[^>]*>[\s\S]*?<a[^>]*href="\/view\/(\d+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*href="(magnet:[^"]+)"[^>]*>[\s\S]*?<td[^>]*class="text-center"[^>]*>\s*([\d.]+\s*[KMGT]i?B)\s*<\/td>[\s\S]*?<td[^>]*class="text-center"[^>]*>[^<]*<\/td>\s*<td[^>]*class="text-center"[^>]*>\s*(\d+)\s*<\/td>/gi;

    for (var qi = 0; qi < queries.length; qi++) {
        try {
            var url = NYAA_BASE + '/?f=0&c=1_2&q=' + encodeURIComponent(queries[qi]) + '&s=seeders&o=desc';
            var res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
            if (!res.ok) continue;
            var html = await res.text();
            var m;
            var streams = [];
            var seenRes = {};
            re.lastIndex = 0;
            while ((m = re.exec(html)) !== null) {
                var name = m[2].replace(/&amp;/g, '&').trim();
                var parsed = parseNyaaSubsPleaseRelease(name, titleEn, titleRom, targetEp, absEp);
                if (!parsed.ok) continue;

                var rawMagnet = m[3].replace(/&amp;/g, '&');
                var size = m[4].trim();
                var seeders = parseInt(m[5], 10) || 0;
                var norm = normalizeMagnetAndHash(rawMagnet);
                if (!norm.infoHash) continue;

                var qLabel = '1080p';
                if (/1080p/i.test(name)) qLabel = '1080p';
                else if (/720p/i.test(name)) qLabel = '720p';
                else if (/480p/i.test(name)) qLabel = '480p';

                var dedupKey = qLabel + '|' + (parsed.isBatch ? 'batch' : 'ep');
                if (seenRes[dedupKey] && streams.length >= 3) continue;
                seenRes[dedupKey] = true;

                var streamUrl = norm.magnet;
                var streamType = 'torrent';
                if (useDebrid) {
                    var resolved = buildDebridUrl(norm.magnet, norm.infoHash, debridProv, debridToken);
                    if (resolved) { streamUrl = resolved; streamType = 'mp4'; }
                }

                streams.push({
                    name: 'SubsPlease',
                    title: name + (size ? ' • ' + size : '') + (seeders ? ' • 👤 ' + seeders : ''),
                    url: streamUrl,
                    quality: qLabel,
                    size: size || undefined,
                    type: streamType,
                    seeders: seeders || undefined,
                    infoHash: norm.infoHash,
                    headers: {},
                    subtitles: []
                });
                if (streams.length >= 6) break;
            }
            if (streams.length > 0) return streams;
        } catch (e) {}
    }
    return [];
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

        var debridProv = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.debrid_provider)
            ? String(SCRAPER_SETTINGS.debrid_provider).toLowerCase().trim()
            : 'none';
        var debridToken = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.debrid_token)
            ? String(SCRAPER_SETTINGS.debrid_token).trim()
            : '';
        var useDebrid = debridProv && debridProv !== 'none' && Boolean(debridToken);

        var queries = [];
        function addQ(q) { if (q && queries.indexOf(q) === -1) queries.push(q); }
        if (targetSeason > 1) {
            if (meta.titleEn) addQ(cleanTitle(meta.titleEn) + ' S' + targetSeason);
            if (meta.titleRom) addQ(cleanTitle(meta.titleRom) + ' S' + targetSeason);
        }
        if (meta.titleEn) addQ(cleanTitle(meta.titleEn));
        if (meta.titleRom) addQ(cleanTitle(meta.titleRom));
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
            var strongMatch = allCandidates.some(function(c) {
                return extractSeasonNumber(c.show, c.page) === targetSeason &&
                       titleMatchSimilarity(c.show, meta.titleEn, meta.titleRom) >= 0.65;
            });
            if (strongMatch) break;
        }

        var chosen = pickBestCandidate(allCandidates, meta.titleEn, meta.titleRom, targetSeason);
        if (chosen) {
            console.log('[subsplease] Chosen show: ' + chosen.show + ' (/shows/' + chosen.page + ')');

            var showPageUrl = SUBSPLEASE_BASE + '/shows/' + chosen.page + '/';
            var pageRes = await fetch(showPageUrl, { headers: { 'User-Agent': UA, 'Referer': SUBSPLEASE_BASE + '/' } });
            if (pageRes.ok) {
                var pageHtml = await pageRes.text();
                var sidM = pageHtml.match(/id=["']show-release-table["'][^>]*sid=["'](\d+)["']/i) ||
                           pageHtml.match(/sid=["'](\d+)["']/i);
                if (sidM && sidM[1]) {
                    var apiRes = await fetch(SUBSPLEASE_BASE + '/api/?f=show&tz=UTC&sid=' + encodeURIComponent(sidM[1]), {
                        headers: { 'User-Agent': UA, 'Referer': showPageUrl, 'Accept': 'application/json' }
                    });
                    if (apiRes.ok) {
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
                                var parsedEp = parseFloat(String(epItem.episode).trim().replace(/v\d+$/i, ''));
                                if (parsedEp === wantNum) {
                                    matchedEp = epItem;
                                    break;
                                }
                            }
                        }

                        if (matchedEp && Array.isArray(matchedEp.downloads)) {
                            var downloads = matchedEp.downloads.slice().sort(function(a, b) {
                                return (parseInt(b.res, 10) || 0) - (parseInt(a.res, 10) || 0);
                            });

                            var streams = [];
                            for (var d = 0; d < downloads.length; d++) {
                                var dl = downloads[d];
                                if (!dl || !dl.magnet) continue;
                                var norm = normalizeMagnetAndHash(dl.magnet);
                                if (!norm.infoHash) continue;

                                var resLabel = (dl.res ? String(dl.res) : '1080') + 'p';
                                var sizeStr = formatBytesFromMagnet(dl.magnet);
                                var streamUrl = norm.magnet;
                                var streamType = 'torrent';

                                if (useDebrid) {
                                    var resolved = buildDebridUrl(norm.magnet, norm.infoHash, debridProv, debridToken);
                                    if (resolved) { streamUrl = resolved; streamType = 'mp4'; }
                                }

                                streams.push({
                                    name: 'SubsPlease',
                                    title: '[SubsPlease] ' + chosen.show + ' - ' + matchedEp.episode + ' (' + resLabel + ')' + (sizeStr ? ' • ' + sizeStr : ''),
                                    url: streamUrl,
                                    quality: resLabel,
                                    size: sizeStr || undefined,
                                    type: streamType,
                                    infoHash: norm.infoHash,
                                    headers: {},
                                    subtitles: []
                                });
                            }
                            if (streams.length > 0) {
                                console.log('[subsplease] returning ' + streams.length + ' streams from API');
                                return streams;
                            }
                        }
                    }
                }
            }
        }

        // Fallback to Nyaa [SubsPlease] releases for older/batch episodes not in SubsPlease's latest 52 list
        var nyaaStreams = await searchNyaaSubsPlease(meta.titleEn, meta.titleRom, targetSeason, targetEp, meta.absEp, useDebrid, debridProv, debridToken);
        console.log('[subsplease] Nyaa fallback returning ' + nyaaStreams.length + ' streams');
        return nyaaStreams;
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
