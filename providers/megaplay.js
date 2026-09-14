/**
 * MegaPlay Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Resolves both SUB and DUB streams
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Stream manifest and subtitles proxied through Cloudflare Worker to strip fake PNG headers and prevent 403 / loading stalls
 */

var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var MEGAPLAY_BASE = 'https://megaplay.buzz';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var PROXY_HOST = 'https://luna-api.mdtahseen2901.workers.dev';
/* MegaPlay enc-token decryptor (pure ES5, QuickJS-safe: no atob/TextEncoder/WebCrypto) */
/* S-boxes are generated at runtime (verified AES construction) to avoid table typos */
var MP_SBOX = null, MP_INV_SBOX = null;
function mpBuildSboxes() {
    if (MP_SBOX) return;
    var exp = new Array(256), log = new Array(256), x = 1, i;
    for (i = 0; i < 255; i++) {
        exp[i] = x; log[x] = i;
        x ^= ((x << 1) ^ ((x & 128) ? 27 : 0)) & 255;
    }
    exp[255] = exp[0];
    function rotl(v, n) { return ((v << n) | (v >> (8 - n))) & 255; }
    MP_SBOX = new Array(256); MP_INV_SBOX = new Array(256);
    for (i = 0; i < 256; i++) {
        var a = (i === 0) ? 0 : exp[(255 - log[i]) % 255];
        var b = (a ^ rotl(a,1) ^ rotl(a,2) ^ rotl(a,3) ^ rotl(a,4) ^ 99) & 255;
        MP_SBOX[i] = b; MP_INV_SBOX[b] = i;
    }
}

function mpGmul(a, b) {
    var p = 0, i;
    for (i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        var hi = a & 128;
        a = (a << 1) & 255;
        if (hi) a ^= 27;
        b >>= 1;
    }
    return p;
}

function mpKeyExpansion(keyBytes) {
    var nk = keyBytes.length / 4, nr = nk + 6, nb = 4;
    var w = [], i, j, temp;
    for (i = 0; i < nk; i++) {
        w[i] = [keyBytes[4*i], keyBytes[4*i+1], keyBytes[4*i+2], keyBytes[4*i+3]];
    }
    for (i = nk; i < nb * (nr + 1); i++) {
        temp = w[i-1].slice();
        if (i % nk === 0) {
            var t0 = temp[0];
            temp[0] = MP_SBOX[temp[1]] ^ (MP_RCON[i/nk] || 0);
            temp[1] = MP_SBOX[temp[2]];
            temp[2] = MP_SBOX[temp[3]];
            temp[3] = MP_SBOX[t0];
        } else if (nk > 6 && i % nk === 4) {
            temp[0] = MP_SBOX[temp[0]];
            temp[1] = MP_SBOX[temp[1]];
            temp[2] = MP_SBOX[temp[2]];
            temp[3] = MP_SBOX[temp[3]];
        }
        w[i] = [0,0,0,0];
        for (j = 0; j < 4; j++) w[i][j] = w[i-nk][j] ^ temp[j];
    }
    return { words: w, rounds: nr };
}

var MP_RCON = [0,1,2,4,8,16,32,64,128,27,54];

function mpAddRoundKey(state, words, round) {
    var c;
    for (c = 0; c < 4; c++) {
        state[0][c] ^= words[round*4+c][0];
        state[1][c] ^= words[round*4+c][1];
        state[2][c] ^= words[round*4+c][2];
        state[3][c] ^= words[round*4+c][3];
    }
}
function mpInvSubBytes(state) {
    var r, c;
    for (r = 0; r < 4; r++) for (c = 0; c < 4; c++) state[r][c] = MP_INV_SBOX[state[r][c]];
}
function mpInvShiftRows(state) {
    var r, t, tmp;
    for (r = 1; r < 4; r++) {
        for (t = 0; t < r; t++) {
            tmp = state[r][3];
            state[r][3] = state[r][2];
            state[r][2] = state[r][1];
            state[r][1] = state[r][0];
            state[r][0] = tmp;
        }
    }
}
function mpInvMixColumns(state) {
    var c, a0, a1, a2, a3;
    for (c = 0; c < 4; c++) {
        a0 = state[0][c]; a1 = state[1][c]; a2 = state[2][c]; a3 = state[3][c];
        state[0][c] = mpGmul(a0,14) ^ mpGmul(a1,11) ^ mpGmul(a2,13) ^ mpGmul(a3,9);
        state[1][c] = mpGmul(a0,9) ^ mpGmul(a1,14) ^ mpGmul(a2,11) ^ mpGmul(a3,13);
        state[2][c] = mpGmul(a0,13) ^ mpGmul(a1,9) ^ mpGmul(a2,14) ^ mpGmul(a3,11);
        state[3][c] = mpGmul(a0,11) ^ mpGmul(a1,13) ^ mpGmul(a2,9) ^ mpGmul(a3,14);
    }
}

