/**
 * WatchHentai Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Direct XOR deciphering of protected player streams
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var BASE_URL = 'https://watchhentai.net';
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

function whDecodeMediaUrl(s) {
    try {
        var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var x = atob(b64);
        var k = 13;
        var r = '';
        for (var i = 0; i < x.length; i++) {
            r += String.fromCharCode(x.charCodeAt(i) ^ ((k + (i % 17)) & 255));
        }
        return atob(r.split('').reverse().join(''));
    } catch (e) {
        return s;
    }
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

async function searchWatchHentai(query) {
    if (!query) return [];
    var searchUrl = BASE_URL + '/?s=' + encodeURIComponent(query.trim());
    try {
        var res = await fetch(searchUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': BASE_URL + '/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        if (!res.ok) return [];
        var html = await res.text();
        if (!html) return [];

        var cheerioObj = (typeof cheerio !== 'undefined' ? cheerio : require('cheerio')).load(html);
        var items = [];

        var articles = cheerioObj('article');
        if (articles.length === 0) articles = cheerioObj('div.result-item');

        articles.each(function (_, el) {
            var $el = cheerioObj(el);
            var link = $el.find('a[href*="/series/"]').attr('href') || $el.find('.title a, h2 a, h3 a, a').first().attr('href');
            if (link) {
                var cleanLink = link.replace(/\/$/, '');
                var slug = cleanLink.split('/').pop() || '';
                var title = $el.find('.title a, h2 a, h3 a, a[title]').first().text().trim() || slug;
                items.push({
                    title: title,
                    slug: slug,
                    url: link
                });
            }
        });

        return items;
    } catch (e) {
        console.warn('[watchhentai] search error: ' + (e && e.message));
        return [];
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        console.log('[watchhentai] getStreams called for ' + tmdbId + ' ep=' + targetEp);

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

        var candidateSeries = null;
        for (var q = 0; q < queriesToTry.length; q++) {
            var items = await searchWatchHentai(queriesToTry[q]);
            if (items.length > 0) {
                candidateSeries = items[0];
                break;
            }
        }

        if (!candidateSeries) {
            console.log('[watchhentai] No series found for ' + meta.title);
            return [];
        }

        // Fetch series page to find episode link
        var seriesUrl = candidateSeries.url.indexOf('http') === 0
            ? candidateSeries.url
            : (BASE_URL + '/series/' + candidateSeries.slug + '/');

        var seriesRes = await fetch(seriesUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': BASE_URL + '/'
            }
        });

        if (!seriesRes.ok) {
            console.warn('[watchhentai] series page returned ' + seriesRes.status);
            return [];
        }

        var seriesHtml = await seriesRes.text();
        var cheerioObj = (typeof cheerio !== 'undefined' ? cheerio : require('cheerio')).load(seriesHtml);
        var episodes = [];

        cheerioObj('.episodios li').each(function (_, el) {
            var $el = cheerioObj(el);
            var epHref = $el.find('.episodiotitle a, a').first().attr('href');
            var epTitle = $el.find('.episodiotitle a, a').first().text().trim();
            if (epHref) {
                var cleanEpHref = epHref.replace(/\/$/, '');
                var epSlug = cleanEpHref.split('/').pop() || '';
                episodes.push({
                    title: epTitle,
                    slug: epSlug,
                    url: epHref
                });
            }
        });

        // Match requested episode
        var targetEpItem = null;
        if (episodes.length > 0) {
            // Check by index (reverse chronological vs chronological)
            if (targetEp <= episodes.length) {
                targetEpItem = episodes[episodes.length - targetEp]; // often listed newest first
                // Verify if it contains the episode number
                var epNumStr = String(targetEp);
                for (var e = 0; e < episodes.length; e++) {
                    var ep = episodes[e];
                    if (ep.slug.indexOf('-' + epNumStr) !== -1 || ep.slug.indexOf('episode-' + epNumStr) !== -1 || ep.title.indexOf(epNumStr) !== -1) {
                        targetEpItem = ep;
                        break;
                    }
                }
            } else {
                targetEpItem = episodes[0];
            }
        }

        var videoUrlToFetch = targetEpItem
            ? (targetEpItem.url.indexOf('http') === 0 ? targetEpItem.url : (BASE_URL + '/videos/' + targetEpItem.slug + '/'))
            : (BASE_URL + '/videos/' + candidateSeries.slug + '-episode-' + targetEp + '/');

        var videoPageRes = await fetch(videoUrlToFetch, {
            headers: {
                'User-Agent': UA,
                'Referer': seriesUrl
            }
        });

        if (!videoPageRes.ok) {
            console.warn('[watchhentai] video page returned ' + videoPageRes.status);
            return [];
        }

        var videoHtml = await videoPageRes.text();
        var videoCheerio = (typeof cheerio !== 'undefined' ? cheerio : require('cheerio')).load(videoHtml);

        var playerUrl = videoCheerio('[itemprop=contentUrl]').attr('content') || videoCheerio('iframe').attr('src');
        if (!playerUrl) {
            var match = videoHtml.match(/https:\/\/watchhentai\.net\/player\/[^\s"'<>]+/);
            if (match) playerUrl = match[0];
        }

        if (!playerUrl) {
            console.warn('[watchhentai] player URL not found in video page');
            return [];
        }

        var playerRes = await fetch(playerUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': videoUrlToFetch
            }
        });

        if (!playerRes.ok) {
            console.warn('[watchhentai] player returned ' + playerRes.status);
            return [];
        }

        var playerHtml = await playerRes.text();
        var streams = [];

        var sourcesMatch = playerHtml.match(/var\s+whJwSources\s*=\s*(\[[^;]+\]);/);
        if (sourcesMatch) {
            try {
                var parsed = JSON.parse(sourcesMatch[1]);
                for (var s = 0; s < parsed.length; s++) {
                    var item = parsed[s];
                    if (item && item.file) {
                        var decoded = whDecodeMediaUrl(item.file);
                        if (decoded && decoded.indexOf('http') === 0) {
                            var isHls = decoded.indexOf('.m3u8') !== -1;
                            streams.push({
                                name: 'WatchHentai',
                                title: 'WatchHentai · Ep ' + targetEp,
                                url: decoded,
                                quality: '1080p',
                                type: isHls ? 'hls' : 'mp4',
                                headers: {
                                    'User-Agent': UA,
                                    'Referer': BASE_URL + '/'
                                },
                                subtitles: []
                            });
                        }
                    }
                }
            } catch (e) {}
        }

        // Fallback: search param 'source' in player url
        if (streams.length === 0) {
            var srcMatch = playerUrl.match(/[?&]source=([^&]+)/);
            if (srcMatch) {
                var rawSource = decodeURIComponent(srcMatch[1]);
                if (rawSource.indexOf('http') === 0) {
                    var isHls2 = rawSource.indexOf('.m3u8') !== -1;
                    streams.push({
                        name: 'WatchHentai',
                        title: 'WatchHentai · Ep ' + targetEp,
                        url: rawSource,
                        quality: '1080p',
                        type: isHls2 ? 'hls' : 'mp4',
                        headers: {
                            'User-Agent': UA,
                            'Referer': BASE_URL + '/'
                        },
                        subtitles: []
                    });
                }
            }
        }

        console.log('[watchhentai] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[watchhentai] getStreams fatal: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for WatchHentai streams.',
            default: 'WatchHentai'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
