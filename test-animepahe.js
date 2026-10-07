/*
 * Integration test harness for providers/animepahe.js
 * animepahe is Cloudflare-protected, so we replay a real cf_clearance cookie + the exact
 * User-Agent that solved it (same machine = same public IP). Paste them below or via env.
 *
 *   CF_COOKIE  = the FULL Cookie header for animepahe.pw after you pass the CF challenge
 *                (DevTools -> Network -> any animepahe.pw request -> Request Headers -> Cookie)
 *   CF_UA      = your browser's navigator.userAgent (DevTools console: navigator.userAgent)
 *
 * Run:  node test-animepahe.js "One Piece" 1
 */
const path = require('path');

const COOKIE = process.env.CF_COOKIE || '';
const UA = process.env.CF_UA || '';
if (!COOKIE || !UA) {
  console.error('Set CF_COOKIE and CF_UA env vars first (see header).');
  process.exit(2);
}

const realFetch = global.fetch;
global.fetch = (url, opts = {}) => {
  const u = String(url);
  const headers = Object.assign({}, opts.headers || {});
  if (/animepahe\.pw|kwik\.|kwik\b/i.test(u)) {
    headers['Cookie'] = COOKIE;
    headers['User-Agent'] = UA;
  }
  return realFetch(u, Object.assign({}, opts, { headers }));
};

const query = process.argv[2] || 'One Piece';
const ep = parseInt(process.argv[3] || '1', 10);

(async () => {
  const mod = require(path.join(__dirname, 'providers', 'animepahe.js'));
  console.log(`Testing getStreams("${query}", "tv", 1, ${ep}) ...\n`);
  const streams = await mod.getStreams(query, 'tv', 1, ep);
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(streams, null, 2));
  console.log(`\n${Array.isArray(streams) ? streams.length : 0} stream(s).`);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
