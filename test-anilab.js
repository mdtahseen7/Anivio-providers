/**
 * Test script for providers/anilab.js
 *
 * Usage:
 *   node test-anilab.js [id] [type] [season] [episode]
 *
 * Example:
 *   node test-anilab.js 603 tv 1 1                 (Anivio Test button)
 *   node test-anilab.js anilab:1000006489 tv 1 1   (Firefly Wedding, direct)
 *   node test-anilab.js anilist:182255 tv 1 1      (Frieren S2 via mapping)
 */

const path = require('path');

const targetId = process.argv[2] || '603';
const mediaType = process.argv[3] || 'tv';
const season = parseInt(process.argv[4] || '1', 10);
const episode = parseInt(process.argv[5] || '1', 10);

(async () => {
  console.log(`\n========================================`);
  console.log(`Testing AniLab Provider with id=${targetId}, type=${mediaType}, season=${season}, ep=${episode}`);
  console.log(`========================================\n`);

  const anilab = require(path.join(__dirname, 'providers', 'anilab.js'));
  const streams = await anilab.getStreams(targetId, mediaType, season, episode);

  console.log(`\nFound ${streams.length} stream(s):`);
  console.log(JSON.stringify(streams, null, 2));

  if (streams.length === 0) {
    console.error('\nFAIL: No streams returned!');
    process.exit(1);
  }

  console.log('\n--- Verifying stream accessibility ---');
  for (let i = 0; i < Math.min(streams.length, 3); i++) {
    const s = streams[i];
    console.log(`\nStream #${i + 1} (${s.name} | ${s.quality}):`);
    console.log(`  Stream URL: ${s.url}`);

    const res = await fetch(s.url, { headers: s.headers || {} });
    console.log(`  Stream HTTP status: ${res.status}`);
    if (res.status === 200) {
      const text = await res.text();
      const isM3U8 = text.includes('#EXTM3U');
      console.log(`  Is valid m3u8 playlist: ${isM3U8}`);
      if (!isM3U8) {
        console.error('  ERROR: Not an m3u8 playlist!');
        process.exit(1);
      }
    } else {
      console.error(`  ERROR: Stream returned HTTP ${res.status}`);
      process.exit(1);
    }
  }

  console.log('\nSUCCESS: AniLab streams tested successfully!\n');
})().catch(err => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
