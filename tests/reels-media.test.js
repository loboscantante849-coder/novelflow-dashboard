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

test('My Reels searches the signed-in user material list by normalized book name', () => {
  assert.match(source, /id="myReelsSearch"/);
  assert.match(source, /function normalizeReelSearchValue\(value\)/);
  assert.match(source, /function filterMyReelsAssets\(query\)/);
  assert.match(source, /_myReelsAssets\.filter\(item => normalizeReelSearchValue\(getReelBookName\(item\)\)\.includes\(normalized\)\)/);
  assert.match(source, /function clearMyReelsSearch\(\)/);
});

test('reel cards use owner-scoped stored book metadata as a display and search fallback', () => {
  assert.match(source, /function getReelLocalMeta\(item\)/);
  assert.match(source, /book_title: reelSelectedBook\?\.title \|\| currentRecommendBook\?\.title \|\| ''/);
  assert.match(source, /const displayBookName = getReelBookName\(item\) \|\| 'Untitled';/);
});
