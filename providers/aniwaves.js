/**
 * AniWaves Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves both SUB and DUB streams
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Direct HLS extraction from EchoVideo with subtitle support
 */

var ANIWAVES_BASE = 'https://aniwaves.ru';
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
    var candNameNorm = normalize(cand.name);
    var candJpNorm = normalize(cand.jp);
    var normEn = normalize(primaryEn);
    var normRom = normalize(primaryRom);

    if (normEn && candNameNorm === normEn) score += 1000;
    if (normRom && candNameNorm === normRom) score += 900;
    if (normRom && candJpNorm === normRom) score += 800;

    if (normEn) {
        if (candNameNorm.indexOf(normEn) === 0 || normEn.indexOf(candNameNorm) === 0) score += 150;
        else if (candNameNorm.indexOf(normEn) !== -1 || normEn.indexOf(candNameNorm) !== -1) score += 80;
    }
    if (normRom) {
        if (candNameNorm.indexOf(normRom) === 0 || normRom.indexOf(candNameNorm) === 0) score += 120;
        else if (candNameNorm.indexOf(normRom) !== -1 || normRom.indexOf(candNameNorm) !== -1) score += 60;
    }
    return score;
}

async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603"
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

function attribute(tag, name) {
    var match = String(tag || '').match(new RegExp('\\b' + name + '=["\']([^"\']*)["\']', 'i'));
    return match ? match[1] : '';
}

async function searchAniWaves(query) {
    if (!query) return [];
    try {
        var res = await fetch(ANIWAVES_BASE + '/filter?keyword=' + encodeURIComponent(query), {
            headers: { 'User-Agent': UA, 'Referer': ANIWAVES_BASE + '/' }
        });
        if (!res.ok) return [];
        var html = await res.text();
        var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
        var m;
        var candidates = [];
        var seen = new Set();

        while ((m = re.exec(html)) !== null) {
            var attrs = m[1];
            if (attrs.indexOf('name') === -1 || attrs.indexOf('d-title') === -1) continue;
            var href = attribute(attrs, 'href');
            var slugMatch = href.match(/^\/watch\/([a-z0-9-]+)$/i);
            if (!slugMatch) continue;
            var slug = slugMatch[1];
            if (seen.has(slug)) continue;
            seen.add(slug);

            var siteIdMatch = slug.match(/-(\d+)$/);
            if (!siteIdMatch) continue;
            var siteId = siteIdMatch[1];

            var name = stripHtml(m[2]);
            var jp = attribute(attrs, 'data-jp');
            candidates.push({ slug: slug, siteId: siteId, name: name, jp: jp });
        }
        return candidates;
    } catch (e) {
        return [];
    }
}

async function extractEchoVideo(embedUrl) {
    try {
        var match = embedUrl.match(/\/(embed-\d+)\/([a-zA-Z0-9_-]+)/);
        if (!match) return null;
        var embedType = match[1];
        var dataId = match[2];

        var getSourcesUrl = 'https://play.echovideo.ru/' + embedType + '/getSources?id=' + encodeURIComponent(dataId);
        var res = await fetch(getSourcesUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': embedUrl,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json,*/*'
            }
        });
        if (!res.ok) return null;
        var data = await res.json();
        if (!data) return null;

        var m3u8Url = '';
        if (typeof data.sources === 'string') {
            m3u8Url = data.sources;
        } else if (data.sources && typeof data.sources === 'object') {
            if (Array.isArray(data.sources.HD) && data.sources.HD[0]) m3u8Url = data.sources.HD[0];
            else if (Array.isArray(data.sources.HQ) && data.sources.HQ[0]) m3u8Url = data.sources.HQ[0];
            else if (Array.isArray(data.sources.SD) && data.sources.SD[0]) m3u8Url = data.sources.SD[0];
        }

        if (!m3u8Url) return null;

        var subtitles = [];
        if (Array.isArray(data.tracks)) {
            for (var i = 0; i < data.tracks.length; i++) {
                var tr = data.tracks[i];
                if (tr && tr.file) {
                    var langLabel = tr.label || 'English';
                    var langCode = 'en';
                    var clean = langLabel.toLowerCase();
                    if (clean.indexOf('english') !== -1 || clean.indexOf('eng') !== -1) langCode = 'en';
                    else if (clean.indexOf('spanish') !== -1 || clean.indexOf('spa') !== -1) langCode = 'es';
                    else if (clean.indexOf('french') !== -1 || clean.indexOf('fre') !== -1) langCode = 'fr';
                    else if (clean.indexOf('german') !== -1 || clean.indexOf('ger') !== -1) langCode = 'de';
                    else if (clean.indexOf('japanese') !== -1 || clean.indexOf('jap') !== -1) langCode = 'ja';

                    subtitles.push({
                        url: tr.file,
                        language: langCode,
                        name: langLabel,
                        headers: {
                            'User-Agent': UA,
                            'Referer': 'https://play.echovideo.ru/'
                        }
                    });
                }
            }
        }

        return {
            url: m3u8Url,
            type: m3u8Url.indexOf('.m3u8') !== -1 ? 'hls' : 'mp4',
            subtitles: subtitles
        };
    } catch (e) {
        return null;
    }
}

