const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'endpoint-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
delete process.env.FEISHU_SIGNUP_WEBHOOK;

const login = require('../api/auth/login');
const me = require('../api/auth/me');
const refresh = require('../api/auth/refresh');
const register = require('../api/auth/register');
const withdrawals = require('../api/withdrawals');
const userData = require('../api/user-data');
const rewards = require('../api/rewards');
const claimLinks = require('../api/claim-links');
const setPassword = require('../api/auth/set-password');
const { signAccessToken, signRefreshToken, verifyJWT } = require('../api/_lib/auth');
const { legacyPasswordHash } = require('../api/_lib/password');

function signRaw(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

test.beforeEach(() => {
  FakeRedis.reset();
  process.env.KV_REST_API_URL = 'https://redis.invalid';
  process.env.KV_REST_API_TOKEN = 'test-token';
});

test('login fails closed when Redis is not configured', async () => {
  delete process.env.KV_REST_API_URL;
  const res = await invoke(login, {
    body: { username: 'alice', password: 'Password1' },
  });

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'Authentication service unavailable');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('login accepts and upgrades a legacy password hash', async () => {
  const legacyHash = legacyPasswordHash('Password1');
  FakeRedis.reset({ 'nf_user_pass:alice': legacyHash });

  const res = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.10' },
    body: { username: 'alice', password: 'Password1' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.headers['set-cookie'].length, 3);
  assert.match(FakeRedis.values.get('nf_user_pass:alice'), /^scrypt\$/);
});

test('legacy user data cannot be claimed without its existing session', async () => {
  const originalData = JSON.stringify({ myBooks: [{ code: '1001' }], points: 25 });
  FakeRedis.reset({ 'nf_user_data:legacy-user': originalData });

  const takeover = await invoke(register, {
    body: { username: 'legacy-user', password: 'Password1' },
  });
  assert.equal(takeover.statusCode, 409);
  assert.equal(takeover.body.code, 'ACCOUNT_RECOVERY_REQUIRED');
  assert.equal(takeover.headers['set-cookie'], undefined);
  assert.equal(FakeRedis.values.has('nf_user_pass:legacy-user'), false);

  const accessToken = signAccessToken({ type: 'local', username: 'legacy-user' });
  const configured = await invoke(register, {
    headers: { cookie: `nf_token=${accessToken}` },
    body: { username: 'legacy-user', password: 'Password1' },
  });
  assert.equal(configured.statusCode, 200);
  assert.equal(FakeRedis.values.get('nf_user_data:legacy-user'), originalData);
  assert.match(FakeRedis.values.get('nf_user_pass:legacy-user'), /^scrypt\$/);
});

test('login also blocks passwordless account takeover without an owner session', async () => {
  FakeRedis.reset({ 'nf_user_data:legacy-user': JSON.stringify({ points: 25 }) });

  const takeover = await invoke(login, {
    body: { username: 'legacy-user', password: 'Password1' },
  });
  assert.equal(takeover.statusCode, 409);
  assert.equal(takeover.body.code, 'ACCOUNT_RECOVERY_REQUIRED');
  assert.equal(FakeRedis.values.has('nf_user_pass:legacy-user'), false);
});

test('username case variants resolve to one password and data identity', async () => {
  const originalData = JSON.stringify({ myBooks: [{ code: '1002' }], points: 30 });
  FakeRedis.reset({ 'nf_user_data:alice': originalData });

  const configured = await invoke(register, {
    headers: { cookie: `nf_token=${signAccessToken({ type: 'local', username: 'alice' })}` },
    body: { username: 'Alice', password: 'Password1' },
  });
  assert.equal(configured.statusCode, 200);
  assert.equal(configured.body.username, 'alice');
  assert.match(FakeRedis.values.get('nf_user_pass:alice'), /^scrypt\$/);
  assert.equal(FakeRedis.values.has('nf_user_pass:Alice'), false);

  const loggedIn = await invoke(login, {
    body: { username: 'ALICE', password: 'Password1' },
  });
  assert.equal(loggedIn.statusCode, 200);
  assert.equal(loggedIn.body.username, 'alice');
  assert.equal(FakeRedis.values.get('nf_user_data:alice'), originalData);
});

test('refresh migrates a previous-secret session to current-secret cookies', async () => {
  const previousSecret = 'previous-endpoint-test-secret-not-used-in-production';
  process.env.JWT_SECRET_PREVIOUS = previousSecret;
  try {
    const now = Math.floor(Date.now() / 1000);
    const previousRefreshToken = signRaw({
      type: 'local',
      username: 'alice',
      _refresh: true,
      iat: now,
      exp: now + 60,
    }, previousSecret);

    const res = await invoke(refresh, {
      headers: { cookie: `nf_refresh=${previousRefreshToken}` },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.headers['set-cookie'].length, 3);

    const accessToken = res.headers['set-cookie'][0].match(/^nf_token=([^;]+)/)[1];
    const refreshToken = res.headers['set-cookie'][1].match(/^nf_refresh=([^;]+)/)[1];
    delete process.env.JWT_SECRET_PREVIOUS;

    assert.equal(verifyJWT(accessToken).username, 'alice');
    assert.equal(verifyJWT(refreshToken)._refresh, true);
  } finally {
    delete process.env.JWT_SECRET_PREVIOUS;
  }
});

test('refresh tokens cannot authenticate access-protected endpoints', async () => {
  const refreshToken = signRefreshToken({ type: 'local', username: 'alice' });
  const bearerHeaders = { authorization: `Bearer ${refreshToken}` };
  const cookieHeaders = { cookie: `nf_token=${refreshToken}` };

  const sync = await invoke(userData, { method: 'GET', headers: bearerHeaders });
  const reward = await invoke(rewards, {
    method: 'POST', headers: bearerHeaders, body: { action: 'checkin' },
  });
  const claim = await invoke(claimLinks, {
    method: 'POST', headers: bearerHeaders, body: { codes: ['10001'] },
  });
  const password = await invoke(setPassword, {
    method: 'POST', headers: cookieHeaders, body: { password: 'Password2' },
  });
  const session = await invoke(me, { method: 'GET', headers: cookieHeaders });

  assert.equal(sync.statusCode, 401);
  assert.equal(reward.statusCode, 401);
  assert.equal(claim.statusCode, 401);
  assert.equal(password.statusCode, 401);
  assert.equal(session.statusCode, 200);
  assert.equal(session.body.loggedIn, false);
});

test('an existing token cannot cross an identity binding', async () => {
  FakeRedis.reset({
    'nf_identity_owner:targetuser': 'discord:discord-target',
    'nf_user_data:targetuser': JSON.stringify({ bonus_balance: 90, myBooks: [{ code: 'private-code' }] }),
  });
  const localToken = signAccessToken({ type: 'local', username: 'targetuser' });

  const sync = await invoke(userData, {
    method: 'GET', headers: { authorization: `Bearer ${localToken}` },
  });
  const session = await invoke(me, {
    method: 'GET', headers: { cookie: `nf_token=${localToken}` },
  });

  assert.equal(sync.statusCode, 409);
  assert.equal(sync.body.code, 'ACCOUNT_IDENTITY_CONFLICT');
  assert.equal(session.statusCode, 409);
  assert.equal(session.body.code, 'ACCOUNT_IDENTITY_CONFLICT');
  assert.equal(session.body.loggedIn, false);
});

test('a Discord owner can explicitly link a password without changing data identity', async () => {
  const discordToken = signAccessToken({
    type: 'discord',
    username: 'discord-owner',
    discordId: 'discord-42',
    principal: 'discord:discord-42',
  });
  FakeRedis.reset({ 'nf_user_data:discord-owner': JSON.stringify({ points: 25 }) });

  const configured = await invoke(setPassword, {
    method: 'POST',
    headers: { cookie: `nf_token=${discordToken}`, 'x-forwarded-for': '192.0.2.90' },
    body: { password: 'Password2' },
  });
  assert.equal(configured.statusCode, 200);
  assert.equal(FakeRedis.values.get('nf_identity_owner:discord-owner'), 'discord:discord-42');
  assert.equal(FakeRedis.values.get('nf_user_pass_owner:discord-owner'), 'discord:discord-42');

  const passwordLogin = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.91' },
    body: { username: 'discord-owner', password: 'Password2' },
  });
  assert.equal(passwordLogin.statusCode, 200);
  const accessToken = passwordLogin.headers['set-cookie'][0].match(/^nf_token=([^;]+)/)[1];
  assert.equal(verifyJWT(accessToken).principal, 'discord:discord-42');
  assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:discord-owner')).points, 25);
});

test('authenticated session reports password status without a public username oracle', async () => {
  const token = signAccessToken({ type: 'local', username: 'alice' });
  FakeRedis.reset({ 'nf_user_pass:alice': legacyPasswordHash('Password1') });
  const protectedAccount = await invoke(me, {
    method: 'GET', headers: { cookie: `nf_token=${token}` },
  });
  assert.equal(protectedAccount.statusCode, 200);
  assert.equal(protectedAccount.body.loggedIn, true);
  assert.equal(protectedAccount.body.hasPassword, true);

  FakeRedis.reset();
  const passwordlessAccount = await invoke(me, {
    method: 'GET', headers: { cookie: `nf_token=${token}` },
  });
  assert.equal(passwordlessAccount.body.hasPassword, false);
});

test('password changes fail closed when user or IP limits are exhausted', async () => {
  const token = signAccessToken({ type: 'local', username: 'alice' });
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({}),
    'nf_rate:set_password:alice': 10,
  });
  const limited = await invoke(setPassword, {
    method: 'POST',
    headers: { cookie: `nf_token=${token}`, 'x-forwarded-for': '192.0.2.50' },
    body: { password: 'Password2' },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal(FakeRedis.values.has('nf_user_pass:alice'), false);
});

test('disabled accounts are rejected by session checks and withdrawals', async () => {
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({ disabled: true, accountType: 'admin', withdrawals: [] }),
  });
  const accessToken = signAccessToken({ type: 'local', username: 'alice' });
  const headers = { cookie: `nf_token=${accessToken}` };

  const session = await invoke(me, { method: 'GET', headers });
  assert.equal(session.statusCode, 403);
  assert.equal(session.body.code, 'ACCOUNT_DISABLED');

  const payout = await invoke(withdrawals, {
    method: 'POST',
    headers,
    body: { amount: 10, payment_account: 'alice@example.com' },
  });
  assert.equal(payout.statusCode, 403);
  assert.equal(payout.body.code, 'ACCOUNT_DISABLED');
});

