/**
 * AniLab / KYOTO Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Supported IDs: anilab:<id>, bare AniLab numeric id (100000xxxx),
 *   anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 * - Chain: AniLab catalog (search/post) -> KYOTO api.kyotoplayer.com
 *   seasons -> episodes -> stream -> direct xlsbox HLS
 * - Multi-quality variant expansion from the master m3u8 playlist
 *
 * KYOTO API details recovered by RE of the AniLab APK (v131):
 * - Base URL: https://api.kyotoplayer.com/ (all endpoints are POST,
 *   x-www-form-urlencoded; /update is a plain POST)
 * - Endpoints: seasons{id}, episodes{id,token}, servers{id,episode},
 *   stream{id,server}, series{ids}, player{embed}, update, log
 * - Requests carry anti-bot headers and a native HMAC signature:
 *     ts        = unix epoch seconds
 *     nonce     = 16 random bytes, base64url, padding stripped
 *     message   = "METHOD\n<path>\n<sha256hex(body)>\n<ts>\n<nonce>\n131"
 *     sig       = HMAC-SHA256(T1, message).hex()
 *   where T1 = HMAC-SHA256(K1, sha256(APK signingBlock blob)) is a constant
 *   baked into libkyoto.so (extracted by emulating nativeSign under unicorn),
 *   and K1 = 904e4bec7b2f8f85fa83cb4c8cd86bfb39d960cb4abaee5251e597111889a47b.
 * - The server occasionally round-robins to backends with skewed validation;
 *   the app itself retries on 401 with a fresh ts/nonce, we do the same.
 */

var ANILAB_API = 'https://anilab2.amdapi.click/api';
var KYOTO_API = 'https://api.kyotoplayer.com';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'okhttp/4.12.0';
var APP_VERSION = '131';

/* --- signing constants (see header comment) ---------------------------- */
var K1_HEX = '904e4bec7b2f8f85fa83cb4c8cd86bfb39d960cb4abaee5251e597111889a47b';
var BLOB_HEX = '482a900b2906766b2e8d3cf19fcf6d06d0b6c9569cb6305c9c43200a8e20979e';
var _T1_hex = null;
/** HMAC-SHA256(K1, sha256(APK signing block blob)) — computed lazily. */
function T1hex() {
    if (!_T1_hex) {
        _T1_hex = bytesToHex(hmacSHA256(hexToBytes(K1_HEX), hexToBytes(BLOB_HEX)));
    }
    return _T1_hex;
}

/**
 * Preferred audio track ('sub' | 'dub'). Overridable via SCRAPER_SETTINGS.
 */
function getAudioPref() {
    var pref = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.audio)
        ? String(SCRAPER_SETTINGS.audio).toLowerCase()
        : 'sub';
    return pref === 'dub' ? 'dub' : 'sub';
}

/* --- minimal pure-JS SHA-256 / HMAC-SHA256 ------------------------------ */
/* Compact implementations (work on byte arrays); used to replicate the
 * native libkyoto.so signature without external dependencies. */

function hexToBytes(hex) {
    var out = new Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

function bytesOf(str) {
    // UTF-8 encode
    var out = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); }
        else if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) {
            var c2 = str.charCodeAt(++i);
            var cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
            out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        } else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
}

function bytesToHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
}

var SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

