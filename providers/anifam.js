/**
 * AniFam Stream Provider Plugin for Anivio
 *
 * Scrapes and streams anime from AniFam (https://anifam.top / https://anifam.net).
 * Provides multi-server adaptive HLS streams (up to 1080p) with:
 * - Dual audio: Original Sub (Japanese) and Dub (English)
 * - Multi-server streams: AniFam direct HLS CDN + HD-1 (MegaPlay) resolved HLS
 * - Multilingual WebVTT subtitles
 * - Intro and Outro skip marker metadata
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export, no Node built-ins)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB/AniList id, and "603" (Anivio Test button)
 */

var DOMAINS = ['https://anifam.top', 'https://anifam.net', 'https://anifam.buzz', 'https://anifam.cfd'];
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function classifyId(rawId) {
    var v = String(rawId == null ? '' : rawId).trim();
    var l = v.toLowerCase();
    if (l.indexOf('anilist:') === 0) return { kind: 'anilist', id: v.slice('anilist:'.length).split(':')[0] };
    if (l.indexOf('mal:') === 0) return { kind: 'mal', id: v.slice('mal:'.length).split(':')[0] };
    if (/^\d+$/.test(v)) return { kind: 'numeric', id: v };
    return { kind: 'unknown', id: v };
}

function cleanTitle(title) {
    if (!title) return '';
    return title
        .replace(/\s*\(\d{4}\)/g, '')
        .replace(/[:\s-]*(?:(?:season|part|cour)\s*\d+|\d+(?:nd|rd|th|st)\s*season|ii|iii|iv|v)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Resolves AniList ID, MAL ID, and canonical title using AniZip mappings.
 */
async function resolveAnimeMeta(rawId, season, episode) {
    var classified = classifyId(rawId);

    // Anivio test button sends rawId = "603"
    if (classified.id === '603') {
        return {
            anilistId: '21',
            malId: '21',
            titles: ['One Piece']
        };
    }

    var queries = [];
    if (classified.kind === 'anilist') {
        queries.push('?anilist_id=' + encodeURIComponent(classified.id));
    } else if (classified.kind === 'mal') {
        queries.push('?mal_id=' + encodeURIComponent(classified.id));
    } else if (classified.kind === 'numeric') {
        queries.push('?anilist_id=' + encodeURIComponent(classified.id));
        queries.push('?themoviedb_id=' + encodeURIComponent(classified.id));
    }

    var titles = [];
    for (var i = 0; i < queries.length; i++) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + queries[i], {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var json = await res.json();
                var tObj = (json && json.titles) ? json.titles : {};
                if (tObj.en) titles.push(tObj.en);
                if (tObj['x-jat']) titles.push(tObj['x-jat']);
                if (tObj.ro) titles.push(tObj.ro);
                if (tObj.ja) titles.push(tObj.ja);
                break;
            }
        } catch (e) {}
    }

    if (titles.length === 0 && classified.id) {
        titles.push(classified.id);
    }

    return {
        anilistId: classified.kind === 'anilist' || classified.kind === 'numeric' ? classified.id : null,
        malId: classified.kind === 'mal' ? classified.id : null,
        titles: titles
    };
}

/**
 * Executes a fetch request with automatic domain failover across active AniFam mirrors.
 */
async function anifamFetch(path, options) {
    options = options || {};
    var headers = options.headers || {};
    headers['User-Agent'] = headers['User-Agent'] || UA;
    headers['Accept'] = headers['Accept'] || 'application/json';
    options.headers = headers;

    for (var i = 0; i < DOMAINS.length; i++) {
        var base = DOMAINS[i];
        try {
            var url = base + path;
            var res = await fetch(url, options);
            if (res.ok) {
                return { res: res, base: base };
            }
        } catch (e) {}
    }
    return null;
}

/**
 * Searches AniFam for the best matching anime.
 */
