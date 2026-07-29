const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.SOCIAL_STORE_SECRET = 'test-social-store-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

const socialStore = require('../api/social-store');

test.beforeEach(() => {
  FakeRedis.reset({
    'nf_social:run_summary:a': '{"id":"a"}',
    'nf_social:run_summary:b': '{"id":"b"}'
  });
});

test('social storage bridge requires its server-to-server bearer secret', async () => {
  const res = await invoke(socialStore, {
    body: { op: 'mget', args: { keys: ['nf_social:run_summary:a'] } }
  });
  assert.equal(res.statusCode, 401);
});

test('social storage bridge batches only authorized nf_social keys', async () => {
  const res = await invoke(socialStore, {
    headers: { authorization: 'Bearer test-social-store-secret' },
    body: { op: 'mget', args: { keys: ['nf_social:run_summary:a', 'nf_social:run_summary:b'] } }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.result, ['{"id":"a"}', '{"id":"b"}']);
});

test('social storage bridge rejects cross-namespace and oversized mget requests', async () => {
  const crossNamespace = await invoke(socialStore, {
    headers: { authorization: 'Bearer test-social-store-secret' },
    body: { op: 'mget', args: { keys: ['nf_user_data:alice'] } }
  });
  assert.equal(crossNamespace.statusCode, 400);

  const oversized = await invoke(socialStore, {
    headers: { authorization: 'Bearer test-social-store-secret' },
    body: { op: 'mget', args: { keys: Array.from({ length: 51 }, (_, index) => `nf_social:run:${index}`) } }
  });
  assert.equal(oversized.statusCode, 400);
});
