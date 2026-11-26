/**
 * Kotokai (AnimeKaiTV) Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Active mirror probing across animekaitv.to, anikaitv.to, animekai.se, anikai.se
 * - Resolves both SUB and DUB streams via MegaPlay with AES enc-token decryption
 * - Season-aware anime matching + MAL-ID verification
 * - Proxied HLS & WebVTT subtitles for smooth ExoPlayer/AVPlayer playback
 */

var KOTOKAI_DOMAINS = [
    'https://animekaitv.to',
    'https://anikaitv.to',
    'https://animekai.se',
    'https://anikai.se'
];
var KOTOKAI_BASE = KOTOKAI_DOMAINS[0];
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function probeActiveDomain() {
    for (var i = 0; i < KOTOKAI_DOMAINS.length; i++) {
        try {
            var res = await fetch(KOTOKAI_DOMAINS[i] + '/', {
                method: 'HEAD',
                headers: { 'User-Agent': UA }
            });
            if (res.ok || res.status === 301 || res.status === 302 || res.status === 303) {
                KOTOKAI_BASE = KOTOKAI_DOMAINS[i];
                console.log('[kotokai] Active domain: ' + KOTOKAI_BASE);
                return;
            }
        } catch (e) {}
    }
    KOTOKAI_BASE = KOTOKAI_DOMAINS[0];
}

function getProxyBase() {
    return (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.backend_url)
        ? String(SCRAPER_SETTINGS.backend_url).replace(/\/+$/, '')
        : 'https://luna-api.mdtahseen2901.workers.dev';
}

function getApiKey() {
    return (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS && SCRAPER_SETTINGS.api_key)
        ? SCRAPER_SETTINGS.api_key
        : 'LetMeIn';
}

function getProxyUrl(targetUrl, referer) {
    if (!targetUrl) return '';
    return getProxyBase() + '/proxy?url=' + encodeURIComponent(targetUrl)
        + (referer ? ('&referer=' + encodeURIComponent(referer)) : '')
        + '&apiKey=' + encodeURIComponent(getApiKey());
}

/* MegaPlay AES-CBC enc-token decryptor (pure ES5, QuickJS-safe) */
var MP_SBOX = null, MP_INV_SBOX = null;
var MP_RCON = [0, 1, 2, 4, 8, 16, 32, 64, 128, 27, 54];

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
        var b = (a ^ rotl(a, 1) ^ rotl(a, 2) ^ rotl(a, 3) ^ rotl(a, 4) ^ 99) & 255;
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
    for (i = 0; i < nk; i++) w[i] = [keyBytes[4 * i], keyBytes[4 * i + 1], keyBytes[4 * i + 2], keyBytes[4 * i + 3]];
    for (i = nk; i < nb * (nr + 1); i++) {
        temp = w[i - 1].slice();
        if (i % nk === 0) {
            var t0 = temp[0];
            temp[0] = MP_SBOX[temp[1]] ^ (MP_RCON[i / nk] || 0);
            temp[1] = MP_SBOX[temp[2]];
            temp[2] = MP_SBOX[temp[3]];
            temp[3] = MP_SBOX[t0];
        } else if (nk > 6 && i % nk === 4) {
            temp[0] = MP_SBOX[temp[0]];
            temp[1] = MP_SBOX[temp[1]];
            temp[2] = MP_SBOX[temp[2]];
            temp[3] = MP_SBOX[temp[3]];
        }
        w[i] = [0, 0, 0, 0];
        for (j = 0; j < 4; j++) w[i][j] = w[i - nk][j] ^ temp[j];
    }
    return { words: w, rounds: nr };
}

function mpAddRoundKey(state, words, round) {
    for (var c = 0; c < 4; c++) {
        state[0][c] ^= words[round * 4 + c][0];
        state[1][c] ^= words[round * 4 + c][1];
        state[2][c] ^= words[round * 4 + c][2];
        state[3][c] ^= words[round * 4 + c][3];
    }
}

function mpInvSubBytes(state) {
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) state[r][c] = MP_INV_SBOX[state[r][c]];
}

function mpInvShiftRows(state) {
    for (var r = 1; r < 4; r++) {
        for (var t = 0; t < r; t++) {
            var tmp = state[r][3];
            state[r][3] = state[r][2]; state[r][2] = state[r][1]; state[r][1] = state[r][0]; state[r][0] = tmp;
        }
    }
}

