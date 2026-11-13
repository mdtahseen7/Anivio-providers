/**
 * Pahenime Stream Provider Plugin for Anivio
 *
 * Conforms to Anivio Plugin Guide specifications:
 * - Engine: QuickJS (supports async/await natively, no transpilation)
 * - Single self-contained file (no import/export)
 * - Pahenime API: /api/search, /api/anime/<uuid>, /stream/metadata, /stream/start
 * - Multi-audio (Japanese/English) HLS with per-quality manifests
 * - Playback is routed through the Luna proxy /hls route, which strips the site's
 *   anti-hotlink image signatures (8-byte PNG before playlists, 20-byte JPEG JFIF
 *   header before fMP4 segments) and rewrites segment URIs back through itself.
 *   The /hls route lives in the Luna backend worker (Luna_Backend/src/routes/hls.ts)
 *   and is already deployed on https://luna-api.mdtahseen2901.workers.dev.
 * - Supported IDs: anilist:<id>, mal:<id>, numeric TMDB id, and "603" (Anivio Test button)
 */

var BASE_URL = 'https://pahenime.com';
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var ANILIST_GRAPHQL = 'https://graphql.anilist.co';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';

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

function getHlsProxyUrl(targetUrl) {
    if (!targetUrl) return '';
    return getProxyBase() + '/hls?url=' + encodeURIComponent(targetUrl)
        + '&apiKey=' + encodeURIComponent(getApiKey());
}

function pahenimeHeaders() {
    return {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': BASE_URL + '/'
    };
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
    return { kind: 'title', id: value };
}

