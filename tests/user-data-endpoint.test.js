const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'endpoint-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

const { signAccessToken } = require('../api/_lib/auth');
const userData = require('../api/user-data');

function authHeaders(username = 'alice') {
  return { authorization: `Bearer ${signAccessToken({ username })}` };
}

test.beforeEach(() => {
  FakeRedis.reset();
  process.env.KV_REST_API_URL = 'https://redis.invalid';
  process.env.KV_REST_API_TOKEN = 'test-token';
});

test('user-data rejects unauthenticated requests', async () => {
  const res = await invoke(userData, { method: 'GET' });
  assert.equal(res.statusCode, 401);
});

test('user-data returns 400 for missing or non-object data', async () => {
  const missingBody = await invoke(userData, {
    headers: authHeaders(),
    body: undefined,
  });
  assert.equal(missingBody.statusCode, 400);

  const arrayData = await invoke(userData, {
    headers: authHeaders(),
    body: { data: [] },
  });
  assert.equal(arrayData.statusCode, 400);
});

test('user-data fails closed instead of replacing corrupt records', async () => {
  FakeRedis.reset({ 'nf_user_data:alice': '{not-json' });
  const loaded = await invoke(userData, { headers: authHeaders(), method: 'GET' });
  assert.equal(loaded.statusCode, 503);
  assert.equal(loaded.body.code, 'USER_DATA_CORRUPT');

  const saved = await invoke(userData, {
    headers: authHeaders(),
    body: { data: { myBooks: [{ code: '1001' }] } },
  });
  assert.equal(saved.statusCode, 503);
  assert.equal(saved.body.code, 'USER_DATA_CORRUPT');
  assert.equal(FakeRedis.values.get('nf_user_data:alice'), '{not-json');
});

test('user-data preserves server fields and tombstones across stale writes', async () => {
  const now = Date.now();
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({
      points: 50,
      myBooks: [
        { code: '1001', title: 'Delete me' },
        { code: '1002', title: 'Keep me' },
      ],
    }),
  });

  const deleted = await invoke(userData, {
    headers: authHeaders(),
    body: {
      data: {
        points: 999999,
        myBooks: [{ code: '1002', title: 'Keep me' }],
        deletedBooks: { 'code:1001': now },
      },
    },
  });
  assert.equal(deleted.statusCode, 200);

  const staleWrite = await invoke(userData, {
    headers: authHeaders(),
    body: {
      data: {
        points: 0,
        myBooks: [{ code: '1001', title: 'Stale copy' }],
      },
    },
  });
  assert.equal(staleWrite.statusCode, 200);

  const saved = JSON.parse(FakeRedis.values.get('nf_user_data:alice'));
  assert.equal(saved.points, 50);
  assert.deepEqual(saved.myBooks, [{ code: '1002', title: 'Keep me' }]);
  assert.equal(saved.deletedBooks['code:1001'], now);
});

test('client sync cannot forge claimed missions or reward audit history', async () => {
  const originalHistory = [{ action: 'checkin', points_before: 10, points_after: 15 }];
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({
      points: 15,
      claimed: { share1: 12345 },
      reward_history: originalHistory,
    }),
  });

  const response = await invoke(userData, {
    headers: authHeaders(),
    body: {
      data: {
        claimed: { share3: 99999, forged: true },
        reward_history: [{ action: 'forged', points_after: 999999 }],
      },
    },
  });

  assert.equal(response.statusCode, 200);
  const saved = JSON.parse(FakeRedis.values.get('nf_user_data:alice'));
  assert.deepEqual(saved.claimed, { share1: 12345 });
  assert.deepEqual(saved.reward_history, originalHistory);
});
