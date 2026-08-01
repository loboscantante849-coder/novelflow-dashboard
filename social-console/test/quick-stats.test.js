const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { quickStats, resolveIdentifier, summarize } = require('../api/_lib/quick-stats');

test('quick query recognizes opaque tracking IDs without claiming they are link IDs', async () => {
  const result = await resolveIdentifier('86750550471daf6cc59821ce6f356907');
  assert.equal(result.kind, 'tracking_id');
  assert.equal(result.identifier, '86750550471daf6cc59821ce6f356907');
});

test('quick summary exposes attribution and mature income metrics', () => {
  const result = summarize([{ date: '2026-08-01', pullUv: 100, activeUv: 40, newUv: 30, attActiveUv: 36, attNewUv: 28, d7Income: 8, d30Income: 12, dnIncome: 15 }]);
  assert.equal(result.activationRate, 40);
  assert.equal(result.attributionRate, 90);
  assert.equal(result.d30Income, 12);
  assert.equal(result.dnIncome, 15);
});

test('quick query chooses the full funnel as primary and never adds source totals', async (t) => {
  const originals = {
    funnelReportRows: providers.funnelReportRows, putreportRows: providers.putreportRows,
    putreportDimensionRows: providers.putreportDimensionRows, putreportBreakdownRows: providers.putreportBreakdownRows, funnelReportIds: providers.funnelReportIds, keywordRecord: providers.keywordRecord, linkDetail: providers.linkDetail
  };
  const originalFetch = global.fetch;
  t.after(() => { Object.assign(providers, originals); global.fetch = originalFetch; });
  providers.funnelReportRows = async () => ({ source: 'social_funnel_realtime', from: '2026-07-31', to: '2026-08-01', rows: [{ date: '2026-08-01', adId: 'opaque', pullUv: 10, activeUv: 4, dnIncome: 2 }] });
  providers.putreportRows = async () => ({ source: 'putreport_realtime', from: '2026-07-31', to: '2026-08-01', rows: [{ date: '2026-08-01', adId: 'opaque', pullUv: 10, visits: 13 }] });
  providers.putreportDimensionRows = async (_id, dimension) => ({ source: `putreport_${dimension}_realtime`, from: '2026-07-31', to: '2026-08-01', rows: [] });
  providers.putreportBreakdownRows = async () => ({ source: 'putreport_adsetid_breakdown_realtime', from: '2026-07-31', to: '2026-08-01', rows: [] });
  providers.funnelReportIds = async () => ({ source: 'social_funnel_realtime', from: '2026-07-31', to: '2026-08-01', rows: [] });
  providers.keywordRecord = async () => null;
  providers.linkDetail = async () => null;
  global.fetch = async () => new Response(JSON.stringify({ last_updated: '2026-08-01T00:00:00Z', ad_ids: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const result = await quickStats('opaque', 2, { from: '2026-07-31', to: '2026-08-01' });

  assert.equal(result.primarySource, 'social_funnel_realtime');
  assert.equal(result.sources.socialFunnel.summary.pullUv, 10);
  assert.equal(result.sources.putreport.summary.pullUv, 10);
  assert.equal(result.sources.putreport.summary.activeUv, null);
  assert.equal(Object.hasOwn(result, 'combinedTotal'), false);
});
