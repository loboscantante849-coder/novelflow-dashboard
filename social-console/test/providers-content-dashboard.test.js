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
    calls.push({ url: String(url), authorization: new Headers(options.headers).get('authorization') });
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
  assert.equal(calls.filter((item) => item.url.includes('/connect/token')).length, 1);
  assert.equal(dashboardCalls[1].authorization, 'Bearer fresh-token');
  assert.equal(result.books[0].title, 'Fresh Book');
});