test('session validation fails closed without clearing cookies during an account-status outage', async () => {
  const accessToken = signAccessToken({ type: 'local', username: 'alice' });
  const refreshToken = signRefreshToken({ type: 'local', username: 'alice' });
  delete process.env.KV_REST_API_URL;

  const session = await invoke(me, {
    method: 'GET',
    headers: { cookie: `nf_token=${accessToken}` },
  });
  assert.equal(session.statusCode, 503);
  assert.equal(session.body.code, 'ACCOUNT_STATUS_UNAVAILABLE');
  assert.equal(session.headers['set-cookie'], undefined);

  const renewed = await invoke(refresh, {
    method: 'POST',
    headers: { cookie: `nf_refresh=${refreshToken}` },
  });
  assert.equal(renewed.statusCode, 503);
  assert.equal(renewed.body.code, 'ACCOUNT_STATUS_UNAVAILABLE');
  assert.equal(renewed.headers['set-cookie'], undefined);
});

test('disabled local accounts cannot receive a fresh login session', async () => {
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({ disabled: true }),
    'nf_user_pass:alice': legacyPasswordHash('Password1'),
  });
  const res = await invoke(login, {
    body: { username: 'alice', password: 'Password1' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'ACCOUNT_DISABLED');
  assert.equal(res.headers['set-cookie'], undefined);

  const registration = await invoke(register, {
    body: { username: 'alice', password: 'Password1' },
  });
  assert.equal(registration.statusCode, 403);
  assert.equal(registration.body.code, 'ACCOUNT_DISABLED');
});

