const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');

test('content dashboard uses the Writer Admin request contract and sorts locally', async (t) => {
  const originalFetch = global.fetch;
  const previousToken = process.env.NOVELFLOW_OIDC_TOKEN;
  process.env.NOVELFLOW_OIDC_TOKEN = 'test-dashboard-token';
  const requests = [];
  t.after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.NOVELFLOW_OIDC_TOKEN;
    else process.env.NOVELFLOW_OIDC_TOKEN = previousToken;
  });
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ code: 200, data: { total: 2, data: [
      { skuId: 'b', title: 'Second', baseReadUnt: 50, firstReadUntRate: 10 },
      { skuId: 'a', title: 'First', baseReadUnt: 100, firstReadUntRate: 20 }
    ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await providers.contentDashboardBooks({
    startDate: '2026-07-01', endDate: '2026-07-07', sortField: 'firstReadUntRate',
    filters: { productLine: ['novelflow'], language: 'EN' }, maxPages: 1
  });
  const request = requests.find((item) => item.url.includes('/contentmiddleground/report/list'));
  const headers = new Headers(request.options.headers);
  const body = JSON.parse(request.options.body);
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(headers.get('x-os'), 'web');
  assert.equal(Object.hasOwn(body, 'sortField'), false);
  assert.deepEqual(result.books.map((book) => book.title), ['First', 'Second']);
});

