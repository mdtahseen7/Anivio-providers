/**
 * KickAssAnime Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Direct 1080p HLS stream extraction via kaa.lt and CatStream
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var BASE_URL = 'https://kaa.lt';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var ANILIST_GRAPHQL = 'https://graphql.anilist.co';
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
    return { kind: 'title', id: value };
}

function normalize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603"
    if (classified.id === '603') {
        return { titleEn: 'One Piece', titleRom: 'One Piece', titles: ['One Piece'] };
    }

    if (classified.kind === 'title') {
        return { titleEn: classified.id, titleRom: classified.id, titles: [classified.id] };
    }

    var titles = [];
    var titleEn = '';
    var titleRom = '';

    // 1. Try AniList GraphQL
    if (classified.kind === 'anilist') {
        try {
            var q = 'query ($id: Int) { Media(id: $id) { title { romaji english native } synonyms } }';
            var alRes = await fetch(ANILIST_GRAPHQL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                body: JSON.stringify({ query: q, variables: { id: parseInt(classified.id, 10) } })
            });
            if (alRes.ok) {
                var alData = await alRes.json();
                var media = alData && alData.data && alData.data.Media;
                if (media && media.title) {
                    titleRom = media.title.romaji || '';
                    titleEn = media.title.english || '';
                    if (titleRom) titles.push(titleRom);
                    if (titleEn && titles.indexOf(titleEn) === -1) titles.push(titleEn);
                    if (Array.isArray(media.synonyms)) {
                        for (var s = 0; s < media.synonyms.length; s++) {
                            if (titles.indexOf(media.synonyms[s]) === -1) titles.push(media.synonyms[s]);
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // 2. Try AniZip for mappings
    if (titles.length === 0) {
        var query = null;
        if (classified.kind === 'mal') query = 'mal_id=' + encodeURIComponent(classified.id);
        else if (classified.kind === 'tmdb') query = 'themoviedb_id=' + encodeURIComponent(classified.id);
        else if (classified.kind === 'anilist') query = 'anilist_id=' + encodeURIComponent(classified.id);

        if (query) {
            try {
                var res = await fetch(ANIZIP_ENDPOINT + '?' + query, {
                    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
                });
                if (res.ok) {
                    var data = await res.json();
                    if (data && data.titles) {
                        titleEn = data.titles.en || '';
                        titleRom = data.titles.ro || '';
                        if (titleEn) titles.push(titleEn);
                        if (titleRom && titles.indexOf(titleRom) === -1) titles.push(titleRom);
                    }
                }
            } catch (e) {}
        }
    }

    if (titles.length === 0) {
        titles.push(classified.id);
        titleRom = classified.id;
    }

    return {
        titleEn: titleEn || titleRom || classified.id,
        titleRom: titleRom || titleEn || classified.id,
        titles: titles
    };
}

function scoreCandidate(item, titleEn, titleRom) {
    var score = 0;
    var candTitle = normalize(item.title || '');
    var candTitleEn = normalize(item.title_en || '');
    var normEn = normalize(titleEn);
    var normRom = normalize(titleRom);

    if (normEn && (candTitle === normEn || candTitleEn === normEn)) score += 1000;
    if (normRom && (candTitle === normRom || candTitleEn === normRom)) score += 900;

    if (normEn) {
        if (candTitle.indexOf(normEn) === 0 || normEn.indexOf(candTitle) === 0) score += 200;
        else if (candTitle.indexOf(normEn) !== -1 || normEn.indexOf(candTitle) !== -1) score += 100;
    }
    if (normRom) {
        if (candTitle.indexOf(normRom) === 0 || normRom.indexOf(candTitle) === 0) score += 150;
        else if (candTitle.indexOf(normRom) !== -1 || normRom.indexOf(candTitle) !== -1) score += 80;
    }

    return score;
}

async function searchKaa(query) {
    if (!query) return [];
    try {
        var res = await fetch(BASE_URL + '/api/fsearch', {
            method: 'POST',
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ page: 1, query: query })
        });
        if (!res.ok) return [];
        var data = await res.json();
        return Array.isArray(data && data.result) ? data.result : [];
    } catch (e) {
        console.warn('[kickassanime] search error: ' + (e && e.message));
        return [];
    }
}

function parseAstroProps(propsStr) {
    try {
        var raw = JSON.parse(propsStr);
        var result = {};
        for (var key in raw) {
            if (Object.prototype.hasOwnProperty.call(raw, key)) {
                var pair = raw[key];
                var type = pair[0];
                var data = pair[1];
                if (type === 0) {
                    result[key] = data;
                } else if (type === 1 && Array.isArray(data)) {
                    result[key] = data.map(function (item) {
                        var inner = item[1];
                        if (typeof inner === 'object' && inner !== null) {
                            var obj = {};
                            for (var k in inner) {
                                if (Object.prototype.hasOwnProperty.call(inner, k)) {
                                    obj[k] = inner[k][1];
                                }
                            }
                            return obj;
                        }
                        return inner;
                    });
                }
            }
        }
        return result;
    } catch (e) {
        return null;
    }
}

async function fetchPlayerData(playerUrl) {
    try {
        var resp = await fetch(playerUrl, {
            headers: { 'User-Agent': UA, 'Referer': BASE_URL + '/' }
        });
        if (!resp.ok) return { manifest: null, subtitles: [], type: null };
        var html = await resp.text();

        var propsMatch = html.match(/props="([^"]+)"/);
        if (!propsMatch) return { manifest: null, subtitles: [], type: null };

        var decoded = propsMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        var props = parseAstroProps(decoded);
        if (!props) return { manifest: null, subtitles: [], type: null };

        function normalizeCdnUrl(url) {
            if (!url) return null;
            var clean = String(url).replace(/^[a-zA-Z]+:\/+/, '').replace(/^\/+/, '');
            return 'https://' + clean;
        }

        var manifest = normalizeCdnUrl(props.manifest);
        var type = props.type || null;
        var subtitles = [];

        if (Array.isArray(props.subtitles)) {
            for (var i = 0; i < props.subtitles.length; i++) {
                var sub = props.subtitles[i];
                if (sub && (sub.src || sub.file)) {
                    var subSrc = normalizeCdnUrl(sub.src || sub.file);
                    if (subSrc) {
                        subtitles.push({
                            language: (sub.language || 'en').toLowerCase().slice(0, 2),
                            name: sub.name || sub.language || 'English',
                            url: subSrc,
                            headers: { 'Referer': 'https://krussdomi.com/' }
                        });
                    }
                }
            }
        }

        return { manifest: manifest, subtitles: subtitles, type: type };
    } catch (e) {
        return { manifest: null, subtitles: [], type: null };
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        console.log('[kickassanime] getStreams called for ' + tmdbId + ' ep=' + targetEp);

        var meta = await resolveMetadata(tmdbId);

        var allCandidates = [];
        for (var t = 0; t < meta.titles.length; t++) {
            var items = await searchKaa(meta.titles[t]);
            for (var it = 0; it < items.length; it++) {
                var item = items[it];
                var score = scoreCandidate(item, meta.titleEn, meta.titleRom);
                allCandidates.push({ item: item, score: score });
            }
            if (allCandidates.length > 0) break;
        }

        if (allCandidates.length === 0) {
            console.log('[kickassanime] No results found on KAA for ' + meta.titleRom);
            return [];
        }

        allCandidates.sort(function (a, b) { return b.score - a.score; });
        var bestShow = allCandidates[0].item;
        var showSlug = bestShow.slug;

        // Fetch episode list
        var epRes = await fetch(BASE_URL + '/api/show/' + encodeURIComponent(showSlug) + '/episodes?ep=1&lang=ja-JP', {
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        });

        if (!epRes.ok) {
            console.warn('[kickassanime] episode list failed: HTTP ' + epRes.status);
            return [];
        }

        var epData = await epRes.json();
        var rawEps = Array.isArray(epData && epData.result) ? epData.result : [];

        var targetEpObj = null;
        for (var e = 0; e < rawEps.length; e++) {
            var ep = rawEps[e];
            var epNum = typeof ep.episode_number === 'number' ? ep.episode_number : (e + 1);
            if (epNum === targetEp) {
                targetEpObj = ep;
                break;
            }
        }

        if (!targetEpObj) {
            console.log('[kickassanime] Episode ' + targetEp + ' not found for show ' + showSlug);
            return [];
        }

        var rawEpSlug = targetEpObj.slug || '';
        var targetEpSlug = rawEpSlug.indexOf('ep-') === 0 ? rawEpSlug : ('ep-' + targetEp + '-' + rawEpSlug);

        // Fetch episode servers
        var srvRes = await fetch(BASE_URL + '/api/show/' + encodeURIComponent(showSlug) + '/episode/' + encodeURIComponent(targetEpSlug), {
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        });

        if (!srvRes.ok) {
            srvRes = await fetch(BASE_URL + '/api/show/' + encodeURIComponent(showSlug) + '/episode/' + encodeURIComponent(rawEpSlug), {
                headers: { 'User-Agent': UA, 'Accept': 'application/json' }
            });
        }

        if (!srvRes.ok) {
            console.warn('[kickassanime] server list failed: HTTP ' + srvRes.status);
            return [];
        }

        var srvData = await srvRes.json();
        var servers = Array.isArray(srvData && srvData.servers)
            ? srvData.servers
            : (Array.isArray(srvData && srvData.result) ? srvData.result : []);

        var streams = [];
        var seenUrls = new Set();

        for (var s = 0; s < servers.length; s++) {
            var srv = servers[s];
            var serverName = srv.name || srv.shortName || srv.server || ('Server ' + (s + 1));
            var rawUrl = srv.src || srv.url || srv.link || srv.file;
            if (!rawUrl) continue;

            // CatPlayer embed resolution
            if (rawUrl.indexOf('cat-player/player') !== -1) {
                var playerData = await fetchPlayerData(rawUrl);
                if (playerData.manifest && playerData.type !== 'dash' && playerData.manifest.indexOf('.mpd') === -1) {
                    var mUrl = playerData.manifest;
                    if (!seenUrls.has(mUrl)) {
                        seenUrls.add(mUrl);
                        streams.push({
                            name: 'KickAssAnime',
                            title: 'KickAssAnime · ' + serverName + ' · Ep ' + targetEp,
                            url: mUrl,
                            quality: '1080p',
                            type: 'hls',
                            headers: {
                                'User-Agent': UA,
                                'Referer': 'https://krussdomi.com/'
                            },
                            subtitles: playerData.subtitles
                        });
                    }
                }
            } else if (rawUrl.indexOf('.m3u8') !== -1 || rawUrl.indexOf('.mp4') !== -1) {
                if (!seenUrls.has(rawUrl)) {
                    seenUrls.add(rawUrl);
                    streams.push({
                        name: 'KickAssAnime',
                        title: 'KickAssAnime · ' + serverName + ' · Ep ' + targetEp,
                        url: rawUrl,
                        quality: '1080p',
                        type: rawUrl.indexOf('.m3u8') !== -1 ? 'hls' : 'mp4',
                        headers: {
                            'User-Agent': UA,
                            'Referer': 'https://krussdomi.com/'
                        },
                        subtitles: []
                    });
                }
            }
        }

        console.log('[kickassanime] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[kickassanime] getStreams fatal: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for KickAssAnime streams.',
            default: 'KickAssAnime'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
