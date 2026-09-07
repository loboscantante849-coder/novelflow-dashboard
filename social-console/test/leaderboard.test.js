const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { createSession } = require('../api/_lib/auth');

process.env.SOCIAL_CONSOLE_SESSION_SECRET = process.env.SOCIAL_CONSOLE_SESSION_SECRET || 'leaderboard-test-session-secret-with-32-characters';

const leaderboardPath = require.resolve('../api/leaderboard');
const storePath = require.resolve('../api/_lib/store');

class MemoryRedis {
  constructor(firstValue = null) {
    this.firstValue = firstValue;
    this.getCalls = 0;
    this.deleted = [];
    this.writes = [];
  }

  async get() {
    this.getCalls += 1;
    return this.getCalls === 1 ? this.firstValue : null;
  }

  async set(key, value) {
    this.writes.push({ key, value });
    return 'OK';
  }

  async del(key) {
    this.deleted.push(key);
    return 1;
  }
}

function responseCollector() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invokeLeaderboard(redis, query = {}) {
  const store = require(storePath);
  const originalGetRedis = store.getRedis;
  store.getRedis = () => redis;
  delete require.cache[leaderboardPath];
  try {
    const handler = require(leaderboardPath);
    const res = responseCollector();
    const token = createSession();
    await handler({ method: 'GET', headers: { cookie: `nf_social_session=${encodeURIComponent(token)}`, host: 'social.test' }, query: { source: 'catalog', ...query } }, res);
    return res;
  } finally {
    store.getRedis = originalGetRedis;
    delete require.cache[leaderboardPath];
  }
}

function bookstoreFallbackPayload() {
  return JSON.stringify({
    source: 'bookstore_uv_fallback',
    selectionMode: 'catalog',
    books: [{ bookSkuId: 'fallback-1', title: 'Bookstore Fallback', baseReadUnt: 1000, fallbackMetric: 'bookstore_uv' }]
  });
}

function verifiedCatalogPayload() {
  return JSON.stringify({
    source: 'content_dashboard_performance',
    selectionMode: 'catalog',
    p0Receipt: 'top-level-old-receipt',
    metrics: { audit: { p0Receipt: 'nested-old-receipt' } },
    books: [{ bookSkuId: 'verified-1', title: 'Verified Catalog Book', source: 'content_dashboard', ownershipVerified: true, baseReadUnt: 800, firstReadUntRate: 0.42, p0Receipt: 'must-not-survive-stale-response' }]
  });
}

function historicalRankingPayload() {
  return JSON.stringify({
    source: 'unified_funnel_performance',
    selectionMode: 'history',
    books: [{ bookSkuId: 'history-1', title: 'Promoted Book', pullUv: 320, activeRate: 0.31 }]
  });
}

test('catalog endpoint rejects a cached bookstore fallback instead of presenting it as verified ranking', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  t.mock.method(console, 'error', () => {});
  let bookstoreCalls = 0;
  providers.contentDashboardBooks = async () => { throw new providers.ProviderError('OIDC authentication failed with HTTP 400: invalid_grant', { status: 400 }); };
  providers.topBooks = async () => { bookstoreCalls += 1; return []; };
  const redis = new MemoryRedis(bookstoreFallbackPayload());

  const res = await invokeLeaderboard(redis);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.dataQuality, 'unavailable');
  assert.equal(res.body.credentialStatus, 'expired_or_invalid');
  assert.equal(res.body.sourceHealth.reason, 'authentication_required');
  assert.equal(res.body.books, undefined);
  assert.equal(redis.deleted.length, 1);
  assert.equal(redis.writes.length, 1);
  assert.equal(bookstoreCalls, 0);
});