function mpInvMixColumns(state) {
    for (var c = 0; c < 4; c++) {
        var a0 = state[0][c], a1 = state[1][c], a2 = state[2][c], a3 = state[3][c];
        state[0][c] = mpGmul(a0, 14) ^ mpGmul(a1, 11) ^ mpGmul(a2, 13) ^ mpGmul(a3, 9);
        state[1][c] = mpGmul(a0, 9) ^ mpGmul(a1, 14) ^ mpGmul(a2, 11) ^ mpGmul(a3, 13);
        state[2][c] = mpGmul(a0, 13) ^ mpGmul(a1, 9) ^ mpGmul(a2, 14) ^ mpGmul(a3, 11);
        state[3][c] = mpGmul(a0, 11) ^ mpGmul(a1, 13) ^ mpGmul(a2, 9) ^ mpGmul(a3, 14);
    }
}

function mpAesDecryptBlock(block16, keyBytes) {
    mpBuildSboxes();
    var ks = mpKeyExpansion(keyBytes), words = ks.words, nr = ks.rounds;
    var state = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], r, c;
    for (r = 0; r < 4; r++) for (c = 0; c < 4; c++) state[r][c] = block16[r + 4 * c];
    mpAddRoundKey(state, words, nr);
    for (r = nr - 1; r >= 1; r--) {
        mpInvShiftRows(state); mpInvSubBytes(state); mpAddRoundKey(state, words, r); mpInvMixColumns(state);
    }
    mpInvShiftRows(state); mpInvSubBytes(state); mpAddRoundKey(state, words, 0);
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
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
    return out;
}

function mpUtf8ToStr(bytes) {
    var out = '', i = 0, c, c2, c3;
    while (i < bytes.length) {
        c = bytes[i++];
        if (c < 128) out += String.fromCharCode(c);
        else if (c > 191 && c < 224) { c2 = bytes[i++] || 0; out += String.fromCharCode(((c & 31) << 6) | (c2 & 63)); }
        else { c2 = bytes[i++] || 0; c3 = bytes[i++] || 0; out += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63)); }
    }
    return out;
}

