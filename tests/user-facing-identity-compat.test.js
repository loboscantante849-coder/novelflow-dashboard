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

test('an unreadable duplicate record does not block the account', async () => {
  process.env.VERCEL_ENV = 'production';
  FakeRedis.reset({
    'nf_user_data:eliza_star': 'not-json{',
    'nf_user_data:eliza_stellar': JSON.stringify({ points: 12, myBooks: [{ bookId: 'b', code: '1' }] }),
  });

  const response = await invoke(userData, { method: 'GET', headers: authHeaders() });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.points, 12);
  assert.equal(response.body.data.myBooks.length, 1);
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

test('an established wallet skips the income-source guard on sync', async () => {
  process.env.VERCEL_ENV = 'production';
  const owners = require('../api/_lib/income-source-owners');
  const originalGuard = owners.acquireWalletCreationSourceGuard;
  const calls = [];
  owners.acquireWalletCreationSourceGuard = async (redis, username) => {
    calls.push(username);
    const error = new Error('Wallet identity is not the verified owner of this income source');
    error.code = 'INCOME_SOURCE_OWNER_UNVERIFIED';
    throw error;
  };
  delete require.cache[require.resolve('../api/user-data')];
  const handler = require('../api/user-data');
  try {
    const token = signAccessToken({ type: 'local', username: 'foo.bar' });

    // The account record already exists, so syncing it is the member's own
    // data and the guard must not run at all.
    FakeRedis.reset({ 'nf_user_data:foo.bar': JSON.stringify({ points: 3 }) });
    const existing = await invoke(handler, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { data: { myBooks: [{ bookId: 'b2', code: '2' }] } },
    });
    assert.equal(existing.statusCode, 200, JSON.stringify(existing.body));
    assert.deepEqual(calls, []);

    // A wallet that would be created still goes through the guard.
    FakeRedis.reset({});
    const creating = await invoke(handler, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { data: { myBooks: [{ bookId: 'b3', code: '3' }] } },
    });
    assert.equal(creating.statusCode, 409);
    assert.equal(creating.body.code, 'INCOME_SOURCE_OWNER_UNVERIFIED');
    assert.deepEqual(calls, ['foo.bar']);
  } finally {
    owners.acquireWalletCreationSourceGuard = originalGuard;
    delete require.cache[require.resolve('../api/user-data')];
  }
});

test('the record holding the most history wins over a smaller canonical record', async () => {
  process.env.VERCEL_ENV = 'production';
  // Mirrors the real Eliza_Star shape: three spellings exist and the canonical
  // key holds only a fraction of her books, points and VIP days.
  FakeRedis.reset({
    'nf_user_data:eliza_star': JSON.stringify({ points: 55, myBooks: new Array(35).fill({ bookId: 'b', code: '1' }) }),
    'nf_user_data:eliza_stellar': JSON.stringify({ points: 290, myBooks: new Array(40).fill({ bookId: 'b', code: '2' }) }),
    'nf_user_data:eliza stellar': JSON.stringify({
      points: 725,
      vip_days: 9,
      bind_id: '697816adf3624595557e36c1',
      bind_id_verified_at: '2026-08-21T03:53:28.049Z',
      myBooks: new Array(70).fill({ bookId: 'b', code: '3' }),
    }),
  });

  const response = await invoke(userData, { method: 'GET', headers: authHeaders('eliza stellar') });

  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.points, 725);
  assert.equal(response.body.data.myBooks.length, 70);
  assert.equal(response.body.data.vip_days, 9);
});
