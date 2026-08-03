const test = require('node:test');
const assert = require('node:assert/strict');
const { copyAssetPayload, listRunsPayload, loadRunView, buildRunInput } = require('../api/runs');

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

test('run detail falls back immediately to the compact summary while its snapshot is rebuilt', async () => {
  const calls = [];
  const result = await loadRunView({ marker: 'redis' }, 'run-slow',
    async () => { calls.push('detail'); return null; },
    async () => { calls.push('summary'); return { id: 'run-slow', _summary: true, stages: { P3: { status: 'running' } } }; });
  assert.deepEqual(calls, ['detail', 'summary']);
  assert.equal(result.partial, true);
  assert.equal(result.run._summary, false);
  assert.equal(result.run._detailPartial, true);
  assert.equal(result.run.stages.P3.status, 'running');
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
