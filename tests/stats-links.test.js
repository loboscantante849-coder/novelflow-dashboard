const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STATS_ENDPOINTS = [
  'api/my-stats.js',
  'api/per-link-stats.js',
];
const statsData = require('../api/_lib/stats-data');

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

test('stats endpoints include source-qualified invite codes', () => {
  for (const relativePath of STATS_ENDPOINTS) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(source, /promoterEntry\.invites|pEntry\.invites/);
    assert.match(source, /invite:/);
    assert.match(source, /channel === 'invite'|isInvite/);
  }
});

test('invite submissions resolve the source-qualified invite asset without double counting', () => {
  const lookup = {
    'invite:90031': {
      ad_id: '90031', channel: 'invite', pull_uv: 4, new_uv: 1, dn_income: 2.5,
      d14_income: 4.5, daily: { '2026-07-21': { pull_uv: 4, new_uv: 1, dn_income: 2.5, d14_income: 4.5 } },
    },
  };
  const result = statsData.aggregateSubmissionStats(
    { code: '90031', inviteCode: '90031' }, lookup,
  );
  assert.equal(result.matchedAssetCount, 1);
  assert.equal(result.channel, 'invite');
  assert.equal(result.pull_uv, 4);
  assert.equal(result.dn_income, 2.5);
  assert.equal(result.d14_income, 4.5);
});

test('stats data keeps bundled snapshots available as a last-known-good source', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('remote snapshot unavailable'); };
  try {
    const data = await statsData.getAdIdDetails([]);
    assert.ok(data && data.ad_ids && data.by_promoter);
  } finally {
    global.fetch = originalFetch;
  }
});

test('cover metadata failures do not block stats responses', async () => {
  const debug = [];
  const redis = {
    async hget() { throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value'); },
  };
  const covers = await statsData.loadCovers(redis, ['book-1'], debug);
  assert.deepEqual(covers, {});
  assert.match(debug[0], /covers unavailable; continuing without covers/);
});

test('D14 income is not silently replaced with DN income in endpoint source', () => {
  for (const relativePath of STATS_ENDPOINTS) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.doesNotMatch(source, /d14_income:\s*dn[,\n]/);
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
