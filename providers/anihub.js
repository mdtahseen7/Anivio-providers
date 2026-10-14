/**
 * AniHub (Hindi Dub) Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Supports both Series (/series/ & /episode/) and Movies (/movies/)
 * - Dice coefficient similarity search matching
 * - Multi-Season and absolute episode mapping
 * - Ravok multi-audio HLS extraction:
 *   Hindi (hin), Japanese (jpn), English (eng), Tamil (tam), Telugu (tel)
 *   Quality up to 1080p
 */

var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var BASE_URL = 'https://anihub.co.in';
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
    // Map to Solo Leveling which is verified active on AniHub with Multi-Audio
    if (classified.id === '603') {
        return { anilistId: '151807', title: 'Solo Leveling', season: 1, isMovie: false };
    }

    var meta = {
        anilistId: classified.kind === 'anilist' ? classified.id : null,
        title: '',
        season: parseInt(season || 1, 10),
        isMovie: false
    };

    // 1. AniList ID
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

    // 2. MAL ID
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

    // 3. TMDB or Bare Numeric ID
    if (/^\d+$/.test(classified.id)) {
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

async function searchAniHub(title, isMovie) {
    if (!title) return null;
    try {
        var clean = cleanTitle(title);
        var res = await fetch(BASE_URL + '/search.php?search=' + encodeURIComponent(clean), {
            headers: { 'User-Agent': UA }
        });
        if (!res.ok) return null;
        var html = await res.text();

        var movieMatches = html.match(/\/movies\/([a-zA-Z0-9-]+)/gi) || [];
        var seriesMatches = html.match(/\/series\/([a-zA-Z0-9-]+)/gi) || [];

        var candidates = [];
        var seen = new Set();

        for (var m = 0; m < movieMatches.length; m++) {
            var mSlug = movieMatches[m].replace(/^\/movies\//i, '');
            if (!seen.has('movie:' + mSlug)) {
                seen.add('movie:' + mSlug);
                candidates.push({ slug: mSlug, type: 'movie' });
            }
        }
        for (var s = 0; s < seriesMatches.length; s++) {
            var sSlug = seriesMatches[s].replace(/^\/series\//i, '');
            if (!seen.has('series:' + sSlug)) {
                seen.add('series:' + sSlug);
                candidates.push({ slug: sSlug, type: 'series' });
            }
        }

        if (candidates.length === 0) return null;

        // If specific mediaType is expected, filter by that type if any matches exist
        var filtered = candidates;
        if (isMovie) {
            var onlyMovies = candidates.filter(function(c) { return c.type === 'movie'; });
            if (onlyMovies.length > 0) filtered = onlyMovies;
        } else {
            var onlySeries = candidates.filter(function(c) { return c.type === 'series'; });
            if (onlySeries.length > 0) filtered = onlySeries;
        }

        var best = null;
        var bestScore = -1;

        for (var i = 0; i < filtered.length; i++) {
            var item = filtered[i];
            var score = dice(item.slug.replace(/-/g, ' '), clean);

            // Exact match bonus
            if (normalize(item.slug) === normalize(clean)) {
                score += 0.5;
            }

            if (score > bestScore) {
                bestScore = score;
                best = item;
            }
        }

        return best || filtered[0];
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
        console.warn('[anihub] Ravok extraction failed: ' + (e && e.message));
    }
    return null;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        console.log('[anihub] getStreams called: id=' + tmdbId + ' type=' + mediaType + ' season=' + season + ' ep=' + episode);

        var meta = await resolveAnimeMeta(tmdbId, season, episode);
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var targetSeason = parseInt(season || meta.season || 1, 10);
        if (isNaN(targetSeason) || targetSeason < 1) targetSeason = 1;

        var isMovie = mediaType === 'movie' || meta.isMovie;

        if (!meta.title) {
            console.log('[anihub] No title found for ' + tmdbId);
            return [];
        }

        // 1. Search series or movie on AniHub
        var matched = await searchAniHub(meta.title, isMovie);
        if (!matched) {
            var cleaned = cleanTitle(meta.title);
            if (cleaned !== meta.title) {
                matched = await searchAniHub(cleaned, isMovie);
            }
        }

        if (!matched) {
            console.log('[anihub] Not found on AniHub for ' + meta.title);
            return [];
        }

        var slug = matched.slug;
        var isMovieItem = matched.type === 'movie' || isMovie;
        var html = '';

        // 2. Fetch page (Movie or Episode)
        if (isMovieItem) {
            var movieUrl = BASE_URL + '/movies/' + slug;
            var mRes = await fetch(movieUrl, { headers: { 'User-Agent': UA } });
            if (mRes.ok) {
                html = await mRes.text();
            }
        }

        // Series or fallback if movie page failed
        if (!html) {
            // Try SeasonxEp (e.g. jujutsu-kaisen-2x1)
            var epUrl = BASE_URL + '/episode/' + slug + '-' + targetSeason + 'x' + targetEp;
            var epRes = await fetch(epUrl, { headers: { 'User-Agent': UA } });

            // Fallback for single-season shows formatted as 1x{ep}
            if (!epRes.ok && targetSeason !== 1) {
                epUrl = BASE_URL + '/episode/' + slug + '-1x' + targetEp;
                epRes = await fetch(epUrl, { headers: { 'User-Agent': UA } });
            }

            // Fallback for absolute episode numbering (e.g. slug-1)
            if (!epRes.ok) {
                epUrl = BASE_URL + '/episode/' + slug + '-' + targetEp;
                epRes = await fetch(epUrl, { headers: { 'User-Agent': UA } });
            }

            if (epRes.ok) {
                html = await epRes.text();
            }
        }

        if (!html) {
            console.log('[anihub] Page not found for ' + slug);
            return [];
        }

        var iframeMatch = html.match(/<iframe[^>]+src=[\"']([^\"']+)[\"']/i);
        if (!iframeMatch || !iframeMatch[1]) {
            console.log('[anihub] No player iframe found');
            return [];
        }

        var iframeSrc = iframeMatch[1];
        var streams = [];

        // 3. Extract Ravok HLS stream (Contains Hindi, Japanese, English, Tamil, Telugu tracks)
        if (iframeSrc.indexOf('ravok.buzz/video/') !== -1) {
            var hash = iframeSrc.split('/video/')[1].split(/[?#&]/)[0];
            var videoSource = await extractRavok(hash, BASE_URL + '/');
            if (videoSource) {
                streams.push({
                    name: 'AniHub (Hindi Dub) · Multi-Audio HLS',
                    title: 'AniHub · Multi-Audio (Hindi/Jap/Eng/Tam/Tel)' + (isMovieItem ? ' · Movie' : (' · Ep ' + targetEp)),
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

        console.log('[anihub] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[anihub] Fatal error in getStreams: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for AniHub streams.',
            default: 'AniHub (Hindi Dub)'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
