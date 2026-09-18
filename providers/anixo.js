/**
 * Anixo Stream Provider Plugin for Anivio
 *
 * Uses Anixo (anixo.buzz) stream relay — proxies MegaPlay/AniNeko/Zoko.
 * Engine: QuickJS (supports async/await natively, no transpilation)
 * Single self-contained file (no import/export)
 * Resolves SUB and DUB streams with intro/outro skip markers
 * Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603"
 */

var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var ANIXO_BASE = 'https://anixo.buzz';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function classifyId(rawId) {
    var v = String(rawId == null ? '' : rawId).trim();
    var l = v.toLowerCase();
    if (l.indexOf('anilist:') === 0) return { kind: 'anilist', id: v.slice('anilist:'.length).split(':')[0] };
    if (l.indexOf('mal:') === 0) return { kind: 'mal', id: v.slice('mal:'.length).split(':')[0] };
    if (/^\d+$/.test(v)) return { kind: 'tmdb', id: v };
    return { kind: 'unknown', id: v };
}
async function getMapping(rawId) {
    var c = classifyId(rawId);
    if (c.id === '603') return { anilistId: '21', kitsuId: '12', imdbId: 'tt0388629' };
    var queries = [];
    if (c.kind === 'anilist') queries.push('anilist_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'mal') queries.push('mal_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'tmdb') queries.push('themoviedb_id=' + encodeURIComponent(c.id));
    if (/^\d+$/.test(c.id)) queries.push('anilist_id=' + encodeURIComponent(c.id));
    for (var qi = 0; qi < queries.length; qi++) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?' + queries[qi], { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
            if (!res.ok) continue;
            var data = await res.json();
            if (data && data.mappings) {
                var m = data.mappings;
                return { anilistId: m.anilist_id ? String(m.anilist_id) : null, kitsuId: m.kitsu_id ? String(m.kitsu_id) : null, imdbId: m.imdb_id ? String(m.imdb_id) : null };
            }
        } catch (e) {}
    }
    return null;
}
function parseSubtitles(rawTracks) {
    var out = [];
    if (!Array.isArray(rawTracks)) return out;
    for (var i = 0; i < rawTracks.length; i++) {
        var t = rawTracks[i];
        if (!t || !t.url) continue;
        var label = t.label || 'English';
        out.push({ url: t.url, language: label.toLowerCase().slice(0, 2), name: label, headers: { 'User-Agent': UA, 'Referer': ANIXO_BASE + '/' } });
    }
    return out;
}
async function getStreams(rawId, mediaType, season, episode) {
    try {
        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;
        var ids = await getMapping(rawId);
        if (!ids || !ids.anilistId) return [];
        var results = [];
        for (var track = 0; track < 2; track++) {
            var isDub = track === 1;
            var trackLabel = isDub ? 'Dub' : 'Sub';
            var streamUrl = null;
            var subtitles = [];
            var intro = null;
            var outro = null;
            for (var server = 1; server <= 3; server++) {
                var resolveUrl = ANIXO_BASE + '/api/stream/resolve?anilistId=' + encodeURIComponent(ids.anilistId) + '&episode=' + targetEp + '&track=' + (isDub ? 'dub' : 'sub') + '&server=' + server + '&parentHost=anixo.buzz';
                try {
                    var res = await fetch(resolveUrl, { headers: { 'User-Agent': UA, 'Referer': ANIXO_BASE + '/', 'Accept': 'application/json' } });
                    if (!res.ok) continue;
                    var data = await res.json();
                    if (!data || !data.streamUrl) continue;
                    streamUrl = data.streamUrl;
                    subtitles = parseSubtitles(data.subtitles);
                    intro = data.intro || null;
                    outro = data.outro || null;
                    break;
                } catch (e) { continue; }
            }
            if (!streamUrl) continue;
            results.push({
                name: 'Anixo (' + trackLabel + ')',
                title: 'Anixo · ' + trackLabel + ' · Ep ' + targetEp,
                url: streamUrl,
                quality: 'auto',
                type: 'hls',
                headers: { 'User-Agent': UA, 'Referer': ANIXO_BASE + '/' },
                subtitles: subtitles,
                intro: intro,
                outro: outro
            });
        }
        return results;
    } catch (err) {
        console.warn('[anixo] getStreams fatal: ' + (err && err.message));
        return [];
    }
}
async function onSettings() {
    return [{ key: 'label', type: 'text', title: 'Provider Name', description: 'Display name', default: 'Anixo' }];
}
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
