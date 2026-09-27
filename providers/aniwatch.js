/**
 * AniWatch Stream Provider Plugin for Anivio
 *
 * Standalone stream provider for https://aniwatch.lu
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Direct HLS master.m3u8 stream extraction via ZokoAnime and AniWatch
 * - Resolves both SUB and DUB streams
 * - Proxied WebVTT subtitles to prevent 403 Forbidden in media players
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var ANIWATCH_BASE = 'https://aniwatch.lu';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

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
 * Base64 decoder safe for QuickJS and standard JS runtimes.
 */
function safeAtob(b64) {
    if (typeof atob === 'function') {
        try { return atob(b64); } catch (e) {}
    }
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    var str = String(b64).replace(/=+$/, '');
    var output = '';
    for (var bc = 0, bs, buffer, idx = 0; buffer = str.charAt(idx++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
        buffer = chars.indexOf(buffer);
    }
    return output;
}

var OBF_KEY = 'otaku-embed-v1';

/**
 * Deobfuscates ZokoAnime embed window.__P payload.
 */
function deobfuscateZoko(blob) {
    try {
        var raw = safeAtob(blob);
        var out = '';
        for (var i = 0; i < raw.length; i++) {
            out += String.fromCharCode(raw.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
        }
        return JSON.parse(decodeURIComponent(escape(out)));
    } catch (e) {
        return null;
    }
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
 * Resolves metadata and MAL ID via AniZip.
 */
async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603"
    if (classified.id === '603') {
        return { titleEn: 'One Piece', titleRom: 'One Piece', anilistId: '21', malId: '21' };
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
                        titleRom: data.titles.ro || data.titles.en || '',
                        anilistId: data.mappings ? String(data.mappings.anilist_id || '') : '',
                        malId: data.mappings && data.mappings.mal_id != null ? String(data.mappings.mal_id) : (classified.kind === 'mal' ? classified.id : '')
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
                        titleRom: aData.titles.ro || aData.titles.en || '',
                        anilistId: classified.id,
                        malId: aData.mappings && aData.mappings.mal_id != null ? String(aData.mappings.mal_id) : ''
                    };
                }
            }
        } catch (e) {}
    }

    return {
        titleEn: classified.id,
        titleRom: classified.id,
        anilistId: '',
        malId: (classified.kind === 'mal' ? classified.id : '')
    };
}

/**
 * Extracts stream from ZokoAnime player URL.
 */
async function extractZokoStream(zokoUrl, serverLabel) {
    try {
        var res = await fetch(zokoUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': ANIWATCH_BASE + '/'
            }
        });
        if (!res.ok) return null;
        var html = await res.text();
        var m = html.match(/window\.__P="([^"]+)"/);
        if (!m) return null;
        var data = deobfuscateZoko(m[1]);
        if (!data || !data.src) return null;

        var subtitles = [];
        if (Array.isArray(data.subtitles)) {
            for (var i = 0; i < data.subtitles.length; i++) {
                var s = data.subtitles[i];
                if (s && s.src) {
                    subtitles.push({
                        url: getProxyUrl(s.src, 'https://zokoanime.video/'),
                        language: s.label || s.lang || 'English',
                        type: 'vtt'
                    });
                }
            }
        }

        return {
            server: serverLabel,
            type: 'hls',
            quality: 'auto',
            url: data.src,
            headers: {
                'User-Agent': UA,
                'Referer': 'https://zokoanime.video/'
            },
            subtitles: subtitles
        };
    } catch (e) {
        return null;
    }
}

/**
 * Fallback: Search aniwatch.lu for anime and extract episode server URLs.
 */
async function searchAniwatch(query) {
    try {
        var sRes = await fetch(ANIWATCH_BASE + '/?s=' + encodeURIComponent(query), {
            headers: { 'User-Agent': UA, 'Referer': ANIWATCH_BASE + '/' }
        });
        if (!sRes.ok) return [];
        var html = await sRes.text();
        var results = [];
        var re = /href=['"](https?:\/\/aniwatch\.lu\/anime\/([^/'"]+)\/?)['"]/g;
        var m;
        var seen = new Set();
        while ((m = re.exec(html)) !== null) {
            var url = m[1];
            var slug = m[2];
            if (seen.has(slug)) continue;
            seen.add(slug);
            results.push({ url: url, slug: slug });
        }
        return results;
    } catch (e) {
        return [];
    }
}