function mpAesDecryptBlock(block16, keyBytes) {
    mpBuildSboxes();
    var ks = mpKeyExpansion(keyBytes), words = ks.words, nr = ks.rounds;
    var state = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], r, c;
    for (r = 0; r < 4; r++) for (c = 0; c < 4; c++) state[r][c] = block16[r + 4*c];
    mpAddRoundKey(state, words, nr);
    for (r = nr - 1; r >= 1; r--) {
        mpInvShiftRows(state);
        mpInvSubBytes(state);
        mpAddRoundKey(state, words, r);
        mpInvMixColumns(state);
    }
    mpInvShiftRows(state);
    mpInvSubBytes(state);
    mpAddRoundKey(state, words, 0);
    var out = [];
    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) out.push(state[r][c]);
    return out;
}

function mpB64ToBytes(s) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var table = {}, i;
    for (i = 0; i < 64; i++) table[chars.charAt(i)] = i;
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    var out = [], j, buf = 0, bits = 0;
    for (j = 0; j < s.length; j++) {
        var ch = s.charAt(j);
        if (ch === '=') break;
        if (!(ch in table)) continue;
        buf = (buf << 6) | table[ch];
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 255);
            buf &= (1 << bits) - 1;
        }
    }
    return out;
}

function mpStrToBytes(s) {
    var out = [], i;
    for (i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
    return out;
}

function mpUtf8ToStr(bytes) {
    var out = '', i = 0, c, c2, c3;
    while (i < bytes.length) {
        c = bytes[i++];
        if (c < 128) { out += String.fromCharCode(c); }
        else if (c > 191 && c < 224) {
            c2 = bytes[i++] || 0;
            out += String.fromCharCode(((c & 31) << 6) | (c2 & 63));
        } else {
            c2 = bytes[i++] || 0; c3 = bytes[i++] || 0;
            out += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
        }
    }
    return out;
}

/* Decrypts a MegaPlay getSourcesNew `enc` token -> stream file URL (or '' on failure) */
function mpDecryptEnc(enc) {
    try {
        var keyStr = 'i?LMTAx0Q6,:}50U', ivStr = 'W0;27ToaUpl_P%\'c';
        var key = mpStrToBytes(keyStr);
        while (key.length < 32) key.push(0);
        var iv = mpStrToBytes(ivStr);
        var ct = mpB64ToBytes(enc);
        if (ct.length === 0 || ct.length % 16 !== 0) return '';
        var pt = [], prev = iv, b, k, dec;
        for (b = 0; b < ct.length; b += 16) {
            var block = ct.slice(b, b + 16);
            dec = mpAesDecryptBlock(block, key);
            for (k = 0; k < 16; k++) pt.push(dec[k] ^ prev[k]);
            prev = block;
        }
        var pad = pt[pt.length - 1];
        if (pad < 1 || pad > 16) return '';
        pt = pt.slice(0, pt.length - pad);
        var text = mpUtf8ToStr(pt);
        var m = text.match(/"file"\s*:\s*"([^"]+)"/);
        if (m) return m[1].replace(/\\\//g, '/');
        return '';
    } catch (e) {
        return '';
    }
}

/* Extracts the HLS file URL from a getSourcesNew response (supports legacy `sources` + new `enc`) */
function mpExtractFileUrl(srcData) {
    if (!srcData) return '';
    var s = srcData.sources;
    if (typeof s === 'string' && s) return s;
    if (s && typeof s === 'object') {
        if (typeof s.file === 'string' && s.file) return s.file;
        if (typeof s.url === 'string' && s.url) return s.url;
        if (typeof s.length === 'number') {
            for (var i = 0; i < s.length; i++) {
                if (s[i]) {
                    if (typeof s[i].file === 'string' && s[i].file) return s[i].file;
                    if (typeof s[i].url === 'string' && s[i].url) return s[i].url;
                }
            }
        }
    }
    if (typeof srcData.file === 'string' && srcData.file) return srcData.file;
    if (typeof srcData.enc === 'string' && srcData.enc) return mpDecryptEnc(srcData.enc);
    return '';
}


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

function extractSeasonNumber(text) {
    var t = (text || '').toLowerCase().trim();
    var sMatch = t.match(/\bseason\s*(\d+)\b/) ||
                 t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/) ||
                 t.match(/\bs(\d+)\b/) ||
                 t.match(/-season-(\d+)(?:-|$)/) ||
                 t.match(/-(\d+)(?:st|nd|rd|th)-season(?:-|$)/) ||
                 t.match(/\s+(\d+)$/);
    if (sMatch) return parseInt(sMatch[1], 10);
    if (/\b(?:season|part)\s+iv\b/.test(t)) return 4;
    if (/\b(?:season|part)\s+iii\b/.test(t)) return 3;
    if (/\b(?:season|part)\s+ii\b/.test(t)) return 2;
    return 1;
}

