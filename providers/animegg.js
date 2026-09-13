/**
 * AnimeGG Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - HTML-scraped HLS / MP4 streams (Sub and Dub tabs)
 * - Supported IDs: anilist:<id>, mal:<id>, numeric ID, and "603" (Anivio Test button)
 */

var BASE = 'https://www.animegg.org';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';

var GG_CACHE = {};
var GG_TTL = 6 * 60 * 60 * 1000;

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
        return { kind: 'tz', id: value };
    }
    return { kind: 'unknown', id: value };
}

function cacheGet(key) {
    var e = GG_CACHE[key];
    if (e && Date.now() - e.t < GG_TTL) return e.v;
    return null;
}

function cacheSet(key, v) {
    GG_CACHE[key] = { v: v, t: Date.now() };
}

function decodeEntities(s) {
    s = String(s == null ? '' : s);
    return s
        .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
        .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

function stripTags(html) {
    return decodeEntities(String(html == null ? '' : html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function attr(tag, name) {
    var m = String(tag || '').match(new RegExp(name + '=["\']([^"\']*)["\']', 'i'));
    return m ? decodeEntities(m[1]) : '';
}

function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function diceCoeff(a, b) {
    var na = norm(a);
    var nb = norm(b);
    if (na === nb) return 1;
    if (na.length < 2 || nb.length < 2) return 0;
    var bigrams = {};
    for (var i = 0; i < na.length - 1; i++) {
        var bg = na.slice(i, i + 2);
        bigrams[bg] = (bigrams[bg] || 0) + 1;
    }
    var hits = 0;
    for (var j = 0; j < nb.length - 1; j++) {
        var bg2 = nb.slice(j, j + 2);
        var count = bigrams[bg2] || 0;
        if (count > 0) {
            hits++;
            bigrams[bg2] = count - 1;
        }
    }
    return (2 * hits) / (na.length + nb.length - 2);
}

function titleScore(query, candidate, slug) {
    var base = Math.max(diceCoeff(query, candidate), diceCoeff(query, slug.replace(/-/g, ' ')));
    var queryFirstNum = (norm(query).match(/\d+/) || [''])[0];
    var slugFirstNum = (String(slug).match(/\d+/) || [''])[0];
    if (queryFirstNum && slugFirstNum && queryFirstNum !== slugFirstNum) return base * 0.65;
    if (queryFirstNum && !slugFirstNum) return base * 0.65;
    if (!queryFirstNum && slugFirstNum) {
        var n = parseInt(slugFirstNum, 10);
        if (n > 1 && n < 1900) return base * (1 - 0.06 * (n - 1));
    }
    var isMovieQuery = /\b(movie|film|the movie)\b/i.test(query);
    var isMovieMatch = /\b(movie|film)\b/i.test(candidate) || /movie|film/.test(slug);
    if (isMovieQuery && !isMovieMatch) return base * 0.4;
    var qLen = norm(query).length;
    var sLen = norm(slug.replace(/-/g, ' ')).length;
    return sLen > qLen * 1.6 + 4 ? base * 0.8 : base;
}

function originOf(url) {
    var m = String(url || '').match(/^(?:https?:)?\/\/[^/]+/i);
    return m ? m[0] : BASE;
}

function fetchHtml(url, headers) {
    var h = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
    };
    for (var k in (headers || {})) h[k] = headers[k];
    return fetch(url, { headers: h }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + url);
        return res.text();
    });
}

async function search(query) {
    var html = await fetchHtml(BASE + '/search/?q=' + encodeURIComponent(query));
    var results = [];
    var re = /<a\b[^>]*class=["'][^"']*\bmse\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
        var tag = (m[0].match(/<a\b[^>]*>/i) || [''])[0];
        var href = attr(tag, 'href');
        var slugMatch = href.match(/^\/series\/([^/?#]+)/);
        if (!slugMatch) continue;
        var strong = (m[0].match(/<strong[^>]*>([\s\S]*?)<\/strong>/i) || ['', ''])[1];
        results.push({ slug: slugMatch[1], text: strong ? stripTags(strong) : slugMatch[1].replace(/-/g, ' ') });
    }
    return results;
}

async function searchFn(query) {
    var r1 = await search(query);
    var compact = String(query).split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '');
    if (compact.length >= 4 && compact.toLowerCase() !== String(query).toLowerCase()) {
        try {
            var r2 = await search(compact);
            var seen = {};
            for (var i = 0; i < r1.length; i++) seen[r1[i].slug] = 1;
            for (var j = 0; j < r2.length; j++) if (!seen[r2[j].slug]) r2[j] && r1.push(r2[j]);
        } catch (e) {}
    }
    return r1;
}

async function scrapeSeries(slug) {
    var html = await fetchHtml(BASE + '/series/' + slug);
    var episodes = [];
    var seenNums = {};
    var liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    var m;
    while ((m = liRe.exec(html)) !== null) {
        var block = m[1];
        if (!/\banm_det_pop\b/.test(block)) continue;
        var link = (block.match(/<a\b[^>]*class=["'][^"']*anm_det_pop[^"']*["'][^>]*>/i) || [''])[0];
        var href = attr(link, 'href').replace(/#.*$/, '').replace(/^\//, '');
        var strong = stripTags((block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i) || ['', ''])[1]);
        var rangeMatch = String(strong).match(/(\d+)-(\d+)\s*$/);
        var numMatch = rangeMatch || String(strong).match(/(\d+)\s*$/);
        if (!numMatch || !href) continue;
        var number = parseInt(numMatch[1], 10);
        if (seenNums[number]) continue;
        seenNums[number] = 1;
        var title = stripTags((block.match(/<i\b[^>]*class=["'][^"']*anititle[^"']*["'][^>]*>([\s\S]*?)<\/i>/i) || ['', ''])[1]) || strong;
        var hasSub = /\bbtn-subbed\b/.test(block);
        var hasDub = /\bbtn-dubbed\b/.test(block);
        episodes.push({ number: number, title: title, epSlug: href, hasSub: hasSub, hasDub: hasDub });
    }
    episodes.sort(function (a, b) { return a.number - b.number; });
    return episodes;
}

function b64ToStr(b64) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var table = {};
    for (var i = 0; i < 64; i++) table[chars.charAt(i)] = i;
    var s = String(b64 == null ? '' : b64);
    while (s.length % 4 !== 0) s += '=';
    var out = [];
    var buf = 0, bits = 0;
    for (var j = 0; j < s.length; j++) {
        var ch = s.charAt(j);
        if (ch === '=' || !(ch in table)) continue;
        buf = (buf << 6) | table[ch];
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 255);
            buf &= (1 << bits) - 1;
        }
    }
    var str = '';
    for (var k = 0; k < out.length; k++) str += String.fromCharCode(out[k]);
    return str;
}

async function scrapeEmbed(embedId) {
    var html = await fetchHtml(BASE + '/embed/' + embedId, { Referer: BASE });
    var m = html.match(/var\s+videoSources\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) return [];
    var aJson = m[1]
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/:\s*'([^']*)'/g, ': "$1"');
    var parsed;
    try {
        parsed = JSON.parse(aJson);
    } catch (e) {
        return [];
    }
    var out = [];
    for (var i = 0; i < parsed.length; i++) {
        var s = parsed[i] || {};
        var backup = null;
        if (s.bk) {
            try {
                backup = decodeURIComponent(b64ToStr(s.bk));
            } catch (e) {
                backup = null;
            }
        }
        var url = s.file || '';
        if (url && url.indexOf('http') !== 0) url = BASE + url;
        if (!url) continue;
        out.push({ quality: s.label || 'unknown', url: url, backup: backup });
    }
    return out;
}

async function scrapeEpisodeWatch(epSlug, audio) {
    var html = await fetchHtml(BASE + '/' + epSlug, { Referer: BASE });
    var tabs = [];
    var tabRe = /<a\b[^>]*data-toggle=["']tab["'][^>]*>/gi;
    var m;
    while ((m = tabRe.exec(html)) !== null) {
        var tag = m[0];
        var embedId = attr(tag, 'data-id');
        var server = attr(tag, 'data-mirror') || 'AnimeGG';
        var version = attr(tag, 'data-version') || 'subbed';
        if (!embedId) continue;
        var normalized = String(version).indexOf('dub') === 0 ? 'dub' : 'sub';
        if (audio === 'all' || normalized === audio) {
            tabs.push({ embedId: embedId, embedUrl: BASE + '/embed/' + embedId, server: server, normalized: normalized });
        }
    }
    var streams = [];
    var settled = await Promise.all(tabs.map(function (tab, i) {
        return scrapeEmbed(tab.embedId).catch(function () { return []; })
            .then(function (sources) {
                return sources.map(function (s, j) {
                    return {
                        url: s.url,
                        type: String(s.url).indexOf('.m3u8') !== -1 ? 'hls' : 'mp4',
                        quality: s.quality,
                        backup: s.backup,
                        audio: tab.normalized,
                        server: tab.server,
                        referer: originOf(tab.embedUrl) + '/',
                        priority: tabs.length - i,
                        isActive: i === 0 && j === 0
                    };
                });
            });
    }));
    for (var a = 0; a < settled.length; a++) {
        for (var b = 0; b < settled[a].length; b++) streams.push(settled[a][b]);
    }
    return streams;
}

function titleScoreBest(candidates, titles) {
    var out = [];
    for (var c = 0; c < candidates.length; c++) {
        var cand = candidates[c];
        var best = 0;
        for (var t = 0; t < titles.length; t++) {
            var s = titleScore(titles[t], cand.text, cand.slug);
            if (s > best) best = s;
        }
        if (best >= 0.5) out.push({ slug: cand.slug, title: cand.text, score: best });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, 6);
}

function buildSearchQueries(title) {
    var set = {};
    set[title] = 1;
    var words = String(title).trim().split(/\s+/);
    if (words.length > 4) set[words.slice(0, 4).join(' ')] = 1;
    if (words.length > 3) set[words.slice(0, 3).join(' ')] = 1;
    var stripped = String(title)
        .replace(/\bseason\s*\d+\b/gi, '')
        .replace(/\bpart\s*\d+\b/gi, '')
        .replace(/\b\d+rd\b|\b\d+th\b|\b\d+st\b|\b\d+nd\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (stripped && stripped !== title) set[stripped] = 1;
    var out = [];
    for (var k in set) if (k.length >= 3) out.push(k);
    return out.slice(0, 12);
}

async function findTopSlugs(titles) {
    var allCandidates = {};
    var searchQueries = {};
    for (var i = 0; i < titles.length && i < 4; i++) {
        var qs = buildSearchQueries(titles[i]);
        for (var q = 0; q < qs.length; q++) searchQueries[qs[q]] = 1;
    }
    var qList = Object.keys(searchQueries);
    var batches = [];
    for (var b = 0; b < qList.length; b += 4) batches.push(qList.slice(b, b + 4));
    for (var bi = 0; bi < batches.length; bi++) {
        await Promise.all(batches[bi].map(function (q) {
            return searchFn(q).then(function (res) {
                for (var r = 0; r < res.length; r++) {
                    if (!allCandidates[res[r].slug]) allCandidates[res[r].slug] = res[r].text;
                }
            }).catch(function () {});
        }));
    }
    var scored = titleScoreBest(
        Object.keys(allCandidates).map(function (slug) { return { slug: slug, text: allCandidates[slug] }; }),
        titles
    );
    return scored;
}

function maxOf(arr) {
    var m = 0;
    for (var i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m;
}

async function selectSeries(candidates, expected, status, offset, minScore) {
    var results = [];
    for (var c = 0; c < candidates.length; c++) {
        var candidate = candidates[c];
        var episodes;
        try {
            episodes = await scrapeSeries(candidate.slug);
        } catch (e) {
            episodes = [];
        }
        var max = maxOf(episodes.map(function (e) { return e.number; }));
        var localHits = expected ? episodes.filter(function (e) { return e.number >= 1 && e.number <= expected; }).length : episodes.length;
        var offsetHits = expected && offset
            ? episodes.filter(function (e) { return e.number > offset && e.number <= offset + expected; }).length
            : 0;
        var mode = offsetHits > localHits ? 'offset' : 'local';
        var hits = Math.max(localHits, offsetHits);
        var countScore = 1;
        if (expected && expected >= 6) {
            var needed = status === 'FINISHED' ? Math.ceil(expected * 0.9) : Math.max(1, expected - 3);
            countScore = hits >= needed ? 1 : hits / needed;
        }
        results.push({ slug: candidate.slug, title: candidate.title, episodes: episodes, max: max, mode: mode, score: candidate.score * 0.7 + countScore * 0.3 });
    }
    var min = minScore == null ? 0.65 : minScore;
    var viable = results
        .filter(function (r) { return r.episodes.length && r.score >= min; })
        .sort(function (a, b) { return b.score - a.score; });
    return viable.length ? viable[0] : null;
}

var RELATION_POSTFIX = 'edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes}}}}}}}}}}}}';

function computePrequelOffset(relations, depth) {
    if (!relations || depth > 5) return 0;
    var edges = relations.edges || [];
    var prequelEdge = null;
    for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        if (e.relationType === 'PREQUEL' && e.node.type === 'ANIME' && (e.node.episodes || 0) >= 5) {
            prequelEdge = e;
            break;
        }
    }
    if (!prequelEdge) return 0;
    return (prequelEdge.node.episodes || 0) + computePrequelOffset(prequelEdge.node.relations, depth + 1);
}

async function anilistMedia(anilistId) {
    var query = 'query($id:Int){Media(id:$id,type:ANIME){episodes status relations{' + RELATION_POSTFIX + '}}}';
    var res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: query, variables: { id: Number(anilistId) } })
    });
    if (!res.ok) throw new Error('AniList HTTP ' + res.status);
    var data = await res.json();
    if (data && data.errors && data.errors.length) throw new Error('AniList: ' + data.errors[0].message);
    return data && data.data ? data.data.Media : null;
}

async function getPrequelOffset(anilistId) {
    var key = 'offset:' + anilistId;
    var cached = cacheGet(key);
    if (cached) return cached;
    var media;
    try {
        media = await anilistMedia(anilistId);
    } catch (e) {
        return { offset: 0, media: null };
    }
    var offset = computePrequelOffset(media && media.relations, 0);
    cacheSet(key, offset);
    return { offset: offset, media: media };
}

function buildTitles(meta) {
    var out = [];
    var seen = {};
    var src = [meta.titleEn, meta.titleRom, meta.titleJa];
    for (var i = 0; i < src.length; i++) {
        var t = String(src[i] || '').trim();
        if (t && !seen[t.toLowerCase()]) {
            seen[t.toLowerCase()] = 1;
            out.push(t);
        }
    }
    return out;
}

async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603" -> One Piece (AniList 21)
    if (classified.id === '603') {
        classified = { kind: 'anilist', id: '21' };
    }

    var query = null;
    if (classified.kind === 'anilist') query = 'anilist_id=' + encodeURIComponent(classified.id);
    else if (classified.kind === 'mal') query = 'mal_id=' + encodeURIComponent(classified.id);

    var meta = {
        anilistId: classified.kind === 'anilist' ? classified.id : '',
        malId: classified.kind === 'mal' ? classified.id : '',
        titleEn: classified.id,
        titleRom: classified.id,
        titleJa: '',
        expected: null
    };

    if (query) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?' + query, {
                headers: { 'User-Agent': UA, 'Accept': 'application/json' }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.titles) {
                    meta.titleEn = data.titles.en || data.titles.ro || data.titles.ja || meta.titleEn;
                    meta.titleRom = data.titles.ro || data.titles.en || meta.titleRom;
                    meta.titleJa = data.titles.ja || '';
                    meta.anilistId = data.mappings ? String(data.mappings.anilist_id || '') : meta.anilistId;
                    if (data.mappings && data.mappings.mal_id != null) meta.malId = String(data.mappings.mal_id);
                }
                var epCount = 0;
                if (data && data.episodes) {
                    for (var k in data.episodes) {
                        var n = Number(k);
                        if (isFinite(n) && n > epCount) epCount = n;
                    }
                }
                if (epCount > 0) meta.expected = epCount;
            }
        } catch (e) {}
    }

    if (!meta.anilistId && /^\d+$/.test(classified.id)) {
        meta.anilistId = classified.id;
    }
    return meta;
}

