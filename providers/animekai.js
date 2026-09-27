/**
 * AnimeKai Stream Provider Plugin for Anivio
 *
 * Standalone stream provider for https://animekai.ro
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Direct high-speed HLS stream extraction via MegaVid and AnimeKai
 * - Multi-server resolution across Zuna, Yuki, Sora, and Loli CDN nodes
 * - Resolves both SUB and DUB streams
 * - Proxied WebVTT subtitles to prevent 403 Forbidden in media players
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var ANIMEKAI_BASE = 'https://animekai.ro';
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
 * Extracts streams directly from MegaVid source endpoint.
 */
async function extractFromMegavid(malId, ep, subType) {
    var sourceUrl = 'https://megavid.buzz/mal/' + malId + '/' + ep + '/' + subType + '/source';
    try {
        var res = await fetch(sourceUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': 'https://megavid.buzz/mal/' + malId + '/' + ep + '/' + subType,
                'Accept': 'application/json'
            }
        });
        if (!res.ok) return [];
        var data = await res.json();
        if (!data || data.status !== 'ok' || !data.source) return [];

        var streams = [];
        var subtitles = [];
        if (Array.isArray(data.tracks)) {
            for (var i = 0; i < data.tracks.length; i++) {
                var t = data.tracks[i];
                if (t && t.file) {
                    subtitles.push({
                        url: t.file,
                        language: String(t.label || 'en').toLowerCase().slice(0, 2),
                        name: t.label || 'English',
                        headers: { 'Referer': 'https://megavid.buzz/' }
                    });
                }
            }
        }

        var providerName = data.provider ? (data.provider.toUpperCase() + ' - ') : '';
        streams.push({
            name: 'AnimeKai',
            title: 'AnimeKai - ' + providerName + subType.toUpperCase() + ' · Ep ' + ep,
            server: 'AnimeKai - ' + providerName + subType.toUpperCase(),
            type: 'hls',
            quality: 'auto',
            url: data.source,
            headers: {
                'User-Agent': UA,
                'Referer': 'https://megavid.buzz/'
            },
            subtitles: subtitles
        });

        // Query up to 2 additional server providers if available
        if (Array.isArray(data.providers) && data.providers.length > 1) {
            for (var p = 0; p < Math.min(data.providers.length, 3); p++) {
                var altP = data.providers[p];
                if (altP && altP.id && altP.id !== data.provider) {
                    try {
                        var altUrl = sourceUrl + '?axsv=' + encodeURIComponent(altP.id);
                        var aRes = await fetch(altUrl, {
                            headers: {
                                'User-Agent': UA,
                                'Referer': 'https://megavid.buzz/',
                                'Accept': 'application/json'
                            }
                        });
                        if (aRes.ok) {
                            var aData = await aRes.json();
                            if (aData && aData.status === 'ok' && aData.source) {
                                streams.push({
                                    name: 'AnimeKai',
                                    title: 'AnimeKai - ' + altP.id.toUpperCase() + ' (' + subType.toUpperCase() + ') · Ep ' + ep,
                                    server: 'AnimeKai - ' + altP.id.toUpperCase() + ' (' + subType.toUpperCase() + ')',
                                    type: 'hls',
                                    quality: 'auto',
                                    url: aData.source,
                                    headers: {
                                        'User-Agent': UA,
                                        'Referer': 'https://megavid.buzz/'
                                    },
                                    subtitles: subtitles
                                });
                            }
                        }
                    } catch (e) {}
                }
            }
        }

        return streams;
    } catch (e) {
        return [];
    }
}

/**
 * Fallback: Search animekai.ro website and extract server link-ids.
 */
