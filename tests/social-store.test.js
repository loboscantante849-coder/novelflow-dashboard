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

test('social storage bridge supports signed atomic counter deltas', async () => {
  FakeRedis.reset({ 'nf_social:video_day:20260904': '4' });
  const incremented = await invoke(socialStore, {
    headers: { authorization: 'Bearer test-social-store-secret' },
    body: { op: 'incrby', args: { key: 'nf_social:video_day:20260904', amount: 3 } }
  });
  assert.equal(incremented.statusCode, 200);
  assert.equal(incremented.body.result, 7);

  const released = await invoke(socialStore, {
    headers: { authorization: 'Bearer test-social-store-secret' },
    body: { op: 'incrby', args: { key: 'nf_social:video_day:20260904', amount: -2 } }
  });
  assert.equal(released.statusCode, 200);
  assert.equal(released.body.result, 5);

  const malformed = await invoke(socialStore, {
    headers: { authorization: 'Bearer test-social-store-secret' },
    body: { op: 'incrby', args: { key: 'nf_social:video_day:20260904', amount: 0.5 } }
  });
  assert.equal(malformed.statusCode, 400);
});

test('social storage bridge supports bounded signed counter increments', async () => {
  const increment = await invoke(socialStore, {
    headers: { authorization: 'Bearer test-social-store-secret' },
    body: { op: 'incrby', args: { key: 'nf_social:ac_points:20260904', amount: 7 } }
  });
  assert.equal(increment.statusCode, 200);
  assert.equal(increment.body.result, 7);

  const decrement = await invoke(socialStore, {
    headers: { authorization: 'Bearer test-social-store-secret' },
    body: { op: 'incrby', args: { key: 'nf_social:ac_points:20260904', amount: -2 } }
  });
  assert.equal(decrement.statusCode, 200);
  assert.equal(decrement.body.result, 5);

  const oversized = await invoke(socialStore, {
    headers: { authorization: 'Bearer test-social-store-secret' },
    body: { op: 'incrby', args: { key: 'nf_social:ac_points:20260904', amount: 1001 } }
  });
  assert.equal(oversized.statusCode, 400);
});