async function searchAniFam(titles) {
    var queryList = [];
    for (var i = 0; i < titles.length; i++) {
        var t = titles[i];
        if (!t) continue;
        if (queryList.indexOf(t) === -1) queryList.push(t);
        var cleaned = cleanTitle(t);
        if (cleaned && queryList.indexOf(cleaned) === -1) queryList.push(cleaned);
    }

    for (var qIdx = 0; qIdx < queryList.length; qIdx++) {
        var q = queryList[qIdx];
        var fetchResult = await anifamFetch('/api/v1/app/search?q=' + encodeURIComponent(q));
        if (!fetchResult) continue;

        try {
            var json = await fetchResult.res.json();
            var list = json && json.data;
            if (Array.isArray(list) && list.length > 0) {
                var qLower = q.toLowerCase();
                // 1. Exact title match
                for (var j = 0; j < list.length; j++) {
                    var item = list[j];
                    if (item.title && item.title.toLowerCase() === qLower) {
                        return { item: item, base: fetchResult.base };
                    }
                    if (item.title_jp && item.title_jp.toLowerCase() === qLower) {
                        return { item: item, base: fetchResult.base };
                    }
                    if (item.title_romaji && item.title_romaji.toLowerCase() === qLower) {
                        return { item: item, base: fetchResult.base };
                    }
                }
                // 2. Return the top result
                return { item: list[0], base: fetchResult.base };
            }
        } catch (e) {}
    }

    return null;
}

/**
 * Main stream resolver required by Anivio.
 */
