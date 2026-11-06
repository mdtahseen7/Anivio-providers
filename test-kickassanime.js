/**
 * Live smoke test for providers/kickassanime.js.
 *
 * Usage:
 *   node test-kickassanime.js [title-or-id] [type] [season] [episode]
 */

const path = require('path');

// Frieren season 2: recent title + numeric TMDB flow used by Anivio.
const targetId = process.argv[2] || '209867';
const mediaType = process.argv[3] || 'tv';
const season = parseInt(process.argv[4] || '2', 10);
const episode = parseInt(process.argv[5] || '1', 10);

(async () => {
    const provider = require(path.join(__dirname, 'providers', 'kickassanime.js'));
    const streams = await provider.getStreams(targetId, mediaType, season, episode);

    console.log(`Found ${streams.length} KickAssAnime stream(s)`);
    if (!streams.length) throw new Error('Provider returned no streams');

    let subtitleChecked = false;
    for (const stream of streams) {
        const response = await fetch(stream.url, { headers: stream.headers || {} });
        if (!response.ok) throw new Error(`${stream.title}: HTTP ${response.status}`);
        const body = await response.text();
        const valid = stream.type === 'dash'
            ? /<MPD(?:\s|>)/i.test(body)
            : body.includes('#EXTM3U');
        if (!valid) throw new Error(`${stream.title}: invalid ${stream.type} manifest`);

        console.log(`PASS ${stream.type.toUpperCase()} ${stream.title}`);
        if (!subtitleChecked && stream.subtitles && stream.subtitles.length) {
            const subtitle = stream.subtitles[0];
            const subtitleResponse = await fetch(subtitle.url, { headers: subtitle.headers || {} });
            if (!subtitleResponse.ok) {
                throw new Error(`Subtitle ${subtitle.name}: HTTP ${subtitleResponse.status}`);
            }
            const subtitleBody = await subtitleResponse.text();
            if (!subtitleBody.trim()) throw new Error(`Subtitle ${subtitle.name}: empty response`);
            console.log(`PASS subtitle ${subtitle.name}`);
            subtitleChecked = true;
        }
    }

    if (!subtitleChecked) throw new Error('No subtitle track was available to verify');
    console.log('KickAssAnime smoke test passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
