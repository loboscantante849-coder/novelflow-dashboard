const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedis, RemoteRedis, getMany, newRun, runSummary, runDetail } = require('../api/_lib/store');

test('storage uses direct Upstash credentials before the remote Vercel bridge', () => {
  const redis = createRedis({
    KV_REST_API_URL: 'https://example.upstash.io',
    KV_REST_API_TOKEN: 'direct-token',
    SOCIAL_STORE_URL: 'https://example.com/api/social-store',
    SOCIAL_STORE_SECRET: 'bridge-secret'
  });

  assert.ok(redis);
  assert.equal(redis instanceof RemoteRedis, false);
});

test('storage keeps the authenticated bridge when direct credentials are unavailable', () => {
  const redis = createRedis({
    SOCIAL_STORE_URL: 'https://example.com/api/social-store',
    SOCIAL_STORE_SECRET: 'bridge-secret'
  });

  assert.ok(redis instanceof RemoteRedis);
});

test('dashboard summaries use one Redis batch read when mget is available', async () => {
  const calls = { mget: 0, get: 0 };
  const redis = {
    async mget(...keys) { calls.mget += 1; return keys.map((key) => `value:${key}`); },
    async get() { calls.get += 1; return null; }
  };
  const values = await getMany(redis, ['a', 'b', 'c']);
  assert.deepEqual(values, ['value:a', 'value:b', 'value:c']);
  assert.deepEqual(calls, { mget: 1, get: 0 });
});

test('dashboard summaries keep the remote bridge fallback without mget', async () => {
  const redis = { async get(key) { return `value:${key}`; } };
  assert.deepEqual(await getMany(redis, ['a', 'b']), ['value:a', 'value:b']);
});
test('dashboard run summaries retain operational state without transferring full planning and model payloads', () => {
  const run = newRun({
    title: 'Summary Romance',
    sku: 'summary-sku',
    creativeProfile: { modelChoice: 'hy3' },
    planning: {
      planId: 'plan_summary',
      preferredModel: 'deepseek',
      actualModel: 'hy3',
      fallbackUsed: true,
      strategy: { editorialThesis: 'x'.repeat(5000), evidence: Array.from({ length: 12 }, () => ({ quote: 'y'.repeat(500) })) }
    }
  });
  run.stages.P3 = { status: 'running', label: 'Creating source-grounded copy', error: 'z'.repeat(1000), providerPayload: { trace: 'q'.repeat(5000) } };
  run.artifacts.book = { title: run.input.title, bookSkuId: run.input.sku, cover: 'https://example.com/cover.jpg', description: 'd'.repeat(10000), tags: Array(30).fill('romance') };
  run.artifacts.usage = { creative: { model: 'hy3', totalTokens: 1234, responseId: 'r'.repeat(5000) } };
  run.artifacts.modelActivity = Array.from({ length: 8 }, () => ({ section: 'posts', model: 'hy3', requestedModel: 'deepseek', totalTokens: 1234, providerPayload: 'p'.repeat(5000) }));
  run.events = Array.from({ length: 8 }, (_, index) => ({ at: new Date().toISOString(), type: 'event', message: `event-${index}-${'m'.repeat(500)}` }));

  const summary = runSummary(run);
  const bytes = Buffer.byteLength(JSON.stringify(summary));

  assert.equal(summary.input.planning.strategy, undefined);
  assert.equal(summary.stages.P3.providerPayload, undefined);
  assert.equal(summary.stages.P3.error.length, 300);
  assert.equal(summary.artifacts.book.description, undefined);
  assert.deepEqual(summary.artifacts.usage.creative, { model: 'hy3', totalTokens: 1234 });
  assert.equal(summary.modelActivity.length, 8);
  assert.equal(summary.events.length, 1);
  assert.equal(summary._summaryVersion, 4);
  assert.ok(bytes < 10000, `summary should be compact, received ${bytes} bytes`);
});

test('detail snapshots bound chapter payloads before the browser reads them', () => {
  const run = newRun({ title: 'Heavy Romance', sku: 'heavy-sku', creativeProfile: { modelChoice: 'deepseek' } });
  run.artifacts.evidence = { chapters: Array.from({ length: 30 }, (_, index) => ({ order: index + 1, title: `Chapter ${index + 1}`, content: 'x'.repeat(50000) })) };
  const detail = runDetail(run);
  assert.equal(detail.artifacts.evidence.chapters.length, 20);
  assert.equal(detail.artifacts.evidence.chapters[0].content.length, 8000);
  assert.equal(detail._detailVersion, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 170000);
});

test('completed review packages stay visible in compact dashboard summaries', () => {
  const run = newRun({ title: 'Review Ready Romance', sku: 'review-sku', creativeProfile: { modelChoice: 'hy3' } });
  run.stages.P6 = { status: 'done', label: 'Review package ready' };
  run.artifacts.review = {
    status: 'ready',
    facebook: { status: 'paused', automaticPublishing: false },
    posts: [{ content: 'large finished post' }],
    mediaWarnings: [{ stage: 'P3_5', status: 'partial' }]
  };

  const summary = runSummary(run);

  assert.deepEqual(summary.artifacts.review, {
    status: 'ready',
    facebook: { status: 'paused', automaticPublishing: false },
    warningCount: 1
  });
});