test('Discord disabled checks use the canonical JWT handle', async () => {
  FakeRedis.reset({
    'nf_user_data:discord-handle': JSON.stringify({ disabled: true }),
  });
  const accessToken = signAccessToken({
    type: 'discord',
    username: 'discord-handle',
    globalName: 'Display Name',
  });
  const session = await invoke(me, {
    method: 'GET',
    headers: { cookie: `nf_token=${accessToken}` },
  });
  assert.equal(session.statusCode, 403);
  assert.equal(session.body.code, 'ACCOUNT_DISABLED');
});

test('client sync and rewards respect the shared user-data lock', async () => {
  const username = 'user_data_lock_test';
  FakeRedis.reset({
    [`nf_user_data:${username}`]: JSON.stringify({ bonus_balance: 40, points: 5, withdrawals: [{ id: 'wd_1', amount: 20, status: 'pending' }] }),
    [`nf_withdrawal_lock:${username}`]: 'other-request',
  });
  const accessToken = signAccessToken({ type: 'local', username });
  const headers = { cookie: `nf_token=${accessToken}` };

  const sync = await invoke(userData, {
    method: 'POST', headers, body: { data: { myBooks: [{ bookId: 'book-1' }] } },
  });
  assert.equal(sync.statusCode, 409);
  assert.equal(sync.body.code, 'USER_DATA_BUSY');

  const reward = await invoke(rewards, {
    method: 'POST', headers, body: { action: 'checkin' },
  });
  assert.equal(reward.statusCode, 409);
  assert.equal(reward.body.code, 'USER_DATA_BUSY');

  const saved = JSON.parse(FakeRedis.values.get(`nf_user_data:${username}`));
  assert.equal(saved.withdrawals.length, 1);
  assert.equal(saved.points, 5);
});