function normalize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function resolveMetadata(rawId) {
    var classified = classifyId(rawId);

    // Anivio test button always passes "603"
    if (classified.id === '603') {
        return { titleEn: 'One Piece', titleRom: 'One Piece', titles: ['One Piece'] };
    }

    if (classified.kind === 'title') {
        return { titleEn: classified.id, titleRom: classified.id, titles: [classified.id] };
    }

    var titles = [];
    var titleEn = '';
    var titleRom = '';

    // 1. Try AniList GraphQL
    if (classified.kind === 'anilist') {
        try {
            var q = 'query ($id: Int) { Media(id: $id) { title { romaji english native } synonyms } }';
            var alRes = await fetch(ANILIST_GRAPHQL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
                body: JSON.stringify({ query: q, variables: { id: parseInt(classified.id, 10) } })
            });
            if (alRes.ok) {
                var alData = await alRes.json();
                var media = alData && alData.data && alData.data.Media;
                if (media && media.title) {
                    titleRom = media.title.romaji || '';
                    titleEn = media.title.english || '';
                    if (titleRom) titles.push(titleRom);
                    if (titleEn && titles.indexOf(titleEn) === -1) titles.push(titleEn);
                    if (Array.isArray(media.synonyms)) {
                        for (var s = 0; s < media.synonyms.length; s++) {
                            if (titles.indexOf(media.synonyms[s]) === -1) titles.push(media.synonyms[s]);
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // 2. Try AniZip for mappings
    if (titles.length === 0) {
        var query = null;
        if (classified.kind === 'mal') query = 'mal_id=' + encodeURIComponent(classified.id);
        else if (classified.kind === 'tmdb') query = 'themoviedb_id=' + encodeURIComponent(classified.id);
        else if (classified.kind === 'anilist') query = 'anilist_id=' + encodeURIComponent(classified.id);

        if (query) {
            try {
                var res = await fetch(ANIZIP_ENDPOINT + '?' + query, {
                    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
                });
                if (res.ok) {
                    var data = await res.json();
                    if (data && data.titles) {
                        titleEn = data.titles.en || '';
                        titleRom = data.titles.ro || '';
                        if (titleEn) titles.push(titleEn);
                        if (titleRom && titles.indexOf(titleRom) === -1) titles.push(titleRom);
                    }
                }
            } catch (e) {}
        }
    }

    if (titles.length === 0) {
        titles.push(classified.id);
        titleRom = classified.id;
    }

    return {
        titleEn: titleEn || titleRom || classified.id,
        titleRom: titleRom || titleEn || classified.id,
        titles: titles
    };
}

function scoreCandidate(item, titleEn, titleRom, mediaType, season) {
    var score = 0;
    var candTitle = normalize(item.name || item.title || '');
    var candTitleEn = normalize(item.english_title || item.title_en || '');
    var normEn = normalize(titleEn);
    var normRom = normalize(titleRom);

    if (normEn && (candTitle === normEn || candTitleEn === normEn)) score += 1000;
    if (normRom && (candTitle === normRom || candTitleEn === normRom)) score += 900;

    if (normEn) {
        if (candTitle.indexOf(normEn) === 0 || normEn.indexOf(candTitle) === 0) score += 200;
        else if (candTitle.indexOf(normEn) !== -1 || normEn.indexOf(candTitle) !== -1) score += 100;
    }
    if (normRom) {
        if (candTitle.indexOf(normRom) === 0 || normRom.indexOf(candTitle) === 0) score += 150;
        else if (candTitle.indexOf(normRom) !== -1 || normRom.indexOf(candTitle) !== -1) score += 80;
    }

    var requestedType = String(mediaType || '').toLowerCase();
    var candidateType = String(item.format || item.type || '').toLowerCase();
    if (requestedType === 'movie' && candidateType === 'movie') score += 120;
    if ((requestedType === 'tv' || requestedType === 'series') && candidateType === 'tv') score += 120;

    var requestedSeason = parseInt(season, 10);
    if (requestedSeason > 1) {
        var searchableTitle = String(item.name || '') + ' ' + String(item.english_title || '');
        var seasonAfterLabel = new RegExp('(?:season|part)\\s*' + requestedSeason + '(?:\\D|$)', 'i');
        var seasonBeforeLabel = new RegExp('(?:^|\\D)' + requestedSeason + '(?:st|nd|rd|th)?\\s*season', 'i');
        // Pahenime stores sequels as separate series. A base-series title can
        // otherwise win the exact-title score when Anivio passes one TMDB series
        // ID plus season > 1.
        if (seasonAfterLabel.test(searchableTitle) || seasonBeforeLabel.test(searchableTitle)) {
            score += 3000;
        } else {
            score -= 1000;
        }
    }

    return score;
}

async function searchPahenime(query) {
    if (!query) return [];
    try {
        var res = await fetch(BASE_URL + '/api/search?q=' + encodeURIComponent(query), {
            headers: pahenimeHeaders()
        });
        if (!res.ok) return [];
        var data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn('[pahenime] search error: ' + (e && e.message));
        return [];
    }
}

function searchQueries(titles) {
    var queries = [];
    function add(value) {
        var query = String(value || '').trim();
        if (query && queries.indexOf(query) === -1) queries.push(query);
    }

    for (var i = 0; i < titles.length; i++) {
        add(titles[i]);
        add(String(titles[i] || '').split(':')[0]);
        add(String(titles[i] || '').replace(/[`’]/g, "'"));
        add(String(titles[i] || '').replace(
            /\s+(?:(?:season|part)\s*\d+|\d+(?:st|nd|rd|th)\s+season)$/i,
            ''
        ));
    }
    return queries;
}

async function fetchPahenimeJson(url) {
    var response = await fetch(url, { headers: pahenimeHeaders() });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
    return response.json();
}

function episodeMatches(item, targetEpisode) {
    var value = item.episode_number != null ? item.episode_number : item.episode_string;
    return String(value) === String(targetEpisode) || Number(value) === Number(targetEpisode);
}

function audioLanguage(track) {
    var lang = String(track && track.lang ? track.lang : '').toLowerCase();
    var iso3ToIso2 = {
        eng: 'en', jpn: 'ja', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de',
        ita: 'it', por: 'pt', rus: 'ru', ara: 'ar', kor: 'ko', zho: 'zh', chi: 'zh',
        ind: 'id', tha: 'th', vie: 'vi', msa: 'ms', may: 'ms', hin: 'hi', tam: 'ta', tel: 'te'
    };
    return iso3ToIso2[lang] || lang || 'und';
}

function audioLabel(track) {
    var mapping = { ja: 'Japanese', en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', es: 'Spanish', fr: 'French', de: 'German', ko: 'Korean', zh: 'Chinese', pt: 'Portuguese', ru: 'Russian' };
    var code = audioLanguage(track);
    return mapping[code] || String(track && track.lang ? track.lang : 'Unknown');
}

function requestedAudioTracks(tracks) {
    var settings = typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS ? SCRAPER_SETTINGS : {};
    var preference = String(settings.preferred_audio || 'all').toLowerCase();
    var usable = Array.isArray(tracks) && tracks.length ? tracks : [{ index: 0, lang: 'jpn' }];
    if (preference === 'all') return usable;

    var filtered = [];
    for (var i = 0; i < usable.length; i++) {
        if (audioLanguage(usable[i]) === preference) filtered.push(usable[i]);
    }
    return filtered.length ? filtered : usable;
}

function preferredQuality(resolutions) {
    var settings = typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS ? SCRAPER_SETTINGS : {};
    var wanted = String(settings.preferred_quality || '1080p').toLowerCase();
    var list = Array.isArray(resolutions) && resolutions.length ? resolutions : [{ quality: '1080p' }];

    // Server-side quality names look like "1080p" / "720p" / "480p".
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].quality || '').toLowerCase() === wanted) return list[i].quality;
    }
    // Fall back to the highest resolution Pahenime reports for this episode.
    return list[0].quality;
}

async function startStream(episodeId, quality, audioIndex, serverUrl) {
    var response = await fetch(BASE_URL + '/stream/start/' + encodeURIComponent(episodeId), {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': BASE_URL + '/'
        },
        body: JSON.stringify({
            quality: quality,
            audioIndex: audioIndex || 0,
            serverUrl: serverUrl
        })
    });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' from /stream/start');
    var data = await response.json();
    if (!data || !data.streamUrl) throw new Error('no streamUrl from /stream/start');
    return data.streamUrl;
}

async function proxiedManifestIsValid(streamUrl) {
    try {
        var response = await fetch(getHlsProxyUrl(streamUrl), { headers: { 'User-Agent': UA } });
        if (response.status === 404) {
            console.warn('[pahenime] proxy /hls route missing (HTTP 404). Deploy workers/luna-hls-strip.js on the proxy worker.');
            return false;
        }
        if (!response.ok) return false;
        var body = await response.text();
        return body.indexOf('#EXTM3U') === 0;
    } catch (e) {
        console.warn('[pahenime] manifest validation failed: ' + (e && e.message));
        return false;
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var targetEpisode = parseInt(episode != null ? episode : 1, 10);
        if (isNaN(targetEpisode) || targetEpisode < 1) targetEpisode = 1;
        console.log('[pahenime] getStreams called for ' + tmdbId + ' ep=' + targetEpisode);

        var meta = await resolveMetadata(tmdbId);
        var allCandidates = [];
        var queries = searchQueries(meta.titles);
        for (var t = 0; t < queries.length; t++) {
            var items = await searchPahenime(queries[t]);
            for (var it = 0; it < items.length; it++) {
                var item = items[it];
                allCandidates.push({
                    item: item,
                    score: scoreCandidate(item, meta.titleEn, meta.titleRom, mediaType, season)
                });
            }
            if (allCandidates.length > 0) break;
        }
        if (allCandidates.length === 0) {
            console.log('[pahenime] No results found on Pahenime for ' + meta.titleRom);
            return [];
        }

        allCandidates.sort(function (a, b) { return b.score - a.score; });
        var seriesId = allCandidates[0].item.id;

        var seriesData = await fetchPahenimeJson(BASE_URL + '/api/anime/' + encodeURIComponent(seriesId));
        var episodes = Array.isArray(seriesData.episodes) ? seriesData.episodes : [];
        var target = null;
        for (var e = 0; e < episodes.length; e++) {
            if (episodeMatches(episodes[e], targetEpisode)) {
                target = episodes[e];
                break;
            }
        }
        if (!target || !target.id) {
            console.log('[pahenime] Episode ' + targetEpisode + ' not found for series ' + seriesId);
            return [];
        }

        var metadata = await fetchPahenimeJson(BASE_URL + '/stream/metadata/' + encodeURIComponent(target.id));
        var servers = Array.isArray(metadata.servers) ? metadata.servers : [];
        var audioTracks = requestedAudioTracks(metadata.audioTracks);
        var quality = preferredQuality(metadata.resolutions);

        var streams = [];
        var seen = {};
        for (var s = 0; s < servers.length; s++) {
            var server = servers[s];
            var serverName = server.name || ('Server ' + (s + 1));
            var serverUrl = server.url;
            if (!serverUrl) continue;

            for (var a = 0; a < audioTracks.length; a++) {
                var track = audioTracks[a];
                var streamUrl;
                try {
                    streamUrl = await startStream(target.id, quality, track.index || 0, serverUrl);
                } catch (streamError) {
                    console.warn('[pahenime] ' + serverName + ' audio ' + (track.index || 0) + ' failed: ' + streamError.message);
                    continue;
                }

                // Identical manifests are commonly exposed on both server hosts.
                var dedupeKey = streamUrl.split('/')[2] + streamUrl.split('/')[4];
                if (seen[dedupeKey]) continue;
                if (!(await proxiedManifestIsValid(streamUrl))) continue;
                seen[dedupeKey] = true;

                streams.push({
                    name: 'Pahenime',
                    provider: 'pahenime',
                    title: 'Pahenime · ' + serverName + ' · ' + audioLabel(track) + ' · Ep ' + targetEpisode,
                    url: getHlsProxyUrl(streamUrl),
                    quality: quality,
                    language: audioLanguage(track),
                    type: 'hls',
                    headers: {},
                    subtitles: []
                });
            }
        }

        console.log('[pahenime] returning ' + streams.length + ' streams');
        return streams;
    } catch (err) {
        console.error('[pahenime] getStreams fatal: ' + (err && err.message));
        return [];
    }
}

async function onSettings() {
    return [
        {
            key: 'backend_url',
            type: 'text',
            title: 'Proxy base URL',
            description: 'Luna worker base that must expose the /hls signature-stripping route.',
            default: 'https://luna-api.mdtahseen2901.workers.dev'
        },
        {
            key: 'api_key',
            type: 'text',
            title: 'Proxy API key',
            description: 'API key accepted by the proxy worker.',
            default: 'LetMeIn'
        },
        {
            key: 'preferred_quality',
            type: 'text',
            title: 'Preferred quality',
            description: 'Pahenime quality to request, for example 1080p, 720p or 480p.',
            default: '1080p'
        },
        {
            key: 'preferred_audio',
            type: 'text',
            title: 'Audio tracks',
            description: 'all returns every audio track; or filter by language code (jpn, eng, hin).',
            default: 'all'
        }
    ];
}

module.exports.getStreams = getStreams;
module.exports.onSettings = onSettings;
globalThis.getStreams = getStreams;
globalThis.onSettings = onSettings;