function mpDecryptEnc(enc) {
    try {
        var key = mpStrToBytes('i?LMTAx0Q6,:}50U');
        while (key.length < 32) key.push(0);
        var iv = mpStrToBytes("W0;27ToaUpl_P%'c");
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
        return m ? m[1].replace(/\\\//g, '/') : '';
    } catch (e) {
        return '';
    }
}

function mpExtractFileUrl(srcData) {
    if (!srcData) return '';
    var s = srcData.sources;
    if (typeof s === 'string' && s) return s;
    if (s && typeof s === 'object') {
        if (typeof s.file === 'string' && s.file) return s.file;
        if (typeof s.url === 'string' && s.url) return s.url;
        if (typeof s.length === 'number') {
            for (var i = 0; i < s.length; i++) {
                if (s[i] && (s[i].file || s[i].url)) return s[i].file || s[i].url;
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
    if (lower.indexOf('anilist:') === 0) return { kind: 'anilist', id: value.slice(8).split(':')[0] };
    if (lower.indexOf('mal:') === 0) return { kind: 'mal', id: value.slice(4).split(':')[0] };
    if (/^\d+$/.test(value)) return { kind: 'numeric', id: value };
    return { kind: 'unknown', id: value };
}

function normalize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractSeasonNumber(title, slug) {
    var text = ((title || '') + ' ' + (slug || '')).toLowerCase();
    var m = text.match(/\bseason\s*(\d+)\b/) ||
            text.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/) ||
            text.match(/\bs(\d+)\b/) ||
            (slug ? slug.match(/-season-(\d+)(?:-|$)/) : null);
    if (m) return parseInt(m[1], 10);
    if (/\b(?:season|part)\s+iv\b/.test(text) || /-season-iv(?:-|$)/.test(text)) return 4;
    if (/\b(?:season|part)\s+iii\b/.test(text) || /-season-iii(?:-|$)/.test(text)) return 3;
    if (/\b(?:season|part)\s+ii\b/.test(text) || /-season-ii(?:-|$)/.test(text)) return 2;
    return 1;
}

function scoreCandidate(cand, primaryEn, primaryRom, targetSeason) {
    var score = 0;
    var candNameNorm = normalize(cand.name);
    var candJpNorm = normalize(cand.jp);
    var normEn = normalize(primaryEn);
    var normRom = normalize(primaryRom);

    if (normEn && candNameNorm === normEn) score += 500;
    if (normRom && candNameNorm === normRom) score += 400;
    if (normRom && candJpNorm === normRom) score += 300;
    if (normEn && (candNameNorm.indexOf(normEn) !== -1 || normEn.indexOf(candNameNorm) !== -1)) score += 150;
    if (normRom && (candNameNorm.indexOf(normRom) !== -1 || normRom.indexOf(candNameNorm) !== -1)) score += 100;

    var candSeason = extractSeasonNumber(cand.name, cand.slug);
    var tSeason = parseInt(targetSeason != null ? targetSeason : 1, 10) || 1;
    score += (candSeason === tSeason) ? 3000 : -4000;
    return score;
}

async function resolveMetadata(rawId) {
    var c = classifyId(rawId);
    if (c.id === '603') {
        return { titleEn: 'One Piece', titleRom: 'One Piece', anilistId: '21', malId: '21' };
    }

    var queries = [];
    if (c.kind === 'anilist') queries.push('anilist_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'mal') queries.push('mal_id=' + encodeURIComponent(c.id));
    else if (c.kind === 'numeric') {
        queries.push('anilist_id=' + encodeURIComponent(c.id));
        queries.push('themoviedb_id=' + encodeURIComponent(c.id));
    }

    for (var i = 0; i < queries.length; i++) {
        try {
            var res = await fetch(ANIZIP_ENDPOINT + '?' + queries[i], {
                headers: { 'User-Agent': UA, 'Accept': 'application/json' }
            });
            if (res.ok) {
                var data = await res.json();
                if (data && data.titles) {
                    return {
                        titleEn: data.titles.en || data.titles.ro || data.titles.ja || '',
                        titleRom: data.titles.ro || data.titles.en || '',
                        anilistId: data.mappings ? String(data.mappings.anilist_id || '') : '',
                        malId: data.mappings && data.mappings.mal_id != null ? String(data.mappings.mal_id) : (c.kind === 'mal' ? c.id : '')
                    };
                }
            }
        } catch (e) {}
    }

    return { titleEn: c.id, titleRom: c.id, anilistId: '', malId: (c.kind === 'mal' ? c.id : '') };
}

async function searchKotokai(query) {
    var res = await fetch(KOTOKAI_BASE + '/filter?keyword=' + encodeURIComponent(query), {
        headers: { 'User-Agent': UA, 'Referer': KOTOKAI_BASE + '/' }
    });
    if (!res.ok) return [];
    var html = await res.text();
    var re = /<a\s+class="name d-title"\s+href="https?:\/\/[^"\/]+\/watch\/([^"\/]+)(?:\/ep-\d+)?"[^>]*data-jp="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    var m, candidates = [], seen = {};
    while ((m = re.exec(html)) !== null) {
        var slug = m[1];
        if (seen[slug]) continue;
        seen[slug] = true;
        candidates.push({
            slug: slug,
            jp: m[2].trim(),
            name: m[3].replace(/<[^>]*>/g, '').replace(/&#039;/g, "'").replace(/&amp;/g, '&').trim()
        });
    }
    return candidates;
}

async function fetchShowEpisodeIndex(slug, cache) {
    if (cache && cache[slug]) return cache[slug];
    try {
        var watchRes = await fetch(KOTOKAI_BASE + '/watch/' + slug, {
            headers: { 'User-Agent': UA, 'Referer': KOTOKAI_BASE + '/' }
        });
        if (!watchRes.ok) return null;
        var watchHtml = await watchRes.text();
        var showIdMatch = watchHtml.match(/data-id=["'](\d+)["']/);
        if (!showIdMatch) return null;
        var epRes = await fetch(KOTOKAI_BASE + '/ajax/episode/list/' + showIdMatch[1], {
            headers: {
                'User-Agent': UA,
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': KOTOKAI_BASE + '/watch/' + slug
            }
        });
        if (!epRes.ok) return null;
        var epJson = await epRes.json();
        var out = { showId: showIdMatch[1], epHtml: epJson && epJson.result ? epJson.result : '' };
        if (cache) cache[slug] = out;
        return out;
    } catch (e) {
        return null;
    }
}

function readEpTagMal(epHtml, targetEp) {
    if (!epHtml) return '';
    var tagRe = /<a\s+[^>]*data-ids="[^"]*"[^>]*>/g;
    var m, firstMal = '', targetMal = '';
    var want = parseInt(targetEp != null ? targetEp : 1, 10);
    while ((m = tagRe.exec(epHtml)) !== null) {
        var tag = m[0];
        var malM = tag.match(/data-mal="([^"]*)"/);
        var mal = malM ? malM[1] : '';
        if (mal && !firstMal) firstMal = mal;
        var numM = tag.match(/data-num="([^"]*)"/);
        if (mal && numM && parseInt(numM[1], 10) === want) {
            targetMal = mal;
            break;
        }
    }
    return targetMal || firstMal;
}

async function getStreams(rawId, mediaType, season, episode) {
    try {
        console.log('[kotokai] getStreams called: id=' + rawId + ' season=' + season + ' ep=' + episode);
        await probeActiveDomain();
        var meta = await resolveMetadata(rawId);

        var targetSeason = parseInt(season != null ? season : 1, 10) || 1;
        var targetEp = parseInt(episode != null ? episode : 1, 10) || 1;

        var candidates = [];
        var queries = [];
        if (targetSeason > 1) {
            if (meta.titleEn) queries.push(meta.titleEn + ' Season ' + targetSeason);
            if (meta.titleRom) queries.push(meta.titleRom + ' Season ' + targetSeason);
        }
        if (meta.titleEn) queries.push(meta.titleEn.replace(/[`'’‘]/g, "'"));
        if (meta.titleRom) queries.push(meta.titleRom);

        for (var i = 0; i < queries.length; i++) {
            var found = await searchKotokai(queries[i]);
            for (var f = 0; f < found.length; f++) candidates.push(found[f]);
            if (candidates.some(function(c) { return extractSeasonNumber(c.name, c.slug) === targetSeason; })) break;
        }

        if (candidates.length === 0) return [];

        candidates.sort(function(a, b) {
            return scoreCandidate(b, meta.titleEn, meta.titleRom, targetSeason) - scoreCandidate(a, meta.titleEn, meta.titleRom, targetSeason);
        });

        var chosen = candidates[0];
        var indexCache = {};
        if (meta.malId) {
            var checkN = Math.min(candidates.length, 5);
            for (var v = 0; v < checkN; v++) {
                var idx = await fetchShowEpisodeIndex(candidates[v].slug, indexCache);
                if (idx && readEpTagMal(idx.epHtml, targetEp) === String(meta.malId)) {
                    chosen = candidates[v];
                    break;
                }
            }
        }
        console.log('[kotokai] Chosen show: ' + chosen.name + ' (' + chosen.slug + ')');

        var index = indexCache[chosen.slug] || await fetchShowEpisodeIndex(chosen.slug, indexCache);
        if (!index) return [];
        var epHtml = index.epHtml;

        var epRe = /<a\s+[^>]*data-ids="([^"]*)"[^>]*>/g;
        var epM, targetEpData = null;
        while ((epM = epRe.exec(epHtml)) !== null) {
            var tag = epM[0];
            var numMatch = tag.match(/data-num="([^"]*)"/);
            if (numMatch && parseInt(numMatch[1], 10) === targetEp) {
                targetEpData = { ids: epM[1] };
                break;
            }
        }

        if (!targetEpData || !targetEpData.ids) return [];

        var srvRes = await fetch(KOTOKAI_BASE + '/ajax/server/list?servers=' + encodeURIComponent(targetEpData.ids), {
            headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Referer': KOTOKAI_BASE + '/' }
        });
        if (!srvRes.ok) return [];
        var srvJson = await srvRes.json();
        var srvHtml = srvJson && srvJson.result ? srvJson.result : '';

        var typeRe = /<div class="type" data-type="([^"]+)">([\s\S]*?)<\/ul>\s*<\/div>/g;
        var typeM, serverButtons = [];
        while ((typeM = typeRe.exec(srvHtml)) !== null) {
            var typeName = typeM[1];
            if (typeName !== 'sub' && typeName !== 'dub' && typeName !== 'hsub') continue;
            var liRe = /<li\s+([^>]*data-link-id[^>]*)>([\s\S]*?)<\/li>/g;
            var li;
            while ((li = liRe.exec(typeM[2])) !== null) {
                var linkIdMatch = li[1].match(/data-link-id="([^"]+)"/);
                var sName = li[2].replace(/<[^>]+>/g, '').trim();
                if (linkIdMatch && linkIdMatch[1]) {
                    serverButtons.push({ typeName: typeName === 'dub' ? 'dub' : 'sub', sName: sName, linkId: linkIdMatch[1] });
                }
            }
        }

        var streams = [];
        var seenUrls = {};

        for (var s = 0; s < serverButtons.length; s++) {
            var sb = serverButtons[s];
            try {
                var embedRes = await fetch(KOTOKAI_BASE + '/ajax/server?get=' + encodeURIComponent(sb.linkId), {
                    headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Referer': KOTOKAI_BASE + '/' }
                });
                if (!embedRes.ok) continue;
                var embedJson = await embedRes.json();
                var embedUrl = embedJson && embedJson.result ? embedJson.result.url : null;
                if (!embedUrl) continue;

                if (embedUrl.indexOf('megaplay') !== -1 || embedUrl.indexOf('stream') !== -1) {
                    var pRes = await fetch(embedUrl, { headers: { 'User-Agent': UA, 'Referer': KOTOKAI_BASE + '/' } });
                    if (!pRes.ok) continue;
                    var pHtml = await pRes.text();
                    var dIdMatch = pHtml.match(/id=["']megaplay-player["'][^>]*data-id=["']([^"']+)["']/i) ||
                                   pHtml.match(/data-id=["']([a-zA-Z0-9_-]+)["']/);
                    if (!dIdMatch || !dIdMatch[1]) continue;

                    var srcRes = await fetch('https://megaplay.buzz/stream/getSourcesNew?id=' + encodeURIComponent(dIdMatch[1]) + '&s=tcdn', {
                        headers: { 'User-Agent': UA, 'Referer': embedUrl, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json,*/*' }
                    });
                    if (!srcRes.ok) continue;
                    var srcData = await srcRes.json();
                    var m3u8 = mpExtractFileUrl(srcData) || null;
                    if (!m3u8 || seenUrls[m3u8]) continue;
                    seenUrls[m3u8] = true;

                    var subtitles = [];
                    var rawTracks = Array.isArray(srcData && srcData.tracks) ? srcData.tracks : [];
                    for (var trIdx = 0; trIdx < rawTracks.length; trIdx++) {
                        var tr = rawTracks[trIdx];
                        if (tr && tr.file) {
                            var langLabel = tr.label || 'English';
                            var langCode = 'en';
                            var low = langLabel.toLowerCase();
                            if (low.indexOf('span') !== -1) langCode = 'es';
                            else if (low.indexOf('port') !== -1) langCode = 'pt';
                            else if (low.indexOf('fren') !== -1) langCode = 'fr';
                            else if (low.indexOf('germ') !== -1) langCode = 'de';
                            else if (low.indexOf('arab') !== -1) langCode = 'ar';
                            else if (low.indexOf('russ') !== -1) langCode = 'ru';

                            subtitles.push({
                                url: getProxyUrl(tr.file, 'https://megaplay.buzz/'),
                                language: langCode,
                                name: langLabel,
                                headers: { 'User-Agent': UA, 'Referer': 'https://megaplay.buzz/' }
                            });
                        }
                    }

                    var labelType = sb.typeName === 'dub' ? 'Dub' : 'Sub';
                    var proxiedStreamUrl = getProxyBase() + '/anime/megaplay/proxy?url=' + encodeURIComponent(m3u8) + '&raw=1&apiKey=' + encodeURIComponent(getApiKey());
                    var epLabel = targetSeason > 1 ? 'S' + targetSeason + 'E' + targetEp : 'Ep ' + targetEp;

                    streams.push({
                        name: 'Kotokai (' + sb.sName + ' - ' + labelType + ')',
                        title: 'Kotokai · ' + sb.sName + ' · ' + labelType + ' · ' + epLabel,
                        server: 'Kotokai - ' + sb.sName,
                        url: proxiedStreamUrl,
                        quality: 'auto',
                        type: 'hls',
                        headers: { 'User-Agent': UA, 'Referer': 'https://megaplay.buzz/' },
                        subtitles: subtitles
                    });
                }
            } catch (err) {}
        }

        console.log('[kotokai] returning ' + streams.length + ' streams');
        return streams;
    } catch (e) {
        console.error('[kotokai] Fatal error: ' + (e && e.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'label',
            type: 'text',
            title: 'Provider Name',
            description: 'Display name for Kotokai streams.',
            default: 'Kotokai'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