test('withdrawal submission is blocked before wallet mutation when rate limited', async () => {
  const username = 'withdraw_rate_test_user';
  FakeRedis.reset({
    [`nf_user_data:${username}`]: JSON.stringify({ bonus_balance: 40, withdrawals: [] }),
    [`nf_rate:withdrawal_submit:${username}`]: 10,
  });
  const accessToken = signAccessToken({ type: 'local', username });
  const response = await invoke(withdrawals, {
    method: 'POST',
    headers: { cookie: `nf_token=${accessToken}`, 'x-forwarded-for': '192.0.2.51' },
    body: {
      amount: 20,
      payment_account: 'withdraw@example.com',
      idempotency_key: 'withdraw-rate-test-0001',
    },
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.body.code, 'RATE_LIMITED');
  const saved = JSON.parse(FakeRedis.values.get(`nf_user_data:${username}`));
  assert.equal(saved.withdrawals.length, 0);
});

test('concurrent withdrawal submissions cannot lose an acknowledged request', async () => {
  const username = 'withdraw_lock_test_user';
  FakeRedis.reset({
    [`nf_user_data:${username}`]: JSON.stringify({ bonus_balance: 40, withdrawals: [] }),
  });
  const accessToken = signAccessToken({ type: 'local', username });
  const request = {
    method: 'POST',
    headers: { cookie: `nf_token=${accessToken}` },
    body: { amount: 20, payment_account: 'alice@example.com', idempotency_key: 'withdraw-lock-test-20260727' },
  };

  const results = await Promise.all([
    invoke(withdrawals, request),
    invoke(withdrawals, request),
  ]);
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
  assert.equal(results.find(result => result.statusCode === 409).body.code, 'WALLET_BUSY');
  assert.equal(results.find(result => result.statusCode === 200).body.available_balance, 20);

  const saved = JSON.parse(FakeRedis.values.get(`nf_user_data:${username}`));
  assert.equal(saved.withdrawals.length, 1);
  assert.equal(saved.withdrawals[0].amount, 20);
  assert.equal(FakeRedis.values.has(`nf_withdrawal_lock:${username}`), false);
});

test('a retried withdrawal request is idempotent across email casing', async () => {
  const username = 'withdraw_retry_test_user';
  FakeRedis.reset({
    [`nf_user_data:${username}`]: JSON.stringify({ bonus_balance: 50, withdrawals: [] }),
  });
  const accessToken = signAccessToken({ type: 'local', username });
  const request = {
    method: 'POST',
    headers: { cookie: `nf_token=${accessToken}` },
    body: {
      amount: 20,
      payment_account: 'Retry@Example.com',
      idempotency_key: 'withdraw-retry-test-20260727',
    },
  };

  const first = await invoke(withdrawals, request);
  const retry = await invoke(withdrawals, {
    ...request,
    body: { ...request.body, payment_account: 'retry@example.com' },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.request_id, first.body.request_id);
  const saved = JSON.parse(FakeRedis.values.get(`nf_user_data:${username}`));
  assert.equal(saved.withdrawals.length, 1);
  assert.equal(saved.withdrawals[0].payment_account, 'retry@example.com');
});

test('withdrawal creation fails closed when the income adjustment cannot be read', async () => {
  const username = 'withdraw_adjustment_test_user';
  FakeRedis.reset({
    [`nf_user_data:${username}`]: JSON.stringify({ bonus_balance: 50, withdrawals: [] }),
  });
  FakeRedis.errorsByKey.set(`nf_admin_income_adjustment:${username}`, new Error('temporary Redis failure'));
  const accessToken = signAccessToken({ type: 'local', username });
  const res = await invoke(withdrawals, {
    method: 'POST',
    headers: { cookie: `nf_token=${accessToken}` },
    body: {
      amount: 20,
      payment_account: 'adjustment@example.com',
      idempotency_key: 'withdraw-adjustment-test-20260727',
    },
  });

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'INCOME_ADJUSTMENT_UNAVAILABLE');
  const saved = JSON.parse(FakeRedis.values.get(`nf_user_data:${username}`));
  assert.equal(saved.withdrawals.length, 0);
  assert.equal(FakeRedis.values.has(`nf_withdrawal_lock:${username}`), false);
});

test('wallet mutations never replace a corrupt user record', async () => {
  const username = 'withdraw_corrupt_test_user';
  FakeRedis.reset({ [`nf_user_data:${username}`]: '{not-json' });
  const accessToken = signAccessToken({ type: 'local', username });
  const response = await invoke(withdrawals, {
    method: 'POST',
    headers: { cookie: `nf_token=${accessToken}` },
    body: {
      amount: 20,
      payment_account: 'corrupt@example.com',
      idempotency_key: 'withdraw-corrupt-test-20260801',
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'WALLET_DATA_CORRUPT');
  assert.equal(FakeRedis.values.get(`nf_user_data:${username}`), '{not-json');
});

test('register rejects reserved new usernames', async () => {
  const res = await invoke(register, {
    body: { username: 'Admin', password: 'Password1' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'This username is not available');
  assert.equal(FakeRedis.values.has('nf_user_pass:Admin'), false);
});

test('register rejects the unmapped system income bucket', async () => {
  const res = await invoke(register, {
    body: { username: '_unmapped', password: 'Password1' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'This username is not available');
  assert.equal(FakeRedis.values.has('nf_user_pass:_unmapped'), false);
});

test('brand new accounts cannot claim a protected promoter identity', async () => {
  const res = await invoke(register, {
    body: { username: 'tom', password: 'Password1' },
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'PROMOTER_RECOVERY_REQUIRED');
  assert.equal(FakeRedis.values.has('nf_user_pass:tom'), false);
});
