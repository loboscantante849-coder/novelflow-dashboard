const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} should be present`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

test('completed reels resolve media URLs and show a first-frame video fallback', () => {
  assert.match(source, /function resolveReelMedia\(resultData\)/);
  assert.match(source, /final_video_url/);
  assert.match(source, /processed_video_url/);
  assert.match(source, /video_result/);
  assert.match(source, /<video[^>]+preload="metadata"[^>]+class="reels-item-thumb"/);
  assert.match(source, /function downloadReelVideo\(videoUrl, title\)/);
});

test('reel status matching accepts Tianji numeric and string states', () => {
  assert.match(source, /function isReelCompletedStatus\(value\)/);
  assert.match(source, /function isReelFailedStatus\(value\)/);
  assert.match(source, /status === 'completed' \|\| status === 'done' \|\| status === '2'/);
});

test('reels normalize Tianji nested result media URLs', () => {
  const resolveReelMedia = new Function('safeClientUrl', `return (${extractFunction('resolveReelMedia')});`)(
    (value) => String(value || ''),
  );
  assert.deepEqual(
    resolveReelMedia({
      final_video_result: { video_url: 'https://cdn.example/final.mp4', cover_image_url: 'https://cdn.example/cover.jpg' },
    }),
    { videoUrl: 'https://cdn.example/final.mp4', coverUrl: 'https://cdn.example/cover.jpg', creativeText: '' },
  );
  assert.equal(
    resolveReelMedia({ video_result: { videos: [{ video_url: 'https://cdn.example/nested.mp4' }] } }).videoUrl,
    'https://cdn.example/nested.mp4',
  );
  assert.equal(
    resolveReelMedia({ processed_video_url: 'https://cdn.example/processed.mp4' }).videoUrl,
    'https://cdn.example/processed.mp4',
  );
  assert.equal(
    resolveReelMedia({ final_video_result: 'https://cdn.example/string-result.mp4' }).videoUrl,
    'https://cdn.example/string-result.mp4',
  );
  assert.equal(
    resolveReelMedia({ result_json: { video_result: { videos: [{ video_url: 'https://cdn.example/result-json.mp4' }] } } }).videoUrl,
    'https://cdn.example/result-json.mp4',
  );
  assert.equal(
    resolveReelMedia({ resultJson: JSON.stringify({ video_result: { videos: [{ video_url: 'https://cdn.example/result-json-string.mp4' }] } }) }).videoUrl,
    'https://cdn.example/result-json-string.mp4',
  );
});

test('reel task identifiers normalize all observed Tianji names and wrappers', () => {
  const getReelTaskId = new Function(`return (${extractFunction('getReelTaskId')});`)();
  assert.equal(getReelTaskId({ thread_id: 'thread-a' }), 'thread-a');
  assert.equal(getReelTaskId({ taskId: 'task-b' }), 'task-b');
  assert.equal(getReelTaskId({ data: { creative: { threadId: 'thread-c' } } }), 'thread-c');
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