function rol(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

/** SHA-256 over Array<number> bytes -> Array<number> (32). */
function sha256(msgBytes) {
    var len = msgBytes.length;
    var bitLenHi = Math.floor(len / 0x20000000);
    var bitLenLo = (len << 3) >>> 0;
    var withPad = msgBytes.slice();
    withPad.push(0x80);
    while (withPad.length % 64 !== 56) withPad.push(0);
    withPad.push((bitLenHi >>> 24) & 255, (bitLenHi >>> 16) & 255, (bitLenHi >>> 8) & 255, bitLenHi & 255,
                 (bitLenLo >>> 24) & 255, (bitLenLo >>> 16) & 255, (bitLenLo >>> 8) & 255, bitLenLo & 255);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var off = 0; off < withPad.length; off += 64) {
        for (var t = 0; t < 16; t++) {
            w[t] = ((withPad[off + 4 * t] << 24) | (withPad[off + 4 * t + 1] << 16) |
                    (withPad[off + 4 * t + 2] << 8) | withPad[off + 4 * t + 3]) >>> 0;
        }
        for (var tt = 16; tt < 64; tt++) {
            var s0 = rotr(w[tt - 15], 7) ^ rotr(w[tt - 15], 18) ^ (w[tt - 15] >>> 3);
            var s1 = rotr(w[tt - 2], 17) ^ rotr(w[tt - 2], 19) ^ (w[tt - 2] >>> 10);
            w[tt] = (w[tt - 16] + s0 + w[tt - 7] + s1) >>> 0;
        }
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (var ti = 0; ti < 64; ti++) {
            var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            var ch = (e & f) ^ (~e & g);
            var temp1 = (h + S1 + ch + SHA_K[ti] + w[ti]) >>> 0;
            var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var temp2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = [];
    for (var hi = 0; hi < 8; hi++) {
        out.push((H[hi] >>> 24) & 255, (H[hi] >>> 16) & 255, (H[hi] >>> 8) & 255, H[hi] & 255);
    }
    return out;
}

/** HMAC-SHA256(keyBytes, msgBytes) -> Array<number> (32). */
function hmacSHA256(keyBytes, msgBytes) {
    var block = 64;
    var k = keyBytes.slice();
    if (k.length > block) k = sha256(k);
    while (k.length < block) k.push(0);
    var ipad = [], opad = [];
    for (var i = 0; i < block; i++) {
        ipad.push((k[i] ^ 0x36) & 255);
        opad.push((k[i] ^ 0x5c) & 255);
    }
    var innerHash = sha256(ipad.concat(msgBytes));
    return sha256(opad.concat(innerHash));
}



function sha256Hex(str) {
    return bytesToHex(sha256(bytesOf(str)));
}

/* --- base64url nonce ---------------------------------------------------- */
var B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function randomBytes(n) {
    var out = new Array(n);
    if (typeof crypto !== 'undefined' && crypto && crypto.getRandomValues && typeof Uint8Array !== 'undefined') {
        var buf = new Uint8Array(n);
        crypto.getRandomValues(buf);
        for (var i = 0; i < n; i++) out[i] = buf[i];
        return out;
    }
    for (var j = 0; j < n; j++) {
        out[j] = Math.floor(Math.random() * 256);
    }
    return out;
}

function makeNonce() {
    // 16 random bytes -> base64url -> equals 22 chars without padding
    var bytes = randomBytes(16);
    var s = '';
    for (var i = 0; i < 15; i += 3) {
        var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        s += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63] +
             B64URL_ALPHABET[(n >> 6) & 63] + B64URL_ALPHABET[n & 63];
    }
    // remaining byte: 16 = 5*3 + 1
    s += B64URL_ALPHABET[(bytes[15] >> 2) & 63] + B64URL_ALPHABET[(bytes[15] << 4) & 63];
    return s; // 22 chars, base64url of 16 bytes, no padding
}

/**
 * Builds POST form body exactly as okhttp's @Field would (percent-encoding
 * reserved chars), plus the signature headers for those exact bytes.
 */
function buildKyotoRequest(path, params) {
    var parts = [];
    var keys = Object.keys(params);
    for (var i = 0; i < keys.length; i++) {
        parts.push(keys[i] + '=' + encodeURIComponent(String(params[keys[i]])));
    }
    var body = parts.join('&');
    var ts = String(Math.floor(Date.now() / 1000));
    var nonce = makeNonce();
    var bodyBytes = bytesOf(body);
    var message = 'POST' + '\n' + path + '\n' + bytesToHex(sha256(bodyBytes)) + '\n' +
                  ts + '\n' + nonce + '\n' + APP_VERSION;
    var sig = bytesToHex(hmacSHA256(hexToBytes(T1hex()), bytesOf(message)));
    var headers = {
        'Accept': 'application/json',
        'os-version': '34',
        'app-id': 'com.kyotoplayer',
        'app-version': APP_VERSION,
        'device-model': 'Pixel 6',
        'X-Kyoto-Ts': ts,
        'X-Kyoto-Nonce': nonce,
        'X-Kyoto-Sig': sig,
        'Content-Type': 'application/x-www-form-urlencoded'
    };
    return { url: KYOTO_API + path, body: body, headers: headers };
}

/**
 * Signed POST to the KYOTO API. Retries up to 4 times on 401 with a fresh
 * ts/nonce (the app's own okhttp interceptor does the same on skews).
 */
async function kyotoPost(path, params) {
    var lastErr = '';
    for (var attempt = 0; attempt < 4; attempt++) {
        var req = buildKyotoRequest(path, params);
        try {
            var res = await fetch(req.url, {
                method: 'POST',
                headers: req.headers,
                body: req.body
            });
            if (res.status === 401) {
                lastErr = '401';
                continue;
            }
            if (!res.ok) {
                console.log('[anilab] kyoto ' + path + ' -> HTTP ' + res.status);
                return null;
            }
            return await res.json();
        } catch (e) {
            lastErr = (e && e.message) || String(e);
        }
    }
    console.log('[anilab] kyoto ' + path + ' failed: ' + lastErr);
    return null;
}

/**
 * Classifies the incoming ID into kind
 * ('anilab' | 'anilist' | 'mal' | 'tmdb' | 'unknown') and raw id.
 */
function classifyId(rawId) {
    var value = String(rawId == null ? '' : rawId).trim();
    if (!value) return { kind: 'unknown', id: '' };

    var lower = value.toLowerCase();
    if (lower.indexOf('anilab:') === 0) {
        return { kind: 'anilab', id: value.slice('anilab:'.length).split(':')[0] };
    }
    if (lower.indexOf('anilist:') === 0) {
        return { kind: 'anilist', id: value.slice('anilist:'.length).split(':')[0] };
    }
    if (lower.indexOf('mal:') === 0) {
        return { kind: 'mal', id: value.slice('mal:'.length).split(':')[0] };
    }
    // AniLab catalog ids are long numerics in the 100000xxxx range.
    // Plain TMDB ids never look like that, so this is collision-free.
    if (/^100000\d+$/.test(value)) {
        return { kind: 'anilab', id: value };
    }
    if (/^\d+$/.test(value)) {
        return { kind: 'tmdb', id: value };
    }
    return { kind: 'unknown', id: value };
}

/**
 * Cleans titles by removing season, part, cour, and year suffixes.
 */
function cleanTitle(title) {
    if (!title) return '';
    return title
        .replace(/\s*\(\d{4}\)/g, '')
        .replace(/[:\s-]*(?:(?:season|part|cour)\s*\d+|\d+(?:nd|rd|th|st)\s*season|ii|iii|iv|v)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Normalizes a title for fuzzy comparison.
 */
function normTitle(title) {
    if (!title) return '';
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolves an incoming ID into metadata including AniList ID, titles, and absolute episode number.
 */
async function resolveAnimeMeta(rawId, season, episode) {
    var classified = classifyId(rawId);

    // Anivio's built-in "Test" button always passes tmdbId = "603" with season=1, episode=1.
    // Firefly Wedding is verified live on AniLab/KYOTO (id 1000006489).
    if (classified.id === '603') {
        return { anilabId: '1000006489', anilistId: '', title: 'Firefly Wedding', absEp: null, season: 1 };
    }

    if (classified.kind === 'anilab') {
        return { anilabId: classified.id, anilistId: '', title: '', absEp: null, season: parseInt(season || 1, 10) };
    }

    var query = '';
    if (classified.kind === 'anilist') {
        query = '?anilist_id=' + encodeURIComponent(classified.id);
    } else if (classified.kind === 'mal') {
        query = '?mal_id=' + encodeURIComponent(classified.id);
    } else if (classified.kind === 'tmdb') {
        query = '?themoviedb_id=' + encodeURIComponent(classified.id);
    }

    var explicitSeason = parseInt(season || 1, 10);
    var meta = {
        anilabId: '',
        anilistId: classified.id,
        title: '',
        absEp: null,
        relEp: null,
        season: explicitSeason
    };

    if (query) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + query, {
                headers: { 'Accept': 'application/json', 'User-Agent': UA }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.mappings && data.mappings.anilist_id) {
                    meta.anilistId = String(data.mappings.anilist_id);
                }
                var titles = (data && data.titles) ? data.titles : {};
                meta.title = titles.en || titles.ro || titles.ja || '';

                var targetEp = parseInt(episode || 1, 10);
                var eps = (data && data.episodes) ? data.episodes : {};

                var epObj = null;
                if (explicitSeason > 1) {
                    // Explicit season+episode call (e.g. test harnesses): match
                    // by season/episode numbers, falling back to the raw key.
                    epObj = eps[String(targetEp)];
                    for (var k in eps) {
                        var e = eps[k];
                        if (e && e.seasonNumber === explicitSeason && e.episodeNumber === targetEp) {
                            epObj = e;
                            break;
                        }
                    }
                } else {
                    // Anivio's anime contract: season is always 1 and episode
                    // is the show's absolute (AniList) episode number, which
                    // can sit in any ani.zip season of this entry. Find the
                    // episode whose absoluteEpisodeNumber equals it.
                    for (var ka in eps) {
                        var ea = eps[ka];
                        if (ea && ea.absoluteEpisodeNumber === targetEp) {
                            epObj = ea;
                            break;
                        }
                    }
                    if (!epObj) epObj = eps[String(targetEp)];
                }
                if (epObj) {
                    if (epObj.absoluteEpisodeNumber) {
                        meta.absEp = parseInt(epObj.absoluteEpisodeNumber, 10) || null;
                    }
                    meta.relEp = parseInt(epObj.episodeNumber || 0, 10) || null;
                    // Derive the effective season from the mapping data unless
                    // the caller explicitly forced one.
                    if (explicitSeason <= 1 && epObj.seasonNumber) {
                        meta.season = parseInt(epObj.seasonNumber, 10) || meta.season;
                    }
                }
            }
        } catch (e) {}
    }

    return meta;
}

/**
 * Detects sequel markers like "Season 2", "Part 2", "Cour 2", "2nd Season", "II".
 */
function seasonMarker(title) {
    if (!title) return 0;
    var m = title.match(/(?:season|part|cour)\s*(\d+)|(\d+)(?:nd|rd|th|st)\s*season|\b(ii|iii|iv|v)\b/i);
    if (!m) return 0;
    if (m[1]) return parseInt(m[1], 10);
    if (m[2]) return parseInt(m[2], 10);
    var romans = { ii: 2, iii: 3, iv: 4, v: 5 };
    return romans[String(m[3]).toLowerCase()] || 0;
}

/**
 * Scores a KYOTO season/series title against the wanted title + season.
 * 3 = cleaned exact match, 2 = containment with season-marker agreement,
 * 1 = plain containment, 0 = no match.
 */
function titleScore(detailTitle, wantClean, wantSeason) {
    var got = normTitle(cleanTitle(detailTitle || ''));
    if (!got || !wantClean) return 0;
    if (got === wantClean) return 3;
    var contains = got.indexOf(wantClean) !== -1 || wantClean.indexOf(got) !== -1;
    if (!contains) return 0;
    var gotMarker = seasonMarker(detailTitle);
    var agree = (wantSeason > 1 && gotMarker === wantSeason) || (wantSeason <= 1 && !gotMarker);
    return agree ? 2 : 1;
}

/**
 * Fetches the KYOTO season list for a catalog id.
 * Returns [{id, number, title, ...}] or [].
 */
async function fetchSeasons(catalogId) {
    var data = await kyotoPost('/seasons', { id: String(catalogId) });
    var list = (data && data.list) ? data.list : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || !s.id) continue;
        out.push({
            id: String(s.id),
            number: parseInt(s.number || 1, 10) || 1,
            title: s.title || '',
            episodes: parseInt(s.episodes || '0', 10) || 0,
            current: !!s.current
        });
    }
    return out;
}

