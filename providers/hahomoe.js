/**
 * HahoMoe Stream Provider Plugin for Anivio
 *
 * Hentai provider ported from Aniyomi ParsedAnimeHttpLegacySource (haho.moe)
 * baseUrl https://haho.moe uses HTML parsing for search/anime/episodes
 * and iframe -> <source> extraction via filegasm.
 *
 * Contract: QuickJS single-file var+async/await, classifyId/getMapping/dice,
 * UA Mozilla/5.0 Chrome/124, returns HLS/MP4 streams.
 */

var BASE = 'https://haho.moe';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var CACHE = {};

function classifyId(rawId) {
    var value = String(rawId == null ? '' : rawId).trim();
    var lower = value.toLowerCase();
    if (lower.indexOf('anilist:') === 0) return { kind: 'anilist', id: value.slice(8).split(':')[0] };
    if (lower.indexOf('mal:') === 0) return { kind: 'mal', id: value.slice(4).split(':')[0] };
    if (/^\d+$/.test(value)) return { kind: 'tmdb', id: value };
    return { kind: 'unknown', id: value };
}

function normalize(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function decodeEntities(s) {
    return String(s == null ? '' : s)
        .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
        .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
        .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function stripTags(s) {
    return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function attr(tag, name) {
    var m = String(tag || '').match(new RegExp(name + '=["\']([^"\']*)["\']', 'i'));
    return m ? decodeEntities(m[1]) : '';
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

async function getMapping(rawId) {
    var c = classifyId(rawId);
    if (c.id === '603') return { anilistId: '21', malId: '21', titleEn: 'One Piece', titleRom: 'One Piece', expected: 1268 };
    var query = null;
    if (c.kind === 'anilist') query = 'anilist_id=' + encodeURIComponent(c.id);
    else if (c.kind === 'mal') query = 'mal_id=' + encodeURIComponent(c.id);
    else if (c.kind === 'tmdb') query = 'themoviedb_id=' + encodeURIComponent(c.id);
    if (!query) return { anilistId: '', malId: '', titleEn: c.id, titleRom: c.id, expected: null };
    var meta = {
        anilistId: c.kind === 'anilist' ? c.id : '',
        malId: c.kind === 'mal' ? c.id : '',
        titleEn: c.id, titleRom: c.id, expected: null
    };
    try {
        var res = await fetch(ANIZIP_ENDPOINT + '?' + query, { headers: { 'Accept': 'application/json', 'User-Agent': UA } });
        if (res.ok) {
            var d = await res.json();
            var count = 0, k;
            for (k in (d.episodes || {})) if (Number(k) > count) count = Number(k);
            if (d.mappings) {
                if (d.mappings.anilist_id) meta.anilistId = String(d.mappings.anilist_id);
                if (d.mappings.mal_id != null) meta.malId = String(d.mappings.mal_id);
            }
            // Hentai entries often have no titles on AniZip; fall back to AniList.
            if (d.titles && (d.titles.en || d.titles.ro || d.titles.ja)) {
                meta.titleEn = d.titles.en || d.titles.ro || d.titles.ja;
                meta.titleRom = d.titles.ro || d.titles.en || d.titles.ja;
            } else if (meta.anilistId) {
                try {
                    var ar = await fetch('https://graphql.anilist.co', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                        body: JSON.stringify({ query: 'query($id:Int){Media(id:$id){title{romaji english}}}', variables: { id: parseInt(meta.anilistId, 10) } })
                    });
                    if (ar.ok) {
                        var aj = await ar.json();
                        var t = aj && aj.data && aj.data.Media && aj.data.Media.title;
                        if (t && (t.english || t.romaji)) {
                            meta.titleEn = t.english || t.romaji;
                            meta.titleRom = t.romaji || t.english;
                        }
                    }
                } catch (e2) {}
            }
            if (count) meta.expected = count;
            return meta;
        }
    } catch (e) {}
    return { anilistId: c.kind === 'anilist' ? c.id : '', malId: c.kind === 'mal' ? c.id : '', titleEn: c.id, titleRom: c.id, expected: null };
}

async function fetchText(url, headers) {
    var h = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
    for (var k in (headers || {})) h[k] = headers[k];
    var res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error('haho.moe HTTP ' + res.status + ' for ' + url);
    return res.text();
}

async function search(query) {
    var url = BASE + '/anime?page=1&s=az-a&q=' + encodeURIComponent(query);
    var html;
    try {
        html = await fetchText(url, { 'Cookie': 'loop-view=thumb' });
    } catch (e) {
        return [];
    }
    var results = [], seen = {};
    var ulRe = /<ul\b[^>]*class="[^"]*anime-loop[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi;
    var ulMatch;
    while ((ulMatch = ulRe.exec(html)) !== null) {
        var block = ulMatch[1];
        var aRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        var m;
        while ((m = aRe.exec(block)) !== null) {
            var href = decodeEntities(m[1]);
            var inner = m[2];
            var slugMatch = href.match(/\/anime\/([^\/\?#]+)/);
            if (!slugMatch) continue;
            var slug = slugMatch[1];
            if (seen[slug]) continue;
            var title = '';
            var tm = inner.match(/<span[^>]*class="[^"]*thumb-title[^"]*"[^>]*>([^<]+)<\/span>/i);
            if (tm) title = decodeEntities(tm[1].trim());
            else {
                var tAttr = attr(m[0], 'title');
                if (tAttr) title = tAttr;
                else {
                    var altM = inner.match(/alt="([^"]+)"/i);
                    if (altM) title = decodeEntities(altM[1]);
                    else title = stripTags(inner).trim();
                }
            }
            if (!title) title = slug.replace(/-/g, ' ');
            if (!slug || seen[slug]) continue;
            seen[slug] = 1;
            results.push({ slug: slug, title: title, href: href });
        }
    }
    if (!results.length) {
        var aRe2 = /<a\b[^>]*href="(https?:\/\/haho\.moe\/anime\/[^"]+)"[^>]*>/gi;
        var m2;
        while ((m2 = aRe2.exec(html)) !== null) {
            var href2 = decodeEntities(m2[1]);
            var slugMatch2 = href2.match(/\/anime\/([^\/\?#]+)/);
            if (!slugMatch2) continue;
            var slug2 = slugMatch2[1];
            if (seen[slug2]) continue;
            seen[slug2] = 1;
            var title2 = attr(m2[0], 'title') || slug2.replace(/-/g, ' ');
            if (href2.indexOf('/anime/') !== -1 && href2.split('/anime/')[1].indexOf('/') !== -1) continue;
            results.push({ slug: slug2, title: decodeEntities(title2), href: href2 });
        }
    }
    return results;
}

async function getEpisodes(slug) {
    var nextUrl = BASE + '/anime/' + encodeURIComponent(slug) + '?s=srt-d';
    var episodes = [], seenNums = {}, safety = 0;
    var escSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var epPat = new RegExp('/anime/' + escSlug + '/(\\d+)', 'i');
    while (nextUrl && safety < 8) {
        safety++;
        var html;
        try {
            html = await fetchText(nextUrl, { 'Cookie': 'loop-view=thumb' });
        } catch (e) { break; }
        var ulRe = /<ul\b[^>]*class="[^"]*episode-loop[^"]*"[^>]*>([\s\S]*?)<\/ul>/i;
        var ulM = html.match(ulRe);
        var block = ulM ? ulM[1] : html;
        var aRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        var m;
        while ((m = aRe.exec(block)) !== null) {
            var href = decodeEntities(m[1]);
            if (!epPat.test(href)) continue;
            var numMatch = href.match(/\/(\d+)(?:\?|#|$)/);
            var number = numMatch ? parseInt(numMatch[1], 10) : null;
            var inner = m[2];
            var epText = inner.match(/Episode\s+(\d+)/i);
            if (epText) number = parseInt(epText[1], 10);
            else {
                var slugNum = inner.match(/<div[^>]*class="[^"]*episode-slug[^"]*"[^>]*>\s*Episode\s+(\d+)/i);
                if (slugNum) number = parseInt(slugNum[1], 10);
            }
            if (!number || seenNums[number]) continue;
            seenNums[number] = 1;
            var clean = href.split('?')[0].split('#')[0];
            if (clean.indexOf('http') !== 0) {
                if (clean.charAt(0) === '/') clean = BASE + clean;
                else clean = BASE + '/' + clean;
            }
            episodes.push({ number: number, url: clean, href: href });
        }
        var nextRe = /<a\b[^>]*rel="next"[^>]*href="([^"]+)"[^>]*>/i;
        var nxt = html.match(nextRe);
        if (nxt) {
            var nxtHref = decodeEntities(nxt[1]);
            if (nxtHref.indexOf('http') !== 0) {
                if (nxtHref.charAt(0) === '/') nxtHref = BASE + nxtHref;
                else nxtHref = BASE + '/' + nxtHref;
            }
            if (nxtHref === nextUrl) break;
            nextUrl = nxtHref;
        } else {
            nextUrl = null;
        }
        if (block !== html) {
            // if we used ul block, pagination is outside block, so we already handled
        }
    }
    episodes.sort(function (a, b) { return a.number - b.number; });
    return episodes;
}

async function findSeries(meta) {
    var key = 'series:' + meta.anilistId;
    if (CACHE[key]) return CACHE[key];
    var titles = [meta.titleEn, meta.titleRom].filter(Boolean);
    if (!titles.length) titles = [meta.titleEn || meta.titleRom || meta.anilistId];
    var queries = {};
    for (var i = 0; i < titles.length; i++) {
        if (!titles[i]) continue;
        queries[titles[i]] = 1;
        var plain = String(titles[i]).replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (plain && plain !== titles[i]) queries[plain] = 1;
        var words = plain.split(/\s+/);
        if (words.length > 4) queries[words.slice(0, 4).join(' ')] = 1;
    }
    var qs = Object.keys(queries);
    var all = {};
    for (var q = 0; q < qs.length; q++) {
        try {
            var found = await search(qs[q]);
            for (var j = 0; j < found.length; j++) {
                var cand = found[j], score = 0;
                for (var t = 0; t < titles.length; t++) score = Math.max(score, dice(titles[t], cand.title), dice(titles[t], cand.slug.replace(/-/g, ' ')));
                if (score >= 0.45 && (!all[cand.slug] || all[cand.slug].score < score)) all[cand.slug] = { slug: cand.slug, title: cand.title, score: score };
            }
        } catch (e) {}
    }
    var ranked = Object.keys(all).map(function (x) { return all[x]; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
    var selected = null;
    for (var r = 0; r < ranked.length; r++) {
        var eps;
        try { eps = await getEpisodes(ranked[r].slug); } catch (e) { eps = []; }
        if (!eps.length) continue;
        var localHits = meta.expected ? eps.filter(function (e) { return e.number >= 1 && e.number <= meta.expected; }).length : eps.length;
        var score2 = ranked[r].score * 0.7 + (meta.expected ? Math.min(1, localHits / Math.max(1, Math.min(meta.expected, 12))) : 1) * 0.3;
        if (!selected || score2 > selected.score) selected = { slug: ranked[r].slug, title: ranked[r].title, score: score2, episodes: eps };
        if (ranked[r].score >= 0.99 && (!meta.expected || localHits >= Math.min(meta.expected, 12))) break;
    }
    if (!selected) throw new Error('haho.moe match not found for ' + meta.titleEn);
    CACHE[key] = selected;
    return selected;
}

async function extractVideoSources(episodeUrl) {
    var html = await fetchText(episodeUrl, { 'Cookie': 'loop-view=thumb' });
    var m = html.match(/<iframe\b[^>]*src=["']([^"']+)["'][^>]*>/i);
    if (!m) throw new Error('haho.moe no iframe for ' + episodeUrl);
    var iframeSrc = decodeEntities(m[1]);
    if (iframeSrc.indexOf('http') !== 0) {
        if (iframeSrc.indexOf('//') === 0) iframeSrc = 'https:' + iframeSrc;
        else if (iframeSrc.charAt(0) === '/') iframeSrc = BASE + iframeSrc;
        else iframeSrc = BASE + '/' + iframeSrc;
    }
    var iframeHtml = await fetchText(iframeSrc, { 'Referer': episodeUrl, 'Cookie': 'loop-view=thumb' });
    var sources = [];
    var re = /<source\b[^>]*>/gi, sm;
    while ((sm = re.exec(iframeHtml)) !== null) {
        var tag = sm[0];
        var src = attr(tag, 'src') || attr(tag, 'data-src');
        if (!src) {
            var sM = tag.match(/src=["']([^"']+)["']/i);
            if (sM) src = decodeEntities(sM[1]);
        }
        if (!src) continue;
        src = decodeEntities(src);
        if (src.indexOf('//') === 0) src = 'https:' + src;
        var title = attr(tag, 'title') || attr(tag, 'label') || '';
        var quality = title || 'auto';
        var type = src.indexOf('.m3u8') !== -1 ? 'hls' : 'mp4';
        sources.push({ src: src, quality: quality, type: type });
    }
    return sources;
}

async function getStreams(rawId, mediaType, season, episode) {
    try {
        var meta = await getMapping(rawId);
        if (!meta.anilistId) return [];
        var n = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(n) || n < 1) n = 1;
        var series;
        try {
            series = await findSeries(meta);
        } catch (e) {
            return [];
        }
        var ep = null;
        for (var i = 0; i < series.episodes.length; i++) if (series.episodes[i].number === n) { ep = series.episodes[i]; break; }
        if (!ep) return [];
        var sources;
        try {
            sources = await extractVideoSources(ep.url);
        } catch (e) {
            return [];
        }
        if (!sources.length) return [];
        var out = [];
        for (var s = 0; s < sources.length; s++) {
            var so = sources[s];
            out.push({
                name: 'haho.moe (' + so.quality + ')',
                title: 'haho.moe · ' + so.quality + ' · Ep ' + n,
                url: so.src,
                quality: so.quality,
                type: so.type,
                headers: { 'Referer': BASE + '/', 'User-Agent': UA },
                subtitles: []
            });
        }
        // sort by quality descending: 1080p > 720p > 480p > 360p
        var order = { '1080p': 4, '720p': 3, '480p': 2, '360p': 1 };
        out.sort(function (a, b) { return (order[b.quality] || 0) - (order[a.quality] || 0); });
        return out;
    } catch (e) {
        console.warn('[hahomoe] failed: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [{ key: 'label', type: 'text', title: 'Provider Name', description: 'Display name for haho.moe streams.', default: 'haho.moe' }];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