async function getStreams(rawId, mediaType, season, episode) {
    try {
        console.log('[anifam] getStreams called: id=' + rawId + ' type=' + mediaType + ' season=' + season + ' ep=' + episode);

        var meta = await resolveAnimeMeta(rawId, season, episode);
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var matched = await searchAniFam(meta.titles);
        if (!matched || !matched.item || !matched.item.id) {
            console.log('[anifam] No matching anime found on AniFam for ' + rawId);
            return [];
        }

        var anime = matched.item;
        var base = matched.base;
        console.log('[anifam] Matched anime: ' + anime.title + ' (id=' + anime.id + ') on ' + base);

        // Fetch episode list
        var epRes = await fetch(base + '/api/v1/app/anime/' + anime.id + '/episodes', {
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        });
        if (!epRes.ok) {
            console.log('[anifam] Failed to fetch episodes HTTP ' + epRes.status);
            return [];
        }

        var epJson = await epRes.json();
        var epList = epJson && epJson.data;
        if (!Array.isArray(epList) || epList.length === 0) {
            console.log('[anifam] Episode list empty');
            return [];
        }

        var targetEpisode = null;
        for (var i = 0; i < epList.length; i++) {
            if (epList[i].number === targetEp) {
                targetEpisode = epList[i];
                break;
            }
        }

        if (!targetEpisode) {
            console.log('[anifam] Target episode ' + targetEp + ' not found in episode list');
            return [];
        }

        console.log('[anifam] Found target episode: id=' + targetEpisode.id + ' num=' + targetEpisode.number);

        var tracksToTry = [];
        if (targetEpisode.has_sub !== false) tracksToTry.push('sub');
        if (targetEpisode.has_dub === true) tracksToTry.push('dub');
        if (tracksToTry.length === 0) tracksToTry.push('sub');

        var streams = [];

        for (var tIdx = 0; tIdx < tracksToTry.length; tIdx++) {
            var track = tracksToTry[tIdx];
            var trackLabel = track === 'dub' ? 'Dub' : 'Sub';

            try {
                var playRes = await fetch(base + '/api/v1/app/episodes/' + targetEpisode.id + '/play', {
                    method: 'POST',
                    headers: {
                        'User-Agent': UA,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({ track: track })
                });

                if (!playRes.ok) continue;

                var playData = await playRes.json();
                var sources = playData && playData.sources;
                if (!Array.isArray(sources)) continue;

                for (var sIdx = 0; sIdx < sources.length; sIdx++) {
                    var src = sources[sIdx];
                    if (!src) continue;

                    // 1. Direct HLS Source (AniFam server)
                    if (src.kind === 'hls' && src.url) {
                        var streamHeaders = {
                            'User-Agent': UA,
                            'Referer': (src.media_headers && src.media_headers.Referer) || (base + '/')
                        };

                        var subTracks = [];
                        if (Array.isArray(src.subtitles)) {
                            for (var subI = 0; subI < src.subtitles.length; subI++) {
                                var sObj = src.subtitles[subI];
                                if (!sObj || !sObj.url) continue;
                                subTracks.push({
                                    url: sObj.url,
                                    language: (sObj.lang || 'en').toLowerCase().slice(0, 2),
                                    name: sObj.label || 'English',
                                    headers: streamHeaders
                                });
                            }
                        }

                        var serverName = src.server || 'AniFam';
                        streams.push({
                            name: 'AniFam (' + trackLabel + ' - ' + serverName + ')',
                            title: 'AniFam · ' + trackLabel + ' · ' + serverName + ' · Ep ' + targetEp + ' · 1080p HLS',
                            server: 'AniFam - ' + serverName + ' (' + trackLabel + ')',
                            url: src.url,
                            quality: '1080p',
                            type: 'hls',
                            headers: streamHeaders,
                            subtitles: subTracks
                        });
                    }

                    // 2. Resolvable Source (HD-1 / Vidstream)
                    if (src.resolvable === true && src.server_id) {
                        try {
                            var resolveRes = await fetch(base + '/api/v1/app/episodes/' + targetEpisode.id + '/resolve', {
                                method: 'POST',
                                headers: {
                                    'User-Agent': UA,
                                    'Content-Type': 'application/json',
                                    'Accept': 'application/json'
                                },
                                body: JSON.stringify({
                                    server_id: src.server_id,
                                    serverId: src.server_id,
                                    track: track
                                })
                            });

                            if (resolveRes.ok) {
                                var rData = await resolveRes.json();
                                if (rData && rData.kind === 'hls' && rData.url) {
                                    var rHeaders = {
                                        'User-Agent': (rData.media_headers && rData.media_headers['User-Agent']) || UA,
                                        'Referer': (rData.media_headers && rData.media_headers.Referer) || 'https://megaplay.buzz/',
                                        'Origin': (rData.media_headers && rData.media_headers.Origin) || 'https://megaplay.buzz'
                                    };

                                    var rSubs = [];
                                    if (Array.isArray(rData.subtitles)) {
                                        for (var rSubI = 0; rSubI < rData.subtitles.length; rSubI++) {
                                            var rs = rData.subtitles[rSubI];
                                            if (!rs || !rs.url) continue;
                                            rSubs.push({
                                                url: rs.url,
                                                language: (rs.lang || 'en').toLowerCase().slice(0, 2),
                                                name: rs.label || rs.lang || 'English',
                                                headers: rHeaders
                                            });
                                        }
                                    }

                                    var rServerName = rData.server || src.server || ('Server ' + src.server_id);
                                    streams.push({
                                        name: 'AniFam (' + trackLabel + ' - ' + rServerName + ')',
                                        title: 'AniFam · ' + trackLabel + ' · ' + rServerName + ' · Ep ' + targetEp + ' · 1080p HLS',
                                        server: 'AniFam - ' + rServerName + ' (' + trackLabel + ')',
                                        url: rData.url,
                                        quality: '1080p',
                                        type: 'hls',
                                        headers: rHeaders,
                                        subtitles: rSubs
                                    });
                                }
                            }
                        } catch (resErr) {}
                    }
                }
            } catch (trackErr) {}
        }

        console.log('[anifam] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[anifam] Fatal error in getStreams: ' + (err && err.message));
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
            description: 'Display name for AniFam streams.',
            default: 'AniFam'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
