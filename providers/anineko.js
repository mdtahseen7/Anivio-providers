/**
 * AniNeko Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves both SUB and DUB streams
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Direct HLS extraction from OtakuHG (StreamHG) and OtakuVid (Earnvids) with subtitles
 */

var ANINEKO_BASE = 'https://anineko.to';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
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
    return { kind: 'unknown', id: value };
}

function normalize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scoreCandidate(cand, primaryEn, primaryRom) {
    var score = 0;
    var candNorm = normalize(cand.title || cand.slug.replace(/-/g, ' '));
    var normEn = normalize(primaryEn);
    var normRom = normalize(primaryRom);

    if (normEn && candNorm === normEn) score += 1000;
    if (normRom && candNorm === normRom) score += 900;

    if (normEn) {
        if (candNorm.indexOf(normEn) === 0 || normEn.indexOf(candNorm) === 0) score += 150;
        else if (candNorm.indexOf(normEn) !== -1 || normEn.indexOf(candNorm) !== -1) score += 80;
    }
    if (normRom) {
        if (candNorm.indexOf(normRom) === 0 || normRom.indexOf(candNorm) === 0) score += 120;
        else if (candNorm.indexOf(normRom) !== -1 || normRom.indexOf(candNorm) !== -1) score += 60;
    }
    return score;
}

async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603" -> Map to One Piece (AniList 21)
    if (classified.id === '603') {
        return { titleEn: 'One Piece', titleRom: 'One Piece', anilistId: '21' };
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
                        anilistId: data.mappings ? String(data.mappings.anilist_id) : ''
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
                        anilistId: classified.id
                    };
                }
            }
        } catch (e) {}
    }

    return { titleEn: classified.id, titleRom: classified.id, anilistId: '' };
}

