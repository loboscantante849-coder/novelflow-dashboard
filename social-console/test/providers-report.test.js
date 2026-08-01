const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');

test('report providers preserve full funnel metrics and putreport traffic metrics', async (t) => {
  const originalFetch = global.fetch;
  const previousToken = process.env.NOVELFLOW_REPORT_TOKEN;
  process.env.NOVELFLOW_REPORT_TOKEN = 'test-report-token';
  const requests = [];
  t.after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.NOVELFLOW_REPORT_TOKEN;
    else process.env.NOVELFLOW_REPORT_TOKEN = previousToken;
  });
  global.fetch = async (url, options = {}) => {
    const request = { url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body) };
    requests.push(request);
    if (request.url.includes('socialsource-code-funnel')) {
      return new Response(JSON.stringify({ code: 200, data: { data: { list: [{
        dt: '2026-08-01', mediaSource: 'link', adId: 'track-1', pullUv: 12, activeUv: 8,
        newUv: 5, attActiveUv: 7, attNewUv: 4, d0Income: 1, d7Income: 3, d30Income: 7, dnIncome: 9
      }] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code: 200, data: [{
      date: '2026-08-01', adid: 'track-1', h5landingpageclicknum: 20,
      h5landingpageclickusernum: 12, newusernum: 5, d14income: 4
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const funnel = await providers.funnelReportRows('', 'track-1', 2, { from: '2026-07-31', to: '2026-08-01' });
  const putreport = await providers.putreportRows('', 'track-1', 2, { from: '2026-07-31', to: '2026-08-01' });

  assert.equal(funnel.rows[0].activeUv, 8);
  assert.equal(funnel.rows[0].attNewUv, 4);
  assert.equal(funnel.rows[0].dnIncome, 9);
  assert.equal(putreport.rows[0].visits, 20);
  assert.equal(putreport.rows[0].d14Income, 4);
  const putRequest = requests.find((item) => item.url.includes('/putreport/putreport'));
  assert.equal(putRequest.headers.get('x-os'), 'web');
  assert.deepEqual(putRequest.body.groupings, ['adid', 'date']);
  const funnelRequest = requests.find((item) => item.url.includes('socialsource-code-funnel'));
  assert.deepEqual(funnelRequest.body.groupings, ['dt', 'ad_id']);
});

test('opaque identifiers can be probed as putreport copywriting IDs', async (t) => {
  const originalFetch = global.fetch;
  const previousToken = process.env.NOVELFLOW_REPORT_TOKEN;
  process.env.NOVELFLOW_REPORT_TOKEN = 'test-report-token';
  let payload;
  t.after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.NOVELFLOW_REPORT_TOKEN;
    else process.env.NOVELFLOW_REPORT_TOKEN = previousToken;
  });
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ code: 200, data: [{ copywritingid: 'opaque-32', date: '2026-08-01', newusernum: 3 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await providers.putreportDimensionRows('opaque-32', 'copywritingid', 2, { from: '2026-07-31', to: '2026-08-01' });
  assert.deepEqual(payload.filters.copywritingid, ['opaque-32']);
  assert.deepEqual(payload.groupings, ['copywritingid', 'date']);
  assert.equal(result.rows[0].copywritingId, 'opaque-32');
  assert.equal(result.rows[0].newUv, 3);
});

test('parent-dimension query can expand to adid by date', async (t) => {
  const originalFetch = global.fetch;
  const previousToken = process.env.NOVELFLOW_REPORT_TOKEN;
  process.env.NOVELFLOW_REPORT_TOKEN = 'test-report-token';
  let payload;
  t.after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.NOVELFLOW_REPORT_TOKEN;
    else process.env.NOVELFLOW_REPORT_TOKEN = previousToken;
  });
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ code: 200, data: [{ adid: 'child-ad', date: '2026-08-01', h5landingpageclickusernum: 4 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await providers.putreportBreakdownRows('parent-adset', 'adsetid', 2, { from: '2026-07-31', to: '2026-08-01' });
  assert.deepEqual(payload.filters.adsetid, ['parent-adset']);
  assert.deepEqual(payload.groupings, ['adid', 'date']);
  assert.equal(result.rows[0].adId, 'child-ad');
});

test('funnel batch query keeps multiple child adids in one request', async (t) => {
  const originalFetch = global.fetch;
  const previousToken = process.env.NOVELFLOW_REPORT_TOKEN;
  process.env.NOVELFLOW_REPORT_TOKEN = 'test-report-token';
  let payload;
  t.after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.NOVELFLOW_REPORT_TOKEN;
    else process.env.NOVELFLOW_REPORT_TOKEN = previousToken;
  });
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ code: 200, data: [{ adId: 'child-a', dt: '2026-08-01', pullUv: 2 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await providers.funnelReportIds(['child-a', 'child-b'], 2, { from: '2026-07-31', to: '2026-08-01' });
  assert.deepEqual(payload.adIds, ['child-a', 'child-b']);
  assert.equal(result.rows[0].adId, 'child-a');
});
