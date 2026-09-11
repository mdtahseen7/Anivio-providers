/**
 * Hentaigasm Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Direct MP4 stream extraction with playback headers
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var BASE_URL = 'https://hentaigasm.com';
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

async function searchHentaigasm(query) {
    if (!query) return [];
    var searchUrl = BASE_URL + '/?s=' + encodeURIComponent(query.trim());
    try {
        var res = await fetch(searchUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': BASE_URL + '/'
            }
        });
        if (!res.ok) return [];
        var html = await res.text();
        if (!html) return [];

        var cheerioObj = (typeof cheerio !== 'undefined' ? cheerio : require('cheerio')).load(html);
        var items = [];

        cheerioObj('.item.cf.item-post').each(function (_, el) {
            var $item = cheerioObj(el);
            var $link = $item.find('h2.title a');
            var href = $link.attr('href') || '';
            var title = $link.text().trim();
            if (href) {
                var cleanHref = href.replace(/\/$/, '');
                var slug = cleanHref.split('/').pop() || '';
                items.push({
                    title: title,
                    slug: slug,
                    url: href
                });
            }
        });

        return items;
    } catch (e) {
        console.warn('[hentaigasm] search error: ' + (e && e.message));
        return [];
    }
}

function matchesEpisode(title, targetEp) {
    if (!title) return false;
    var epStr = String(targetEp);
    var patterns = [
        new RegExp('\\bepisode\\s*' + epStr + '\\b', 'i'),
        new RegExp('\\bep\\s*' + epStr + '\\b', 'i'),
        new RegExp('\\s+' + epStr + '\\s+', 'i'),
        new RegExp('\\s+' + epStr + '$', 'i'),
        new RegExp('\\b' + epStr + '\\s*(?:sub|subbed|raw|dub|dubbed)', 'i'),
        new RegExp('-' + epStr + '-?', 'i')
    ];
    for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].test(title)) return true;
    }
    return false;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        console.log('[hentaigasm] getStreams called for ' + tmdbId + ' ep=' + targetEp);

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
            var items = await searchHentaigasm(queriesToTry[q]);
            if (items.length > 0) {
                // 1. Look for item matching episode
                for (var i = 0; i < items.length; i++) {
                    if (matchesEpisode(items[i].title, targetEp)) {
                        candidate = items[i];
                        break;
                    }
                }
                if (candidate) break;

                // 2. If looking for episode 1 and only 1 result or title matches without number
                if (targetEp === 1 && items.length > 0) {
                    candidate = items[0];
                    break;
                }
            }
        }

        if (!candidate) {
            console.log('[hentaigasm] No matching episode found for ' + meta.title + ' ep=' + targetEp);
            return [];
        }

        var targetUrl = candidate.url.indexOf('http') === 0 ? candidate.url : (BASE_URL + '/' + candidate.slug + '/');
        var pageRes = await fetch(targetUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': BASE_URL + '/'
            }
        });

        if (!pageRes.ok) {
            console.warn('[hentaigasm] page returned ' + pageRes.status);
            return [];
        }

        var pageHtml = await pageRes.text();
        var videoUrl = null;

        // Try extracting JWPlayer file from script content
        var fileMatch = pageHtml.match(/file:\s*["']([^"']+)["']/);
        if (fileMatch && fileMatch[1]) {
            videoUrl = fileMatch[1];
        }

        // Fallback: search for mp4 or m3u8 in page source
        if (!videoUrl) {
            var urlMatch = pageHtml.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*/i);
            if (urlMatch) {
                videoUrl = urlMatch[0];
            }
        }

        if (!videoUrl) {
            console.warn('[hentaigasm] Could not extract video URL from ' + targetUrl);
            return [];
        }

        var isHls = videoUrl.indexOf('.m3u8') !== -1;
        var streams = [
            {
                name: 'Hentaigasm',
                title: 'Hentaigasm · ' + (candidate.title || ('Ep ' + targetEp)),
                url: videoUrl,
                quality: '1080p',
                type: isHls ? 'hls' : 'mp4',
                headers: {
                    'User-Agent': UA,
                    'Referer': BASE_URL + '/'
                },
                subtitles: []
            }
        ];

        console.log('[hentaigasm] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[hentaigasm] getStreams fatal: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for Hentaigasm streams.',
            default: 'Hentaigasm'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