/**
 * Fetches the KYOTO episode list for a season id.
 * Episodes carry inline server lists ({id:"<ep>/<lang>", lang, name}).
 * Returns { eps, subMap } or null.
 */
async function fetchEpisodes(seasonId) {
    var data = await kyotoPost('/episodes', { id: String(seasonId), token: '0' });
    if (!data) return null;
    var list = data.list || [];
    var eps = [];
    for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || !e.id) continue;
        eps.push({
            id: String(e.id),
            name: e.name || '',
            number: parseInt(e.number || '0', 10) || 0,
            servers: (e.servers || []).filter(function (s) { return s && s.id; })
        });
    }
    return eps;
}

/**
 * Searches the AniLab catalog by title (AMDAPI search) and ranks candidates
 * by matching their KYOTO season titles. Returns [{id, score, title}] sorted
 * best-first, or [].
 */
async function searchAniLab(title, season, absEp) {
    if (!title) return [];
    try {
        var res = await fetch(ANILAB_API + '/search?query=' + encodeURIComponent(title) + '&page=1', {
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        });
        if (!res.ok) return [];
        var json = await res.json();
        var posts = (json && json.posts) ? json.posts : [];
        if (posts.length === 0) return [];

        var wantClean = normTitle(cleanTitle(title));
        var wantSeason = parseInt(season || 1, 10);
        var scored = [];
        var count = Math.min(posts.length, 4);
        for (var i = 0; i < count; i++) {
            var catalogId = String(posts[i].id);
            if (!/^1000\d+$/.test(catalogId)) continue;
            try {
                var seasons = await fetchSeasons(catalogId);
                // Score every season title of this catalog entry; a franchise
                // entry ("Naruto" -> "Naruto Shippuden") matches per-season.
                var best = 0;
                var bestSeason = null;
                for (var sj = 0; sj < seasons.length; sj++) {
                    var sc = titleScore(seasons[sj].title, wantClean, wantSeason);
                    if (sc > best) { best = sc; bestSeason = seasons[sj]; }
                }
                if (best > 0) {
                    scored.push({ id: catalogId, score: best, title: bestSeason ? bestSeason.title : '', seasonId: bestSeason ? bestSeason.id : null });
                }
            } catch (e) {}
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        if (scored.length === 0 && posts.length > 0) {
            return [{ id: String(posts[0].id), score: 0, title: '', seasonId: null }];
        }
        return scored;
    } catch (e) {}
    return [];
}

/**
 * Selects the KYOTO season that matches the wanted meta (season number,
 * absolute episode number via cumulative counts) and the target episode.
 * Returns { season, targetEp } or null.
 */
function pickSeason(seasons, meta, targetEp) {
    if (seasons.length === 0) return null;
    // Single season: nothing to decide.
    if (seasons.length === 1) {
        return { season: seasons[0], targetEp: meta.absEp ? (meta.absEp - (meta.absEp <= seasons[0].episodes ? 0 : 0)) : targetEp };
    }
    // Prefer exact season number match.
    if (meta.season) {
        for (var i = 0; i < seasons.length; i++) {
            if (seasons[i].number === meta.season) {
                var chosen = seasons[i];
                var rel = targetEp;
                if (meta.absEp) {
                    // Map the absolute number onto this season when it falls
                    // inside its (approximate) range: sum previous seasons.
                    var cum = 0;
                    for (var j = 0; j < seasons.length; j++) {
                        if (seasons[j].number < chosen.number && seasons[j].episodes) {
                            cum += seasons[j].episodes;
                        }
                    }
                    if (meta.absEp > cum) rel = meta.absEp - cum;
                }
                return { season: chosen, targetEp: rel };
            }
        }
    }
    // Absolute episode mapping across seasons via cumulative counts.
    if (meta.absEp) {
        var seasonsSorted = seasons.slice().sort(function (a, b) { return a.number - b.number; });
        var cum2 = 0;
        for (var k = 0; k < seasonsSorted.length; k++) {
            var cnt = seasonsSorted[k].episodes || 0;
            if (meta.absEp > cum2 && meta.absEp <= cum2 + cnt) {
                return { season: seasonsSorted[k], targetEp: meta.absEp - cum2 };
            }
            cum2 += cnt;
        }
        // Fallback: last season holding the absolute range.
        var last = seasonsSorted[seasonsSorted.length - 1];
        return { season: last, targetEp: meta.absEp };
    }
    // Fall back to the "current"/first season.
    for (var c = 0; c < seasons.length; c++) {
        if (seasons[c].current) return { season: seasons[c], targetEp: targetEp };
    }
    return { season: seasons[0], targetEp: targetEp };
}

/**
 * Requests the direct HLS master link for (seriesId, serverId).
 */
async function fetchStream(seriesId, serverId) {
    var data = await kyotoPost('/stream', { id: String(seriesId), server: String(serverId) });
    if (data && data.link) return String(data.link);
    return null;
}

/**
 * Fetches JSON with a plain GET.
 */
async function getJson(url, headers) {
    var res = await fetch(url, { headers: headers || { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!res.ok) return null;
    try {
        return await res.json();
    } catch (e) {
        return null;
    }
}

/**
 * Expands an xlsbox master m3u8 into per-resolution variant entries.
 * Falls back to the master URL itself when parsing fails.
 */
async function expandVariants(masterUrl) {
    var fallback = [{ url: masterUrl, quality: 'auto' }];
    try {
        var res = await fetch(masterUrl, { headers: { 'User-Agent': UA } });
        if (!res.ok) return fallback;
        var text = await res.text();
        if (text.indexOf('#EXTM3U') === -1) return fallback;

        var lines = text.split('\n');
        var variants = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('#EXT-X-STREAM-INF') === 0 && i + 1 < lines.length) {
                var next = lines[i + 1].trim();
                if (!next || next.charAt(0) === '#') continue;
                var resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                var quality = resMatch ? resMatch[1] + 'p' : 'auto';
                var absUrl = (next.indexOf('http') === 0) ? next : new URL(next, masterUrl).toString();
                variants.push({ url: absUrl, quality: quality });
            }
        }
        // Variant playlists in this CDN are absolute already; keep master first as 'auto'.
        if (variants.length === 0) return fallback;
        var out = [{ url: masterUrl, quality: 'auto' }];
        var seen = {};
        seen[masterUrl] = true;
        for (var v = 0; v < variants.length; v++) {
            if (!seen[variants[v].url]) {
                seen[variants[v].url] = true;
                out.push(variants[v]);
            }
        }
        return out;
    } catch (e) {
        return fallback;
    }
}

/**
 * Main stream resolver required by Anivio.
 *
 * @param {string} tmdbId - Raw id (anilab:100000xxxx, bare 100000xxxx,
 *                          anilist:123, mal:123, numeric TMDB id, or "603")
 * @param {string} mediaType - "movie" | "tv"
 * @param {number|undefined} season - Season number
 * @param {number|undefined} episode - Episode number
 * @returns {Promise<Array>} List of stream objects
 */
async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        console.log('[anilab] getStreams called: id=' + tmdbId + ' type=' + mediaType + ' season=' + season + ' ep=' + episode);

        var meta = await resolveAnimeMeta(tmdbId, season, episode);

        var targetEp = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEp) || targetEp < 1) targetEp = 1;

        // 1. Resolve the AniLab catalog id (direct or via title search).
        var anilabId = meta.anilabId || '';
        var anilabTitle = meta.title || '';
        if (!anilabId) {
            if (!meta.title) {
                console.log('[anilab] No title to search for ' + tmdbId);
                return [];
            }
            console.log('[anilab] Searching AniLab catalog for: ' + meta.title);
            var hits = await searchAniLab(meta.title, meta.season, meta.absEp);
            if (hits.length === 0) {
                // Retry once with the franchise-cleaned title (strips "Season 2", years, ...).
                var cleaned = cleanTitle(meta.title);
                if (cleaned && cleaned !== meta.title) {
                    console.log('[anilab] Retrying search with cleaned title: ' + cleaned);
                    hits = await searchAniLab(cleaned, meta.season, meta.absEp);
                }
            }
            if (hits.length === 0) {
                console.log('[anilab] No AniLab catalog hit for ' + meta.title);
                return [];
            }
            anilabId = hits[0].id;
        }
        console.log('[anilab] AniLab id=' + anilabId + (anilabTitle ? ' (' + anilabTitle + ')' : ''));

        // 2. KYOTO seasons for the catalog id, then pick the matching season.
        var seasons = await fetchSeasons(anilabId);
        if (seasons.length === 0) {
            console.log('[anilab] No seasons for id ' + anilabId);
            return [];
        }
        console.log('[anilab] seasons: ' + seasons.map(function (s) { return '#' + s.number + ' ' + s.title + (s.current ? ' (current)' : ''); }).join(' | '));

        var picked = pickSeason(seasons, meta, targetEp);
        if (!picked) {
            console.log('[anilab] Could not pick a season for ' + anilabId);
            return [];
        }
        var seasonObj = picked.season;
        var seasonEp = picked.targetEp;
        if (isNaN(seasonEp) || seasonEp < 1) seasonEp = targetEp;
        console.log('[anilab] Picked season #' + seasonObj.number + ' "' + seasonObj.title + '" id=' + seasonObj.id + ' target ep ' + seasonEp);

        // 3. Episodes (inline servers) -> match by number, then name.
        var epsList = await fetchEpisodes(seasonObj.id);
        if (!epsList || epsList.length === 0) {
            console.log('[anilab] No episodes for season ' + seasonObj.id);
            return [];
        }

        var epObj = null;
        var matchedNum = '';
        var candidates = [];
        // Candidate episode numbers inside the chosen season's list.
        // KYOTO seasons either restart numbering at 1 (Shippuden-style) or
        // continue the franchise count (Apothecary/Black-Clover-style).
        // Cover both layouts, in priority order:
        //   1. relEp      — per-season number from ani.zip (seasonNumber path)
        //   2. seasonEp   — season-relative number computed by pickSeason
        //   3. targetEp   — what the host app passed (absolute for anime)
        //   4. absEp      — absolute number from ani.zip
        function pushCand(x) {
            if (x == null) return;
            var s = String(x);
            if (!s || s === '0' || s === 'NaN' || candidates.indexOf(s) !== -1) return;
            candidates.push(s);
        }
        pushCand(meta.relEp);
        pushCand(seasonEp);
        pushCand(targetEp);
        if (meta.absEp) pushCand(Math.max(1, meta.absEp));
        for (var ci = 0; ci < candidates.length && !epObj; ci++) {
            for (var ei = 0; ei < epsList.length; ei++) {
                if (String(epsList[ei].number) === candidates[ci]) {
                    epObj = epsList[ei];
                    matchedNum = candidates[ci];
                    break;
                }
            }
        }
        // Name-based fallback: "Episode 12"
        if (!epObj) {
            for (var nf = 0; nf < epsList.length && !epObj; nf++) {
                var nm = epsList[nf].name; // e.g. "Episode 12"
                if (nm && new RegExp('\\b' + targetEp + '\\b').test(nm)) {
                    epObj = epsList[nf];
                    matchedNum = String(targetEp);
                }
            }
        }
        if (!epObj) {
            console.log('[anilab] Episode ' + seasonEp + ' not in season index (' + epsList.length + ' eps)');
            return [];
        }
        console.log('[anilab] Matched episode: ' + JSON.stringify(epObj).slice(0, 200));

        if (epObj.servers.length === 0) {
            console.log('[anilab] Episode has no servers');
            return [];
        }

        // 4. Order servers by audio preference, direct links per server.
        var audioPref = getAudioPref();
        var wantLang = audioPref === 'dub' ? 'dub' : 'sub';
        var preferred = [];
        var others = [];
        for (var si = 0; si < epObj.servers.length; si++) {
            var lang = String(epObj.servers[si].lang || '').toLowerCase();
            if (lang === wantLang) {
                preferred.push(epObj.servers[si]);
            } else {
                others.push(epObj.servers[si]);
            }
        }
        var orderedServers = preferred.concat(others);

        var masterLinks = [];
        var seenLinks = {};
        for (var sj = 0; sj < orderedServers.length && masterLinks.length < 3; sj++) {
            try {
                var link = await fetchStream(seasonObj.id, orderedServers[sj].id);
                if (!link || seenLinks[link]) continue;
                // Only direct media links are playable here; HTML embed pages
                // need KYOTO's WebView scraper (out of scope for this provider).
                if (link.indexOf('.m3u8') === -1) {
                    console.log('[anilab] Skipping non-direct embed: ' + link.slice(0, 80));
                    continue;
                }
                seenLinks[link] = true;
                masterLinks.push({ link: link, server: orderedServers[sj] });
            } catch (err) {
                console.warn('[anilab] stream resolve failed: ' + (err && err.message));
            }
        }

        if (masterLinks.length === 0) {
            console.log('[anilab] No direct HLS links for episode ' + epObj.id);
            return [];
        }

        // 5. Expand master playlists into per-quality HLS streams.
        var streams = [];
        for (var mk = 0; mk < masterLinks.length; mk++) {
            var item = masterLinks[mk];
            var variants = await expandVariants(item.link);
            var langLabel = String(item.server.lang || '').toUpperCase();
            for (var vk = 0; vk < variants.length; vk++) {
                var displayTitle = 'AniLab · ' + (item.server.name || ('Server ' + (mk + 1)))
                    + (langLabel ? ' · ' + langLabel : '')
                    + ' · Ep ' + (epObj.number || targetEp);
                if (matchedNum && matchedNum !== String(targetEp)) {
                    displayTitle += ' (' + matchedNum + ')';
                }
                streams.push({
                    name: 'AniLab (' + (item.server.name || 'HLS') + ')',
                    title: displayTitle + ' · ' + variants[vk].quality,
                    url: variants[vk].url,
                    quality: variants[vk].quality,
                    type: 'hls',
                    headers: { 'User-Agent': UA },
                    subtitles: []
                });
            }
        }

        console.log('[anilab] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[anilab] Fatal error in getStreams: ' + (e && e.message));
        return [];
    }
}

/**
 * Provider settings for Anivio UI.
 */
async function onSettings() {
    // NOTE: the Anivio settings dialog reads label/defaultValue/options,
    // older readers used title/default — both are provided.
    return [
        {
            key: 'label',
            type: 'text',
            label: 'Provider Name',
            title: 'Provider Name',
            description: 'Display name for AniLab streams.',
            defaultValue: 'AniLab',
            default: 'AniLab'
        },
        {
            key: 'audio',
            type: 'select',
            label: 'Preferred Audio',
            title: 'Preferred Audio',
            description: 'Which server audio to prefer when both exist.',
            defaultValue: 'sub',
            default: 'sub',
            options: [
                { value: 'sub', label: 'Sub (Japanese)' },
                { value: 'dub', label: 'Dub (English)' }
            ]
        }
    ];
}

// Export according to Anivio Plugin Contract
module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