test('catalog endpoint serves only a stale verified cache when the current source fails', async (t) => {
  const original = providers.contentDashboardBooks;
  t.after(() => { providers.contentDashboardBooks = original; });
  t.mock.method(console, 'error', () => {});
  providers.contentDashboardBooks = async () => { throw new providers.ProviderError('OIDC authentication failed with HTTP 400: invalid_grant', { status: 400 }); };
  const redis = new MemoryRedis(verifiedCatalogPayload());

  const res = await invokeLeaderboard(redis, { refresh: '1' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dataQuality, 'stale_verified_metrics');
  assert.equal(res.body.sourceHealth.status, 'stale');
  assert.equal(res.body.credentialStatus, 'expired_or_invalid');
  assert.equal(res.body.books[0].title, 'Verified Catalog Book');
  assert.equal(res.body.books[0].p0Receipt, undefined);
  assert.equal(res.body.p0Receipt, undefined);
  assert.equal(res.body.metrics.audit.p0Receipt, undefined);
  assert.equal(redis.deleted.length, 0);
  assert.equal(redis.writes.length, 0);
});

test('historical promotion ranking remains independent from catalog provenance checks', async () => {
  const redis = new MemoryRedis(historicalRankingPayload());

  const res = await invokeLeaderboard(redis, { source: 'history', days: '7' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'unified_funnel_performance');
  assert.equal(res.body.selectionMode, 'history');
  assert.equal(res.body.books[0].pullUv, 320);
  assert.equal(redis.deleted.length, 0);
  assert.equal(redis.writes.length, 0);
});

test('catalog retries the previous complete day when yesterday is not published yet', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  t.mock.method(console, 'error', () => {});
  const windows = [];
  providers.contentDashboardBooks = async (input) => {
    windows.push({ startDate: input.startDate, endDate: input.endDate });
    if (windows.length === 1) throw new providers.ProviderError('Content dashboard ranking page 1 failed with HTTP 500', { status: 500 });
    return {
      books: [{ bookSkuId: 'verified-lag-1', title: 'Published Two Days Ago', source: 'content_dashboard', productLineVerified: true, baseReadUnt: 900, firstReadUntRate: 31 }],
      total: 1,
      minReadUnt: 0
    };
  };
  providers.topBooks = async () => [];
  const redis = new MemoryRedis();

  const res = await invokeLeaderboard(redis, { days: '7', refresh: '1' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dataQuality, 'verified_metrics');
  assert.equal(res.body.window.dataLagDays, 2);
  assert.equal(windows.length, 6);
  const firstEnd = new Date(`${windows[0].endDate}T00:00:00Z`);
  const secondEnd = new Date(`${windows[3].endDate}T00:00:00Z`);
  assert.equal(firstEnd.getTime() - secondEnd.getTime(), 86400000);
});

test('catalog supports the latest complete one-day ranking for daily selection', async (t) => {
  const redis = new MemoryRedis();
  let requestedWindow = null;
  t.mock.method(providers, 'contentDashboardBooks', async (input) => {
    requestedWindow = { startDate: input.startDate, endDate: input.endDate };
    return {
      books: [{ bookSkuId: 'daily-1', title: 'Daily Winner', productLine: 'novelflow', productLineVerified: true, source: 'content_dashboard', baseReadUnt: 120, firstReadUntRate: 40, read20wRate: 18 }],
      total: 1,
      fetched: 1
    };
  });
  t.mock.method(providers, 'topBooks', async () => [{ bookSkuId: 'daily-1', title: 'Daily Winner', chapterCount: 20, words: 50000 }]);

  const res = await invokeLeaderboard(redis, { days: '1', refresh: '1' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.window.days, 1);
  assert.equal(requestedWindow.startDate, requestedWindow.endDate);
  assert.ok(res.body.books[0].p0Receipt);
  assert.equal(JSON.parse(redis.writes[0].value).books[0].p0Receipt, undefined);
});

test('catalog recalls and audits the three-axis Top union', async (t) => {
  const redis = new MemoryRedis();
  const calls = [];
  t.mock.method(providers, 'contentDashboardBooks', async (input) => {
    calls.push(input.sortField);
    const books = {
      baseReadUnt: { bookSkuId: 'scale-1', title: 'Scale Winner', baseReadUnt: 5000, firstReadUntRate: 20, read20wRate: 8 },
      firstReadUntRate: { bookSkuId: 'first-1', title: 'First Read Winner', baseReadUnt: 900, firstReadUntRate: 68, read20wRate: 14 },
      read20wRate: { bookSkuId: 'long-1', title: 'Long Read Winner', baseReadUnt: 700, firstReadUntRate: 45, read20wRate: 39 }
    };
    return { books: [{ ...books[input.sortField], productLine: 'novelflow', productLineVerified: true, source: 'content_dashboard', rank: 1 }], total: 200, candidateTotal: 200, fetched: 200 };
  });
  t.mock.method(providers, 'topBooks', async () => [
    { bookSkuId: 'scale-1', title: 'Scale Winner' },
    { bookSkuId: 'first-1', title: 'First Read Winner' },
    { bookSkuId: 'long-1', title: 'Long Read Winner' }
  ]);

  const res = await invokeLeaderboard(redis, { days: '1', refresh: '1' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.sort(), ['baseReadUnt', 'firstReadUntRate', 'read20wRate'].sort());
  assert.deepEqual(new Set(res.body.books.map((book) => book.bookSkuId)), new Set(['scale-1', 'first-1', 'long-1']));
  assert.deepEqual(res.body.metrics.candidateAxes, ['baseReadUnt', 'firstReadUntRate', 'read20wRate']);
  assert.equal(res.body.snapshotVersion, 'p0_multi_axis_v1');
  assert.ok(res.body.books.every((book) => Number.isFinite(book.selectionScore) && book.selectionRank > 0 && book.p0Receipt));
});

test('three-axis merge preserves non-zero metrics when an axis omits them as zero', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  const rows = {
    baseReadUnt: { bookSkuId: 'axis-merge-1', title: 'Axis Merge Book', baseReadUnt: 5000, firstReadUntRate: 0, read20wRate: 0 },
    firstReadUntRate: { bookSkuId: 'axis-merge-1', title: 'Axis Merge Book', baseReadUnt: 0, firstReadUntRate: 42, read20wRate: 0 },
    read20wRate: { bookSkuId: 'axis-merge-1', title: 'Axis Merge Book', baseReadUnt: 0, firstReadUntRate: 0, read20wRate: 18 }
  };
  providers.contentDashboardBooks = async (input) => ({ books: [{ ...rows[input.sortField], source: 'content_dashboard', productLine: 'novelflow', productLineVerified: true, rank: 1 }], total: 1, fetched: 1 });
  providers.topBooks = async () => [];
  const res = await invokeLeaderboard(new MemoryRedis(), { days: '1', refresh: '1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.books[0].baseReadUnt, 5000);
  assert.equal(res.body.books[0].firstReadUntRate, 42);
  assert.equal(res.body.books[0].read20wRate, 18);
});

test('fresh-but-expired cached snapshots cannot be re-signed and old receipts are stripped', async () => {
  const payload = {
    source: 'content_dashboard_performance', selectionMode: 'catalog', snapshotVersion: 'p0_multi_axis_v1',
    generatedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString(), window: { days: 30 }, metrics: { filters: {} },
    books: [{ bookSkuId: 'expired-snapshot-1', title: 'Expired Snapshot', source: 'content_dashboard', ownershipVerified: true, automationReady: true, baseReadUnt: 900, firstReadUntRate: 30, p0Receipt: 'expired-old-receipt' }]
  };
  const res = await invokeLeaderboard(new MemoryRedis(JSON.stringify(payload)));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sourceHealth.status, 'cached');
  assert.equal(res.body.books[0].p0Receipt, undefined);
});

test('MaxNovel uses the verified target-app SKU universe without sending productLine', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  t.mock.method(console, 'error', () => {});
  const calls = [];
  providers.contentDashboardBooks = async (input) => {
    calls.push(input.filters);
    if (!input.filters.omitServerProductLine) throw new providers.ProviderError('Content dashboard generic 500', { status: 500 });
    return {
      books: [{ bookSkuId: 'max-relaxed-1', title: 'Max Relaxed Romance', productLine: 'Max-Novel', productLineVerified: true, source: 'content_dashboard', baseReadUnt: 1200, firstReadUntRate: 36, read20wRate: 18 }],
      total: 1, fetched: 1
    };
  };
  providers.topBooks = async () => [{ bookSkuId: 'max-relaxed-1', title: 'Max Relaxed Romance' }];
  const res = await invokeLeaderboard(new MemoryRedis(), { line: 'maxnovel', platform: 'facebook', accountId: '13943482', refresh: '1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dataQuality, 'verified_metrics');
  assert.equal(res.body.books[0].title, 'Max Relaxed Romance');
  assert.equal(calls.length, 3);
  assert.ok(calls.some((filters) => filters.omitServerProductLine === true && filters.requireProductLineEcho === true));
  assert.deepEqual(calls[0].skuIds, ['max-relaxed-1']);
  assert.equal(res.body.books[0].selectionTarget.applicationId, '69a172040a2d5813dec3bff7');
});

test('MaxNovel SKU scoping bypasses an invalid storefront productLine request', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  t.mock.method(console, 'error', () => {});
  const calls = [];
  providers.contentDashboardBooks = async (input) => {
    calls.push(input.filters);
    if (!input.filters.omitServerProductLine) return { books: [], total: 0, fetched: 0 };
    return {
      books: [{ bookSkuId: 'max-empty-recovered-1', title: 'Max Empty Response Recovery', productLine: '', productLineVerified: false, source: 'content_dashboard', baseReadUnt: 1400, firstReadUntRate: 38, read20wRate: 20 }],
      total: 1, fetched: 1
    };
  };
  providers.topBooks = async () => [{ bookSkuId: 'max-empty-recovered-1', title: 'Max Empty Response Recovery' }];

  const res = await invokeLeaderboard(new MemoryRedis(), { line: 'maxnovel', platform: 'facebook', accountId: '13943482', refresh: '1' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dataQuality, 'verified_metrics');
  assert.equal(res.body.books[0].title, 'Max Empty Response Recovery');
  assert.equal(calls.length, 3);
  assert.ok(calls[0].omitServerProductLine);
  assert.ok(calls[0].requireProductLineEcho);
  assert.ok(calls[0].allowMissingProductLineEcho);
  assert.ok(calls[0].allowUnmatchedProductLine);
  assert.deepEqual(calls[0].skuIds, ['max-empty-recovered-1']);
});

test('Novelvio starts with the global live report and never sends a fake storefront product line', async (t) => {
  const calls = [];
  t.mock.method(providers, 'contentDashboardBooks', async (input) => {
    calls.push(input.filters);
    return {
      books: [{ bookSkuId: 'novelvio-live-1', title: 'Novelvio Live', productLine: 'anystories', productLineVerified: false, source: 'content_dashboard', baseReadUnt: 88, firstReadUntRate: 30, read20wRate: 12 }],
      total: 1, fetched: 1
    };
  });
  t.mock.method(providers, 'topBooks', async () => [{ bookSkuId: 'novelvio-live-1', title: 'Novelvio Live' }]);
  const res = await invokeLeaderboard(new MemoryRedis(), { app: 'novelvio', accountId: '13943485', refresh: '1' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].omitServerProductLine, true);
  assert.equal(calls[0].minimalContract, true);
  assert.deepEqual(calls[0].productLine, ['novelvio']);
});

test('app-level catalog cache is shared across platform accounts', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  let providerCalls = 0;
  providers.contentDashboardBooks = async () => {
    providerCalls += 1;
    return { books: [{ bookSkuId: 'shared-catalog-1', title: 'Shared Verified Book', productLine: 'maxnovel', productLineVerified: true, source: 'content_dashboard', baseReadUnt: 1200, firstReadUntRate: 36, read20wRate: 18 }], total: 1, fetched: 1 };
  };
  providers.topBooks = async () => [{ bookSkuId: 'shared-catalog-1', title: 'Shared Verified Book' }];
  class MapRedis {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.get(key) || null; }
    async set(key, value) { this.values.set(key, value); return 'OK'; }
    async del(key) { this.values.delete(key); return 1; }
  }
  const redis = new MapRedis();
  const first = await invokeLeaderboard(redis, { line: 'maxnovel', platform: 'facebook', accountId: '13943482', refresh: '1' });
  const second = await invokeLeaderboard(redis, { line: 'maxnovel', platform: 'instagram', accountId: '15590770' });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(providerCalls, 3);
  assert.equal(first.body.books[0].selectionTarget.accountId, 13943482);
  assert.equal(second.body.books[0].selectionTarget.accountId, 15590770);
});

test('an explicit Top 200 refresh receives the long server budget', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  let deadlineMs = 0;
  providers.contentDashboardBooks = async (input) => {
    deadlineMs = input.deadlineMs;
    return {
      books: [{ bookSkuId: 'long-refresh-1', title: 'Long Window Ranking', source: 'content_dashboard', productLineVerified: true, baseReadUnt: 42, firstReadUntRate: 25 }],
      total: 1,
      minReadUnt: 0
    };
  };
  providers.topBooks = async () => [{ bookSkuId: 'storyca-fast-1', title: 'Storyca Verified Book' }];
  const res = await invokeLeaderboard(new MemoryRedis(), { days: '90', refresh: '1' });

  assert.equal(res.statusCode, 200);
  assert.ok(deadlineMs >= 60000);
});

test('catalog comparison aligns 7/30/90 reader bases and normalizes them per day', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  const requestedDays = [];
  providers.contentDashboardBooks = async (input) => {
    const days = Math.round((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86400000) + 1;
    requestedDays.push(days);
    return { books: [{ bookSkuId: 'trend-sku', title: 'Trend Book', source: 'content_dashboard', productLineVerified: true, baseReadUnt: days * 100, firstReadUntRate: 30, read10wRate: 20 }], total: 1, fetched: 1 };
  };
  providers.topBooks = async () => [];

  const res = await invokeLeaderboard(new MemoryRedis(), { days: '30', compare: '1', refresh: '1' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(requestedDays.sort((a, b) => a - b), [7, 7, 7, 30, 30, 30, 90, 90, 90]);
  assert.equal(res.body.books[0].readerBase7d, 700);
  assert.equal(res.body.books[0].readerDaily90d, 100);
  assert.equal(res.body.books[0].trend7v30, 0);
  assert.equal(res.body.books[0].comparisonQuality, 'complete');
});

test('Storyca interactive ranking returns its verified primary window without timing out on comparisons', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  const requestedDays = [];
  providers.contentDashboardBooks = async (input) => {
    const days = Math.round((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86400000) + 1;
    requestedDays.push(days);
    return { books: [{ bookSkuId: 'storyca-fast-1', title: 'Storyca Verified Book', productLine: 'Storyca', productLineVerified: true, source: 'content_dashboard', baseReadUnt: 120, firstReadUntRate: 30, read10wRate: 15 }], total: 1, fetched: 1 };
  };
  providers.topBooks = async () => [{ bookSkuId: 'storyca-fast-1', title: 'Storyca Verified Book' }];

  const res = await invokeLeaderboard(new MemoryRedis(), { line: 'storyca', platform: 'facebook', accountId: '13943484', days: '7', compare: '1', refresh: '1' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(requestedDays, [7, 7, 7]);
  assert.equal(res.body.books[0].comparisonQuality, 'partial');
  assert.equal(res.body.metrics.comparisonWindows.deferred, true);
});

test('catalog enforces a promotion-scale UV threshold for every time window', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  const requests = [];
  providers.topBooks = async () => [];
  providers.contentDashboardBooks = async (input) => {
    requests.push(input);
    return {
      books: [{ bookSkuId: `qualified-${input.minReadUnt}`, title: 'Qualified Book', source: 'content_dashboard', productLineVerified: true, baseReadUnt: Math.max(1, input.minReadUnt), firstReadUntRate: 35, read10wRate: 20 }],
      total: 1, candidateTotal: 200, qualifiedTotal: 1, observedTopUv: input.minReadUnt, fetched: 200
    };
  };
  const seven = await invokeLeaderboard(new MemoryRedis(), { days: '7', refresh: '1' });
  const thirty = await invokeLeaderboard(new MemoryRedis(), { days: '30', refresh: '1' });
  const ninety = await invokeLeaderboard(new MemoryRedis(), { days: '90', refresh: '1' });
  assert.deepEqual(requests.map((request) => request.minReadUnt), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(seven.body.metrics.promotionMinUv, 0);
  assert.equal(thirty.body.metrics.promotionMinUv, 0);
  assert.equal(ninety.body.metrics.promotionMinUv, 0);
});

test('catalog failure cooldown avoids repeating a known unavailable source', async (t) => {
  const original = providers.contentDashboardBooks;
  t.after(() => { providers.contentDashboardBooks = original; });
  t.mock.method(console, 'error', () => {});
  let providerCalls = 0;
  providers.contentDashboardBooks = async () => { providerCalls += 1; throw new providers.ProviderError('Content dashboard ranking page 1 failed with HTTP 503', { status: 503 }); };
  const failure = JSON.stringify({ httpStatus: 502, reason: 'upstream_unavailable', errorKind: 'upstream_5xx', credentialStatus: 'not_checked', warning: 'cooldown', retryAfter: new Date(Date.now() + 60000).toISOString() });
  const redis = {
    getCalls: 0,
    async get() { this.getCalls += 1; return this.getCalls === 1 ? null : failure; },
    async set() { throw new Error('should not write during cooldown'); },
    async del() { return 1; }
  };

  const res = await invokeLeaderboard(redis);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.sourceHealth.errorKind, 'upstream_5xx');
  assert.equal(res.body.refreshWarning, 'cooldown');
  assert.equal(providerCalls, 0);
});

test('catalog reports invalid upstream response shape without accepting books', async (t) => {
  const original = providers.contentDashboardBooks;
  t.after(() => { providers.contentDashboardBooks = original; });
  t.mock.method(console, 'error', () => {});
  providers.contentDashboardBooks = async () => { throw new providers.ProviderError('Content dashboard ranking page 1 returned an invalid response shape'); };
  const redis = new MemoryRedis();

  const res = await invokeLeaderboard(redis);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.sourceHealth.errorKind, 'invalid_shape');
  assert.equal(res.body.books, undefined);
});

test('ranking target rejects an account that belongs to another application', () => {
  const { rankingTarget } = require('../api/leaderboard');
  assert.throws(() => rankingTarget({ line: 'maxnovel', platform: 'facebook', accountId: '13751295' }), /does not belong to the selected application/);
  assert.throws(() => rankingTarget({ line: 'maxnovel', platform: 'instagram', accountId: '13943482' }), /does not belong to the selected platform/);
});

test('MaxNovel ranking is application-SKU first and carries the exact account route', async (t) => {
  const originals = { contentDashboardBooks: providers.contentDashboardBooks, topBooks: providers.topBooks };
  t.after(() => Object.assign(providers, originals));
  let requestedFilters;
  providers.contentDashboardBooks = async (input) => {
    requestedFilters = input.filters;
    return {
      books: [{ bookSkuId: 'max-verified-1', title: 'Max Verified Romance', productLine: 'maxnovel', productLineVerified: true, source: 'content_dashboard', baseReadUnt: 4800, firstReadUntRate: 0.36, read20wRate: 0.14 }],
      total: 1, fetched: 1
    };
  };
  providers.topBooks = async () => [{ bookSkuId: 'max-verified-1', title: 'Max Verified Romance' }];

  const res = await invokeLeaderboard(new MemoryRedis(), { line: 'maxnovel', platform: 'facebook', accountId: '13943482', refresh: '1' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(requestedFilters.productLine, ['maxnovel']);
  assert.equal(requestedFilters.applicationId, '69a172040a2d5813dec3bff7');
  assert.deepEqual(requestedFilters.skuIds, ['max-verified-1']);
  assert.equal(requestedFilters.omitServerProductLine, true);
  assert.equal(res.body.target.appKey, 'maxnovel');
  assert.equal(res.body.target.accountId, 13943482);
  assert.equal(res.body.books[0].selectionTarget.accountId, 13943482);
  assert.equal(res.body.books[0].selectionTarget.applicationId, '69a172040a2d5813dec3bff7');
});

test('metric thresholds normalize decimal and percent-style rates', () => {
  const { applyMetricFilters } = require('../api/leaderboard');
  const books = [
    { title: 'Decimal', baseReadUnt: 1000, firstReadUntRate: 0.3, read20wRate: 0.1 },
    { title: 'Percent', baseReadUnt: 1000, firstReadUntRate: 30, read20wRate: 10 },
    { title: 'Below', baseReadUnt: 999, firstReadUntRate: 29, read20wRate: 9 }
  ];
  assert.deepEqual(applyMetricFilters(books, { readBaseMin: 1000, firstReadMin: 0.3, longReadMin: 0.1 }).map((book) => book.title), ['Decimal', 'Percent']);
});

test('catalog metric filters reject zero-reader rows even when the operator threshold is zero', () => {
  const { applyMetricFilters } = require('../api/leaderboard');
  const books = [
    { title: 'Zero readers', baseReadUnt: 0, firstReadUntRate: 100, read20wRate: 100 },
    { title: 'One reader', baseReadUnt: 1, firstReadUntRate: 0, read20wRate: 0 }
  ];
  assert.deepEqual(applyMetricFilters(books, { readBaseMin: 0, firstReadMin: 0, longReadMin: 0 }).map((book) => book.title), ['One reader']);
});

test('catalog long-read filter treats an explicit read20w zero as zero', () => {
  const { applyMetricFilters } = require('../api/leaderboard');
  const books = [
    { title: 'Explicit zero', baseReadUnt: 1000, firstReadUntRate: 30, read10wRate: 20, read20wRate: 0 },
    { title: 'Missing 20w', baseReadUnt: 1000, firstReadUntRate: 30, read10wRate: 20 }
  ];
  assert.deepEqual(applyMetricFilters(books, { readBaseMin: 0, firstReadMin: 0, longReadMin: 0.1 }).map((book) => book.title), ['Missing 20w']);
});

test('catalog ownership never upgrades a same-title record with a different target-application SKU', async (t) => {
  const original = providers.topBooks;
  t.after(() => { providers.topBooks = original; });
  providers.topBooks = async () => [{
    bookSkuId: 'catalog-sku', title: 'The Same Title', cover: 'https://cover.example/test.jpg', category: 'Romance', tags: ['werewolf']
  }];
  const { enrichBooks } = require('../api/leaderboard');
  const [unverified] = await enrichBooks([{
    bookSkuId: 'dashboard-sku', title: 'The Same Title', source: 'content_dashboard', productLineVerified: false
  }], true, { productLine: ['maxnovel'] });
  assert.equal(unverified.bookSkuId, 'dashboard-sku');
  assert.equal(unverified.ownershipVerified, false);
  assert.equal(unverified.automationReady, false);

  const [echoVerified] = await enrichBooks([{
    bookSkuId: 'dashboard-sku', title: 'The Same Title', source: 'content_dashboard', productLineVerified: true
  }], true, { productLine: ['maxnovel'] });
  assert.equal(echoVerified.bookSkuId, 'dashboard-sku');
  assert.equal(echoVerified.ownershipVerified, true);
});

test('relaxed ownership scans beyond the first 24 global rows with an exact target-app SKU lookup', async (t) => {
  const originals = { topBooks: providers.topBooks, findExactBookBySku: providers.findExactBookBySku };
  t.after(() => Object.assign(providers, originals));
  providers.topBooks = async () => [];
  const checked = [];
  providers.findExactBookBySku = async (sku) => {
    checked.push(sku);
    if (sku !== 'global-31') throw new providers.ProviderError('not in target app', { status: 404 });
    return { bookSkuId: sku, title: 'Novelvio Live Winner', cityBookId: 'city-31', chapterCount: 60, words: 90000 };
  };
  const { enrichBooks } = require('../api/leaderboard');
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    bookSkuId: `global-${index + 1}`,
    title: `Global ${index + 1}`,
    source: 'content_dashboard',
    productLineVerified: false,
    baseReadUnt: 1000 - index
  }));
  const enriched = await enrichBooks(candidates, true, { productLine: ['novelvio'], requireProductLineEcho: true });
  const winner = enriched.find((book) => book.bookSkuId === 'global-31');
  assert.equal(winner.ownershipVerified, true);
  assert.equal(winner.automationReady, true);
  assert.equal(winner.title, 'Novelvio Live Winner');
  assert.ok(checked.includes('global-31'));
  assert.ok(checked.length > 24);
});

test('v21 catalog fallback reads only the current filter schema and never probes v20', async () => {
  const { legacyCatalogCache, CATALOG_CACHE_VERSION } = require('../api/leaderboard');
  const queried = [];
  const payload = {
    source: 'content_dashboard_performance', selectionMode: 'catalog', metrics: {},
    books: [{ bookSkuId: 'safe-sku', title: 'Safe Book', source: 'content_dashboard', ownershipVerified: true, baseReadUnt: 100 }]
  };
  const redis = {
    async get(key) {
      queried.push(key);
      return key.includes(`:catalog:${CATALOG_CACHE_VERSION}:`) && key.includes(':maxnovel:EN:\u5df2\u5b8c\u7ed3:\u4e0a\u67b6:undefined:100:0.3:0.1:single')
        ? JSON.stringify(payload)
        : null;
    },
    async del() { return 1; }
  };
  const restored = await legacyCatalogCache(redis, 30, 'baseReadUnt', {
    appKey: 'maxnovel', productLine: ['maxnovel'], language: 'EN', completeSts: '已完结', status: '上架', isShort: undefined,
    readBaseMin: 100, firstReadMin: 0.3, longReadMin: 0.1
  });
  assert.equal(CATALOG_CACHE_VERSION, 'v21');
  assert.equal(restored?.books?.[0]?.bookSkuId, 'safe-sku');
  assert.ok(queried.some((key) => key.includes(':catalog:v21:')));
  assert.equal(queried.some((key) => key.includes(':catalog:v20:')), false);
});
