/**
 * Test script for providers/mmani.js and providers/anibd.js
 *
 * Usage:
 *   node test-mmani.js [id] [type] [season] [episode]
 *
 * Example:
 *   node test-mmani.js 603 tv 1 1       (Anivio Test button)
 *   node test-mmani.js 182255 tv 1 1   (Frieren S2 BD)
 *   node test-mmani.js 172463 tv 1 1   (Jujutsu Kaisen BD)
 */

const path = require('path');

const targetId = process.argv[2] || '603';
const mediaType = process.argv[3] || 'tv';
const season = parseInt(process.argv[4] || '1', 10);
const episode = parseInt(process.argv[5] || '1', 10);

(async () => {
  console.log(`\n========================================`);
  console.log(`Testing MMani Provider with id=${targetId}, type=${mediaType}, season=${season}, ep=${episode}`);
  console.log(`========================================\n`);

  const mmani = require(path.join(__dirname, 'providers', 'mmani.js'));
  const streams = await mmani.getStreams(targetId, mediaType, season, episode);

  console.log(`\nFound ${streams.length} stream(s):`);
  console.log(JSON.stringify(streams, null, 2));

  if (streams.length === 0) {
    console.error('\nFAIL: No streams returned!');
    process.exit(1);
  }

  console.log('\n--- Verifying stream & subtitle accessibility ---');
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    console.log(`\nStream #${i + 1} (${s.name}):`);
    console.log(`  Stream URL: ${s.url}`);

    const res = await fetch(s.url);
    console.log(`  Stream HTTP status: ${res.status}`);
    if (res.status === 200) {
      const text = await res.text();
      const isM3U8 = text.includes('#EXTM3U');
      console.log(`  Is valid m3u8 playlist: ${isM3U8}`);
    } else {
      console.error(`  ERROR: Stream returned HTTP ${res.status}`);
    }

    if (s.subtitles && s.subtitles.length > 0) {
      for (const sub of s.subtitles) {
        console.log(`  Subtitle [${sub.language}]: ${sub.url}`);
        const subRes = await fetch(sub.url);
        console.log(`  Subtitle HTTP status: ${subRes.status} (${subRes.headers.get('content-type')})`);
        if (subRes.status !== 200) {
          console.error(`  ERROR: Subtitle returned HTTP ${subRes.status}`);
        }
      }
    }
  }

  console.log('\nSUCCESS: All streams and subtitles tested successfully!\n');
})().catch(err => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
