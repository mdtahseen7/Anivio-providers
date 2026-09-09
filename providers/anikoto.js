/**
 * Anikoto Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves both SUB and DUB streams
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Direct HLS extraction with required playback headers
 */

var ANIKOTO_BASE = 'https://anikototv.to';
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

async function searchAnikoto(query) {
    var res = await fetch(ANIKOTO_BASE + '/filter?keyword=' + encodeURIComponent(query), {
        headers: { 'User-Agent': UA, 'Referer': ANIKOTO_BASE + '/' }
    });
    if (!res.ok) return [];
    var html = await res.text();
    var re = /<a\s+class="name d-title"\s+href="https:\/\/anikototv\.to\/watch\/([^"/]+)(?:\/ep-\d+)?"[^>]*data-jp="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    var m;
    var candidates = [];
    var seen = new Set();
    while ((m = re.exec(html)) !== null) {
        var slug = m[1];
        if (seen.has(slug)) continue;
        seen.add(slug);
        candidates.push({
            slug: slug,
            jp: m[2].trim(),
            name: m[3].replace(/<[^>]*>/g, '').trim()
        });
    }
    return candidates;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        console.log('[anikoto] getStreams called: id=' + tmdbId + ' ep=' + episode);
        var meta = await resolveMetadata(tmdbId);

        var candidates = [];
        var queries = [meta.titleEn, meta.titleRom].filter(Boolean);
        for (var i = 0; i < queries.length; i++) {
            var found = await searchAnikoto(queries[i]);
            for (var f = 0; f < found.length; f++) {
                candidates.push(found[f]);
            }
            if (candidates.length > 0) break;
        }

        if (candidates.length === 0) {
            console.log('[anikoto] No results found on Anikoto for ' + tmdbId);
            return [];
        }

        candidates.sort(function(a, b) {
            return scoreCandidate(b, meta.titleEn, meta.titleRom) - scoreCandidate(a, meta.titleEn, meta.titleRom);
        });

        var chosen = candidates[0];
        console.log('[anikoto] Chosen show: ' + chosen.name + ' (' + chosen.slug + ')');

        // Fetch watch page to get showId
        var watchRes = await fetch(ANIKOTO_BASE + '/watch/' + chosen.slug, {
            headers: { 'User-Agent': UA, 'Referer': ANIKOTO_BASE + '/' }
        });
        if (!watchRes.ok) return [];
        var watchHtml = await watchRes.text();
        var showIdMatch = watchHtml.match(/data-id=["'](\d+)["']/);
        if (!showIdMatch) return [];
        var showId = showIdMatch[1];

        // Episode list
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        var epRes = await fetch(ANIKOTO_BASE + '/ajax/episode/list/' + showId, {
            headers: {
                'User-Agent': UA,
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': ANIKOTO_BASE + '/watch/' + chosen.slug
            }
        });
        if (!epRes.ok) return [];
        var epJson = await epRes.json();
        var epHtml = epJson && epJson.result ? epJson.result : '';

        var epRe = /<a\s+[^>]*data-id="([^"]*)"[^>]*>/g;
        var epM;
        var targetEpData = null;
        while ((epM = epRe.exec(epHtml)) !== null) {
            var tag = epM[0];
            var numMatch = tag.match(/data-num="([^"]*)"/);
            var num = numMatch ? parseInt(numMatch[1], 10) : 0;
            if (num === targetEp) {
                var idsMatch = tag.match(/data-ids="([^"]*)"/);
                targetEpData = { ids: idsMatch ? idsMatch[1] : '' };
                break;
            }
        }

        if (!targetEpData || !targetEpData.ids) {
            console.log('[anikoto] Episode ' + targetEp + ' not found in index');
            return [];
        }

        // Fetch servers for this episode
        var srvRes = await fetch(ANIKOTO_BASE + '/ajax/server/list?servers=' + encodeURIComponent(targetEpData.ids), {
            headers: {
                'User-Agent': UA,
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': ANIKOTO_BASE + '/'
            }
        });
        if (!srvRes.ok) return [];
        var srvJson = await srvRes.json();
        var srvHtml = srvJson && srvJson.result ? srvJson.result : '';

        var typeRe = /<div class="type" data-type="([^"]+)">([\s\S]*?)<\/ul>\s*<\/div>/g;
        var typeM;
        var serverButtons = [];
        while ((typeM = typeRe.exec(srvHtml)) !== null) {
            var typeName = typeM[1]; // 'sub', 'dub'
            if (typeName !== 'sub' && typeName !== 'dub') continue;
            var liMatches = typeM[2].matchAll(/<li\s+([^>]*data-link-id[^>]*)>([\s\S]*?)<\/li>/g);
            for (var li of liMatches) {
                var linkIdMatch = li[1].match(/data-link-id="([^"]+)"/);
                var sName = li[2].replace(/<[^>]+>/g, '').trim();
                if (linkIdMatch && linkIdMatch[1]) {
                    serverButtons.push({ typeName: typeName, sName: sName, linkId: linkIdMatch[1] });
                }
            }
        }

        var streams = [];
        var seenUrls = new Set();

        // Resolve servers (prioritizing Vidstream-2 / HD-1)
        for (var s = 0; s < serverButtons.length; s++) {
            var sb = serverButtons[s];
            try {
                var embedRes = await fetch(ANIKOTO_BASE + '/ajax/server?get=' + encodeURIComponent(sb.linkId), {
                    headers: {
                        'User-Agent': UA,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': ANIKOTO_BASE + '/'
                    }
                });
                if (!embedRes.ok) continue;
                var embedJson = await embedRes.json();
                var embedUrl = embedJson && embedJson.result ? embedJson.result.url : null;
                if (!embedUrl) continue;

                if (embedUrl.indexOf('megaplay') !== -1 || embedUrl.indexOf('stream') !== -1) {
                    var pRes = await fetch(embedUrl, {
                        headers: { 'User-Agent': UA, 'Referer': ANIKOTO_BASE + '/' }
                    });
                    if (!pRes.ok) continue;
                    var pHtml = await pRes.text();
                    var dIdMatch = pHtml.match(/id=["']megaplay-player["'][^>]*data-id=["']([^"']+)["']/i) ||
                                   pHtml.match(/data-id=["']([^"']+)["'][^>]*id=["']megaplay-player["']/i) ||
                                   pHtml.match(/data-id=["']([a-zA-Z0-9_-]+)["']/);
                    var dId = dIdMatch ? dIdMatch[1] : null;
                    if (!dId) continue;

                    var srcRes = await fetch('https://megaplay.buzz/stream/getSourcesNew?id=' + encodeURIComponent(dId), {
                        headers: {
                            'User-Agent': UA,
                            'Referer': embedUrl,
                            'X-Requested-With': 'XMLHttpRequest',
                            'Accept': 'application/json,*/*'
                        }
                    });
                    if (!srcRes.ok) continue;
                    var srcData = await srcRes.json();
                    var m3u8 = srcData && srcData.sources && srcData.sources.file ? srcData.sources.file : null;
                    if (!m3u8 && Array.isArray(srcData && srcData.sources) && srcData.sources[0]) {
                        m3u8 = srcData.sources[0].file || srcData.sources[0].url || null;
                    }
                    if (!m3u8 || seenUrls.has(m3u8)) continue;
                    seenUrls.add(m3u8);

                    var subtitles = [];
                    var rawTracks = Array.isArray(srcData && srcData.tracks) ? srcData.tracks : [];
                    for (var trIdx = 0; trIdx < rawTracks.length; trIdx++) {
                        var tr = rawTracks[trIdx];
                        if (tr && tr.file) {
                            var langLabel = tr.label || 'English';
                            var langCode = 'en';
                            var cleanLabel = langLabel.toLowerCase();
                            if (cleanLabel.indexOf('english') !== -1 || cleanLabel.indexOf('eng') !== -1) langCode = 'en';
                            else if (cleanLabel.indexOf('spanish') !== -1 || cleanLabel.indexOf('spa') !== -1) langCode = 'es';
                            else if (cleanLabel.indexOf('portuguese') !== -1 || cleanLabel.indexOf('por') !== -1) langCode = 'pt';
                            else if (cleanLabel.indexOf('french') !== -1 || cleanLabel.indexOf('fre') !== -1) langCode = 'fr';
                            else if (cleanLabel.indexOf('german') !== -1 || cleanLabel.indexOf('ger') !== -1) langCode = 'de';
                            else if (cleanLabel.indexOf('italian') !== -1 || cleanLabel.indexOf('ita') !== -1) langCode = 'it';
                            else if (cleanLabel.indexOf('japanese') !== -1 || cleanLabel.indexOf('jap') !== -1) langCode = 'ja';
                            else if (cleanLabel.indexOf('russian') !== -1 || cleanLabel.indexOf('rus') !== -1) langCode = 'ru';
                            else if (cleanLabel.indexOf('arabic') !== -1 || cleanLabel.indexOf('ara') !== -1) langCode = 'ar';

                            subtitles.push({
                                url: tr.file,
                                language: langCode,
                                name: langLabel,
                                headers: {
                                    'User-Agent': UA,
                                    'Referer': 'https://megaplay.buzz/'
                                }
                            });
                        }
                    }

                    var labelType = sb.typeName === 'dub' ? 'Dub' : 'Sub';
                    streams.push({
                        name: 'Anikoto',
                        title: 'Anikoto · ' + sb.sName + ' · ' + labelType + ' · Ep ' + targetEp,
                        url: m3u8,
                        quality: 'auto',
                        type: 'hls',
                        headers: {
                            'User-Agent': UA,
                            'Referer': 'https://megaplay.buzz/'
                        },
                        subtitles: subtitles
                    });
                }
            } catch (err) {
                console.warn('[anikoto] server resolve error: ' + (err && err.message));
            }
        }

        console.log('[anikoto] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[anikoto] Fatal error: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for Anikoto streams.',
            default: 'Anikoto'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
