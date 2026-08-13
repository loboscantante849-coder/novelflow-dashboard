const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aggregateSubmissionStats,
  buildAdIdLookup,
  buildLegacyAdIdLookup,
  markVerifiedAssets,
  loadSubmissions,
  loadCovers,
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

test('an authenticated submission can recover an unmapped pipeline asset', () => {
  const lookup = buildAdIdLookup({
    by_promoter: {},
    ad_ids: {
      'unmapped-link': {
        ad_id: 'unmapped-link', channel: 'link', username_canon: null,
        stats: { pull_uv: 9, dn_income: 1.5 }, daily: [],
      },
    },
  }, 'alice', false, [markVerifiedAssets({ linkId: 'unmapped-link' })]);

  assert.equal(lookup.byAdId['unmapped-link'].pull_uv, 9);
  assert.equal(lookup.byAdId['unmapped-link'].dn_income, 1.5);
});

test('client CloudSync asset ids cannot grant access to another promoter statistics', async () => {
  const redis = {
    async smembers() { return []; },
    async get(key) {
      if (key === 'nf_user_data:alice') {
        return JSON.stringify({ myBooks: [{ code: 'victim-code', title: 'Forged Book' }] });
      }
      return null;
    },
  };
  const submissions = await loadSubmissions(redis, 'alice', false, []);
  const lookup = buildAdIdLookup({
    by_promoter: {
      alice: { links: [], codes: [], invites: [] },
      victim: { links: [], codes: ['victim-code'], invites: [] },
    },
    ad_ids: {
      'victim-code': {
        ad_id: 'victim-code', channel: 'code', username_canon: 'victim',
        stats: { pull_uv: 123, dn_income: 45.67 }, daily: [],
      },
    },
  }, 'alice', false, submissions);

  assert.equal(lookup.byAdId['victim-code'], undefined);
  const result = aggregateSubmissionStats(submissions[0], lookup.byAdId);
  assert.equal(result.pull_uv, 0);
  assert.equal(result.dn_income, 0);
});

test('legacy fallback counts only server-verified submission identifiers', () => {
  const lookup = buildLegacyAdIdLookup({
    'owned-link': { visits: 7, dn_income: 1.25 },
    'victim-code': { visits: 123, dn_income: 45.67 },
  });
  const submission = markVerifiedAssets(
    { linkId: 'owned-link', code: 'victim-code' },
    ['owned-link'],
  );
  const result = aggregateSubmissionStats(submission, lookup, new Set(), { verifiedOnly: true });

  assert.deepEqual(result.assetIds, ['owned-link']);
  assert.equal(result.pull_uv, 7);
  assert.equal(result.dn_income, 1.25);
});

test('submission loading uses lowercase CloudSync keys and exact invite ownership', async () => {
  const reads = [];
  const redis = {
    async smembers(key) { reads.push(key); return []; },
    async get(key) {
      reads.push(key);
      if (key === 'nf_user_data:alice') return JSON.stringify({ myBooks: [{ code: '1001', bookId: 'book-1', title: 'Book One', cover: 'https://cdn.example/cloud.jpg' }] });
      if (key === 'nf_equity_code:alice') return JSON.stringify({ status: 'active', code: '90031', bookId: 'book-2', bookTitle: 'Invite Book' });
      return null;
    },
  };

  const submissions = await loadSubmissions(redis, 'Alice', false, []);
  assert.ok(reads.includes('nf_user_subs:alice'));
  assert.ok(reads.includes('nf_user_data:alice'));
  assert.ok(reads.includes('nf_equity_code:alice'));
  assert.equal(submissions.some(item => item.code === '1001' && item.bookId === 'book-1'), true);
  assert.equal(submissions.find(item => item.code === '1001').cover, 'https://cdn.example/cloud.jpg');
  assert.equal(submissions.some(item => item.inviteCode === '90031' && item.bookId === 'book-2'), true);
});

test('server submission cover wins while CloudSync fills a missing cover', () => {
  const merged = mergeSubmissionRecords([
    { code: '1001', bookId: 'book-1', cover: 'https://cdn.example/server.jpg' },
    { code: '1001', bookId: 'book-1', cover: 'https://cdn.example/cloud.jpg' },
    { code: '1002', bookId: 'book-2', cover: '' },
    { code: '1002', bookId: 'book-2', cover: 'https://cdn.example/cloud-2.jpg' },
  ]);

  assert.equal(merged.find(item => item.code === '1001').cover, 'https://cdn.example/server.jpg');
  assert.equal(merged.find(item => item.code === '1002').cover, 'https://cdn.example/cloud-2.jpg');
});

test('historical covers are fetched with a hard cap and cached without blocking failures', async () => {
  const hashes = new Map();
  const redis = {
    async hget(hash, field) { return hashes.get(hash)?.[field] || null; },
    async hset(hash, values) { hashes.set(hash, { ...(hashes.get(hash) || {}), ...values }); },
    async get() { return null; },
    async set() { return 'OK'; },
  };
  const fetched = [];
  const debug = [];
  const covers = await loadCovers(redis, ['one', 'two', 'three'], debug, {
    backfill: true,
    maxLookups: 2,
    concurrency: 1,
    fetchCover: async bookId => {
      fetched.push(bookId);
      if (bookId === 'two') throw new Error('temporary bookstore failure');
      return 'http://cdn.example/one.jpg';
    },
  });

  assert.deepEqual(fetched, ['one', 'two']);
  assert.equal(covers.one, 'https://cdn.example/one.jpg');
  assert.equal(covers.two, undefined);
  assert.equal(covers.three, undefined);
  assert.equal(hashes.get('nf_book_covers').one, 'https://cdn.example/one.jpg');
  assert.match(debug.join('\n'), /cover lookup failed for two/);
  assert.match(debug.join('\n'), /limited to 2\/3/);
});

test('submission loading fails visibly on Redis read errors', async () => {
  const redis = { async smembers() { throw new Error('temporary Redis failure'); } };
  await assert.rejects(
    loadSubmissions(redis, 'alice', false, []),
    error => error && error.code === 'USER_DATA_UNAVAILABLE',
  );
});

test('a stale user index cannot authorize a record owned by another account', async () => {
  const redis = {
    async smembers() { return ['victim-code']; },
    async hget() {
      return JSON.stringify({ code: 'victim-code', discordUsername: 'victim', bookId: 'victim-book' });
    },
    async get() { return null; },
  };
  const submissions = await loadSubmissions(redis, 'alice', false, []);
  assert.deepEqual(submissions, []);
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
