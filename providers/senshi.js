/**
 * Senshi Stream Provider Plugin for Anivio
 *
 * Standalone stream provider for https://senshi.to
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - No backend dependency: resolves streams directly from senshi.to
 *   + the vidcloud source endpoint the site's own player uses
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 *
 * Resolution flow (mirrors the site's web player):
 *   1. ani.zip -> series titles (en / romaji)
 *   2. POST senshi.to/anime/filter {searchTerm} -> senshi anime id (title matched)
 *   3. GET senshi.to/episode-embeds/{id}/{ep} -> embed records (remote_source_id)
 *   4. GET s.vidcloud.se/_v1/sources?id={remote_source_id} -> real HLS url + subtitle tracks
 */

var SENSHI_BASE = 'https://senshi.to';
var SENSHI_FILTER = SENSHI_BASE + '/anime/filter';
var SENSHI_EMBEDS = SENSHI_BASE + '/episode-embeds';
var VIDCLOUD_SOURCES = 'https://s.vidcloud.se/_v1/sources';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

var STREAM_HEADERS = {
    'User-Agent': UA,
    'Referer': SENSHI_BASE + '/',
    'Origin': SENSHI_BASE
};

/**
 * Classifies the incoming ID into kind ('anilist' | 'mal' | 'tmdb' | 'unknown') and raw id.
 */
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

/**
 * Resolves series titles via AniZip.
 */
async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603"
    if (classified.id === '603') {
        return { titleEn: 'One Piece', titleRom: 'One Piece' };
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
                        titleRom: data.titles.ro || data.titles.en || ''
                    };
                }
            }
        } catch (e) {}
    }

    // Bare numeric id: try it as an AniList id
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
                        titleRom: aData.titles.ro || aData.titles.en || ''
                    };
                }
            }
        } catch (e) {}
    }

    return { titleEn: classified.id, titleRom: classified.id };
}

/**
 * Normalizes a title for comparison: lowercase alphanumeric only.
 */
function normalizeTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Searches senshi.to's anime index.
 */
async function searchSenshi(term) {
    try {
        var res = await fetch(SENSHI_FILTER, {
            method: 'POST',
            headers: {
                'User-Agent': UA,
                'Referer': SENSHI_BASE + '/',
                'Origin': SENSHI_BASE,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ searchTerm: term, page: 1, limit: 10 })
        });
        if (!res.ok) return [];
        var data = await res.json();
        if (data && Array.isArray(data.data)) return data.data;
        if (Array.isArray(data)) return data;
        return [];
    } catch (e) {
        return [];
    }
}

/**
 * Picks the best senshi anime entry for the given titles.
 * Prefers exact normalized title matches, then TV type for series.
 */
function pickBest(candidates, titleEn, titleRom, mediaType) {
    if (!candidates || candidates.length === 0) return null;

    var wantEn = normalizeTitle(titleEn);
    var wantRom = normalizeTitle(titleRom);
    var wantType = mediaType === 'movie' ? 'movie' : 'tv';

    var best = null;
    var bestScore = -1;

    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var t = normalizeTitle(c.title);
        var te = normalizeTitle(c.title_english);
        var score = 0;

        if ((wantEn && (t === wantEn || te === wantEn)) ||
            (wantRom && (t === wantRom || te === wantRom))) {
            score += 100;
        } else if ((wantEn && (t.indexOf(wantEn) === 0 || wantEn.indexOf(t) === 0 || te.indexOf(wantEn) === 0)) ||
                   (wantRom && (t.indexOf(wantRom) === 0 || wantRom.indexOf(t) === 0 || te.indexOf(wantRom) === 0))) {
            score += 40;
        } else {
            continue;
        }

        var ctype = String(c.type || '').toLowerCase();
        if (wantType === 'tv' && ctype === 'tv') score += 10;
        if (wantType === 'movie' && ctype === 'movie') score += 10;
        // Deprioritize specials/OVAs when looking for the main series
        if (ctype === 'special' || ctype === 'ova' || ctype === 'ona') score -= 5;

        // Earlier results from the site's own ranking win ties
        score -= i * 0.1;

        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }

    return best;
}

/**
 * Fetches the embed records for an episode. Each carries a remote_source_id.
 */
