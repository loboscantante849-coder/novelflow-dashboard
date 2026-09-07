'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const meta = require('../api/_lib/meta-ads');
const beidou = require('../api/_lib/beidou-ads');
const performance = require('../api/_lib/ad-performance');
const { handleAdPerformance } = require('../api/_lib/ad-performance');

function fakeRedis(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    async get(key) { return values.get(key) || null; },
    async set(key, value) { values.set(key, value); return 'OK'; },
    async incr(key) { const next = Number(values.get(key) || 0) + 1; values.set(key, String(next)); return next; },
    values
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = String(value); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('Meta registry starts with exactly the six active account-matching ads', async () => {
  const registry = await meta.loadMetaRegistry(null);
  assert.equal(registry.length, 6);
  assert.equal(registry.filter((entry) => entry.active).length, 6);
  assert.deepEqual(new Set(registry.map((entry) => entry.metaAdId)), new Set([
    '120248838909080743', '120248835695450743', '120248801168210743',
    '120248839344220743', '120248846340630743', '120248846975590743'
  ]));
  assert.ok(registry.every((entry) => entry.accountId === meta.META_ACCOUNT_ID));
});

test('Meta Insights request stays on stable public fields and never puts a token in the URL', () => {
  const url = meta.graphUrl('2026-08-01', '2026-08-08').toString();
  assert.doesNotMatch(url, /access_token|token=/i);
  assert.doesNotMatch(meta.META_FIELDS.join(','), /quality_score_|budget|delivery_info/i);
  assert.match(meta.META_FIELDS.join(','), /inline_link_clicks/);
});

test('a persisted seed disable survives a sparse Redis registry record', async () => {
  const redis = fakeRedis({ [meta.META_REGISTRY_KEY]: JSON.stringify([{ metaAdId: meta.SEED_META_AD_IDS[0], active: false }]) });
  const registry = await meta.loadMetaRegistry(redis);
  assert.equal(registry.find((entry) => entry.metaAdId === meta.SEED_META_AD_IDS[0]).active, false);
});

test('Meta pagination filters unknown ads and mismatched accounts after every response', async (t) => {
  const calls = [];
  const previous = process.env.META_MARKETING_ACCESS_TOKEN;
  process.env.META_MARKETING_ACCESS_TOKEN = 'meta-test-token';
  t.after(() => { if (previous === undefined) delete process.env.META_MARKETING_ACCESS_TOKEN; else process.env.META_MARKETING_ACCESS_TOKEN = previous; });
  const result = await meta.fetchMetaAds({
    from: '2026-08-01', to: '2026-08-09', registry: meta.cloneSeedRegistry(),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return new Response(JSON.stringify({ data: [
        { account_id: meta.META_ACCOUNT_ID, ad_id: meta.SEED_META_AD_IDS[0], spend: '1.25', impressions: '10' },
        { account_id: meta.META_ACCOUNT_ID, ad_id: '999999999999999999', spend: '99' },
        { account_id: '123456789', ad_id: meta.SEED_META_AD_IDS[1], spend: '88' }
      ], paging: { next: 'https://graph.facebook.com/v23.0/page?access_token=should-not-leak&after=one' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ data: [{ account_id: meta.META_ACCOUNT_ID, ad_id: meta.SEED_META_AD_IDS[0], spend: '2.75' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(result.rows.length, 2);
  assert.equal(result.summary.spend, 4);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ url, options }) => !url.includes('access_token') && !url.includes('meta-test-token') && options.headers.Authorization === 'Bearer meta-test-token'));
});

test('Meta without a token is partial and never throws', async () => {
  const previous = process.env.META_MARKETING_ACCESS_TOKEN;
  delete process.env.META_MARKETING_ACCESS_TOKEN;
  const result = await meta.fetchMetaAds({ from: '2026-08-01', to: '2026-08-09', registry: meta.cloneSeedRegistry(), fetchImpl: async () => { throw new Error('must not call'); } });
  if (previous !== undefined) process.env.META_MARKETING_ACCESS_TOKEN = previous;
  assert.equal(result.status, 'unconfigured');
  assert.equal(result.configured, false);
});

test('private registry upsert requires the exact Meta account and can add a future ad', async () => {
  const redis = fakeRedis();
  await assert.rejects(() => performance.mutateRegistry(redis, { action: 'upsert', metaAdId: '120248899999999999', accountId: '1', language: 'pt' }), /Only Meta account/);
  const changed = await performance.mutateRegistry(redis, { action: 'upsert', metaAdId: '120248899999999999', accountId: meta.META_ACCOUNT_ID, language: 'pt', beidouCampaignName: 'Exact PT Campaign', reportDimension: 'adid', reportId: 'report-1' });
  assert.equal(changed.record.active, true);
  assert.equal(changed.record.beidouCampaignName, 'Exact PT Campaign');
  assert.equal(changed.record.reportDimension, 'adid');
  assert.equal(changed.registry.length, 7);
  const cleared = await performance.mutateRegistry(redis, { action: 'upsert', metaAdId: '120248899999999999', language: 'pt', name: '', active: false, beidouCampaignName: '', reportDimension: '', reportId: '' });
  assert.equal(cleared.record.active, false);
  assert.equal(Object.hasOwn(cleared.record, 'beidouCampaignName'), false);
  assert.equal(Object.hasOwn(cleared.record, 'reportId'), false);
  const listed = await performance.queryAdPerformance({
    from: '2026-08-01', to: '2026-08-09', redis, metaAdapter: async () => ({ status: 'no_data', configured: true, ads: [] }),
    beidouAdapter: async () => ({ status: 'no_data', configured: true, ads: [] }),
    socialAdapter: async () => ({ status: 'no_data', configured: true, ads: [] })
  });
  const disabled = listed.ads.find((entry) => entry.registry.metaAdId === '120248899999999999');
  assert.equal(disabled.metaStatus, 'disabled');
});

test('open access explicitly rejects both read and registry write endpoints', async () => {
  const previous = process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
  process.env.SOCIAL_CONSOLE_OPEN_ACCESS = 'true';
  const getResponse = responseRecorder();
  await handleAdPerformance({ method: 'GET', headers: {}, query: {} }, getResponse);
  assert.equal(getResponse.statusCode, 403);
  const postResponse = responseRecorder();
  await handleAdPerformance({ method: 'POST', headers: {}, body: { action: 'disable', metaAdId: meta.SEED_META_AD_IDS[0] } }, postResponse);
  assert.equal(postResponse.statusCode, 403);
  if (previous === undefined) delete process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
  else process.env.SOCIAL_CONSOLE_OPEN_ACCESS = previous;
});

test('Beidou queries only explicit campaign names and identifies campaign-level data', async () => {
  const calls = [];
  const registry = [{ ...meta.cloneSeedRegistry()[0], beidouCampaignName: 'Exact Campaign' }, meta.cloneSeedRegistry()[1]];
  const result = await beidou.fetchBeidouAds({ from: '2026-08-01', to: '2026-08-09', registry, token: 'beidou-test-token', endpoint: 'https://beidou.test/report', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: [{ campaignName: 'Exact Campaign', date: '2026-08-01', d7Income: 3 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.filter.conditions[1], { field: 'e.self_campaign_name', function: 'EQUAL', paramDatas: ['Exact Campaign'] });
  assert.equal(calls[0].options.headers['x-project-id'], beidou.BEIDOU_PROJECT_ID);
  assert.equal(result.ads.length, 1);
  assert.equal(result.ads[0].campaignLevel, true);
  assert.equal(result.ads[0].adLevel, false);
  assert.equal(result.ads[0].rows[0].d7Income, 3);
  assert.equal(result.ads[0].rows[0].visits, 0);
});

test('Beidou campaign-level summaries count a shared campaign once', async () => {
  const seed = meta.cloneSeedRegistry();
  const registry = [
    { ...seed[0], beidouCampaignName: 'Shared Campaign' },
    { ...seed[1], beidouCampaignName: 'Shared Campaign' }
  ];
  const result = await beidou.fetchBeidouAds({
    from: '2026-08-01', to: '2026-08-09', registry, token: 'beidou-test-token', endpoint: 'https://beidou.test/report',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ campaignName: 'Shared Campaign', date: '2026-08-01', visits: 12, d7Income: 4 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  });
  assert.equal(result.ads.length, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.summary.visits, 12);
  assert.equal(result.summary.d7Income, 4);
  assert.ok(result.ads.every((ad) => ad.sharedAcrossAds === true && ad.mappedMetaAdIds.length === 2));
  assert.match(result.warnings[0], /counted once/);
});

test('Beidou parses the verified async detailResult response as campaign visits', () => {
  const rows = beidou.parseStoredRows({ is_done: true, items: [{ detailResult: {
    series: ['26-08-01'], rows: [{ byValues: ['Exact Campaign'], values: [[12]] }]
  } }] }, { from: '2026-08-01', to: '2026-08-09' }, 'Exact Campaign');
  const normalized = beidou.normalizeBeidouRow(rows[0], 'Exact Campaign', { from: '2026-08-01', to: '2026-08-09' });
  assert.equal(normalized.visits, 12);
  assert.equal(normalized.adLevel, false);
});

test('social report rows require the exact mapped ID and reporting window', () => {
  const rows = performance.filterSocialReportRows([
    { adId: 'report-1', date: '2026-08-01', pullUv: 3 },
    { adId: 'other-ad', date: '2026-08-01', pullUv: 90 },
    { adId: 'report-1', date: '2026-07-31', pullUv: 80 },
    { date: '2026-08-01', pullUv: 70 }
  ], 'adid', 'report-1', { from: '2026-08-01', to: '2026-08-09' });
  assert.deepEqual(rows, [{ adId: 'report-1', date: '2026-08-01', pullUv: 3 }]);
});

test('three source failures remain independent and are not added together', async () => {
  const seed = meta.cloneSeedRegistry();
  const result = await performance.queryAdPerformance({
    from: '2026-08-01', to: '2026-08-09', redis: null, registry: seed,
    metaAdapter: async () => ({ source: 'meta', status: 'ok', configured: true, ads: [{ metaAdId: seed[0].metaAdId, metrics: { spend: 2 } }], summary: { spend: 2 } }),
    beidouAdapter: async () => { throw new Error('beidou down'); },
    socialAdapter: async () => ({ source: 'social', status: 'ok', configured: true, ads: [{ metaAdId: seed[0].metaAdId, metrics: { d7Income: 7 } }], summary: { d7Income: 7 } })
  });
  assert.equal(result.sourceStatus.meta.status, 'ok');
  assert.equal(result.sourceStatus.beidou.status, 'failed');
  assert.equal(result.sourceStatus.social.status, 'ok');
  assert.equal(result.status, 'partial');
  assert.equal(result.ads.length, 6);
  const matched = result.ads.find((ad) => ad.registry.metaAdId === seed[0].metaAdId);
  assert.equal(matched.meta.metrics.spend, 2);
  assert.equal(matched.social.metrics.d7Income, 7);
  assert.equal(Object.hasOwn(result.summary, 'combined'), false);
});

test('synchronous adapter throws are isolated like rejected source promises', async () => {
  const result = await performance.queryAdPerformance({
    from: '2026-08-01', to: '2026-08-09', redis: null, registry: meta.cloneSeedRegistry(),
    metaAdapter: () => { throw new Error('meta sync down'); },
    beidouAdapter: () => ({ status: 'no_data', configured: true, ads: [] }),
    socialAdapter: () => ({ status: 'no_data', configured: true, ads: [] })
  });
  assert.equal(result.sourceStatus.meta.status, 'failed');
  assert.equal(result.sourceStatus.beidou.status, 'no_data');
  assert.equal(result.sourceStatus.social.status, 'no_data');
});
