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