async function getEpisodeEmbeds(senshiId, epNum) {
    try {
        var res = await fetch(SENSHI_EMBEDS + '/' + senshiId + '/' + epNum, {
            headers: {
                'User-Agent': UA,
                'Referer': SENSHI_BASE + '/',
                'Accept': 'application/json'
            }
        });
        if (!res.ok) return [];
        var data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}

/**
 * Resolves a remote_source_id through the vidcloud source endpoint
 * (the same endpoint the senshi.to web player calls).
 * Returns { src, tracks } or null.
 */
async function resolveVidcloudSource(remoteId) {
    try {
        var res = await fetch(VIDCLOUD_SOURCES + '?id=' + encodeURIComponent(remoteId), {
            headers: {
                'User-Agent': UA,
                'Referer': SENSHI_BASE + '/',
                'Origin': SENSHI_BASE,
                'Accept': 'application/json'
            }
        });
        if (!res.ok) return null;
        var data = await res.json();
        var entry = Array.isArray(data) ? data[0] : data;
        if (!entry || !entry.source || !entry.source.src) return null;
        return {
            src: entry.source.src,
            quality: entry.source.quality || 'auto',
            tracks: Array.isArray(entry.tracks) ? entry.tracks : []
        };
    } catch (e) {
        return null;
    }
}

/**
 * Builds Anivio subtitle entries from vidcloud track records.
 */
function buildSubtitles(tracks) {
    var subs = [];
    var seen = {};
    for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (!t) continue;
        var url = t.vtt_url || t.url || '';
        if (!url || seen[url]) continue;
        var label = String(t.label || 'English');
        if (/chapter/i.test(label)) continue;
        seen[url] = true;
        var lang = 'en';
        if (/spanish/i.test(label)) lang = 'es';
        else if (/portuguese/i.test(label)) lang = 'pt';
        else if (/french/i.test(label)) lang = 'fr';
        else if (/german/i.test(label)) lang = 'de';
        else if (/arabic/i.test(label)) lang = 'ar';
        else if (/indonesian/i.test(label)) lang = 'id';
        subs.push({
            url: url,
            language: lang,
            name: label,
            headers: {
                'User-Agent': UA,
                'Referer': SENSHI_BASE + '/'
            }
        });
    }
    return subs;
}

/**
 * Main stream extraction method invoked by Anivio.
 */
async function getStreams(id, type, season, episode) {
    try {
        console.log('[senshi] getStreams called: id=' + id + ' type=' + type + ' season=' + season + ' ep=' + episode);

        var meta = await resolveMetadata(id);
        if (!meta.titleEn && !meta.titleRom) {
            console.warn('[senshi] could not resolve any title for id=' + id);
            return [];
        }

        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;
        var targetSeason = parseInt(season != null ? season : 1, 10);
        if (isNaN(targetSeason) || targetSeason < 1) targetSeason = 1;
        var mediaType = type === 'movie' ? 'movie' : 'tv';

        // 1. Find the senshi anime id by title
        var queries = [];
        if (meta.titleEn) queries.push(meta.titleEn);
        if (meta.titleRom && meta.titleRom !== meta.titleEn) queries.push(meta.titleRom);
        if (targetSeason > 1 && meta.titleEn) queries.push(meta.titleEn + ' Season ' + targetSeason);

        var anime = null;
        for (var q = 0; q < queries.length && !anime; q++) {
            var candidates = await searchSenshi(queries[q]);
            anime = pickBest(candidates, meta.titleEn, meta.titleRom, mediaType);
        }

        if (!anime || !anime.id) {
            console.warn('[senshi] no senshi entry found for "' + meta.titleEn + '"');
            return [];
        }
        console.log('[senshi] matched senshi id=' + anime.id + ' (' + anime.title + ')');

        // 2. Episode embeds -> remote_source_id
        var embeds = await getEpisodeEmbeds(anime.id, targetEp);
        if (embeds.length === 0) {
            console.warn('[senshi] no embeds for id=' + anime.id + ' ep=' + targetEp);
            return [];
        }

        // 3. Resolve each unique remote source (usually a single shared one)
        var seenSources = {};
        var streams = [];
        for (var e = 0; e < embeds.length; e++) {
            var remoteId = embeds[e] && embeds[e].remote_source_id;
            if (!remoteId || seenSources[remoteId]) continue;
            seenSources[remoteId] = true;

            var source = await resolveVidcloudSource(remoteId);
            if (!source || !source.src) continue;

            streams.push({
                name: 'Senshi',
                title: 'Senshi · Ep ' + targetEp,
                server: 'Senshi',
                type: 'hls',
                quality: source.quality && source.quality !== 'Unknown' ? source.quality : 'auto',
                url: source.src,
                headers: STREAM_HEADERS,
                subtitles: buildSubtitles(source.tracks)
            });
        }

        console.log('[senshi] Total streams resolved: ' + streams.length);
        return streams;
    } catch (e) {
        console.error('[senshi] Error in getStreams: ' + (e && e.message));
        return [];
    }
}

/**
 * Provider settings for Anivio UI.
 */
async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for Senshi streams.',
            default: 'Senshi'
        }
    ];
}

// Export according to Anivio Plugin Contract
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