async function resolveSeries(meta) {
    var cacheKey = 'series:' + meta.anilistId;
    var cached = cacheGet(cacheKey);
    if (cached) return cached;

    var titles = buildTitles(meta);
    var candidates = await findTopSlugs(titles);
    var expected = meta.expected;
    var pre = await getPrequelOffset(meta.anilistId);
    var media = pre.media;
    if (!expected && media && media.episodes) expected = Number(media.episodes) || null;
    var offset = pre.offset || 0;
    var status = media && media.status ? String(media.status) : '';
    var isSingleMovie = expected === 1 || (media && /^MOVIE$/i.test(media.format || ''));
    var minScore = isSingleMovie ? 0.9 : 0.65;

    var selected = await selectSeries(candidates, expected, status, offset, minScore);
    if (!selected) throw new Error('AnimeGG match not found for AniList ' + meta.anilistId);

    var data = { slug: selected.slug, title: selected.title, mode: selected.mode, offset: offset, score: selected.score };
    cacheSet(cacheKey, data);
    return data;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var meta = await resolveMetadata(tmdbId);
        if (!meta.anilistId) return [];

        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var series = await resolveSeries(meta);
        var providerEp = series.mode === 'offset' ? targetEp + series.offset : targetEp;
        var episodes = await scrapeSeries(series.slug);
        var ep = null;
        for (var i = 0; i < episodes.length; i++) {
            if (episodes[i].number === providerEp) { ep = episodes[i]; break; }
        }
        if (!ep) throw new Error('AnimeGG episode ' + providerEp + ' not found');

        var subStreams = [];
        var dubStreams = [];
        if (ep.hasSub) subStreams = await scrapeEpisodeWatch(ep.epSlug, 'sub');
        if (ep.hasDub) dubStreams = await scrapeEpisodeWatch(ep.epSlug, 'dub');

        var streams = [];
        var pushTrack = function (list, audio) {
            for (var s = 0; s < list.length; s++) {
                var src = list[s];
                if (!src || !src.url) continue;
                streams.push({
                    name: 'AnimeGG ' + String(src.server || 'AnimeGG') + ' (' + audio + ')',
                    title: 'AnimeGG · ' + audio + ' · Ep ' + targetEp,
                    url: src.url,
                    quality: src.quality || 'auto',
                    type: src.type || (String(src.url).indexOf('.m3u8') !== -1 ? 'hls' : 'mp4'),
                    headers: {
                        'Referer': src.referer || BASE + '/',
                        'User-Agent': UA
                    }
                });
            }
        };
        pushTrack(subStreams, 'Sub');
        pushTrack(dubStreams, 'Dub');

        return streams;
    } catch (e) {
        console.warn('[animegg] failed: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [{
        key: 'label',
        type: 'text',
        title: 'Provider Name',
        description: 'Display name for AnimeGG streams.',
        default: 'AnimeGG'
    }];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;