test('promotion score ranks only statistically qualified books and balances scale with conversion', async (t) => {
  const originalFetch = global.fetch;
  const previousToken = process.env.NOVELFLOW_OIDC_TOKEN;
  process.env.NOVELFLOW_OIDC_TOKEN = 'test-dashboard-token';
  t.after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.NOVELFLOW_OIDC_TOKEN;
    else process.env.NOVELFLOW_OIDC_TOKEN = previousToken;
  });
  global.fetch = async () => new Response(JSON.stringify({ code: 200, data: { total: 3, data: [
    { skuId: 'tiny', title: 'Tiny Sample', baseReadUnt: 71, firstReadUntRate: 90, read10wRate: 90, read20wRate: 80, ttProfit: 5 },
    { skuId: 'scale', title: 'Scale Winner', baseReadUnt: 2000, firstReadUntRate: 35, read10wRate: 25, read20wRate: 18, ttProfit: 80 },
    { skuId: 'balanced', title: 'Balanced Winner', baseReadUnt: 1200, firstReadUntRate: 55, read10wRate: 45, read20wRate: 35, ttProfit: 70 }
  ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const result = await providers.contentDashboardBooks({
    startDate: '2026-07-01', endDate: '2026-07-07', sortField: 'promotionScore', minReadUnt: 300,
    filters: { productLine: ['novelflow'], language: 'EN' }, maxPages: 1
  });
  assert.deepEqual(result.books.map((book) => book.title), ['Balanced Winner', 'Scale Winner']);
  assert.equal(result.candidateTotal, 3);
  assert.equal(result.qualifiedTotal, 2);
  assert.equal(result.observedTopUv, 2000);
  assert.ok(result.books.every((book) => book.promotionScore > 0));
});

test('content dashboard refreshes an expired configured credential once after its masked 500', async (t) => {
  const originalFetch = global.fetch;
  const previous = {
    token: process.env.NOVELFLOW_OIDC_TOKEN,
    username: process.env.NOVELFLOW_OIDC_USERNAME,
    password: process.env.NOVELFLOW_OIDC_PASSWORD
  };
  process.env.NOVELFLOW_OIDC_TOKEN = 'stale-token';
  process.env.NOVELFLOW_OIDC_USERNAME = 'test-user';
  process.env.NOVELFLOW_OIDC_PASSWORD = 'test-password';
  const calls = [];
  t.after(() => {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      const key = `NOVELFLOW_OIDC_${name === 'token' ? 'TOKEN' : name.toUpperCase()}`;
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: new Headers(options.headers).get('authorization'), body: String(options.body || '') });
    if (String(url).includes('/connect/token')) {
      return new Response(JSON.stringify({ access_token: 'fresh-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const dashboardCalls = calls.filter((item) => item.url.includes('/contentmiddleground/report/list'));
    if (dashboardCalls.length === 1) return new Response(JSON.stringify({ message: 'oops' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ code: 200, data: { total: 1, data: [{ skuId: 'fresh-book', title: 'Fresh Book', baseReadUnt: 1 }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await providers.contentDashboardBooks({ startDate: '2026-07-01', endDate: '2026-07-07', maxPages: 1 });
  const dashboardCalls = calls.filter((item) => item.url.includes('/contentmiddleground/report/list'));
  assert.equal(dashboardCalls.length, 2);
  const tokenCalls = calls.filter((item) => item.url.includes('/connect/token'));
  assert.equal(tokenCalls.length, 1);
  const tokenBody = new URLSearchParams(tokenCalls[0].body);
  assert.equal(tokenBody.get('grant_type'), 'password');
  assert.equal(tokenBody.get('client_id'), 'AuthClient');
  assert.equal(tokenBody.has('scope'), false);
  assert.equal(dashboardCalls[1].authorization, 'Bearer fresh-token');
  assert.equal(result.books[0].title, 'Fresh Book');
});

test('exact book lookup falls back to a SKU-verified canonical record', async (t) => {
  const originalFetch = global.fetch;
  const previousToken = process.env.NOVELFLOW_OIDC_TOKEN;
  process.env.NOVELFLOW_OIDC_TOKEN = 'test-book-token';
  const requests = [];
  t.after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.NOVELFLOW_OIDC_TOKEN;
    else process.env.NOVELFLOW_OIDC_TOKEN = previousToken;
  });
  global.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    requests.push(requestUrl);
    const record = requestUrl.searchParams.get('bookId')
      ? { skuId: 'target-sku', id: 'canonical-city-id', title: 'Canonical Book Title', cover: 'https://cdn.example/canonical-cover.jpg' }
      : { bookSkuId: 'different-sku', id: 'different-city-id', title: 'Different Book' };
    return new Response(JSON.stringify({ code: 200, data: { data: [record], total: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const book = await providers.findExactBook('Stale Dashboard Title', 'target-sku');

  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get('bookId'), 'target-sku');
  assert.equal(book.bookSkuId, 'target-sku');
  assert.equal(book.title, 'Canonical Book Title');
  assert.equal(book.cover, 'https://cdn.example/canonical-cover.jpg');
});

test('exact book lookup uses the legacy SKU keyword path only with an exact identifier match', async (t) => {
  const originalFetch = global.fetch;
  const previousToken = process.env.NOVELFLOW_OIDC_TOKEN;
  process.env.NOVELFLOW_OIDC_TOKEN = 'test-keyword-token';
  const requests = [];
  t.after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.NOVELFLOW_OIDC_TOKEN;
    else process.env.NOVELFLOW_OIDC_TOKEN = previousToken;
  });
  global.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    requests.push(requestUrl);
    const record = requestUrl.searchParams.get('keyword')
      ? [{ bookSkuId: 'keyword-sku', id: 'keyword-city-id', title: 'Keyword Canonical Title', cover: 'https://cdn.example/keyword-cover.jpg' }]
      : [];
    return new Response(JSON.stringify({ code: 200, data: { data: record, total: record.length } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const book = await providers.findExactBook('Unmatched Dashboard Title', 'keyword-sku');

  assert.equal(requests.length, 3);
  assert.equal(requests[2].searchParams.get('keyword'), 'keyword-sku');
  assert.equal(book.bookSkuId, 'keyword-sku');
  assert.equal(book.title, 'Keyword Canonical Title');
  assert.equal(book.cover, 'https://cdn.example/keyword-cover.jpg');
});
