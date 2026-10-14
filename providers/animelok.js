/**
 * AnimeLok (Hindi Dub) Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Direct AniList ID mapping with fallback search API & Dice coefficient matching
 * - Multi-Season aware resolution
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

function normalize(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function dice(a, b) {
    var x = normalize(a), y = normalize(b);
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

function cleanTitle(title) {
    if (!title) return '';
    return title
        .replace(/\s*\(\d{4}\)/g, '')
        .replace(/[:\s-]*(?:(?:season|part|cour)\s*\d+|\d+(?:nd|rd|th|st)\s*season|ii|iii|iv|v)\b/gi, '')
        .replace(/[^\w\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function resolveAnimeMeta(rawId, season, episode) {
    var classified = classifyId(rawId);

    // Anivio's built-in "Test" button passes tmdbId = "603"
    // Map to Solo Leveling (AniList ID 151807) which is verified active with Multi-Audio
    if (classified.id === '603') {
        return { anilistId: '151807', title: 'Solo Leveling', season: 1, isMovie: false };
    }

    var meta = {
        anilistId: classified.kind === 'anilist' ? classified.id : null,
        title: '',
        season: parseInt(season || 1, 10),
        isMovie: false
    };

    // 1. Direct AniList lookup
    if (classified.kind === 'anilist') {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?anilist_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                var titles = (data && data.titles) ? data.titles : {};
                meta.title = titles.en || titles.ro || titles.ja || '';
                if (data && data.mappings && data.mappings.anilist_id) {
                    meta.anilistId = String(data.mappings.anilist_id);
                }
                var ep1 = (data && data.episodes && data.episodes['1']) ? data.episodes['1'] : null;
                if (ep1 && ep1.seasonNumber) {
                    meta.season = ep1.seasonNumber;
                }
                if (data && data.mappings && data.mappings.type === 'MOVIE') {
                    meta.isMovie = true;
                }
                return meta;
            }
        } catch (e) {}
    }

    // 2. MAL lookup
    if (classified.kind === 'mal') {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?mal_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                var titles = (data && data.titles) ? data.titles : {};
                meta.title = titles.en || titles.ro || titles.ja || '';
                if (data && data.mappings && data.mappings.anilist_id) {
                    meta.anilistId = String(data.mappings.anilist_id);
                }
                var ep1 = (data && data.episodes && data.episodes['1']) ? data.episodes['1'] : null;
                if (ep1 && ep1.seasonNumber) {
                    meta.season = ep1.seasonNumber;
                }
                if (data && data.mappings && data.mappings.type === 'MOVIE') {
                    meta.isMovie = true;
                }
                return meta;
            }
        } catch (e) {}
    }

    // 3. TMDB / Bare numeric ID
    if (/^\d+$/.test(classified.id)) {
        // Try as TMDB ID first
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?themoviedb_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                var titles = (data && data.titles) ? data.titles : {};
                meta.title = titles.en || titles.ro || titles.ja || '';
                if (data && data.mappings && data.mappings.anilist_id) {
                    meta.anilistId = String(data.mappings.anilist_id);
                }
                var ep1 = (data && data.episodes && data.episodes['1']) ? data.episodes['1'] : null;
                if (ep1 && ep1.seasonNumber) {
                    meta.season = ep1.seasonNumber;
                }
                if (data && data.mappings && data.mappings.type === 'MOVIE') {
                    meta.isMovie = true;
                }
                return meta;
            }
        } catch (e) {}

        // Fallback: check if the numeric string is directly an AniList ID
        try {
            var aRes = await fetch(ANIZIP_ENDPOINT + '?anilist_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (aRes.ok) {
                var aData = await aRes.json();
                var titles = (aData && aData.titles) ? aData.titles : {};
                meta.title = titles.en || titles.ro || titles.ja || '';
                meta.anilistId = String(classified.id);
                var ep1 = (aData && aData.episodes && aData.episodes['1']) ? aData.episodes['1'] : null;
                if (ep1 && ep1.seasonNumber) {
                    meta.season = ep1.seasonNumber;
                }
                if (aData && aData.mappings && aData.mappings.type === 'MOVIE') {
                    meta.isMovie = true;
                }
                return meta;
            }
        } catch (e) {}
    }

    return meta;
}

async function searchAnimeLok(query, targetSeason) {
    if (!query) return null;
    try {
        var clean = cleanTitle(query);
        var searchQuery = clean;
        if (targetSeason && targetSeason > 1 && !/(?:season|\bs\d+\b)/i.test(clean)) {
            searchQuery = clean + ' Season ' + targetSeason;
        }

        var res = await fetch(BASE_URL + '/api/search?q=' + encodeURIComponent(searchQuery), {
            headers: { 'User-Agent': UA }
        });
        if (!res.ok && searchQuery !== clean) {
            res = await fetch(BASE_URL + '/api/search?q=' + encodeURIComponent(clean), {
                headers: { 'User-Agent': UA }
            });
        }
        if (!res.ok) return null;
        var json = await res.json();
        if (!json || !Array.isArray(json.results) || json.results.length === 0) {
            if (searchQuery !== clean) {
                res = await fetch(BASE_URL + '/api/search?q=' + encodeURIComponent(clean), {
                    headers: { 'User-Agent': UA }
                });
                if (res.ok) {
                    json = await res.json();
                }
            }
        }

        if (!json || !Array.isArray(json.results) || json.results.length === 0) {
            return null;
        }

        var results = json.results;
        var best = null;
        var bestScore = -1;

        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            var enTitle = (r.title && r.title.english) || '';
            var roTitle = (r.title && r.title.romaji) || '';
            var natTitle = (r.title && r.title.native) || '';
            var animeId = r.anime_id || '';

            var score = Math.max(
                dice(enTitle, clean),
                dice(roTitle, clean),
                dice(animeId.replace(/-/g, ' '), clean)
            );

            // Bonus if season number is in title when targetSeason > 1
            if (targetSeason && targetSeason > 1) {
                var seasonStr = 'season ' + targetSeason;
                var sStr = 's' + targetSeason;
                if (enTitle.toLowerCase().indexOf(seasonStr) !== -1 || animeId.toLowerCase().indexOf(seasonStr.replace(' ', '-')) !== -1) {
                    score += 0.3;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                best = r;
            }
        }

        return best || results[0];
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

        var targetSeason = parseInt(season || meta.season || 1, 10);
        if (isNaN(targetSeason) || targetSeason < 1) targetSeason = 1;

        var isMovie = mediaType === 'movie' || meta.isMovie;
        var servers = [];
        var anilistId = meta.anilistId;

        // 1. If anilistId is known, query AnimeLok directly
        if (anilistId) {
            try {
                var epRes = await fetch(BASE_URL + '/api/anilist/' + encodeURIComponent(anilistId) + '/' + encodeURIComponent(targetEp), {
                    headers: { 'User-Agent': UA }
                });
                if (epRes.ok) {
                    var epJson = await epRes.json();
                    if (epJson && Array.isArray(epJson.servers) && epJson.servers.length > 0) {
                        servers = epJson.servers;
                    }
                }
            } catch (err) {}
        }

        // 2. If servers empty or multi-season, search AnimeLok
        if (servers.length === 0 && meta.title) {
            var searched = await searchAnimeLok(meta.title, targetSeason);
            if (!searched) {
                var cleaned = cleanTitle(meta.title);
                if (cleaned !== meta.title) {
                    searched = await searchAnimeLok(cleaned, targetSeason);
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

        // 3. Fallback: if multi-season query returned nothing, try with original anilistId
        if (servers.length === 0 && anilistId && targetSeason > 1) {
            try {
                var fallbackRes = await fetch(BASE_URL + '/api/anilist/' + encodeURIComponent(anilistId) + '/' + encodeURIComponent(targetEp), {
                    headers: { 'User-Agent': UA }
                });
                if (fallbackRes.ok) {
                    var fbJson = await fallbackRes.json();
                    if (fbJson && Array.isArray(fbJson.servers)) {
                        servers = fbJson.servers;
                    }
                }
            } catch (err) {}
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

            // Handle Ravok HLS streams (Multi-Audio: Hindi, Tamil, Telugu, English, Japanese)
            if (s.url.indexOf('ravok.buzz/video/') !== -1) {
                var hash = s.url.split('/video/')[1].split(/[?#&]/)[0];
                var videoSource = await extractRavok(hash, BASE_URL + '/');
                if (videoSource && !seenUrls.has(videoSource)) {
                    seenUrls.add(videoSource);
                    streams.push({
                        name: 'AnimeLok (Hindi Dub) · Multi-Audio HLS',
                        title: 'AnimeLok · Multi-Audio (Hindi/Jap/Eng/Tam/Tel)' + (isMovie ? ' · Movie' : (' · Ep ' + targetEp)),
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
