const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aggregateSubmissionStats,
  buildAdIdLookup,
  buildLegacyAdIdLookup,
  mergeSubmissionRecords,
} = require('../api/_lib/stats-data');

test('keeps an invite code separate from the same numeric promotion code', () => {
  const lookup = buildAdIdLookup({
    by_promoter: {
      alice: { links: [], codes: ['90031'], invites: ['90031'] },
    },
    ad_ids: {
      '90031': {
        ad_id: '90031', media_source: 'code', channel: 'code', username_canon: 'alice',
        book_name: 'Code Book', stats: { pull_uv: 1 }, daily: [],
      },
      'invite:90031': {
        ad_id: '90031', media_source: 'invite', channel: 'invite', username_canon: 'alice',
        book_name: 'Invite Book', book_id: '64b8c91e0123456789abcdef',
        stats: { pull_uv: 3 }, daily: [],
      },
    },
  }, 'alice', false);

  assert.equal(lookup.byAdId['90031'].pull_uv, 1);
  assert.equal(lookup.byAdId['invite:90031'].pull_uv, 3);
  assert.equal(lookup.byAdId['invite:90031'].ad_id, '90031');
  assert.equal(lookup.byAdId['invite:90031'].channel, 'invite');
  assert.equal(lookup.byAdId['invite:90031'].book_id, '64b8c91e0123456789abcdef');
});

const byAdId = {
  'link-10': {
    channel: 'link',
    book_name: 'Combined Book',
    pull_uv: 12,
    new_uv: 3,
    dn_income: 1.25,
    d14_income: 1.25,
    daily: {
      '2026-07-16': { pull_uv: 7, new_uv: 2, dn_income: 0.75, d14_income: 0.75 },
    },
  },
  'code-20': {
    channel: 'code',
    book_name: 'Combined Book',
    pull_uv: 8,
    new_uv: 4,
    dn_income: 2.5,
    d14_income: 2.5,
    daily: {
      '2026-07-16': { pull_uv: 5, new_uv: 3, dn_income: 1.5, d14_income: 1.5 },
    },
  },
};

test('combines link and code attribution for one book submission', () => {
  const stats = aggregateSubmissionStats({ linkId: 'link-10', code: 'code-20' }, byAdId);

  assert.equal(stats.pull_uv, 20);
  assert.equal(stats.new_uv, 7);
  assert.equal(stats.dn_income, 3.75);
  assert.equal(stats.channel, 'link+code');
  assert.deepEqual(stats.assetIds, ['link-10', 'code-20']);
  assert.equal(stats.assetCount, 2);
  assert.deepEqual(stats.daily['2026-07-16'], {
    pull_uv: 12,
    new_uv: 5,
    dn_income: 2.25,
    d14_income: 2.25,
  });
});

test('counts an identical ad id only once across duplicate submissions', () => {
  const seen = new Set();
  const first = aggregateSubmissionStats({ linkId: 'link-10', code: 'code-20' }, byAdId, seen);
  const duplicate = aggregateSubmissionStats({ linkId: 'link-10', code: 'code-20' }, byAdId, seen);

  assert.equal(first.pull_uv, 20);
  assert.equal(duplicate.pull_uv, 0);
  assert.equal(duplicate.assetCount, 0);
  assert.deepEqual(Array.from(seen).sort(), ['code-20', 'link-10']);
});

test('does not double count when linkId and code are the same identifier', () => {
  const stats = aggregateSubmissionStats({ linkId: 'link-10', code: 'link-10' }, byAdId);

  assert.equal(stats.pull_uv, 12);
  assert.equal(stats.assetCount, 1);
  assert.deepEqual(stats.assetIds, ['link-10']);
});

test('merges partial Redis and CloudSync records without losing code or linkId', () => {
  const merged = mergeSubmissionRecords([
    { linkId: 'link-10', bookId: 'book-1', matchedBookName: 'Combined Book' },
    { code: 'code-20', linkId: 'link-10', link: 'https://example.test/read' },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].linkId, 'link-10');
  assert.equal(merged[0].code, 'code-20');
  assert.equal(merged[0].bookId, 'book-1');
  assert.equal(merged[0].link, 'https://example.test/read');
});

test('legacy lookup combines code and link instead of choosing one', () => {
  const legacy = buildLegacyAdIdLookup({
    'link-10': { channel: 'link', visits: 3, new_users: 1, dn_income: 0.5, daily: { '2026-07-16': { uv: 2, new: 1, dn: 0.25 } } },
    'code-20': { channel: 'code', visits: 4, new_users: 2, dn_income: 1.5, daily: { '2026-07-16': { uv: 3, new: 2, dn: 1 } } },
  });
  const stats = aggregateSubmissionStats({ linkId: 'link-10', code: 'code-20' }, legacy);

  assert.equal(stats.pull_uv, 7);
  assert.equal(stats.new_uv, 3);
  assert.equal(stats.dn_income, 2);
  assert.equal(stats.daily['2026-07-16'].pull_uv, 5);
});
