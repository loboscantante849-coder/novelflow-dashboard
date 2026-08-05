const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedis, RemoteRedis, getMany, listRunSummaries, newRun, runSummary, runDetail, runAssets, setStage, saveRun, findActiveRun, registerActiveRun, acquireRunCreation, releaseRunCreation, runIsActive } = require('../api/_lib/store');

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
test('dashboard summary lists skip archived tasks without hiding usable history', async () => {
  const archived = newRun({ title: 'Archived failure', sku: 'archived-failure' });
  archived.state = 'archived';
  const visible = newRun({ title: 'Visible success', sku: 'visible-success' });
  visible.state = 'completed';
  const values = new Map([
    [`nf_social:run_summary:${archived.id}`, JSON.stringify(runSummary(archived))],
    [`nf_social:run_summary:${visible.id}`, JSON.stringify(runSummary(visible))]
  ]);
  const redis = {
    async zrange(_key, start, end) { return [archived.id, visible.id].slice(start, end + 1); },
    async mget(...keys) { return keys.map((key) => values.get(key) || null); },
    async get(key) { return values.get(key) || null; },
    async set(key, value) { values.set(key, value); return 'OK'; }
  };

  const summaries = await listRunSummaries(redis, 1);
  assert.deepEqual(summaries.map((item) => item.id), [visible.id]);
  assert.ok(values.has(`nf_social:run_summary:${archived.id}`));
});
test('archived runs retain an archived autopilot state', () => {
  const run = newRun({ title: 'Archived task', sku: 'archived-task' });
  run.state = 'archived';
  assert.equal(runSummary(run).autopilot.status, 'archived');
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
  assert.equal(summary.modelActivity.length, 3);
  assert.equal(summary.events.length, 1);
  assert.equal(summary._summaryVersion, 7);
  assert.deepEqual(summary.stages.P1, { status: 'waiting' });
  assert.ok(bytes < 6000, `summary should be compact, received ${bytes} bytes`);
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

test('ready asset snapshots keep finished media and copy without chapter payloads', () => {
  const run = newRun({ title: 'Ready Asset Romance', sku: 'ready-asset-sku' });
  run.artifacts.evidence = { chapters: [{ order: 1, content: 'chapter evidence'.repeat(5000) }] };
  run.artifacts.posts = [{ type: 'dialogue_hook', content: 'Finished English copy', zhContent: '完成中文文案' }];
  run.artifacts.images = [{ variant: 'luminous_cinema', status: 'success', url: 'https://example.com/poster.jpg', prompt: 'p'.repeat(9000) }];
  run.artifacts.video = { status: 'success', threadId: 'video-1', videoUrls: ['https://example.com/video.mp4'] };
  const assets = runAssets(run);

  assert.equal(assets._assetOnly, true);
  assert.equal(assets.artifacts.posts[0].content, 'Finished English copy');
  assert.equal(assets.artifacts.images[0].url, 'https://example.com/poster.jpg');
  assert.equal(assets.artifacts.video.videoUrls[0], 'https://example.com/video.mp4');
  assert.equal(assets.artifacts.evidence, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(assets)) < 50000);
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

test('new production runs persist one-click autopilot state and safe source flags', () => {
  const run = newRun({ title: 'Autopilot Romance', sku: 'auto-sku', source: 'catalog_7d', fullBookEvidence: true });
  assert.equal(run.input.source, 'catalog_7d');
  assert.equal(run.input.automationMode, 'one_click');
  assert.equal(run.input.fullBookEvidence, true);
  assert.deepEqual(run.autopilot, {
    enabled: true,
    mode: 'one_click',
    status: 'queued',
    queuedAt: run.createdAt,
    lastProgressAt: run.createdAt,
    nextAction: 'P1',
    nextActionLabel: '核验书籍身份'
  });
  setStage(run, 'P1', 'done', { label: '书籍已核验' });
  setStage(run, 'P2', 'running', { label: '正在读取章节' });
  assert.equal(run.autopilot.status, 'running');
  assert.equal(run.autopilot.nextAction, 'P2');
  assert.equal(run.autopilot.nextActionLabel, '正在读取章节');
  const summary = runSummary(run);
  const detail = runDetail(run);
  assert.deepEqual(summary.autopilot, run.autopilot);
  assert.deepEqual(detail.autopilot, run.autopilot);
  assert.equal(summary.input.source, 'catalog_7d');
  assert.equal(summary.input.fullBookEvidence, true);
});

test('saveRun advances autopilot progress but analytics-only saves do not move it', async () => {
  const values = new Map();
  const redis = {
    async set(key, value) { values.set(key, value); return 'OK'; },
    async zadd() { return 1; }
  };
  const run = newRun({ title: 'Progress Romance', sku: 'progress-sku' });
  const initial = run.autopilot.lastProgressAt;
  await new Promise((resolve) => setTimeout(resolve, 3));
  setStage(run, 'P1', 'running');
  await saveRun(redis, run);
  const progressed = run.autopilot.lastProgressAt;
  assert.notEqual(progressed, initial);
  await new Promise((resolve) => setTimeout(resolve, 3));
  await saveRun(redis, run, { preserveUpdatedAt: true });
  assert.equal(run.autopilot.lastProgressAt, progressed);
  assert.ok(values.has(`nf_social:run_assets:${run.id}`));
});

test('active run pointer and creation lock prevent duplicate one-click tasks', async () => {
  const values = new Map();
  const redis = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async del(key) { values.delete(key); return 1; },
    async zadd() { return 1; },
    async zrange() { return []; }
  };
  const run = newRun({ title: 'Idempotent Romance', sku: 'idempotent-sku' });
  await saveRun(redis, run);
  await registerActiveRun(redis, run);
  assert.equal((await findActiveRun(redis, run.input.sku)).id, run.id);
  const first = await acquireRunCreation(redis, run.input.sku);
  assert.equal(first.acquired, true);
  const second = await acquireRunCreation(redis, run.input.sku);
  assert.equal(second.acquired, false);
  await releaseRunCreation(redis, first);
  const third = await acquireRunCreation(redis, run.input.sku);
  assert.equal(third.acquired, true);
  await releaseRunCreation(redis, third);
});

test('a failed run with persisted paid task ids remains guarded from ordinary one-click recreation', () => {
  const run = newRun({ title: 'Paid Failure', sku: 'paid-failure-sku', paidAuthorized: true });
  run.state = 'failed';
  run.artifacts.video = { threadId: 'paid-thread-1', status: 'failed' };
  assert.equal(runIsActive(run), true);
  run.artifacts.video = null;
  assert.equal(runIsActive(run), false);
});