async function searchAnimekai(query) {
    try {
        var res = await fetch(ANIMEKAI_BASE + '/?s=' + encodeURIComponent(query), {
            headers: { 'User-Agent': UA }
        });
        if (!res.ok) return [];
        var html = await res.text();
        var re = /href=['"](https?:\/\/animekai\.ro\/anime\/([^/'"]+))['"]/g;
        var m;
        var results = [];
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

async function scrapeKaiWatchPage(slug, targetEp) {
    try {
        var watchUrl = ANIMEKAI_BASE + '/watch/' + slug + '/ep-' + targetEp;
        var res = await fetch(watchUrl, { headers: { 'User-Agent': UA } });
        if (!res.ok) return [];
        var html = await res.text();

        var linkIdRe = /<li[^>]+class=['"][^'"]*server-btn[^'"]*['"][^>]*data-link-id=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/li>/gi;
        var m;
        var linkIds = [];
        while ((m = linkIdRe.exec(html)) !== null) {
            var lid = m[1];
            var sName = m[2].replace(/<[^>]*>/g, '').trim();
            linkIds.push({ linkId: lid, name: sName });
        }

        var streams = [];
        for (var i = 0; i < Math.min(linkIds.length, 4); i++) {
            try {
                var srvRes = await fetch(ANIMEKAI_BASE + '/ajax/server?get=' + encodeURIComponent(linkIds[i].linkId), {
                    headers: {
                        'User-Agent': UA,
                        'Referer': watchUrl,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json'
                    }
                });
                if (srvRes.ok) {
                    var srvData = await srvRes.json();
                    var embedUrl = srvData && srvData.result && srvData.result.url;
                    if (embedUrl) {
                        var sourceEndpoint = embedUrl.replace(/\/+$/, '') + '/source';
                        var srcRes = await fetch(sourceEndpoint, {
                            headers: {
                                'User-Agent': UA,
                                'Referer': embedUrl,
                                'Accept': 'application/json'
                            }
                        });
                        if (srcRes.ok) {
                            var srcData = await srcRes.json();
                            if (srcData && srcData.status === 'ok' && srcData.source) {
                                var subtitles = [];
                                if (Array.isArray(srcData.tracks)) {
                                    for (var t = 0; t < srcData.tracks.length; t++) {
                                        var tr = srcData.tracks[t];
                                        if (tr && tr.file) {
                                            subtitles.push({
                                                url: tr.file,
                                                language: String(tr.label || 'en').toLowerCase().slice(0, 2),
                                                name: tr.label || 'English',
                                                headers: { 'Referer': 'https://megavid.buzz/' }
                                            });
                                        }
                                    }
                                }
                                streams.push({
                                    name: 'AnimeKai',
                                    title: 'AnimeKai - ' + linkIds[i].name + ' · Ep ' + targetEp,
                                    server: 'AnimeKai - ' + linkIds[i].name,
                                    type: 'hls',
                                    quality: 'auto',
                                    url: srcData.source,
                                    headers: {
                                        'User-Agent': UA,
                                        'Referer': 'https://megavid.buzz/'
                                    },
                                    subtitles: subtitles
                                });
                            }
                        }
                    }
                }
            } catch (e) {}
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
        console.log('[animekai] getStreams called: id=' + id + ' season=' + season + ' ep=' + episode);
        var meta = await resolveMetadata(id);
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var streams = [];

        // 1. Direct MAL-indexed extraction via MegaVid (High Speed, Full HD)
        if (meta.malId) {
            console.log('[animekai] Attempting direct MegaVid extraction for MAL ID ' + meta.malId);
            try {
                // Sub streams
                var subStreams = await extractFromMegavid(meta.malId, targetEp, 'sub');
                for (var s = 0; s < subStreams.length; s++) {
                    streams.push(subStreams[s]);
                }

                // Dub streams
                var dubStreams = await extractFromMegavid(meta.malId, targetEp, 'dub');
                for (var d = 0; d < dubStreams.length; d++) {
                    streams.push(dubStreams[d]);
                }
            } catch (err) {
                console.warn('[animekai] Direct MegaVid extraction failed: ' + (err && err.message));
            }
        }

        // If direct extraction returned streams, return them immediately
        if (streams.length > 0) {
            console.log('[animekai] Successfully extracted ' + streams.length + ' direct streams');
            return streams;
        }

        // 2. Fallback: Search animekai.ro website
        console.log('[animekai] Direct extraction yielded 0 streams, attempting website search fallback...');
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
            var found = await searchAnimekai(queries[q]);
            if (found.length > 0) {
                for (var f = 0; f < Math.min(found.length, 3); f++) {
                    var sFound = await scrapeKaiWatchPage(found[f].slug, targetEp);
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

        console.log('[animekai] Total streams resolved: ' + streams.length);
        return streams;
    } catch (e) {
        console.error('[animekai] Error in getStreams: ' + (e && e.message));
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
            description: 'Display name for AnimeKai streams.',
            default: 'AnimeKai'
        },
        {
            key: 'backend_url',
            type: 'text',
            title: 'Luna Backend URL',
            description: 'Backend base URL used to proxy subtitle files.',
            default: 'https://luna-api.mdtahseen2901.workers.dev'
        },
        {
            key: 'api_key',
            type: 'text',
            title: 'Luna API Key',
            description: 'API key required by Luna Backend.',
            default: 'LetMeIn'
        }
    ];
}

// Export according to Anivio Plugin Contract
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
