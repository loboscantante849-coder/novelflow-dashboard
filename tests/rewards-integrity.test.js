const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'reward-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

const { signAccessToken } = require('../api/_lib/auth');
const rewards = require('../api/rewards');

function authHeaders(username = 'zoe') {
  return {
    authorization: `Bearer ${signAccessToken({ type: 'local', username })}`,
    'x-forwarded-for': '192.0.2.77',
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  process.env.KV_REST_API_URL = 'https://redis.invalid';
  process.env.KV_REST_API_TOKEN = 'test-token';
});

test('successful reward mutations append an auditable before/after record', async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({
      points: 690,
      checkin: { streak: 4, lastCheckin: yesterday, history: [yesterday] },
    }),
  });

  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: 'checkin' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.snapshot.points, 695);
  assert.equal(response.body.snapshot.checkin.streak, 5);

  const saved = JSON.parse(FakeRedis.values.get('nf_user_data:zoe'));
  assert.equal(saved.reward_history.length, 1);
  assert.deepEqual({
    action: saved.reward_history[0].action,
    points_before: saved.reward_history[0].points_before,
    points_after: saved.reward_history[0].points_after,
    points_delta: saved.reward_history[0].points_delta,
    streak_before: saved.reward_history[0].streak_before,
    streak_after: saved.reward_history[0].streak_after,
  }, {
    action: 'checkin',
    points_before: 690,
    points_after: 695,
    points_delta: 5,
    streak_before: 4,
    streak_after: 5,
  });
  assert.ok(!Number.isNaN(Date.parse(saved.reward_history[0].timestamp)));
});

test('reward history retains only the latest 100 entries', async () => {
  const oldHistory = Array.from({ length: 100 }, (_, index) => ({ action: `old-${index}`, timestamp: new Date(0).toISOString() }));
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({ points: 10, reward_history: oldHistory }),
  });

  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: 'bind_id', bind_id: 'zoe-reader-1' },
  });

  assert.equal(response.statusCode, 200);
  const saved = JSON.parse(FakeRedis.values.get('nf_user_data:zoe'));
  assert.equal(saved.reward_history.length, 100);
  assert.equal(saved.reward_history[0].action, 'old-1');
  assert.equal(saved.reward_history.at(-1).action, 'bind_id');
});

test('reward endpoint rejects malformed actions before mutation', async () => {
  FakeRedis.reset({ 'nf_user_data:zoe': JSON.stringify({ points: 690 }) });

  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: { unexpected: true } },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'INVALID_ACTION');
  assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:zoe')).points, 690);
});

test('reward mutations never replace a corrupt user record', async () => {
  FakeRedis.reset({ 'nf_user_data:zoe': '{not-json' });
  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: 'bind_id', bind_id: 'zoe-reader-1' },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'USER_DATA_CORRUPT');
  assert.equal(FakeRedis.values.get('nf_user_data:zoe'), '{not-json');
});

test('reward endpoint repairs malformed legacy check-in and claimed state', async () => {
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({ points: 690, checkin: 'broken', claimed: [] }),
  });

  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: 'checkin' },
  });

  assert.equal(response.statusCode, 200);
  const saved = JSON.parse(FakeRedis.values.get('nf_user_data:zoe'));
  assert.equal(saved.points, 695);
  assert.equal(saved.checkin.streak, 1);
  assert.deepEqual(saved.claimed, {});
  assert.equal(saved.reward_history.length, 1);
});