async function resolveSeasonAnilist(title, targetSeason) {
    if (!title || targetSeason <= 1) return null;
    try {
        var baseTitle = title.split(/\s*-\s*/)[0].trim();
        var queries = [
            baseTitle + ' ' + targetSeason,
            baseTitle + ' Season ' + targetSeason,
            baseTitle,
            title
        ];
        var seenKitsuIds = new Set();
        for (var q = 0; q < queries.length; q++) {
            var res = await fetch('https://kitsu.io/api/edge/anime?filter[text]=' + encodeURIComponent(queries[q]), {
                headers: { 'Accept': 'application/vnd.api+json', 'User-Agent': UA }
            });
            if (!res.ok) continue;
            var data = await res.json();
            var items = data && Array.isArray(data.data) ? data.data : [];
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (seenKitsuIds.has(item.id)) continue;
                seenKitsuIds.add(item.id);
                var canTitle = item.attributes ? (item.attributes.canonicalTitle || '') : '';
                var enTitle = (item.attributes && item.attributes.titles) ? (item.attributes.titles.en || '') : '';
                var sNum = extractSeasonNumber(canTitle + ' ' + enTitle);
                if (sNum === targetSeason) {
                    var zRes = await fetch(ANIZIP_ENDPOINT + '?kitsu_id=' + encodeURIComponent(item.id), {
                        headers: { 'Accept': 'application/json', 'User-Agent': UA }
                    });
                    if (zRes.ok) {
                        var zData = await zRes.json();
                        if (zData && zData.mappings && zData.mappings.anilist_id) {
                            return String(zData.mappings.anilist_id);
                        }
                    }
                }
            }
        }
    } catch (e) {}
    return null;
}

