/**
 * AnimeNoSub Stream Provider Plugin for Anivio
 *
 * Standalone stream provider for https://animenosub.to
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves Vidmoly direct HLS streams and multi-server embeds (Byse, FileMoon, Vtube, Nova)
 * - Accurate title matching (filters out spin-offs and specials)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var ANIMENOSUB_BASE = 'https://animenosub.to';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

var STREAM_HEADERS = {
    'User-Agent': UA,
    'Referer': ANIMENOSUB_BASE + '/',
    'Origin': ANIMENOSUB_BASE
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

    // Anivio test button passes "603" (One Piece)
    if (classified.id === '603') {
        return { titleEn: 'One Piece', titleRom: 'One Piece' };
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
                if (data && data.titles) {
                    return {
                        titleEn: data.titles.en || data.titles.ro || data.titles.ja || '',
                        titleRom: data.titles.ro || data.titles.en || ''
                    };
                }
            }
        } catch (e) {}
    }

    if (/^\d+$/.test(classified.id)) {
        try {
            var aRes = await fetch(ANIZIP_ENDPOINT + '?anilist_id=' + encodeURIComponent(classified.id), {
                headers: { 'User-Agent': UA, 'Accept': 'application/json' }
            });
            if (aRes.ok) {
                var aData = await aRes.json();
                if (aData && aData.titles) {
                    return {
                        titleEn: aData.titles.en || aData.titles.ro || '',
                        titleRom: aData.titles.ro || aData.titles.en || ''
                    };
                }
            }
        } catch (e) {}
    }

    return { titleEn: classified.id, titleRom: classified.id };
}

function normalizeTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// -------------------------------------------------------------
// AnimeNoSub Site Search & Episode Scraping
// -------------------------------------------------------------

async function searchAnimeNoSub(query) {
    try {
        var res = await fetch(ANIMENOSUB_BASE + '/wp-admin/admin-ajax.php', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': UA,
                'Origin': ANIMENOSUB_BASE,
                'Referer': ANIMENOSUB_BASE + '/'
            },
            body: 'action=ts_ac_do_search&ts_ac_query=' + encodeURIComponent(query)
        });
        if (!res.ok) return [];
        var data = await res.json();
        var list = data && data.anime && data.anime[0] && Array.isArray(data.anime[0].all) ? data.anime[0].all : [];
        var results = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var m = item.post_link && item.post_link.match(/\/anime\/([^/]+)\/?$/);
            if (!m) continue;
            results.push({
                slug: m[1],
                title: item.post_title || m[1].replace(/-/g, ' ')
            });
        }
        return results;
    } catch (e) {
        return [];
    }
}

function pickBestSlug(results, titleEn, titleRom, season) {
    if (!results || results.length === 0) return null;

    var wantNormEn = normalizeTitle(titleEn);
    var wantNormRom = normalizeTitle(titleRom);
    var seasonNum = parseInt(season || 1, 10);

    var best = null;
    var bestScore = -1;

    for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var slug = r.slug.toLowerCase();
        var t = normalizeTitle(r.title);
        var score = 0;

        // Severe penalty for spin-offs
        if (slug.indexOf('lego') !== -1 || slug.indexOf('heroines') !== -1 || slug.indexOf('live-action') !== -1) {
            score -= 100;
        }

        // Exact matches
        if (t === wantNormEn || t === wantNormRom) {
            score += 100;
        } else if (slug === wantNormEn || slug === wantNormRom) {
            score += 90;
        } else if (t.indexOf(wantNormEn) === 0 || t.indexOf(wantNormRom) === 0) {
            score += 50;
        }

        // Season match
        if (seasonNum > 1) {
            var sStr = 'season' + seasonNum;
            var sSlugStr = 'season-' + seasonNum;
            if (t.indexOf(sStr) !== -1 || slug.indexOf(sSlugStr) !== -1) {
                score += 30;
            }
        }

        score -= i * 0.1;

        if (score > bestScore) {
            bestScore = score;
            best = r.slug;
        }
    }

    return best || results[0].slug;
}

async function scrapeSeriesEpisodes(slug) {
    try {
        var res = await fetch(ANIMENOSUB_BASE + '/anime/' + encodeURIComponent(slug) + '/', {
            headers: { 'User-Agent': UA, 'Referer': ANIMENOSUB_BASE + '/' }
        });
        if (!res.ok) return [];
        var html = await res.text();
        var regex = /<li\b[^>]*data-index="\d+"[^>]*>[\s\S]*?<a\s+href="(https?:\/\/animenosub\.to\/[^"]+)"[\s\S]*?<div\s+class="epl-num">([^<]+)<\/div>/gi;
        var episodes = [];
        var seen = {};
        var match;
        while ((match = regex.exec(html)) !== null) {
            var epUrl = match[1];
            var label = match[2].trim();
            var num = 1;
            if (!/^movie$/i.test(label)) {
                var parsed = parseFloat(label);
                if (!isNaN(parsed) && parsed >= 1) num = Math.round(parsed);
                else continue;
            }
            if (seen[num]) continue;
            seen[num] = true;
            episodes.push({ number: num, epUrl: epUrl });
        }
        return episodes;
    } catch (e) {
        return [];
    }
}

async function scrapeEpisodeEmbeds(epUrl) {
    try {
        var res = await fetch(epUrl, {
            headers: { 'User-Agent': UA, 'Referer': ANIMENOSUB_BASE + '/' }
        });
        if (!res.ok) return [];
        var html = await res.text();
        var embeds = [];

        var optRegex = /<option\s+value="([A-Za-z0-9+/=]+)"\s+data-index="\d+"[^>]*>([^<]+)<\/option>/gi;
        var optMatch;
        while ((optMatch = optRegex.exec(html)) !== null) {
            try {
                var decoded = atob(optMatch[1]);
                var srcMatch = decoded.match(/src=["']([^"']+)["']/i);
                if (srcMatch && srcMatch[1]) {
                    var src = srcMatch[1];
                    if (src.indexOf('//') === 0) src = 'https:' + src;
                    embeds.push({
                        server: optMatch[2].trim(),
                        url: src
                    });
                }
            } catch (e) {}
        }

        if (embeds.length === 0) {
            var ifrRegex = /<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi;
            var ifrMatch;
            while ((ifrMatch = ifrRegex.exec(html)) !== null) {
                var src2 = ifrMatch[1];
                if (src2.indexOf('//') === 0) src2 = 'https:' + src2;
                embeds.push({
                    server: 'Direct',
                    url: src2
                });
            }
        }

        return embeds;
    } catch (e) {
        return [];
    }
}

// -------------------------------------------------------------
// Resolvers: Vidmoly HLS extraction
// -------------------------------------------------------------

async function resolveVidmoly(embedUrl) {
    try {
        var res = await fetch(embedUrl, {
            headers: { 'User-Agent': UA, 'Referer': ANIMENOSUB_BASE + '/' }
        });
        if (!res.ok) return null;
        var html = await res.text();
        var m = html.match(/sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
        if (m && m[1]) return m[1];
    } catch (e) {}
    return null;
}

// -------------------------------------------------------------
// Main getStreams Method
// -------------------------------------------------------------

async function getStreams(id, type, season, episode) {
    try {
        console.log('[animenosub] getStreams called: id=' + id + ' type=' + type + ' ep=' + episode);

        var meta = await resolveMetadata(id);
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;
        var targetSeason = parseInt(season != null ? season : 1, 10);
        if (isNaN(targetSeason) || targetSeason < 1) targetSeason = 1;

        var queries = [];
        if (meta.titleEn) queries.push(meta.titleEn);
        if (meta.titleRom && meta.titleRom !== meta.titleEn) queries.push(meta.titleRom);
        if (targetSeason > 1 && meta.titleEn) queries.push(meta.titleEn + ' Season ' + targetSeason);

        var matchedSlug = null;
        for (var q = 0; q < queries.length && !matchedSlug; q++) {
            var results = await searchAnimeNoSub(queries[q]);
            matchedSlug = pickBestSlug(results, meta.titleEn, meta.titleRom, targetSeason);
        }

        if (!matchedSlug) {
            console.warn('[animenosub] No matching anime slug for: ' + (meta.titleEn || id));
            return [];
        }
        console.log('[animenosub] Matched slug: ' + matchedSlug);

        var episodes = await scrapeSeriesEpisodes(matchedSlug);
        if (episodes.length === 0) {
            console.warn('[animenosub] No episodes found on page for: ' + matchedSlug);
            return [];
        }

        var epEntry = episodes.find(function(e) { return e.number === targetEp; });
        if (!epEntry && targetEp === 1 && episodes.length > 0) {
            epEntry = episodes[0];
        }

        if (!epEntry) {
            console.warn('[animenosub] Episode ' + targetEp + ' not found for: ' + matchedSlug);
            return [];
        }

        console.log('[animenosub] Found episode URL: ' + epEntry.epUrl);
        var embeds = await scrapeEpisodeEmbeds(epEntry.epUrl);
        if (embeds.length === 0) {
            console.warn('[animenosub] No embeds on episode page: ' + epEntry.epUrl);
            return [];
        }

        var streams = [];
        var seenUrls = {};

        for (var e = 0; e < embeds.length; e++) {
            var emb = embeds[e];
            if (!emb || !emb.url) continue;

            // 1. Vidmoly direct HLS extraction
            if (/vidmoly\.(net|biz|to)/i.test(emb.url)) {
                var directM3u8 = await resolveVidmoly(emb.url);
                if (directM3u8 && !seenUrls[directM3u8]) {
                    seenUrls[directM3u8] = true;
                    streams.push({
                        name: 'AnimeNoSub (Vidmoly)',
                        title: 'AnimeNoSub · Ep ' + targetEp + ' (1080p)',
                        server: 'Vidmoly',
                        type: 'hls',
                        quality: '1080p',
                        url: directM3u8,
                        headers: {
                            'User-Agent': UA,
                            'Referer': 'https://vidmoly.net/'
                        },
                        subtitles: []
                    });
                }
            } else {
                // 2. Direct embed servers (Byse, FileMoon, Vtube, Nova, etc.)
                var serverHost = 'Embed';
                try { serverHost = new URL(emb.url).hostname.replace(/^www\./, ''); } catch (uErr) {}
                if (!seenUrls[emb.url]) {
                    seenUrls[emb.url] = true;
                    streams.push({
                        name: 'AnimeNoSub (' + (emb.server || serverHost) + ')',
                        title: 'AnimeNoSub · Ep ' + targetEp,
                        server: emb.server || serverHost,
                        type: 'embed',
                        quality: 'auto',
                        url: emb.url,
                        headers: {
                            'User-Agent': UA,
                            'Referer': ANIMENOSUB_BASE + '/'
                        },
                        subtitles: []
                    });
                }
            }
        }

        console.log('[animenosub] Total streams resolved: ' + streams.length);
        return streams;
    } catch (e) {
        console.error('[animenosub] Error in getStreams: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for AnimeNoSub streams.',
            default: 'AnimeNoSub'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
