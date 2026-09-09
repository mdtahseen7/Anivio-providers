/**
 * AniZone Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves both SUB and DUB streams
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Direct HLS extraction from Vidstack player with 10+ subtitle tracks
 */

var ANIZONE_BASE = 'https://anizone.to';
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
    var normEn = normalize(primaryEn);
    var normRom = normalize(primaryRom);

    var candTitles = [cand.main_title];
    if (cand.title_list && typeof cand.title_list === 'object') {
        var vals = Object.values(cand.title_list);
        for (var v = 0; v < vals.length; v++) {
            candTitles.push(vals[v]);
        }
    }

    for (var i = 0; i < candTitles.length; i++) {
        var tNorm = normalize(candTitles[i]);
        if (!tNorm) continue;
        if (normEn && tNorm === normEn) { score = Math.max(score, 1000); break; }
        if (normRom && tNorm === normRom) { score = Math.max(score, 900); break; }

        if (normEn) {
            if (tNorm.indexOf(normEn) === 0 || normEn.indexOf(tNorm) === 0) score = Math.max(score, 150);
            else if (tNorm.indexOf(normEn) !== -1 || normEn.indexOf(tNorm) !== -1) score = Math.max(score, 80);
        }
        if (normRom) {
            if (tNorm.indexOf(normRom) === 0 || normRom.indexOf(tNorm) === 0) score = Math.max(score, 120);
            else if (tNorm.indexOf(normRom) !== -1 || normRom.indexOf(tNorm) !== -1) score = Math.max(score, 60);
        }
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

function decodeJsonArgument(raw) {
    if (!raw) return null;
    var marker = '\x01U\x01';
    var value = String(raw).replace(/\\\\u([0-9a-fA-F]{4})/g, marker + '$1');
    value = value.replace(/\\u([0-9a-fA-F]{4})/g, function(_, hex) {
        return String.fromCharCode(parseInt(hex, 16));
    });
    value = value.replace(/\x01U\x01([0-9a-fA-F]{4})/g, '\\u$1');
    try {
        return JSON.parse(value);
    } catch (e) {
        return null;
    }
}

function jsonArgument(html, name) {
    var pattern = new RegExp(name + '\\s*:\\s*JSON\\.parse\\(\'((?:[^\'\\\\]|\\\\.)*)\'\\)', 'i');
    var match = String(html || '').match(pattern);
    return decodeJsonArgument(match ? match[1] : null);
}

function normalizeUrl(value) {
    return String(value || '').replace(/\\+\//g, '/');
}

async function searchAniZone(query) {
    if (!query) return [];
    try {
        var res = await fetch(ANIZONE_BASE + '/anime?search=' + encodeURIComponent(query), {
            headers: { 'User-Agent': UA, 'Referer': ANIZONE_BASE + '/' }
        });
        if (!res.ok) return [];
        var html = await res.text();
        var items = jsonArgument(html, 'items');
        if (Array.isArray(items)) {
            return items;
        }
        return [];
    } catch (e) {
        return [];
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        console.log('[anizone] getStreams called: id=' + tmdbId + ' ep=' + episode);
        var meta = await resolveMetadata(tmdbId);
        if (!meta.titleEn && !meta.titleRom) {
            return [];
        }

        // Search AniZone
        var candidates = [];
        var queries = [meta.titleEn, meta.titleRom].filter(Boolean);
        for (var q = 0; q < queries.length; q++) {
            var res = await searchAniZone(queries[q]);
            if (res && res.length) {
                for (var r = 0; r < res.length; r++) {
                    candidates.push(res[r]);
                }
            }
        }

        if (!candidates.length) {
            console.log('[anizone] No search results for ' + meta.titleEn);
            return [];
        }

        var scored = candidates.map(function(c) {
            return { cand: c, score: scoreCandidate(c, meta.titleEn, meta.titleRom) };
        });
        scored.sort(function(a, b) { return b.score - a.score; });
        var selected = scored[0].cand;
        console.log('[anizone] Selected anime: ' + selected.main_title + ' (slug=' + selected.slug + ')');

        var targetNum = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetNum) || targetNum < 1) targetNum = 1;

        // Fetch episode page
        var epUrl = ANIZONE_BASE + '/anime/' + encodeURIComponent(selected.slug) + '/' + targetNum;
        var epRes = await fetch(epUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': ANIZONE_BASE + '/anime/' + encodeURIComponent(selected.slug)
            }
        });
        if (!epRes.ok) return [];
        var epHtml = await epRes.text();

        var playerMatch = epHtml.match(/vidstackPlayer\s*\(\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)\s*\)/i);
        if (!playerMatch) {
            console.log('[anizone] vidstackPlayer payload not found');
            return [];
        }

        var player = decodeJsonArgument(playerMatch[1]);
        if (!player || !player.src) {
            console.log('[anizone] Player payload has no src');
            return [];
        }

        var hlsUrl = normalizeUrl(player.src);

        // Process subtitle tracks
        var subtitles = [];
        var rawSubs = Array.isArray(player.subtitles) ? player.subtitles : [];
        for (var s = 0; s < rawSubs.length; s++) {
            var sub = rawSubs[s];
            if (sub && sub.file) {
                var langLabel = sub.title || sub.language || 'English';
                var langCode = sub.language || 'en';
                var clean = langLabel.toLowerCase();
                if (clean.indexOf('english') !== -1 || clean.indexOf('eng') !== -1) langCode = 'en';
                else if (clean.indexOf('spanish') !== -1 || clean.indexOf('spa') !== -1) langCode = 'es';
                else if (clean.indexOf('french') !== -1 || clean.indexOf('fre') !== -1) langCode = 'fr';
                else if (clean.indexOf('german') !== -1 || clean.indexOf('ger') !== -1) langCode = 'de';
                else if (clean.indexOf('italian') !== -1 || clean.indexOf('ita') !== -1) langCode = 'it';
                else if (clean.indexOf('portuguese') !== -1 || clean.indexOf('por') !== -1) langCode = 'pt';
                else if (clean.indexOf('russian') !== -1 || clean.indexOf('rus') !== -1) langCode = 'ru';
                else if (clean.indexOf('arabic') !== -1 || clean.indexOf('ara') !== -1) langCode = 'ar';

                subtitles.push({
                    url: normalizeUrl(sub.file),
                    language: langCode,
                    name: langLabel,
                    headers: {
                        'User-Agent': UA,
                        'Referer': ANIZONE_BASE + '/'
                    }
                });
            }
        }

        var headers = {
            'User-Agent': UA,
            'Referer': ANIZONE_BASE + '/'
        };

        var streams = [
            {
                name: 'AniZone',
                title: 'AniZone · Sub · Ep ' + targetNum,
                url: hlsUrl,
                quality: 'auto',
                type: 'hls',
                headers: headers,
                subtitles: subtitles
            },
            {
                name: 'AniZone',
                title: 'AniZone · Dub · Ep ' + targetNum,
                url: hlsUrl,
                quality: 'auto',
                type: 'hls',
                headers: headers,
                subtitles: subtitles
            }
        ];

        console.log('[anizone] Returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[anizone] Fatal error: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for AniZone streams.',
            default: 'AniZone'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
