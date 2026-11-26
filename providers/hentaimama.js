/**
 * HentaiMama Stream Provider Plugin for Anivio
 *
 * Ported from yuzono/anime-extensions (HentaiMama.kt):
 * - Engine: QuickJS (pure ES5/async-await, zero external dependencies)
 * - WordPress AJAX player extraction (`action=get_player_contents`) across all available mirrors
 * - Dual AniZip + AniList GraphQL title resolution for reliable 18+ OVA matching
 * - Direct 1080p, 720p, and 480p MP4 & HLS stream support
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB/AniList id, and "603" (Anivio Test button)
 */

var HM_BASE = 'https://hentaimama.io';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var ANILIST_GQL = 'https://graphql.anilist.co';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function classifyId(rawId) {
    var v = String(rawId == null ? '' : rawId).trim();
    if (!v) return { kind: 'unknown', id: '' };
    var l = v.toLowerCase();
    if (l.indexOf('anilist:') === 0) return { kind: 'anilist', id: v.slice('anilist:'.length).split(':')[0] };
    if (l.indexOf('mal:') === 0) return { kind: 'mal', id: v.slice('mal:'.length).split(':')[0] };
    if (/^\d+$/.test(v)) return { kind: 'numeric', id: v };
    return { kind: 'unknown', id: v };
}

