const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'user-facing-identity-test-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

const { signAccessToken } = require('../api/_lib/auth');
const userData = require('../api/user-data');
const rewards = require('../api/rewards');

function authHeaders(username = 'eliza_star') {
  return {
    authorization: `Bearer ${signAccessToken({ type: 'local', username })}`,
    'x-forwarded-for': '192.0.2.15',
  };
}

function conflictingWallets() {
  return {
    // The canonical key is an empty stub; the member's real data lives under
    // the historical spelling. Picking the data-bearing record is what keeps
    // books, points and streak visible instead of showing an empty wallet.
    'nf_user_data:eliza_star': JSON.stringify({}),
    'nf_user_data:eliza_stellar': JSON.stringify({
      points: 40,
      checkin: { streak: 1, lastCheckin: '2026-09-01', history: ['2026-09-01'] },
      myBooks: [{ bookId: 'book-1', code: '1234', title: 'Kept Book' }],
    }),
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  process.env.KV_REST_API_URL = 'https://redis.invalid';
  process.env.KV_REST_API_TOKEN = 'test-token';
  delete process.env.VERCEL_ENV;
});

test.after(() => {
  delete process.env.VERCEL_ENV;
});

test('production cloud sync reads the data-bearing wallet instead of failing', async () => {
  process.env.VERCEL_ENV = 'production';
  FakeRedis.reset(conflictingWallets());

  const response = await invoke(userData, { method: 'GET', headers: authHeaders() });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.exists, true);
  assert.equal(response.body.data.points, 40);
  assert.equal(response.body.data.myBooks.length, 1);
});

test('production cloud sync writes the data-bearing wallet instead of failing', async () => {
  process.env.VERCEL_ENV = 'production';
  FakeRedis.reset(conflictingWallets());

  const response = await invoke(userData, {
    method: 'POST',
    headers: authHeaders(),
    body: { data: { points: 41 } },
  });

  assert.equal(response.statusCode, 200);
  const saved = JSON.parse(FakeRedis.values.get('nf_user_data:eliza_stellar'));
  // Server-managed reward state is preserved; the sync still lands on the
  // data-bearing record instead of the empty canonical stub.
  assert.equal(saved.points, 40);
  assert.equal(saved.myBooks.length, 1);
  assert.ok(saved.lastSyncAt > 0);
  assert.equal(FakeRedis.values.get('nf_user_data:eliza_star'), JSON.stringify({}));
});

test('production check-in works while a historical duplicate wallet exists', async () => {
  process.env.VERCEL_ENV = 'production';
  FakeRedis.reset(conflictingWallets());

  const response = await invoke(rewards, {
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'checkin' },
  });

  assert.equal(response.statusCode, 200);
  const saved = JSON.parse(FakeRedis.values.get('nf_user_data:eliza_stellar'));
  assert.ok(saved.checkin.lastCheckin >= '2026-09-02');
  assert.ok(saved.points > 40);
});

test('a disabled duplicate wallet still blocks the account', async () => {
  process.env.VERCEL_ENV = 'production';
  FakeRedis.reset({
    'nf_user_data:eliza_star': JSON.stringify({ points: 5 }),
    'nf_user_data:eliza_stellar': JSON.stringify({ points: 9, disabled: true }),
  });

  const response = await invoke(rewards, {
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'checkin' },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'WALLET_IDENTITY_CONFLICT');
});

test('a conflicting identity owner index is tolerated in production only', async () => {
  const ownerRecords = {
    'nf_user_data:eliza_star': JSON.stringify({ points: 5 }),
    'nf_identity_owner:eliza_star': 'discord:999999999999999999',
  };

  FakeRedis.reset(ownerRecords);
  const strict = await invoke(userData, { method: 'GET', headers: authHeaders() });
  assert.equal(strict.statusCode, 409);
  assert.equal(strict.body.code, 'ACCOUNT_IDENTITY_CONFLICT');

  process.env.VERCEL_ENV = 'production';
  FakeRedis.reset(ownerRecords);
  const compatible = await invoke(userData, { method: 'GET', headers: authHeaders() });
  assert.equal(compatible.statusCode, 200);
  assert.equal(compatible.body.data.points, 5);
});
