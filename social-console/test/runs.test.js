const test = require('node:test');
const assert = require('node:assert/strict');
const { copyAssetPayload, listRunsPayload } = require('../api/runs');

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