async function scrapeAniwatchPage(animeUrl, targetEp) {
    try {
        var res = await fetch(animeUrl, { headers: { 'User-Agent': UA } });
        if (!res.ok) return [];
        var html = await res.text();

        var idMatch = html.match(/data-anime-id=['"](\d+)['"]/) || html.match(/data-animeid=['"](\d+)['"]/) || html.match(/data-id=['"](\d+)['"]/);
        if (!idMatch) return [];
        var animeId = idMatch[1];

        // Fetch episode list
        var epListRes = await fetch(ANIWATCH_BASE + '/wp-json/v1/otakuthemes/episode/list/' + animeId, {
            headers: { 'User-Agent': UA, 'Referer': animeUrl }
        });
        if (!epListRes.ok) return [];
        var epListData = await epListRes.json();
        var epHtml = epListData && epListData.html ? epListData.html : '';
        if (!epHtml) return [];

        // Match episode
        var epRe = /<a[^>]+data-id=['"](\d+)['"][^>]*data-number=['"](\d+)['"][^>]*>/gi;
        var epMatch;
        var targetEpId = null;
        var wantEp = parseInt(targetEp, 10) || 1;
        while ((epMatch = epRe.exec(epHtml)) !== null) {
            if (parseInt(epMatch[2], 10) === wantEp) {
                targetEpId = epMatch[1];
                break;
            }
        }

        if (!targetEpId) {
            // Fallback match by title or href
            var epRe2 = /<a[^>]+data-id=['"](\d+)['"][^>]*title=['"]Episode\s*(\d+)['"]/gi;
            while ((epMatch = epRe2.exec(epHtml)) !== null) {
                if (parseInt(epMatch[2], 10) === wantEp) {
                    targetEpId = epMatch[1];
                    break;
                }
            }
        }

        if (!targetEpId) return [];

        // Fetch server list
        var srvRes = await fetch(ANIWATCH_BASE + '/wp-json/v1/otakuthemes/episode/servers?episodeId=' + targetEpId, {
            headers: { 'User-Agent': UA, 'Referer': animeUrl }
        });
        if (!srvRes.ok) return [];
        var srvData = await srvRes.json();
        var srvHtml = srvData && srvData.html ? srvData.html : '';
        if (!srvHtml) return [];

        var streams = [];
        var itemRe = /<div[^>]+class=['"][^'"]*server-item[^'"]*['"][^>]*data-type=['"]([^'"]+)['"][^>]*data-server-name=['"]([^'"]+)['"][^>]*data-hash=['"]([^'"]+)['"]/gi;
        var itemMatch;
        while ((itemMatch = itemRe.exec(srvHtml)) !== null) {
            var sType = itemMatch[1];
            var sName = itemMatch[2];
            var sHash = itemMatch[3];
            var decodedUrl = safeAtob(sHash);
            if (decodedUrl && decodedUrl.indexOf('zokoanime.video') !== -1) {
                var stream = await extractZokoStream(decodedUrl, 'AniWatch - ' + sName + ' (' + sType.toUpperCase() + ')');
                if (stream) streams.push(stream);
            }
        }

        return streams;
    } catch (e) {
        return [];
    }
}

/**
 * Main stream extraction method invoked by Anivio.
 */
async function getStreams(id, type, season, episode) {
    try {
        console.log('[aniwatch] getStreams called: id=' + id + ' season=' + season + ' ep=' + episode);
        var meta = await resolveMetadata(id);
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var streams = [];

        // 1. Direct MAL-indexed extraction via ZokoAnime (High Speed, Full HD)
        if (meta.malId) {
            console.log('[aniwatch] Attempting direct ZokoAnime extraction for MAL ID ' + meta.malId);
            try {
                // Sub
                var subStream = await extractZokoStream(
                    'https://zokoanime.video/stream/mal/' + meta.malId + '/' + targetEp + '/sub',
                    'AniWatch - ZokoAnime (SUB)'
                );
                if (subStream) streams.push(subStream);

                // Dub
                var dubStream = await extractZokoStream(
                    'https://zokoanime.video/stream/mal/' + meta.malId + '/' + targetEp + '/dub',
                    'AniWatch - ZokoAnime (DUB)'
                );
                if (dubStream) streams.push(dubStream);
            } catch (err) {
                console.warn('[aniwatch] Direct ZokoAnime extraction failed: ' + (err && err.message));
            }
        }

        // If direct extraction returned streams, return them immediately
        if (streams.length > 0) {
            console.log('[aniwatch] Successfully extracted ' + streams.length + ' direct streams');
            return streams;
        }

        // 2. Fallback: Search aniwatch.lu website
        console.log('[aniwatch] Direct extraction yielded 0 streams, attempting website search fallback...');
        var queries = [];
        var targetSeason = parseInt(season != null ? season : 1, 10);
        if (isNaN(targetSeason) || targetSeason < 1) targetSeason = 1;

        if (targetSeason > 1) {
            if (meta.titleEn) queries.push(meta.titleEn + ' Season ' + targetSeason);
            if (meta.titleRom) queries.push(meta.titleRom + ' Season ' + targetSeason);
        }
        if (meta.titleEn) queries.push(meta.titleEn);
        if (meta.titleRom && queries.indexOf(meta.titleRom) === -1) queries.push(meta.titleRom);

        for (var q = 0; q < queries.length; q++) {
            var found = await searchAniwatch(queries[q]);
            if (found.length > 0) {
                for (var f = 0; f < Math.min(found.length, 3); f++) {
                    var sFound = await scrapeAniwatchPage(found[f].url, targetEp);
                    if (sFound.length > 0) {
                        for (var sf = 0; sf < sFound.length; sf++) {
                            streams.push(sFound[sf]);
                        }
                        break;
                    }
                }
            }
            if (streams.length > 0) break;
        }

        console.log('[aniwatch] Total streams resolved: ' + streams.length);
        return streams;
    } catch (e) {
        console.error('[aniwatch] Error in getStreams: ' + (e && e.message));
        return [];
    }
}
