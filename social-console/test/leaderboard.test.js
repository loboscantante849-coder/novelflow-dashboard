const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');

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
    await handler({ method: 'GET', headers: {}, query: { source: 'catalog', ...query } }, res);
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
    books: [{ bookSkuId: 'verified-1', title: 'Verified Catalog Book', source: 'content_dashboard', baseReadUnt: 800, firstReadUntRate: 0.42 }]
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
      books: [{ bookSkuId: 'verified-lag-1', title: 'Published Two Days Ago', source: 'content_dashboard', baseReadUnt: 900, firstReadUntRate: 31 }],
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
  assert.equal(windows.length, 2);
  const firstEnd = new Date(`${windows[0].endDate}T00:00:00Z`);
  const secondEnd = new Date(`${windows[1].endDate}T00:00:00Z`);
  assert.equal(firstEnd.getTime() - secondEnd.getTime(), 86400000);
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
