const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

test('completed reels resolve media URLs and show a first-frame video fallback', () => {
  assert.match(source, /function resolveReelMedia\(resultData\)/);
  assert.match(source, /video_url \|\| item\.videoUrl \|\| item\.file_url \|\| item\.url/);
  assert.match(source, /<video[^>]+preload="metadata"[^>]+class="reels-item-thumb"/);
  assert.match(source, /function downloadReelVideo\(videoUrl, title\)/);
});
