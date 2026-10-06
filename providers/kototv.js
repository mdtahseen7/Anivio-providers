/**
 * KotoTV Stream Provider Plugin for Anivio
 *
 * Scrapes KotoTV (kototv.to) using its JSON search API and server-rendered HTML.
 * The video sources are protected by a custom XOR cipher (key: "otaku-embed-v1")
 * exposed via `window.__P` inside `player.kototv.to` embed iframes.
 */

var BASE = 'https://kototv.to';
var PLAYER_URL = 'https://player.kototv.to';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

// Map ID to Title string via AniZip
async function getTitle(rawId) {
    var c = classifyId(rawId);
    if (c.id === '603') return 'One Piece';
    
    var query = '';
    if (c.kind === 'anilist') query = 'anilist_id=' + encodeURIComponent(c.id);
    else if (c.kind === 'mal') query = 'mal_id=' + encodeURIComponent(c.id);
    else if (c.kind === 'tmdb') query = 'themoviedb_id=' + encodeURIComponent(c.id);
    else return c.id;

    try {
        var res = await fetch('https://api.ani.zip/mappings?' + query, { headers: { 'Accept': 'application/json', 'User-Agent': UA } });
        if (res.ok) {
            var d = await res.json();
            if (d.titles) {
                return d.titles.en || d.titles.ro || d.titles.ja || c.id;
            }
        }
    } catch (e) {}
    return c.id;
}

// Decode Base64 without Node's Buffer
function b64Bytes(value) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', table = {}, out = [], buf = 0, bits = 0;
    for (var i = 0; i < 64; i++) table[chars.charAt(i)] = i;
    value = String(value || '');
    for (var j = 0; j < value.length; j++) {
        var c = value.charAt(j);
        if (c === '=' || table[c] == null) continue;
        buf = (buf << 6) | table[c]; bits += 6;
        if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); buf &= (1 << bits) - 1; }
    }
    return out;
}

// Decrypt the player payload
function decodeEmbedBlob(blob) {
    var bytes = b64Bytes(blob);
    var key = 'otaku-embed-v1';
    var text = '';
    for (var i = 0; i < bytes.length; i++) {
        text += String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length));
    }
    try {
        return JSON.parse(decodeURIComponent(escape(text)));
    } catch(e) {
        return null;
    }
}

async function getStreams(rawId, mediaType, season, episode) {
    try {
        var title = await getTitle(rawId);
        var n = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(n) || n < 1) n = 1;

        // 1. Search KotoTV
        var searchRes = await fetch(BASE + '/api/ajax/search?q=' + encodeURIComponent(title), { headers: { 'User-Agent': UA } });
        var searchData = await searchRes.json();
        if (!searchData.results || !searchData.results.length) return [];

        // Match best result
        var best = null, bestScore = -1;
        for (var i = 0; i < searchData.results.length; i++) {
            var item = searchData.results[i];
            var score = dice(title, item.title);
            if (score > bestScore) {
                bestScore = score;
                best = item;
            }
        }
        if (!best || bestScore < 0.3) return [];

        // 2. Fetch watch page HTML to get the embed URL config
        var watchRes = await fetch(BASE + '/anime/' + best.slug + '/watch/' + n, { headers: { 'User-Agent': UA } });
        if (!watchRes.ok) return [];
        var watchHtml = await watchRes.text();
        
        // Extract baseEmbedUrl from window.__WATCH_CFG__
        var m = watchHtml.match(/baseEmbedUrl["']?\s*:\s*["'](https?:\/\/[^"']+)["']/i);
        if (!m) return [];
        var baseEmbedUrl = m[1];

        // Also check if the episode actually has sub/dub via data attributes on the ep list
        // <li data-num="1" data-sub="1" data-dub="0"...>
        var hasSub = true, hasDub = true;
        var epMatch = watchHtml.match(new RegExp('data-num=["\']' + n + '["\'][^>]*data-sub=["\'](\\d+)["\'][^>]*data-dub=["\'](\\d+)["\']', 'i'));
        if (epMatch) {
            hasSub = epMatch[1] === '1';
            hasDub = epMatch[2] === '1';
        }

        var streams = [];
        var types = [];
        if (hasSub) types.push('sub');
        if (hasDub) types.push('dub');

        for (var t = 0; t < types.length; t++) {
            var type = types[t];
            try {
                // 3. Fetch the player embed frame
                var embedUrl = baseEmbedUrl + '/' + type;
                var embedRes = await fetch(embedUrl, { headers: { 'User-Agent': UA, 'Referer': BASE + '/' } });
                var embedHtml = await embedRes.text();

                // 4. Extract and decode window.__P payload
                var pMatch = embedHtml.match(/window\.__P\s*=\s*["']([^"']+)["']/);
                if (pMatch) {
                    var payload = decodeEmbedBlob(pMatch[1]);
                    if (payload && payload.src) {
                        var subtitles = [];
                        if (payload.subtitles && Array.isArray(payload.subtitles)) {
                            for (var s = 0; s < payload.subtitles.length; s++) {
                                var sub = payload.subtitles[s];
                                subtitles.push({
                                    url: sub.src,
                                    language: sub.lang || sub.label || 'en',
                                    name: sub.label || sub.lang || 'English'
                                });
                            }
                        }

                        streams.push({
                            name: 'KotoTV (' + type.toUpperCase() + ')',
                            title: 'KotoTV · HLS · ' + type.toUpperCase() + ' · Ep ' + n,
                            url: payload.src,
                            quality: '1080p',
                            type: 'hls',
                            headers: { 'Referer': PLAYER_URL + '/', 'User-Agent': UA },
                            subtitles: subtitles,
                            intro: payload.skip && payload.skip.intro ? payload.skip.intro : null,
                            outro: payload.skip && payload.skip.outro ? payload.skip.outro : null
                        });
                    }
                }
            } catch (e) {
                console.warn('[kototv] failed to extract ' + type + ':', e.message);
            }
        }

        return streams;
    } catch (e) {
        console.warn('[kototv] failed: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [{ key: 'label', type: 'text', title: 'Provider Name', description: 'Display name for KotoTV streams.', default: 'KotoTV' }];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
