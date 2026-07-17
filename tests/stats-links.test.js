const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STATS_ENDPOINTS = [
  'api/my-stats.js',
  'api/per-link-stats.js',
];

test('stats endpoints never fabricate a promotion URL from linkId', () => {
  for (const relativePath of STATS_ENDPOINTS) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.equal(
      source.includes('s.novelflow.top'),
      false,
      `${relativePath} must return null when the real promotion link is missing`,
    );
  }
});

test('user stats combine code and link attribution instead of choosing one', () => {
  for (const relativePath of STATS_ENDPOINTS) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.equal(source.includes('aggregateSubmissionStats(sub, byAdId, seenAdIds)'), true);
    assert.equal(source.includes('else if (code && byAdId[code])'), false);
  }
});