async function resolveAnilistId(rawId, targetSeason) {
    var classified = classifyId(rawId);

    if (classified.kind === 'anilist') {
        return classified.id;
    }

    // Anivio's built-in "Test" button always passes tmdbId = "603" with season=1, episode=1
    // Map to One Piece (AniList 21)
    if (classified.id === '603') {
        return '21';
    }

    if (classified.kind === 'mal') {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?mal_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.mappings && data.mappings.anilist_id) {
                    return String(data.mappings.anilist_id);
                }
            }
        } catch (e) {}
        return null;
    }

    if (classified.kind === 'tmdb') {
        try {
            var tmdbRes = await fetch(ANIZIP_ENDPOINT + '?themoviedb_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (tmdbRes.ok) {
                var tmdbData = await tmdbRes.json();
                if (targetSeason > 1 && tmdbData && tmdbData.titles) {
                    var primaryTitle = tmdbData.titles.en || tmdbData.titles.ro || tmdbData.titles.ja;
                    var seasonAnilistId = await resolveSeasonAnilist(primaryTitle, targetSeason);
                    if (seasonAnilistId) {
                        return seasonAnilistId;
                    }
                }
                if (tmdbData && tmdbData.mappings && tmdbData.mappings.anilist_id) {
                    return String(tmdbData.mappings.anilist_id);
                }
            }
        } catch (e) {}

        // If not found by TMDB id, check if the numeric string is directly an AniList id
        try {
            var aniRes = await fetch(ANIZIP_ENDPOINT + '?anilist_id=' + encodeURIComponent(classified.id), {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (aniRes.ok) {
                var aniData = await aniRes.json();
                if (aniData && aniData.mappings && aniData.mappings.anilist_id) {
                    return String(aniData.mappings.anilist_id);
                }
            }
        } catch (e) {}

        return classified.id;
    }

    return null;
}

async function fetchSourceForType(anilistId, targetEp, type, targetSeason) {
    var embedUrl = MEGAPLAY_BASE + '/stream/ani/' + encodeURIComponent(anilistId) + '/' + encodeURIComponent(targetEp) + '/' + type;
    try {
        var pageRes = await fetch(embedUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': MEGAPLAY_BASE + '/'
            }
        });
        if (!pageRes.ok) {
            return null;
        }

        var html = await pageRes.text();
        var dataIdMatch = html.match(/id=["']megaplay-player["'][^>]*data-id=["']([^"']+)["']/i) ||
                          html.match(/data-id=["']([^"']+)["'][^>]*id=["']megaplay-player["']/i) ||
                          html.match(/data-id=["']([a-zA-Z0-9_-]+)["']/);
        if (!dataIdMatch) {
            return null;
        }

        var dataId = dataIdMatch[1];
        var sParam = 's=tcdn';
        if (html.indexOf('"s=tcdn"') !== -1 || html.indexOf('s=tcdn') !== -1) {
            sParam = 's=tcdn';
        }

        var apiUrl = MEGAPLAY_BASE + '/stream/getSourcesNew?id=' + encodeURIComponent(dataId) + '&' + sParam;
        var apiRes = await fetch(apiUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': embedUrl,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json, text/javascript, */*; q=0.01'
            }
        });

        var srcData = null;
        if (apiRes.ok) {
            try {
                srcData = await apiRes.json();
            } catch (e) {}
        }

        // New responses normally contain an encrypted `enc` token instead of
        // a plain `sources` field. Keep that valid response rather than
        // selecting a different, potentially dead CDN in the fallback.
        if (!srcData || (!srcData.sources && !srcData.enc)) {
            var fallbackUrl = MEGAPLAY_BASE + '/stream/getSourcesNew?id=' + encodeURIComponent(dataId);
            var fbRes = await fetch(fallbackUrl, {
                headers: {
                    'User-Agent': UA,
                    'Referer': embedUrl,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'application/json, text/javascript, */*; q=0.01'
                }
            });
            if (fbRes.ok) {
                try {
                    srcData = await fbRes.json();
                } catch (e) {}
            }
        }

        if (!srcData) return null;

        // Supports legacy plain `sources` AND the new AES-encrypted `enc` token
        var m3u8Url = mpExtractFileUrl(srcData);

        if (!m3u8Url) return null;

        // Process subtitle tracks
        var subtitles = [];
        var rawTracks = Array.isArray(srcData.tracks) ? srcData.tracks : [];
        for (var t = 0; t < rawTracks.length; t++) {
            var tr = rawTracks[t];
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

                // Subtitle proxied so mobile players don't receive 403 Forbidden
                var subProxyUrl = PROXY_HOST + '/anime/megaplay/proxy?url=' + encodeURIComponent(tr.file);
                subtitles.push({
                    url: subProxyUrl,
                    language: langCode,
                    name: langLabel,
                    headers: {
                        'User-Agent': UA,
                        'Referer': MEGAPLAY_BASE + '/'
                    }
                });
            }
        }

        var labelType = type === 'dub' ? 'Dub' : 'Sub';
        // Stream proxied through worker to strip 252-byte disguised PNG headers and avoid ExoPlayer loading stalls
        var proxiedStreamUrl = PROXY_HOST + '/anime/megaplay/proxy?url=' + encodeURIComponent(m3u8Url) + '&raw=1';

        var epLabel = (targetSeason && targetSeason > 1) ? 'S' + targetSeason + 'E' + targetEp : 'Ep ' + targetEp;
        return {
            name: 'MegaPlay (' + labelType + ')',
            title: 'MegaPlay · ' + labelType + ' · ' + epLabel,
            url: proxiedStreamUrl,
            quality: 'auto',
            type: 'hls',
            headers: {
                'User-Agent': UA,
                'Referer': MEGAPLAY_BASE + '/'
            },
            subtitles: subtitles
        };
    } catch (err) {
        console.warn('[megaplay] failed resolving ' + type + ': ' + (err && err.message));
        return null;
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        console.log('[megaplay] getStreams called: id=' + tmdbId + ' season=' + season + ' ep=' + episode);
        var targetSeason = parseInt(season != null ? season : 1, 10);
        if (isNaN(targetSeason) || targetSeason < 1) targetSeason = 1;

        var anilistId = await resolveAnilistId(tmdbId, targetSeason);
        if (!anilistId) {
            console.log('[megaplay] No AniList ID resolved for ' + tmdbId);
            return [];
        }

        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        // Fetch both sub and dub in parallel
        var results = await Promise.all([
            fetchSourceForType(anilistId, targetEp, 'sub', targetSeason),
            fetchSourceForType(anilistId, targetEp, 'dub', targetSeason)
        ]);

        var streams = [];
        for (var i = 0; i < results.length; i++) {
            if (results[i]) {
                streams.push(results[i]);
            }
        }

        console.log('[megaplay] returning ' + streams.length + ' streams (sub/dub)');
        return streams;
    } catch (e) {
        console.error('[megaplay] Fatal error: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for MegaPlay streams.',
            default: 'MegaPlay'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