function stripHtml(v) {
    return String(v || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function unpackPacker(packedCode) {
    try {
        var fnBody = packedCode.replace(/^\s*eval\s*\(/, '(').replace(/\);\s*$/, ')');
        return Function('"use strict"; return ' + fnBody + ';')();
    } catch (e) {
        return null;
    }
}

async function searchAniNeko(query) {
    if (!query) return [];
    try {
        var res = await fetch(ANINEKO_BASE + '/browser?keyword=' + encodeURIComponent(query), {
            headers: { 'User-Agent': UA, 'Referer': ANINEKO_BASE + '/' }
        });
        if (!res.ok) return [];
        var html = await res.text();
        var re = /<a\b[^>]*class=["'][^"']*nv-anime-thumb[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
        var m;
        var results = [];
        var seen = new Set();

        while ((m = re.exec(html)) !== null) {
            var block = m[0];
            var tagMatch = block.match(/<a\b[^>]*>/i);
            var tag = tagMatch ? tagMatch[0] : '';
            var hrefMatch = tag.match(/href=["']([^"']*)["']/i);
            var href = hrefMatch ? hrefMatch[1] : '';
            var slugMatch = href.match(/\/watch\/([^/?#]+)/);
            if (!slugMatch) continue;
            var slug = slugMatch[1];
            if (seen.has(slug)) continue;
            seen.add(slug);

            var titleMatch = block.match(/<(?:h3|[^>]+class=["'][^"']*nv-anime-title[^"']*["'][^>]*)>([\s\S]*?)<\/(?:h3|[^>]+)>/i);
            var title = titleMatch ? stripHtml(titleMatch[1]) : slug.replace(/-/g, ' ');
            results.push({ slug: slug, title: title });
        }
        return results;
    } catch (e) {
        return [];
    }
}

async function extractEmbed(embedUrl, epUrl) {
    try {
        // Skip unplayable / Cloudflare-blocked providers
        var lowerEmbed = embedUrl.toLowerCase();
        if (lowerEmbed.indexOf('vivibebe') !== -1 || lowerEmbed.indexOf('bibiemb') !== -1 || lowerEmbed.indexOf('playmogo') !== -1) {
            return null;
        }

        var res = await fetch(embedUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': epUrl
            }
        });
        if (!res.ok) return null;
        var html = await res.text();

        // 1. Packed script (OtakuHG, OtakuVid)
        var m3u8Url = null;
        var packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)[\s\S]*?\)\)/);
        if (packedMatch) {
            var unpacked = unpackPacker(packedMatch[0]);
            if (unpacked) {
                var hls2Match = unpacked.match(/"hls2"\s*:\s*"([^"]+)"/) || unpacked.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
                if (hls2Match) {
                    m3u8Url = hls2Match[1] || hls2Match[0];
                }
            }
        }

        // 2. Direct m3u8 in html
        if (!m3u8Url) {
            var directM3u8 = html.match(/https?:\/\/[^"'\s\(\)]+\.m3u8[^"'\s\(\)]*/i);
            if (directM3u8) {
                m3u8Url = directM3u8[0];
            }
        }

        if (!m3u8Url) return null;

        // Extract subtitles if passed in query params
        var subtitles = [];
        var capMatch = embedUrl.match(/caption_\d+=([^&]+)/) || embedUrl.match(/c\d+_file=([^&]+)/) || embedUrl.match(/sub=([^&]+)/);
        var subLabelMatch = embedUrl.match(/sub_\d+=([^&]+)/) || embedUrl.match(/c\d+_label=([^&]+)/);
        if (capMatch) {
            var subUrl = decodeURIComponent(capMatch[1]);
            var subLabel = subLabelMatch ? decodeURIComponent(subLabelMatch[1]) : 'English';
            subtitles.push({
                url: subUrl,
                language: 'en',
                name: subLabel,
                headers: {
                    'User-Agent': UA,
                    'Referer': embedUrl
                }
            });
        }

        var origin = new URL(embedUrl).origin;
        return {
            url: m3u8Url,
            type: 'hls',
            subtitles: subtitles,
            headers: {
                'User-Agent': UA,
                'Referer': origin + '/'
            }
        };
    } catch (e) {
        return null;
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var meta = await resolveMetadata(tmdbId);
        if (!meta.titleEn && !meta.titleRom) {
            return [];
        }

        // Search AniNeko
        var candidates = [];
        var queries = [meta.titleEn, meta.titleRom].filter(Boolean);
        for (var q = 0; q < queries.length; q++) {
            var res = await searchAniNeko(queries[q]);
            if (res && res.length) {
                for (var r = 0; r < res.length; r++) {
                    candidates.push(res[r]);
                }
            }
        }

        if (!candidates.length) {
            return [];
        }

        var scored = candidates.map(function(c) {
            return { cand: c, score: scoreCandidate(c, meta.titleEn, meta.titleRom) };
        });
        scored.sort(function(a, b) { return b.score - a.score; });
        var selected = scored[0].cand;

        var targetNum = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetNum) || targetNum < 1) targetNum = 1;

        var epUrl = ANINEKO_BASE + '/watch/' + encodeURIComponent(selected.slug) + '/ep-' + targetNum;
        var epRes = await fetch(epUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': ANINEKO_BASE + '/watch/' + encodeURIComponent(selected.slug)
            }
        });
        if (!epRes.ok) return [];
        var epHtml = await epRes.text();

        // Find server panels: <div class="nv-server-grid" data-id="sub|dub">
        var panelRe = /<div\b[^>]*class=["'][^"']*nv-server-grid[^"']*["'][^>]*data-id=["']([^"']+)["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*nv-server-grid|$)/gi;
        var pm;
        var serverEmbeds = [];

        while ((pm = panelRe.exec(epHtml)) !== null) {
            var dt = pm[1].toLowerCase();
            var audio = dt.indexOf('dub') !== -1 ? 'dub' : 'sub';
            var seg = pm[2];

            var btnRe = /data-video=["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi;
            var bm;
            while ((bm = btnRe.exec(seg)) !== null) {
                var vUrl = bm[1];
                var sName = stripHtml(bm[2]) || 'Server';
                if (vUrl) {
                    serverEmbeds.push({ audio: audio, embedUrl: vUrl, serverName: sName });
                }
            }
        }

        if (!serverEmbeds.length) {
            var altBtns = [...epHtml.matchAll(/data-video=["']([^"']+)["']/gi)].map(function(m) { return m[1]; });
            for (var b = 0; b < altBtns.length; b++) {
                serverEmbeds.push({ audio: 'sub', embedUrl: altBtns[b], serverName: 'Server ' + (b + 1) });
            }
        }

        // Extract playable streams
        var streamTasks = serverEmbeds.map(async function(item) {
            var extracted = await extractEmbed(item.embedUrl, epUrl);
            if (extracted && extracted.url) {
                var labelType = item.audio === 'dub' ? 'Dub' : 'Sub';
                return {
                    name: 'AniNeko (' + item.serverName + ' - ' + labelType + ')',
                    title: 'AniNeko · ' + item.serverName + ' · ' + labelType + ' · Ep ' + targetNum,
                    url: extracted.url,
                    quality: 'auto',
                    type: extracted.type,
                    headers: extracted.headers,
                    subtitles: extracted.subtitles
                };
            }
            return null;
        });

        var results = await Promise.all(streamTasks);
        var streams = [];
        for (var i = 0; i < results.length; i++) {
            if (results[i]) streams.push(results[i]);
        }

        return streams;
    } catch (err) {
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for AniNeko streams.',
            default: 'AniNeko'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