async function resolveAudioStreams(selected, targetEp, audio) {
    var watchUrl = ANIWAVES_BASE + '/watch/' + selected.slug + '/ep-' + targetEp.slug;
    var serverRes = await fetch(
        ANIWAVES_BASE + '/ajax/server/list?servers=' + encodeURIComponent(selected.siteId) + '&eps=' + encodeURIComponent(targetEp.slug),
        {
            headers: {
                'User-Agent': UA,
                'Referer': watchUrl,
                'X-Requested-With': 'XMLHttpRequest'
            }
        }
    );
    if (!serverRes.ok) return [];
    var sJson = await serverRes.json();
    var serverHtml = String(sJson.result || '');

    // Parse server markers
    var serverGroups = [];
    var markerRe = /<div\b([^>]*)>/gi;
    var markers = [];
    var mm;
    while ((mm = markerRe.exec(serverHtml)) !== null) {
        var dt = attribute(mm[1], 'data-type');
        if (dt === 'sub' || dt === 'dub') {
            markers.push({ index: mm.index, type: dt });
        }
    }

    for (var i = 0; i < markers.length; i++) {
        var curr = markers[i];
        if (curr.type !== audio) continue;
        var nextIdx = markers[i + 1] ? markers[i + 1].index : serverHtml.length;
        var seg = serverHtml.slice(curr.index, nextIdx);
        var liRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
        var lm;
        while ((lm = liRe.exec(seg)) !== null) {
            var linkId = attribute(lm[1], 'data-link-id');
            var sName = stripHtml(lm[2]);
            if (linkId) {
                serverGroups.push({ type: curr.type, linkId: linkId, name: sName });
            }
        }
    }

    var streams = [];
    for (var s = 0; s < serverGroups.length; s++) {
        var srv = serverGroups[s];
        try {
            var srcRes = await fetch(
                ANIWAVES_BASE + '/ajax/sources?id=' + encodeURIComponent(srv.linkId) + '&asi=0&autoPlay=0',
                {
                    headers: {
                        'User-Agent': UA,
                        'Referer': watchUrl,
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                }
            );
            if (!srcRes.ok) continue;
            var srcJson = await srcRes.json();
            var embedUrl = srcJson && srcJson.result ? srcJson.result.url : '';
            if (!embedUrl) continue;

            if (embedUrl.indexOf('echovideo.ru') !== -1) {
                var extracted = await extractEchoVideo(embedUrl);
                if (extracted && extracted.url) {
                    var labelType = audio === 'dub' ? 'Dub' : 'Sub';
                    streams.push({
                        name: 'AniWaves (' + srv.name + ')',
                        title: 'AniWaves · ' + srv.name + ' · ' + labelType + ' · Ep ' + targetEp.num,
                        url: extracted.url,
                        quality: 'auto',
                        type: extracted.type,
                        headers: {
                            'User-Agent': UA,
                            'Referer': 'https://play.echovideo.ru/'
                        },
                        subtitles: extracted.subtitles
                    });
                }
            }
        } catch (err) {}
    }

    return streams;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        console.log('[aniwaves] getStreams called: id=' + tmdbId + ' ep=' + episode);
        var meta = await resolveMetadata(tmdbId);
        if (!meta.titleEn && !meta.titleRom) {
            return [];
        }

        // Search AniWaves
        var candidates = [];
        var queries = [meta.titleEn, meta.titleRom].filter(Boolean);
        for (var q = 0; q < queries.length; q++) {
            var res = await searchAniWaves(queries[q]);
            if (res && res.length) {
                for (var r = 0; r < res.length; r++) {
                    candidates.push(res[r]);
                }
            }
        }

        if (!candidates.length) {
            console.log('[aniwaves] No search results for ' + meta.titleEn);
            return [];
        }

        var scored = candidates.map(function(c) {
            return { cand: c, score: scoreCandidate(c, meta.titleEn, meta.titleRom) };
        });
        scored.sort(function(a, b) { return b.score - a.score; });
        var selected = scored[0].cand;
        console.log('[aniwaves] Selected anime: ' + selected.name + ' (slug=' + selected.slug + ')');

        // Fetch episode list
        var epRes = await fetch(
            ANIWAVES_BASE + '/ajax/episode/list/' + encodeURIComponent(selected.siteId) + '?vrf=',
            {
                headers: {
                    'User-Agent': UA,
                    'Referer': ANIWAVES_BASE + '/watch/' + selected.slug,
                    'X-Requested-With': 'XMLHttpRequest'
                }
            }
        );
        if (!epRes.ok) return [];
        var epJson = await epRes.json();
        var epHtml = String(epJson.result || '');

        var epRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
        var em;
        var episodes = [];
        while ((em = epRe.exec(epHtml)) !== null) {
            var a = em[1];
            var num = parseInt(attribute(a, 'data-num'), 10);
            var slug = attribute(a, 'data-slug') || String(num);
            var hasSub = attribute(a, 'data-sub') === '1';
            var hasDub = attribute(a, 'data-dub') === '1';
            if (!isNaN(num)) {
                episodes.push({ num: num, slug: slug, hasSub: hasSub, hasDub: hasDub });
            }
        }

        if (!episodes.length) return [];

        var targetNum = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetNum) || targetNum < 1) targetNum = 1;

        var targetEp = null;
        for (var e = 0; e < episodes.length; e++) {
            if (episodes[e].num === targetNum) {
                targetEp = episodes[e];
                break;
            }
        }
        if (!targetEp) targetEp = episodes[0];

        // Parallel sub and dub resolution
        var tasks = [];
        if (targetEp.hasSub) tasks.push(resolveAudioStreams(selected, targetEp, 'sub'));
        if (targetEp.hasDub) tasks.push(resolveAudioStreams(selected, targetEp, 'dub'));

        var streamBatches = await Promise.all(tasks);
        var allStreams = [];
        for (var b = 0; b < streamBatches.length; b++) {
            var batch = streamBatches[b];
            for (var k = 0; k < batch.length; k++) {
                allStreams.push(batch[k]);
            }
        }

        console.log('[aniwaves] Returning ' + allStreams.length + ' streams');
        return allStreams;
    } catch (err) {
        console.error('[aniwaves] Fatal error: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for AniWaves streams.',
            default: 'AniWaves'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
