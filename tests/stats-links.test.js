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

test('stats endpoints fail visibly and production responses omit debug details', () => {
  const perLink = fs.readFileSync(path.join(ROOT, 'api/per-link-stats.js'), 'utf8');
  const myStats = fs.readFileSync(path.join(ROOT, 'api/my-stats.js'), 'utf8');

  assert.match(perLink, /res\.status\(503\)/);
  assert.match(myStats, /res\.status\(503\)/);
  assert.match(perLink, /const \{ debug, \.\.\.publicBody \} = body/);
  assert.match(perLink, /buildLegacyAdIdLookup/);
  assert.match(perLink, /if \(!linkStats\) throw new Error/);
  assert.match(myStats, /if \(!dataJson\) throw new Error/);
});

test('dashboard labels daily revenue as attributed income and counts assets', () => {
  const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  assert.match(source, /daily_books_income: 'Attributed income'/);
  assert.match(source, /Business date \(UTC\+8\).*Cumulative attributed income/);
  assert.match(source, /dailyBookHelper\.countAssets\(perfLinks\)/);
  assert.match(source, /STATS_UNAVAILABLE/);
  assert.match(source, /_lastPerfUsername !== currentPerfUsername/);
});