function normalizeTitle(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cleanTitle(s) {
    return String(s == null ? '' : s)
        .replace(/[`'’‘"]/g, "'")
        .replace(/\s*\(\d{4}\)/g, '')
        .replace(/\b(?:TV|OVA|ONA|Special|Movie|Uncensored|The Animation)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function diceSimilarity(a, b) {
    var x = normalizeTitle(a), y = normalizeTitle(b);
    if (!x || !y) return 0;
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

async function resolveTitles(rawId) {
    var c = classifyId(rawId);
    if (c.id === '603') return ['Overflow'];

    var titles = [];
    function addTitle(t) {
        if (t && typeof t === 'string') {
            var trimmed = t.trim();
            if (trimmed && titles.indexOf(trimmed) === -1) titles.push(trimmed);
        }
    }

    // 1. Try AniZip
    var queries = [];
    if (c.kind === 'anilist') queries.push('?anilist_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'mal') queries.push('?mal_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'numeric') {
        queries.push('?anilist_id=' + encodeURIComponent(c.id));
        queries.push('?themoviedb_id=' + encodeURIComponent(c.id));
    }

    for (var i = 0; i < queries.length; i++) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + queries[i], {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.titles) {
                    addTitle(data.titles.ro);
                    addTitle(data.titles.en);
                    addTitle(data.titles.ja);
                    if (titles.length > 0) break;
                }
            }
        } catch (e) {}
    }

    // 2. Fallback / supplement with AniList GraphQL (especially reliable for 18+ OVAs)
    if ((c.kind === 'anilist' || c.kind === 'mal' || c.kind === 'numeric') && titles.length === 0) {
        try {
            var gqlQuery = c.kind === 'mal'
                ? 'query ($id: Int) { Media(idMal: $id, type: ANIME) { title { romaji english native } synonyms } }'
                : 'query ($id: Int) { Media(id: $id, type: ANIME) { title { romaji english native } synonyms } }';
            var gRes = await fetch(ANILIST_GQL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                body: JSON.stringify({ query: gqlQuery, variables: { id: parseInt(c.id, 10) } })
            });
            if (gRes.ok) {
                var gJson = await gRes.json();
                var m = gJson && gJson.data && gJson.data.Media;
                if (m && m.title) {
                    addTitle(m.title.romaji);
                    addTitle(m.title.english);
                    addTitle(m.title.native);
                    if (Array.isArray(m.synonyms)) {
                        for (var s = 0; s < Math.min(m.synonyms.length, 3); s++) addTitle(m.synonyms[s]);
                    }
                }
            }
        } catch (e) {}
    }

    if (titles.length === 0 && c.kind === 'unknown') addTitle(c.id);
    return titles;
}

async function searchHentaiMama(query) {
    if (!query) return [];
    try {
        var cleanQ = query.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        var res = await fetch(HM_BASE + '/page/1/?s=' + encodeURIComponent(cleanQ), {
            headers: { 'User-Agent': UA, 'Referer': HM_BASE + '/' }
        });
        if (!res.ok) return [];
        var html = await res.text();

        var results = [];
        var seen = {};
        var artRe = /<article[^>]*class="[^"]*series-card[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
        var m;
        while ((m = artRe.exec(html)) !== null) {
            var block = m[1];
            var linkM = block.match(/<a[^>]*class="[^"]*sc-poster[^"]*"[^>]*href="([^"]+)"/i) ||
                        block.match(/<h3[^>]*class="[^"]*sc-title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/i);
            if (!linkM) continue;
            var url = linkM[1];
            if (seen[url]) continue;
            seen[url] = true;

            var titleM = block.match(/<h3[^>]*class="[^"]*sc-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) ||
                         block.match(/alt="([^"]+)"/i);
            var title = titleM
                ? titleM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;/g, "'").trim()
                : '';
            results.push({ url: url, title: title });
        }
        return results;
    } catch (e) {
        return [];
    }
}

function pickBestMatch(candidates, titles) {
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        for (var t = 0; t < titles.length; t++) {
            var score = Math.max(
                diceSimilarity(c.title, titles[t]),
                diceSimilarity(cleanTitle(c.title), cleanTitle(titles[t]))
            );
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
    }
    return bestScore >= 0.4 ? best : (candidates[0] || null);
}

/**
 * Main stream resolver required by Anivio.
 */
async function getStreams(rawId, mediaType, season, episode) {
    try {
        console.log('[hentaimama] getStreams called: id=' + rawId + ' ep=' + episode);

        var titles = await resolveTitles(rawId);
        if (!titles || titles.length === 0) return [];

        var targetEp = parseInt(episode != null ? episode : 1, 10) || 1;
        var chosen = null;

        for (var t = 0; t < titles.length; t++) {
            var cands = await searchHentaiMama(titles[t]);
            if (cands.length > 0) {
                chosen = pickBestMatch(cands, titles);
                if (chosen) break;
            }
            var cleaned = cleanTitle(titles[t]);
            if (cleaned && cleaned !== titles[t]) {
                var cands2 = await searchHentaiMama(cleaned);
                if (cands2.length > 0) {
                    chosen = pickBestMatch(cands2, titles);
                    if (chosen) break;
                }
            }
        }

        if (!chosen) {
            console.log('[hentaimama] No matching series found');
            return [];
        }

        console.log('[hentaimama] Chosen series: ' + chosen.title + ' (' + chosen.url + ')');

        // 1. Fetch show page to list episodes
        var showRes = await fetch(chosen.url, { headers: { 'User-Agent': UA, 'Referer': HM_BASE + '/' } });
        if (!showRes.ok) return [];
        var showHtml = await showRes.text();

        var epItems = [];
        var epRe = /<a[^>]*class="[^"]*dt-se-item[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        var em;
        while ((em = epRe.exec(showHtml)) !== null) {
            var epUrl = em[1];
            var inner = em[2];
            var epTitleM = inner.match(/class="[^"]*dt-se-title[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
            var epTitleText = epTitleM ? epTitleM[1].replace(/<[^>]+>/g, '').trim() : inner.replace(/<[^>]+>/g, '').trim();
            var numM = epTitleText.match(/Episode\s+(\d+(?:\.\d+)?)/i) || epUrl.match(/episode-(\d+)/i);
            var epNum = numM ? parseFloat(numM[1]) : (epItems.length + 1);
            epItems.push({ url: epUrl, num: epNum, name: epTitleText });
        }

        if (epItems.length === 0) return [];

        var targetItem = null;
        for (var k = 0; k < epItems.length; k++) {
            if (epItems[k].num === targetEp) {
                targetItem = epItems[k];
                break;
            }
        }
        if (!targetItem) {
            // Episodes on HentaiMama are typically ordered newest-first; reverse for fallback indexing
            var asc = epItems.slice().reverse();
            targetItem = asc[targetEp - 1] || asc[0];
        }

        // 2. Fetch episode page to obtain postId & mirror option tabs
        var epRes = await fetch(targetItem.url, { headers: { 'User-Agent': UA, 'Referer': chosen.url } });
        if (!epRes.ok) return [];
        var epHtml = await epRes.text();

        var postIdM = epHtml.match(/name=["']idpost["'][^>]*value=["'](\d+)["']/i) ||
                      epHtml.match(/value=["'](\d+)["'][^>]*name=["']idpost["']/i);
        if (!postIdM) return [];
        var postId = postIdM[1];

        var tabs = [];
        var tabRe = /<a[^>]*href=["']#option-(\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        var tm;
        while ((tm = tabRe.exec(epHtml)) !== null) {
            tabs.push({ opt: tm[1], name: tm[2].replace(/<[^>]+>/g, '').trim() });
        }
        if (tabs.length === 0) tabs.push({ opt: '1', name: 'Server 1' });

        // Fetch player contents from AJAX
        var ajaxRes = await fetch(HM_BASE + '/wp-admin/admin-ajax.php', {
            method: 'POST',
            headers: {
                'User-Agent': UA,
                'Referer': HM_BASE + '/',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'action=get_player_contents&a=' + encodeURIComponent(postId) + '&i=' + encodeURIComponent(tabs[0].opt)
        });
        if (!ajaxRes.ok) return [];
        var fragments = await ajaxRes.json();
        if (!Array.isArray(fragments)) return [];

        var streams = [];
        var seenUrls = {};

        for (var f = 0; f < fragments.length; f++) {
            var frag = fragments[f];
            if (!frag || typeof frag !== 'string') continue;
            var ifrM = frag.match(/src=["']([^"']+)["']/i);
            if (!ifrM || !ifrM[1]) continue;

            var iframeUrl = ifrM[1].replace(/&#038;|&amp;/g, '&');
            if (iframeUrl.indexOf('http') !== 0) {
                iframeUrl = HM_BASE + (iframeUrl.charAt(0) === '/' ? '' : '/') + iframeUrl;
            }

            try {
                var ir = await fetch(iframeUrl, { headers: { 'User-Agent': UA, 'Referer': HM_BASE + '/' } });
                if (!ir.ok) continue;
                var ih = await ir.text();
                var srcM = ih.match(/sources\s*:\s*(\[[\s\S]*?\])/);
                if (!srcM) continue;
                var sources = JSON.parse(srcM[1]);
                if (!Array.isArray(sources)) continue;

                var tabInfo = tabs.find(function(x) { return parseInt(x.opt, 10) === (f + 1); });
                var srvLabel = tabInfo ? tabInfo.name : ('Server ' + (f + 1));

                for (var s = 0; s < sources.length; s++) {
                    var src = sources[s];
                    if (!src || !src.file) continue;
                    var streamUrl = String(src.file).replace(/\\\//g, '/');
                    if (seenUrls[streamUrl]) continue;
                    seenUrls[streamUrl] = true;

                    var qLabel = src.label || '1080p';
                    var isHls = src.type === 'hls' || streamUrl.indexOf('.m3u8') !== -1;

                    streams.push({
                        name: 'HentaiMama (' + srvLabel + ' - ' + qLabel + ')',
                        title: 'HentaiMama · ' + chosen.title + ' · Ep ' + targetEp + ' · ' + qLabel,
                        server: 'HentaiMama - ' + srvLabel,
                        url: streamUrl,
                        quality: qLabel,
                        type: isHls ? 'hls' : 'mp4',
                        headers: {
                            'User-Agent': UA,
                            'Referer': HM_BASE + '/'
                        }
                    });
                }
            } catch (e) {}
        }

        console.log('[hentaimama] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[hentaimama] Fatal error in getStreams: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for HentaiMama streams.',
            default: 'HentaiMama'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
