/**
 * Test script for providers/anifam.js
 */

const path = require('path');

const targetId = process.argv[2] || '603';
const mediaType = process.argv[3] || 'tv';
const season = parseInt(process.argv[4] || '1', 10);
const episode = parseInt(process.argv[5] || '1', 10);

(async () => {
  console.log(`\n========================================`);
  console.log(`Testing AniFam Provider with id=${targetId}, type=${mediaType}, season=${season}, ep=${episode}`);
  console.log(`========================================\n`);

  const anifam = require(path.join(__dirname, 'providers', 'anifam.js'));
  const streams = await anifam.getStreams(targetId, mediaType, season, episode);

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

  console.log('\nSUCCESS: AniFam streams tested successfully!\n');
})().catch(err => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
