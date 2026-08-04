const test = require('node:test');
const assert = require('node:assert/strict');
const { copyAssetPayload, listRunsPayload, loadRunView, buildRunInput, archiveFailedRuns } = require('../api/runs');

test('copy asset payload excludes full-book evidence and provider diagnostics', () => {
  const run = {
    id: 'run-copy',
    artifacts: {
      posts: [{ type: 'hook', content: 'English finished copy', zhContent: 'Chinese review copy', evidence: [{ quote: 'q'.repeat(5000) }] }],
      evidence: { chapters: [{ content: 'chapter'.repeat(10000) }] },
      videoPrompt: { buildRequirement: 'video'.repeat(10000) }
    }
  };
  const payload = copyAssetPayload(run);
  assert.deepEqual(payload.posts, [{ type: 'hook', content: 'English finished copy', zhContent: 'Chinese review copy' }]);
  assert.equal(payload.evidence, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1000);
});

test('default runs payload uses bounded summaries instead of full chapter evidence', async () => {
  const redis = { marker: 'redis' };
  let receivedRedis;
  let receivedLimit;
  const payload = await listRunsPayload(redis, async (value, limit) => {
    receivedRedis = value;
    receivedLimit = limit;
    return [{ id: 'run-summary', _summary: true }];
  });

  assert.equal(receivedRedis, redis);
  assert.equal(receivedLimit, 50);
  assert.deepEqual(payload, { runs: [{ id: 'run-summary', _summary: true }] });
});

test('run detail reads the compact summary first and falls back when its snapshot is unavailable', async () => {
  const calls = [];
  const result = await loadRunView({ marker: 'redis' }, 'run-slow',
    async () => { calls.push('detail'); return null; },
    async () => { calls.push('summary'); return { id: 'run-slow', _summary: true, stages: { P3: { status: 'running' } } }; });
  assert.deepEqual(calls, ['summary', 'detail']);
  assert.equal(result.partial, true);
  assert.equal(result.run._summary, false);
  assert.equal(result.run._detailPartial, true);
  assert.equal(result.run.stages.P3.status, 'running');
});

test('run detail returns the summary projection when a legacy snapshot exceeds its deadline', async () => {
  const result = await loadRunView({ marker: 'redis' }, 'run-late',
    async () => new Promise((resolve) => setTimeout(() => resolve({ id: 'run-late', full: true }), 30)),
    async () => ({ id: 'run-late', _summary: true, stages: { P3: { status: 'waiting' } } }),
    5);
  assert.equal(result.partial, true);
  assert.equal(result.run._detailPartial, true);
  assert.equal(result.run.stages.P3.status, 'waiting');
});

test('one-click run input keeps source and full-book evidence decisions', () => {
  const input = buildRunInput({ title: 'Exact Romance', bookSkuId: 'sku-42' }, {
    source: 'catalog_30d',
    fullBookEvidence: true,
    paidAuthorized: true,
    promoter: 'xujt'
  }, null);
  assert.equal(input.source, 'catalog_30d');
  assert.equal(input.automationMode, 'one_click');
  assert.equal(input.fullBookEvidence, true);
  assert.equal(input.paidAuthorized, true);
});

test('one-click mode is enforced even when a caller sends a different mode', () => {
  const input = buildRunInput({ title: 'Exact Romance', bookSkuId: 'sku-42' }, {
    automationMode: 'manual',
    paidAuthorized: true
  }, null);
  assert.equal(input.automationMode, 'one_click');
});

test('clearing failed tasks archives only failed runs and preserves their durable assets', async () => {
  const failed = {
    id: 'failed-run-1234', state: 'failed', stages: { P3: { status: 'failed' } },
    artifacts: { code: 'NF-123', shortLink: 'https://example.com/s/123', video: { threadId: 'paid-video-1', status: 'failed' } }, events: []
  };
  const completed = { id: 'complete-run-12', state: 'completed', stages: { P6: { status: 'done' } }, artifacts: { code: 'NF-456' }, events: [] };
  const saves = [];
  const redis = {
    async set(key, value) { saves.push({ key, value }); return 'OK'; },
    async zadd() { return 1; }
  };
  const archived = await archiveFailedRuns(redis, async () => [failed, completed]);
  assert.deepEqual(archived, [failed.id]);
  assert.equal(failed.state, 'archived');
  assert.equal(failed.artifacts.code, 'NF-123');
  assert.equal(failed.artifacts.video.threadId, 'paid-video-1');
  assert.equal(completed.state, 'completed');
  assert.ok(saves.length >= 3);
});
