const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'reward-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
const tokenPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
process.env.NOVELSPA_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${tokenPayload}.test-signature`;
delete process.env.OIDC_USERNAME;
delete process.env.OIDC_PASSWORD;

const { signAccessToken } = require('../api/_lib/auth');
const rewards = require('../api/rewards');
const { bindNovelFlowMember, bindingMemberKey, bindingUserKey } = require('../api/_lib/vip-entitlements');

function authHeaders(username = 'zoe') {
  return {
    authorization: `Bearer ${signAccessToken({ type: 'local', username })}`,
    'x-forwarded-for': '192.0.2.77',
  };
}

function mockMemberLookup() {
  global.fetch = async url => {
    const requested = new URL(String(url)).searchParams.get('userId');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 200, data: { data: [{
        applicationId: '642fc1ace309494378a774a6', userId: requested,
      }] } }),
    };
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

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ code: 200, data: { data: [{
      applicationId: '642fc1ace309494378a774a6', userId: '67e519c3da10a5c772ca196e',
    }] } }),
  });
  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: 'bind_id', bind_id: '67e519c3da10a5c772ca196e' },
  });
  global.fetch = originalFetch;

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

test('client-created books cannot satisfy promotion missions', async () => {
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({
      points: 0,
      myBooks: [
        { code: 'fake-1', bookId: 'book-1' },
        { code: 'fake-2', bookId: 'book-2' },
        { code: 'fake-3', bookId: 'book-3' },
      ],
    }),
  });

  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: 'claim_mission', missionId: 'share3' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'NOT_ELIGIBLE');
  assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:zoe')).points, 0);
});

test('server-indexed promotions satisfy promotion missions', async () => {
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({ points: 0 }),
    'nf_user_subs:zoe': ['code-1', 'code-2', 'code-3'],
    nf_subs: {
      'code-1': JSON.stringify({ code: 'code-1', bookId: 'book-1', status: 'completed' }),
      'code-2': JSON.stringify({ code: 'code-2', bookId: 'book-2', status: 'completed' }),
      'code-3': JSON.stringify({ code: 'code-3', bookId: 'book-3', status: 'completed' }),
    },
  });

  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: 'claim_mission', missionId: 'share3' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.points_awarded, 50);
  assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:zoe')).points, 50);
});

test('failed, foreign, and assetless submissions cannot satisfy promotion missions', async () => {
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({ points: 0 }),
    'nf_user_subs:zoe': ['failed-code', 'assetless', 'foreign-code'],
    nf_subs: {
      'failed-code': JSON.stringify({ code: 'failed-code', bookId: 'book-1', status: 'failed' }),
      assetless: JSON.stringify({ bookId: 'book-2', status: 'completed' }),
      'foreign-code': JSON.stringify({ code: 'foreign-code', bookId: 'book-3', status: 'completed', username: 'other-user' }),
    },
  });

  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: 'claim_mission', missionId: 'share1' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'NOT_ELIGIBLE');
  assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:zoe')).points, 0);
});

test('NovelFlow member binding atomically enforces one dashboard account per App ID', async () => {
  const redis = new FakeRedis();
  const member = { user_id: '67e519c3da10a5c772ca196e', application_id: '642fc1ace309494378a774a6' };
  const results = await Promise.allSettled([
    bindNovelFlowMember(redis, 'alice', member),
    bindNovelFlowMember(redis, 'bob', member),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = await redis.get(bindingMemberKey(member.user_id));
  assert.ok(['alice', 'bob'].includes(winner));
  assert.equal(JSON.parse(await redis.get(bindingUserKey(winner))).user_id, member.user_id);
  const loser = winner === 'alice' ? 'bob' : 'alice';
  assert.equal(await redis.get(bindingUserKey(loser)), null);
});

test('concurrent App ID choices cannot leave an orphan reverse binding', async () => {
  const redis = new FakeRedis();
  const first = { user_id: '67e519c3da10a5c772ca196e', application_id: '642fc1ace309494378a774a6' };
  const second = { user_id: '67e519c3da10a5c772ca196f', application_id: '642fc1ace309494378a774a6' };
  const results = await Promise.allSettled([
    bindNovelFlowMember(redis, 'alice', first),
    bindNovelFlowMember(redis, 'alice', second),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const saved = JSON.parse(await redis.get(bindingUserKey('alice')));
  assert.equal(await redis.get(bindingMemberKey(saved.user_id)), 'alice');
  const losingId = saved.user_id === first.user_id ? second.user_id : first.user_id;
  assert.equal(await redis.get(bindingMemberKey(losingId)), null);
});

test('VIP exchange commits the point deduction and entitlement in one Redis mutation', async () => {
  const originalFetch = global.fetch;
  mockMemberLookup();
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({ points: 1000, bind_id: '67e519c3da10a5c772ca196e' }),
  });
  try {
    const response = await invoke(rewards, {
      headers: authHeaders(),
      body: { action: 'exchange_vip' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:zoe')).points, 0);
    const event = JSON.parse(FakeRedis.values.get(`nf_vip_event:v1:${response.body.vip_event_id}`));
    assert.equal(event.status, 'pending');
    assert.equal(event.days, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a failed atomic VIP commit leaves both points and the entitlement unchanged', async () => {
  const originalFetch = global.fetch;
  const originalEval = FakeRedis.prototype.eval;
  mockMemberLookup();
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({ points: 1000, bind_id: '67e519c3da10a5c772ca196e' }),
  });
  FakeRedis.prototype.eval = async function evalWithFailure(script, keys, args) {
    if (String(script).includes('NF_VIP_USER_DATA_COMMIT_V1')) throw new Error('simulated atomic commit failure');
    return originalEval.call(this, script, keys, args);
  };
  try {
    const response = await invoke(rewards, {
      headers: authHeaders(),
      body: { action: 'exchange_vip' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:zoe')).points, 1000);
    assert.equal(Array.from(FakeRedis.values.keys()).some(key => key.startsWith('nf_vip_event:v1:')), false);
  } finally {
    FakeRedis.prototype.eval = originalEval;
    global.fetch = originalFetch;
  }
});

test('a failed streak-grand commit leaves the bonus, claim marker, and entitlement unchanged', async () => {
  const originalFetch = global.fetch;
  const originalEval = FakeRedis.prototype.eval;
  mockMemberLookup();
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({
      points: 50,
      bonus_balance: 4,
      bind_id: '67e519c3da10a5c772ca196e',
      checkin: { streak: 7, lastCheckin: '2026-08-11', history: [] },
      claimed: { share1: 1 },
    }),
    'nf_user_subs:zoe': ['verified-code'],
    nf_subs: { 'verified-code': JSON.stringify({ code: 'verified-code', bookId: 'verified-book', status: 'completed' }) },
  });
  FakeRedis.prototype.eval = async function evalWithFailure(script, keys, args) {
    if (String(script).includes('NF_VIP_USER_DATA_COMMIT_V1')) throw new Error('simulated atomic commit failure');
    return originalEval.call(this, script, keys, args);
  };
  try {
    const response = await invoke(rewards, {
      headers: authHeaders(),
      body: { action: 'claim_streak_grand' },
    });
    assert.equal(response.statusCode, 503);
    const saved = JSON.parse(FakeRedis.values.get('nf_user_data:zoe'));
    assert.equal(saved.bonus_balance, 4);
    assert.equal(saved.streak_grand_claimed, undefined);
    assert.equal(Array.from(FakeRedis.values.keys()).some(key => key.startsWith('nf_vip_event:v1:')), false);
  } finally {
    FakeRedis.prototype.eval = originalEval;
    global.fetch = originalFetch;
  }
});

test('the 7-day streak grand prize can be claimed again after a seven-day cooldown', async () => {
  const originalFetch = global.fetch;
  mockMemberLookup();
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({
      points: 50,
      bonus_balance: 4,
      bind_id: '67e519c3da10a5c772ca196e',
      checkin: { streak: 7, lastCheckin: new Date().toISOString().slice(0, 10), history: [] },
      claimed: { share1: 1 },
      streak_grand_claimed: new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString(),
      streak_grand_sequence: 1,
    }),
    'nf_user_subs:zoe': ['verified-code'],
    nf_subs: { 'verified-code': JSON.stringify({ code: 'verified-code', bookId: 'verified-book', status: 'completed' }) },
  });
  try {
    const response = await invoke(rewards, {
      headers: authHeaders(),
      body: { action: 'claim_streak_grand' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.vip_days_awarded, 2);
    const saved = JSON.parse(FakeRedis.values.get('nf_user_data:zoe'));
    assert.equal(saved.streak_grand_sequence, 2);
    assert.ok(Date.parse(saved.streak_grand_claimed) > Date.now() - 60000);
    assert.equal(JSON.parse(FakeRedis.values.get(`nf_vip_event:v1:${response.body.vip_event_id}`)).source_id, '2');
  } finally {
    global.fetch = originalFetch;
  }
});

test('the 7-day streak grand prize rejects a second claim during its cooldown', async () => {
  FakeRedis.reset({
    'nf_user_data:zoe': JSON.stringify({
      checkin: { streak: 7, lastCheckin: new Date().toISOString().slice(0, 10), history: [] },
      claimed: { share1: 1 },
      streak_grand_claimed: new Date().toISOString(),
    }),
    'nf_user_subs:zoe': ['verified-code'],
    nf_subs: { 'verified-code': JSON.stringify({ code: 'verified-code', bookId: 'verified-book', status: 'completed' }) },
  });
  const response = await invoke(rewards, {
    headers: authHeaders(),
    body: { action: 'claim_streak_grand' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'STREAK_GRAND_COOLDOWN');
  assert.ok(Date.parse(response.body.available_at) > Date.now());
});
