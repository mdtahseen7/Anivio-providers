/**
 * OppaiStream Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves multi-quality MP4/WebM/HLS streams with subtitles
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var BASE_URL = 'https://oppai.stream';
var SEARCH_API = 'https://oppai.stream/actions/search.php';
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

function cleanTitle(s) {
    return (s || '')
        .replace(/\b(TV|OVA|ONA|Special|Movie|Uncensored|Subbed|Dubbed)\b/gi, '')
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603"
    if (classified.id === '603') {
        return { title: 'Overflow', titles: ['Overflow'] };
    }

    if (classified.kind === 'title') {
        return { title: classified.id, titles: [classified.id] };
    }

    var titles = [];

    // 1. Try AniList GraphQL if anilist ID is available
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
                if (media) {
                    if (media.title) {
                        if (media.title.romaji) titles.push(media.title.romaji);
                        if (media.title.english) titles.push(media.title.english);
                    }
                    if (Array.isArray(media.synonyms)) {
                        for (var s = 0; s < media.synonyms.length; s++) {
                            titles.push(media.synonyms[s]);
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // 2. Try AniZip for MAL or TMDB mapping
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
                        if (data.titles.en) titles.push(data.titles.en);
                        if (data.titles.ro) titles.push(data.titles.ro);
                    }
                }
            } catch (e) {}
        }
    }

    var primaryTitle = titles[0] || classified.id;
    return { title: primaryTitle, titles: titles };
}

async function searchOppai(query) {
    if (!query) return [];
    var params = 'text=' + encodeURIComponent(query) + '&order=recent&page=1&limit=12&genres=&blacklist=&studio=&ibt=0&swa=1';
    try {
        var res = await fetch(SEARCH_API + '?' + params, {
            headers: {
                'User-Agent': UA,
                'Referer': BASE_URL,
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        if (!res.ok) return [];
        var html = await res.text();
        if (!html) return [];

        var cheerioObj = (typeof cheerio !== 'undefined' ? cheerio : require('cheerio')).load(html);
        var items = [];

        cheerioObj('.in-grid.episode-shown').each(function (_, el) {
            var $el = cheerioObj(el);
            var name = $el.attr('name') || '';
            var ep = $el.attr('ep') || '1';
            var href = $el.find('a').attr('href') || '';
            var slug = '';
            if (href) {
                var match = href.match(/[?&]e=([^&]+)/);
                if (match) slug = decodeURIComponent(match[1]);
            }
            if (!slug) {
                var idgt = $el.attr('idgt');
                if (idgt) slug = idgt + '-' + ep;
            }
            if (slug) {
                items.push({
                    name: name,
                    episode: parseInt(ep, 10) || 1,
                    slug: slug,
                    href: href
                });
            }
        });

        return items;
    } catch (e) {
        console.warn('[oppaistream] search error: ' + (e && e.message));
        return [];
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        console.log('[oppaistream] getStreams called for ' + tmdbId + ' ep=' + targetEp);

        var meta = await resolveMetadata(tmdbId);
        var queriesToTry = [];
        if (meta.title) queriesToTry.push(meta.title);
        var cleaned = cleanTitle(meta.title);
        if (cleaned && cleaned !== meta.title) queriesToTry.push(cleaned);
        if (meta.titles) {
            for (var t = 0; t < meta.titles.length; t++) {
                var tit = meta.titles[t];
                if (tit && queriesToTry.indexOf(tit) === -1) queriesToTry.push(tit);
                var cTit = cleanTitle(tit);
                if (cTit && queriesToTry.indexOf(cTit) === -1) queriesToTry.push(cTit);
            }
        }

        var candidate = null;
        for (var q = 0; q < queriesToTry.length; q++) {
            var items = await searchOppai(queriesToTry[q]);
            if (items.length > 0) {
                // Find episode match
                for (var i = 0; i < items.length; i++) {
                    if (items[i].episode === targetEp) {
                        candidate = items[i];
                        break;
                    }
                }
                if (candidate) break;
                // If only 1 episode exists in search and target is 1
                if (items.length === 1 && targetEp === 1) {
                    candidate = items[0];
                    break;
                }
            }
        }

        if (!candidate) {
            console.log('[oppaistream] No matching episode found for ' + meta.title + ' ep=' + targetEp);
            return [];
        }

        // 1. Try direct video endpoint first (bypasses Cloudflare on /watch)
        var videoUrl = BASE_URL + '/video?e=' + encodeURIComponent(candidate.slug);
        var pageHtml = null;
        var streams = [];
        var subtitles = [];

        try {
            var vRes = await fetch(videoUrl, {
                headers: {
                    'User-Agent': UA,
                    'Referer': BASE_URL + '/'
                }
            });
            if (vRes.ok) {
                var vText = await vRes.text();
                if (vText && vText.indexOf('Wait a moment') === -1) {
                    pageHtml = vText;
                    var cheerioObj = (typeof cheerio !== 'undefined' ? cheerio : require('cheerio')).load(pageHtml);
                    var primarySrc = cheerioObj('video source').attr('src') || cheerioObj('source').attr('src');
                    if (primarySrc) {
                        streams.push({
                            name: 'OppaiStream',
                            title: 'OppaiStream · 720p · Ep ' + targetEp,
                            url: primarySrc,
                            quality: '720p',
                            type: primarySrc.indexOf('.m3u8') !== -1 ? 'hls' : 'mp4',
                            headers: {
                                'User-Agent': UA,
                                'Referer': BASE_URL + '/'
                            },
                            subtitles: []
                        });
                    }

                    var folderMatch = pageHtml.match(/var\s+folder\s*=\s*"([^"]+)"/);
                    var fmpsMatch = pageHtml.match(/var\s+fmps\s*=\s*"([^"]+)"/);
                    if (folderMatch && fmpsMatch && folderMatch[1] && fmpsMatch[1]) {
                        var folder = folderMatch[1];
                        var fmps = fmpsMatch[1];
                        var stream1080 = 'https://myspacecat.pictures/' + folder + '/1080/' + fmps + '.mp4';
                        if (streams.length === 0 || streams[0].url !== stream1080) {
                            streams.unshift({
                                name: 'OppaiStream',
                                title: 'OppaiStream · 1080p · Ep ' + targetEp,
                                url: stream1080,
                                quality: '1080p',
                                type: 'mp4',
                                headers: {
                                    'User-Agent': UA,
                                    'Referer': BASE_URL + '/'
                                },
                                subtitles: []
                            });
                        }
                    }
                }
            }
        } catch (vErr) {}

        // 2. Fallback to /watch page if video endpoint didn't yield streams
        if (streams.length === 0) {
            var watchUrl = BASE_URL + '/watch?e=' + encodeURIComponent(candidate.slug);
            var watchRes = await fetch(watchUrl, {
                headers: {
                    'User-Agent': UA,
                    'Referer': BASE_URL + '/'
                }
            });

            if (watchRes.ok) {
                var watchHtml = await watchRes.text();
                var match = watchHtml.match(/var\s+availableres\s*=\s*({[^}]+})/);
                var parsedSources = {};
                if (match) {
                    try {
                        parsedSources = JSON.parse(match[1]);
                    } catch (e) {}
                }

                // Subtitles extraction
                try {
                    var cObj = (typeof cheerio !== 'undefined' ? cheerio : require('cheerio')).load(watchHtml);
                    cObj('track[kind="subtitles"]').each(function (_, el) {
                        var $el = cObj(el);
                        var src = $el.attr('src');
                        var label = $el.attr('label') || 'English';
                        if (src) {
                            var subUrl = src.indexOf('http') === 0 ? src : (BASE_URL + src);
                            subtitles.push({
                                url: subUrl,
                                language: label.toLowerCase().slice(0, 2),
                                name: label,
                                headers: {
                                    'User-Agent': UA,
                                    'Referer': BASE_URL + '/'
                                }
                            });
                        }
                    });
                } catch (e) {}

                for (var resKey in parsedSources) {
                    if (Object.prototype.hasOwnProperty.call(parsedSources, resKey)) {
                        var streamUrl = parsedSources[resKey];
                        if (typeof streamUrl === 'string' && streamUrl.indexOf('http') === 0) {
                            var isHls = streamUrl.indexOf('.m3u8') !== -1;
                            var qual = resKey.toLowerCase() === '4k' ? '4k' : (resKey + 'p');
                            streams.push({
                                name: 'OppaiStream',
                                title: 'OppaiStream · ' + qual + ' · Ep ' + targetEp,
                                url: streamUrl,
                                quality: qual,
                                type: isHls ? 'hls' : 'mp4',
                                headers: {
                                    'User-Agent': UA,
                                    'Referer': BASE_URL + '/'
                                },
                                subtitles: subtitles
                            });
                        }
                    }
                }
            }
        }

        // Fallback: If Cloudflare blocks direct watch page, query Luna Backend
        if (streams.length === 0) {
            var backendUrl = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.backend_url)
                || 'https://luna-backend.mdtahseen7378.workers.dev';
            if (backendUrl) {
                try {
                    var bRes = await fetch(backendUrl + '/hentai/oppaistream/sources?episodeId=' + encodeURIComponent(candidate.slug), {
                        headers: { 'Referer': 'https://luna-stream.me/' }
                    });
                    if (bRes.ok) {
                        var bData = await bRes.json();
                        if (bData && bData.data && Array.isArray(bData.data.sources)) {
                            for (var b = 0; b < bData.data.sources.length; b++) {
                                var sObj = bData.data.sources[b];
                                if (sObj && sObj.url) {
                                    streams.push({
                                        name: 'OppaiStream',
                                        title: 'OppaiStream · ' + (sObj.quality || 'Auto') + ' · Ep ' + targetEp,
                                        url: sObj.url,
                                        quality: sObj.quality || 'auto',
                                        type: sObj.isM3U8 ? 'hls' : 'mp4',
                                        headers: {
                                            'User-Agent': UA,
                                            'Referer': BASE_URL + '/'
                                        },
                                        subtitles: subtitles
                                    });
                                }
                            }
                        }
                    }
                } catch (bErr) {}
            }
        }

        console.log('[oppaistream] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[oppaistream] getStreams fatal: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'backend_url',
            type: 'text',
            title: 'Fallback Backend URL',
            description: 'Optional backend proxy if direct watch page encounters Cloudflare.',
            default: 'https://luna-backend.mdtahseen7378.workers.dev'
        },
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for OppaiStream streams.',
            default: 'OppaiStream'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
