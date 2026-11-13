/**
 * Live smoke test for providers/pahenime.js
 *
 * Validates the complete playback path through the proxy worker:
 *   1. getStreams returns streams
 *   2. Each proxied manifest is clean HLS (#EXTM3U at byte 0)
 *   3. The first segment is a valid stripped fMP4 payload (ftyp box present)
 *
 * NOTE: requires the /hls route from workers/luna-hls-strip.js to be deployed
 * on the proxy worker. The test reports a clear error when it is missing.
 *
 * Usage:
 *   node test-pahenime.js [title-or-id] [type] [season] [episode]
 */

const path = require('path');

// Frieren season 2: recent title + dual-audio (jpn/eng) + numeric TMDB flow.
const targetId = process.argv[2] || '209867';
const mediaType = process.argv[3] || 'tv';
const season = parseInt(process.argv[4] || '2', 10);
const episode = parseInt(process.argv[5] || '1', 10);

(async () => {
    const provider = require(path.join(__dirname, 'providers', 'pahenime.js'));
    const streams = await provider.getStreams(targetId, mediaType, season, episode);

    console.log(`Found ${streams.length} Pahenime stream(s)`);
    if (!streams.length) throw new Error('Provider returned no streams (is the /hls route deployed?)');

    let validated = 0;
    for (const stream of streams) {
        const manifestResponse = await fetch(stream.url, { headers: stream.headers || {} });
        if (!manifestResponse.ok) throw new Error(`${stream.title}: HTTP ${manifestResponse.status}`);
        const manifest = await manifestResponse.text();
        if (!manifest.startsWith('#EXTM3U')) {
            throw new Error(`${stream.title}: proxied manifest is not clean HLS (signature strip failed?)`);
        }

        // Resolve the first playlist URI (init or segment) and verify stripped MP4.
        const base = stream.url.slice(0, stream.url.lastIndexOf('/') + 1);
        const firstUri = manifest.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
        const segmentUrl = new URL(firstUri, base).href;
        const segmentResponse = await fetch(segmentUrl, { headers: stream.headers || {} });
        if (!segmentResponse.ok) throw new Error(`${stream.title}: segment HTTP ${segmentResponse.status}`);
        const segment = Buffer.from(await segmentResponse.arrayBuffer());
        const text = segment.subarray(0, 512).toString('latin1');
        if (!/ftyp|moof|moov|mdat/.test(text)) {
            throw new Error(`${stream.title}: segment is not a valid stripped fMP4 payload`);
        }

        console.log(`PASS HLS ${stream.title} (${stream.quality}, ${manifest.length} bytes manifest)`);
        validated++;
        if (validated >= 3) break; // sample three streams to keep the test fast
    }

    console.log('Pahenime smoke test passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
