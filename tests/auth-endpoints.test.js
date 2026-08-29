const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'endpoint-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
delete process.env.FEISHU_SIGNUP_WEBHOOK;

const statsData = require('../api/_lib/stats-data');
statsData.getAdIdDetails = async () => require('../ad_id_details.json');
statsData.getLiveAdIdDetails = statsData.getAdIdDetails;

const login = require('../api/auth/login');
const logout = require('../api/auth/logout');
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

test('logout only accepts POST and clears the auth cookies', async () => {
  const crossSiteNavigation = await invoke(logout, { method: 'GET' });
  assert.equal(crossSiteNavigation.statusCode, 405);
  assert.equal(crossSiteNavigation.headers['set-cookie'], undefined);

  const preflight = await invoke(logout, {
    method: 'OPTIONS',
    headers: { origin: 'https://novelflow.top' },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-methods'], 'POST, OPTIONS');
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true');

  const response = await invoke(logout, { method: 'POST' });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['set-cookie'].length, 3);
});

test('login and register return generic 503 responses when lock or status reads fail', async () => {
  const cases = [
    {
      name: 'login lock',
      handler: login,
      key: 'nf_login_lock:192.0.2.240',
      seed: { 'nf_user_pass:alice': legacyPasswordHash('Password1') },
      expectedCode: 'ACCOUNT_STATUS_UNAVAILABLE',
      body: { username: 'alice', password: 'Password1' },
    },
    {
      name: 'login account data',
      handler: login,
      key: 'nf_user_data:alice',
      seed: { 'nf_user_pass:alice': legacyPasswordHash('Password1') },
      expectedCode: 'ACCOUNT_STATUS_UNAVAILABLE',
      body: { username: 'alice', password: 'Password1' },
    },
    {
      name: 'register lock',
      handler: register,
      key: 'nf_login_lock:alice',
      seed: {},
      expectedCode: 'ACCOUNT_STATUS_UNAVAILABLE',
      body: { username: 'alice', password: 'Password1' },
    },
    {
      name: 'register account data',
      handler: register,
      key: 'nf_user_data:alice',
      seed: {},
      expectedCode: 'ACCOUNT_STATUS_UNAVAILABLE',
      body: { username: 'alice', password: 'Password1' },
    },
  ];
  for (const scenario of cases) {
    FakeRedis.reset(scenario.seed);
    FakeRedis.errorsByKey.set(scenario.key, new Error(`${scenario.name} unavailable`));
    const response = await invoke(scenario.handler, {
      headers: { 'x-forwarded-for': '192.0.2.240' },
      body: scenario.body,
    });
    assert.equal(response.statusCode, 503, scenario.name);
    assert.equal(response.body.code, scenario.expectedCode, scenario.name);
    assert.doesNotMatch(JSON.stringify(response.body), /lock unavailable|account data unavailable|redis|upstash/i, scenario.name);
  }
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

test('unknown public login names cannot trigger legacy case-variant scans', async () => {
  FakeRedis.reset();
  const originalScan = FakeRedis.prototype.scan;
  let scans = 0;
  FakeRedis.prototype.scan = async function guardedScan(...args) {
    scans += 1;
    return originalScan.apply(this, args);
  };
  try {
    const response = await invoke(login, {
      headers: { 'x-forwarded-for': '192.0.2.149' },
      body: { username: 'unlisted_case_scan_probe', password: 'Password1' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(scans, 0);
  } finally {
    FakeRedis.prototype.scan = originalScan;
  }
});

test('a protected canonical sign-in finds one case-variant legacy credential and wallet without creating duplicates', async () => {
  const originalData = JSON.stringify({ bonus_balance: 0.5, points: 160, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_pass:Xenomorphette': legacyPasswordHash('Password1'),
    'nf_user_data:Xenomorphette': originalData,
  });

  const response = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.150' },
    body: { username: 'xenomorphette', password: 'Password1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.username, 'xenomorphette');
  assert.equal(FakeRedis.values.get('nf_user_data:Xenomorphette'), originalData);
  assert.equal(FakeRedis.values.has('nf_user_data:xenomorphette'), false);
  assert.match(FakeRedis.values.get('nf_user_pass:Xenomorphette'), /^scrypt\$/);
  assert.equal(FakeRedis.values.has('nf_user_pass:xenomorphette'), false);
});

test('auth/me keeps an authenticated case-variant legacy session usable and reports its password state', async () => {
  const originalData = JSON.stringify({ bonus_balance: 0.5, points: 160, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_pass:Xenomorphette': legacyPasswordHash('Password1'),
    'nf_user_data:Xenomorphette': originalData,
  });
  const accessToken = signAccessToken({ type: 'local', username: 'xenomorphette' });

  const response = await invoke(me, {
    method: 'GET',
    headers: { cookie: `nf_token=${accessToken}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.loggedIn, true);
  assert.equal(response.body.username, 'xenomorphette');
  assert.equal(response.body.hasPassword, true);
  assert.equal(response.body.passwordRecoveryRequired, false);
  assert.equal(FakeRedis.values.get('nf_user_data:Xenomorphette'), originalData);
  assert.equal(FakeRedis.values.has('nf_user_data:xenomorphette'), false);
});

test('auth/me and refresh fail closed when case-variant wallets conflict', async () => {
  FakeRedis.reset({
    'nf_user_data:xenomorphette': JSON.stringify({ bonus_balance: 0.5 }),
    'nf_user_data:Xenomorphette': JSON.stringify({ bonus_balance: 1 }),
  });
  const accessToken = signAccessToken({ type: 'local', username: 'xenomorphette' });
  const refreshToken = signRefreshToken({ type: 'local', username: 'xenomorphette' });

  const status = await invoke(me, {
    method: 'GET',
    headers: { cookie: `nf_token=${accessToken}` },
  });
  assert.equal(status.statusCode, 409);
  assert.equal(status.body.loggedIn, false);
  assert.equal(status.body.code, 'WALLET_IDENTITY_CONFLICT');
  assert.equal(status.headers['set-cookie'].length, 3);

  const refreshed = await invoke(refresh, {
    headers: { cookie: `nf_refresh=${refreshToken}` },
  });
  assert.equal(refreshed.statusCode, 409);
  assert.equal(refreshed.body.code, 'WALLET_IDENTITY_CONFLICT');
  assert.equal(refreshed.headers['set-cookie'].length, 3);
});

test('matching case-variant credentials are consolidated only after the supplied password verifies every record', async () => {
  const originalData = JSON.stringify({ myBooks: [{ code: '5563' }], points: 30 });
  const legacyHash = legacyPasswordHash('Password1');
  FakeRedis.reset({
    'nf_user_pass:alice': legacyHash,
    'nf_user_pass:Alice': legacyHash,
    'nf_user_data:alice': originalData,
  });

  const response = await invoke(login, {
    body: { username: 'Alice', password: 'Password1' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.username, 'alice');
  assert.match(FakeRedis.values.get('nf_user_pass:alice'), /^scrypt\$/);
  assert.equal(FakeRedis.values.has('nf_user_pass:Alice'), false);
  assert.equal(FakeRedis.values.get('nf_user_data:alice'), originalData);
});

test('different duplicate credentials remain blocked and are not consolidated', async () => {
  const firstHash = legacyPasswordHash('Password1');
  const secondHash = legacyPasswordHash('Password2');
  FakeRedis.reset({
    'nf_user_pass:alice': firstHash,
    'nf_user_pass:Alice': secondHash,
  });

  const response = await invoke(login, {
    body: { username: 'Alice', password: 'Password1' },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'ACCOUNT_CREDENTIAL_CONFLICT');
  assert.equal(FakeRedis.values.get('nf_user_pass:alice'), firstHash);
  assert.equal(FakeRedis.values.get('nf_user_pass:Alice'), secondHash);
});

test('protected historical promoters require support even without a recovery proof', async () => {
  const response = await invoke(register, {
    body: { username: 'Ndidii2000', password: 'Password1' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'SUPPORT_RECOVERY_REQUIRED');
  assert.equal(FakeRedis.values.has('nf_user_pass:ndidi2000'), false);
});

test('passwordless protected promoter data also routes unauthenticated recovery to support', async () => {
  FakeRedis.reset({
    'nf_user_data:ndidi2000': JSON.stringify({ myBooks: [{ code: '5563' }] }),
  });
  const response = await invoke(register, {
    body: { username: 'Ndidii2000', password: 'Password1' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'SUPPORT_RECOVERY_REQUIRED');
  assert.equal(FakeRedis.values.has('nf_user_pass:ndidi2000'), false);
});

test('legacy recovery proof is rejected before any register Redis access or mutation', async () => {
  const originalPasswordHash = legacyPasswordHash('ForgottenPassword1');
  const originalData = JSON.stringify({ bonus_balance: 42.5, myBooks: [{ code: '4722' }] });
  FakeRedis.reset({
    'nf_user_pass:英语': originalPasswordHash,
    'nf_user_data:英语': originalData,
    'nf_login_ip:192.0.2.203': 10,
    'nf_login_lock:英语': '1',
  });
  FakeRedis.expiries.set('nf_login_ip:192.0.2.203', 900);
  FakeRedis.expiries.set('nf_login_lock:英语', 900);
  const before = new Map(FakeRedis.values);

  const response = await invoke(register, {
    headers: { 'x-forwarded-for': '192.0.2.203' },
    body: {
      username: '英语',
      password: 'Password2',
      legacy_recovery: {
        promotion_code: '4722',
        promotion_link: 'https://social.novelplatform.vip/s/75RNsI',
      },
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'SUPPORT_RECOVERY_REQUIRED');
  assert.deepEqual(new Map(FakeRedis.values), before);
});

test('legacy recovery proof is rejected before any login Redis access or mutation', async () => {
  const originalPasswordHash = legacyPasswordHash('ForgottenPassword1');
  FakeRedis.reset({
    'nf_user_pass:英语': originalPasswordHash,
    'nf_user_data:英语': JSON.stringify({ bonus_balance: 20 }),
    'nf_login_lock:192.0.2.205': '1',
    'nf_login_fail:192.0.2.205': 5,
  });
  FakeRedis.expiries.set('nf_login_lock:192.0.2.205', 900);
  const before = new Map(FakeRedis.values);

  const response = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.205' },
    body: {
      username: '英语',
      password: 'Password2',
      legacy_recovery: {
        promotion_code: '4722',
        promotion_link: 'https://social.novelplatform.vip/s/75RNsI',
      },
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'SUPPORT_RECOVERY_REQUIRED');
  assert.deepEqual(new Map(FakeRedis.values), before);
});

test('Cons Espher login spellings resolve to the established local account without wallet mutation', async () => {
  const originalData = JSON.stringify({ bonus_balance: 8.62, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_pass:@cons espher': legacyPasswordHash('Password1'),
    'nf_user_pass:constance.espher': legacyPasswordHash('Password2'),
    'nf_user_data:cons_espher': originalData,
  });

  const attempts = [
    { handler: login, username: 'Cons Espher', ip: '192.0.2.151' },
    { handler: login, username: '@cons_espher', ip: '192.0.2.152' },
    { handler: register, username: 'cons_espher', ip: '192.0.2.153' },
  ];
  let accessToken = null;
  for (const attempt of attempts) {
    const response = await invoke(attempt.handler, {
      headers: { 'x-forwarded-for': attempt.ip },
      body: { username: attempt.username, password: 'Password1' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.username, 'cons_espher');
    accessToken = response.headers['set-cookie'][0].match(/^nf_token=([^;]+)/)[1];
  }

  const status = await invoke(me, {
    method: 'GET',
    headers: { cookie: `nf_token=${accessToken}` },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.hasPassword, true);
  assert.equal(status.body.passwordRecoveryRequired, false);

  const changed = await invoke(setPassword, {
    headers: { cookie: `nf_token=${accessToken}` },
    body: { oldPassword: 'Password1', password: 'Password3' },
  });
  assert.equal(changed.statusCode, 200);

  const relogin = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.154' },
    body: { username: 'Cons Espher', password: 'Password3' },
  });
  assert.equal(relogin.statusCode, 200);
  assert.equal(relogin.body.username, 'cons_espher');

  assert.equal(FakeRedis.values.get('nf_user_data:cons_espher'), originalData);
  assert.equal(FakeRedis.values.has('nf_user_data:cons espher'), false);
  assert.equal(FakeRedis.values.has('nf_user_data:@cons_espher'), false);
  assert.equal(FakeRedis.values.has('nf_user_pass:cons espher'), false);
  assert.equal(FakeRedis.values.has('nf_user_pass:@cons_espher'), false);
  assert.equal(FakeRedis.values.has('nf_user_pass:cons_espher'), false);
  assert.match(FakeRedis.values.get('nf_user_pass:@cons espher'), /^scrypt\$/);
  assert.equal(FakeRedis.values.get('nf_user_pass:constance.espher'), legacyPasswordHash('Password2'));
  assert.equal(FakeRedis.values.get('nf_identity_owner:cons_espher'), 'local:cons_espher');
  assert.equal(FakeRedis.values.get('nf_identity_owner:@cons espher'), 'local:cons_espher');
  assert.equal(FakeRedis.values.get('nf_user_pass_owner:@cons espher'), 'local:cons_espher');
});

test('Cons legacy proof recovery requires support and leaves all aliases unchanged', async () => {
  const canonicalHash = legacyPasswordHash('ForgottenPassword1');
  const aliasHash = legacyPasswordHash('ForgottenPassword2');
  const wallet = JSON.stringify({ bonus_balance: 16.75 });
  FakeRedis.reset({
    'nf_user_pass:cons_espher': canonicalHash,
    'nf_user_pass:@cons espher': aliasHash,
    'nf_user_data:cons_espher': wallet,
  });
  const before = new Map(FakeRedis.values);

  const response = await invoke(register, {
    headers: { 'x-forwarded-for': '192.0.2.160' },
    body: {
      username: 'Cons Espher',
      password: 'Password4',
      legacy_recovery: {
        promotion_code: '4630',
        promotion_link: 'https://social.novelplatform.vip/s/8t6s8v',
      },
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'SUPPORT_RECOVERY_REQUIRED');
  assert.deepEqual(new Map(FakeRedis.values), before);
});

test('a disabled duplicate Cons wallet blocks every session entry point', async () => {
  const seed = () => ({
    'nf_user_pass:@cons espher': legacyPasswordHash('Password1'),
    'nf_user_data:cons_espher': JSON.stringify({ bonus_balance: 8.62 }),
    'nf_user_data:@cons espher': JSON.stringify({ bonus_balance: 3.14, disabled: true }),
    'nf_identity_owner:cons_espher': 'local:cons_espher',
    'nf_identity_owner:@cons espher': 'local:cons_espher',
  });

  FakeRedis.reset(seed());
  const loginResponse = await invoke(login, {
    body: { username: 'Cons Espher', password: 'Password1' },
  });
  assert.equal(loginResponse.statusCode, 403);
  assert.equal(loginResponse.body.code, 'ACCOUNT_DISABLED');

  FakeRedis.reset(seed());
  const registerResponse = await invoke(register, {
    body: { username: 'Cons Espher', password: 'Password1' },
  });
  assert.equal(registerResponse.statusCode, 403);
  assert.equal(registerResponse.body.code, 'ACCOUNT_DISABLED');

  FakeRedis.reset(seed());
  const token = signAccessToken({ type: 'local', username: 'cons_espher', principal: 'local:cons_espher' });
  const sessionResponse = await invoke(me, {
    method: 'GET',
    headers: { cookie: `nf_token=${token}` },
  });
  assert.equal(sessionResponse.statusCode, 403);
  assert.equal(sessionResponse.body.code, 'ACCOUNT_DISABLED');

  FakeRedis.reset(seed());
  const refreshToken = signRefreshToken({ type: 'local', username: 'cons_espher', principal: 'local:cons_espher' });
  const refreshResponse = await invoke(refresh, {
    method: 'POST',
    headers: { cookie: `nf_refresh=${refreshToken}` },
  });
  assert.equal(refreshResponse.statusCode, 403);
  assert.equal(refreshResponse.body.code, 'ACCOUNT_DISABLED');
});

test('Cons login repairs stale no-expiry account and IP lock state without bypassing password checks', async () => {
  FakeRedis.reset({
    'nf_user_pass:@cons espher': legacyPasswordHash('Password1'),
    'nf_user_data:cons_espher': JSON.stringify({ bonus_balance: 8.88 }),
    'nf_login_lock:cons_espher': '1',
    'nf_login_ip:192.0.2.155': 10,
  });

  const response = await invoke(register, {
    headers: { 'x-forwarded-for': '192.0.2.155' },
    body: { username: 'Cons Espher', password: 'Password1' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.username, 'cons_espher');
  assert.equal(FakeRedis.values.has('nf_login_lock:cons_espher'), false);
  assert.equal(Number(FakeRedis.values.get('nf_login_ip:192.0.2.155')), 1);
  assert.equal(FakeRedis.expiries.get('nf_login_ip:192.0.2.155'), 900);

  const wrongPassword = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.156' },
    body: { username: 'Cons Espher', password: 'WrongPassword1' },
  });
  assert.equal(wrongPassword.statusCode, 401);
});

test('the dedicated login endpoint repairs a stale no-expiry IP lock', async () => {
  FakeRedis.reset({
    'nf_user_pass:alice': legacyPasswordHash('Password1'),
    'nf_user_data:alice': JSON.stringify({}),
    'nf_login_lock:192.0.2.157': '1',
  });

  const response = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.157' },
    body: { username: 'alice', password: 'Password1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(FakeRedis.values.has('nf_login_lock:192.0.2.157'), false);
});

test('refresh canonicalizes an established Cons alias session without requiring another login', async () => {
  FakeRedis.reset({
    'nf_user_data:cons_espher': JSON.stringify({ bonus_balance: 8.88 }),
    'nf_identity_owner:cons_espher': 'local:cons_espher',
    'nf_identity_owner:@cons espher': 'local:cons_espher',
  });
  const legacyRefresh = signRefreshToken({
    type: 'local', username: '@cons espher', principal: 'local:@cons espher',
  });
  const response = await invoke(refresh, {
    headers: { cookie: `nf_refresh=${legacyRefresh}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.username, 'cons_espher');
  const accessToken = response.headers['set-cookie'][0].match(/^nf_token=([^;]+)/)[1];
  assert.equal(verifyJWT(accessToken).username, 'cons_espher');
  assert.equal(verifyJWT(accessToken).principal, 'local:cons_espher');
});

test('auth/me canonicalizes an established Cons alias access session', async () => {
  FakeRedis.reset({
    'nf_user_data:cons_espher': JSON.stringify({ bonus_balance: 8.88 }),
    'nf_identity_owner:cons_espher': 'local:cons_espher',
    'nf_identity_owner:@cons espher': 'local:cons_espher',
  });
  const accessToken = signAccessToken({
    type: 'local', username: '@cons espher', principal: 'local:@cons espher',
  });
  const response = await invoke(me, {
    method: 'GET',
    headers: { cookie: `nf_token=${accessToken}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.loggedIn, true);
  assert.equal(response.body.username, 'cons_espher');
});

test('Cons login fails closed if canonical and verified alias credentials both exist', async () => {
  const wallet = JSON.stringify({ bonus_balance: 8.62, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_pass:cons_espher': legacyPasswordHash('Password1'),
    'nf_user_pass:@cons espher': legacyPasswordHash('Password2'),
    'nf_user_data:cons_espher': wallet,
  });
  const response = await invoke(login, {
    body: { username: 'Cons Espher', password: 'Password1' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'ACCOUNT_CREDENTIAL_CONFLICT');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(FakeRedis.values.get('nf_user_data:cons_espher'), wallet);
});

test('Eliza legacy credential remains visible and mutable through the primary session identity', async () => {
  const wallet = JSON.stringify({ bonus_balance: 12, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_pass:eliza_stellar': legacyPasswordHash('Password1'),
    'nf_user_data:eliza_star': wallet,
  });

  const loggedIn = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.161' },
    body: { username: 'eliza_star', password: 'Password1' },
  });
  assert.equal(loggedIn.statusCode, 200);
  assert.equal(loggedIn.body.username, 'eliza_star');
  const accessToken = loggedIn.headers['set-cookie'][0].match(/^nf_token=([^;]+)/)[1];

  const status = await invoke(me, {
    method: 'GET',
    headers: { cookie: `nf_token=${accessToken}` },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.hasPassword, true);
  assert.equal(status.body.passwordRecoveryRequired, false);

  const changed = await invoke(setPassword, {
    headers: { cookie: `nf_token=${accessToken}` },
    body: { oldPassword: 'Password1', password: 'Password2' },
  });
  assert.equal(changed.statusCode, 200);

  const relogin = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.162' },
    body: { username: '@eliza.stellar', password: 'Password2' },
  });
  assert.equal(relogin.statusCode, 200);
  assert.equal(relogin.body.username, 'eliza_star');
  assert.equal(FakeRedis.values.has('nf_user_pass:eliza_star'), false);
  assert.match(FakeRedis.values.get('nf_user_pass:eliza_stellar'), /^scrypt\$/);
  assert.equal(FakeRedis.values.get('nf_user_data:eliza_star'), wallet);
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

test('auth/me returns the canonical Discord handle and a separate display name', async () => {
  FakeRedis.reset({
    'nf_user_data:discord-handle': JSON.stringify({}),
    'nf_identity_owner:discord-handle': 'discord:discord-42',
  });
  const accessToken = signAccessToken({
    type: 'discord',
    username: 'discord-handle',
    globalName: 'Display Name',
    discordId: 'discord-42',
    principal: 'discord:discord-42',
  });
  const session = await invoke(me, {
    method: 'GET',
    headers: { cookie: `nf_token=${accessToken}` },
  });
  assert.equal(session.statusCode, 200);
  assert.equal(session.body.loggedIn, true);
  assert.equal(session.body.username, 'discord-handle');
  assert.equal(session.body.displayName, 'Display Name');
  assert.equal(session.body.globalName, 'Display Name');
});

test('client sync and rewards respect the shared user-data lock', async () => {
  const username = 'user_data_lock_test';
  FakeRedis.reset({
    [`nf_user_data:${username}`]: JSON.stringify({ bonus_balance: 40, points: 5, withdrawals: [{ id: 'wd_1', amount: 20, status: 'pending' }] }),
    [`nf_user_data_lock:v2:${username}`]: 'other-request',
  });
  const accessToken = signAccessToken({ type: 'local', username });
  const headers = { cookie: `nf_token=${accessToken}` };

  const sync = await invoke(userData, {
    method: 'POST', headers, body: { data: { myBooks: [{ bookId: 'book-1' }] } },
  });
  assert.equal(sync.statusCode, 409);
  assert.equal(sync.body.code, 'USER_DATA_BUSY');

  const reward = await invoke(rewards, {
    method: 'POST', headers, body: { action: 'claim_mission', missionId: 'share1' },
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
  assert.equal(FakeRedis.values.has(`nf_user_data_lock:v2:${username}`), false);
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
  assert.equal(FakeRedis.values.has(`nf_user_data_lock:v2:${username}`), false);
});

test('login never creates a new account', async () => {
  FakeRedis.reset();

  const response = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.12' },
    body: { username: 'brand-new-reader', password: 'Password1' },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'INVALID_CREDENTIALS');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(FakeRedis.values.has('nf_user_pass:brand-new-reader'), false);
  assert.equal(FakeRedis.values.has('nf_identity_owner:brand-new-reader'), false);
});

test('brand new registration atomically stages a complete signup outbox event', async () => {
  FakeRedis.reset();

  const response = await invoke(register, {
    headers: {
      'x-forwarded-for': '192.0.2.44',
      'user-agent': 'Mozilla/5.0 (iPhone)',
    },
    body: { username: 'fresh-signup-reader', password: 'Password1' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.isNewUser, true);
  assert.match(FakeRedis.values.get('nf_user_pass:fresh-signup-reader'), /^scrypt\$/);
  const eventKey = Array.from(FakeRedis.values.keys())
    .find(key => key.startsWith('nf_outbox:signup:v1:'));
  assert.ok(eventKey);
  const event = JSON.parse(FakeRedis.values.get(eventKey));
  assert.equal(event.type, 'signup');
  assert.equal(event.username, 'fresh-signup-reader');
  assert.equal(event.status, 'pending');
  assert.equal(event.attempts, 0);
  assert.equal(event.device, 'iOS');
  assert.match(event.registered_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(event.ip_hash, /^[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(event).includes('192.0.2.44'), false);
});

test('registration fails closed when its abuse limit cannot be verified', async () => {
  const originalIncr = FakeRedis.prototype.incr;
  FakeRedis.prototype.incr = async function failRegistrationLimit(key) {
    if (String(key).startsWith('nf_login_ip:')) throw new Error('rate storage unavailable');
    return originalIncr.call(this, key);
  };
  try {
    const response = await invoke(register, {
      headers: { 'x-forwarded-for': '192.0.2.45' },
      body: { username: 'rate-limit-unknown', password: 'Password1' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'RATE_LIMIT_UNAVAILABLE');
    assert.equal(FakeRedis.values.has('nf_user_pass:rate-limit-unknown'), false);
  } finally {
    FakeRedis.prototype.incr = originalIncr;
  }
});

test('withdrawal creation is blocked when income details require reconciliation', async () => {
  const username = 'withdraw_reconciliation_test_user';
  FakeRedis.reset({
    [`nf_user_data:${username}`]: JSON.stringify({ bonus_balance: 50, withdrawals: [] }),
  });
  const statsData = require('../api/_lib/stats-data');
  const originalLegacy = statsData.getLegacyDataJson;
  const originalAd = statsData.getAdIdDetails;
  statsData.getLegacyDataJson = async () => ({
    users: {
      [username]: {
        subscription_revenue_dn: 40,
        subscription_revenue_dn_daily: { '2026-08-11': 20 },
      },
    },
  });
  statsData.getAdIdDetails = async () => ({
    by_promoter: { [username]: { display_name: username, links: [] } },
    ad_ids: {},
  });
  delete require.cache[require.resolve('../api/withdrawals')];
  const isolatedWithdrawals = require('../api/withdrawals');
  const accessToken = signAccessToken({ type: 'local', username });
  try {
    const response = await invoke(isolatedWithdrawals, {
      method: 'POST',
      headers: { cookie: `nf_token=${accessToken}` },
      body: {
        amount: 20,
        payment_account: 'reconcile@example.com',
        idempotency_key: ['withdraw', 'reconcile', 'test'].join('-'),
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'INCOME_RECONCILIATION_REQUIRED');
    assert.deepEqual(response.body.reconciliation_reasons, ['income_daily_total_mismatch']);
    const saved = JSON.parse(FakeRedis.values.get(`nf_user_data:${username}`));
    assert.deepEqual(saved.withdrawals, []);
  } finally {
    statsData.getLegacyDataJson = originalLegacy;
    statsData.getAdIdDetails = originalAd;
    delete require.cache[require.resolve('../api/withdrawals')];
  }
});

test('admin approval is blocked while the target wallet requires reconciliation', async () => {
  const username = 'withdraw_reconciliation_review_user';
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    [`nf_user_data:${username}`]: JSON.stringify({
      bonus_balance: 50,
      withdrawals: [{
        id: 'wd_reconciliation_review', amount: 20, status: 'pending',
        payment_account: 'review@example.com',
      }],
    }),
  });
  const statsData = require('../api/_lib/stats-data');
  const originalLegacy = statsData.getLegacyDataJson;
  const originalAd = statsData.getAdIdDetails;
  statsData.getLegacyDataJson = async () => ({
    users: {
      [username]: {
        subscription_revenue_dn: 40,
        subscription_revenue_dn_daily: { '2026-08-11': 20 },
      },
    },
  });
  statsData.getAdIdDetails = async () => ({
    by_promoter: { [username]: { display_name: username, links: [] } },
    ad_ids: {},
  });
  delete require.cache[require.resolve('../api/withdrawals')];
  const isolatedWithdrawals = require('../api/withdrawals');
  const accessToken = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const response = await invoke(isolatedWithdrawals, {
      method: 'PATCH',
      headers: { cookie: `nf_token=${accessToken}` },
      body: {
        username,
        request_id: 'wd_reconciliation_review',
        action: 'approve',
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'INCOME_RECONCILIATION_REQUIRED');
    const saved = JSON.parse(FakeRedis.values.get(`nf_user_data:${username}`));
    assert.equal(saved.withdrawals[0].status, 'pending');
  } finally {
    statsData.getLegacyDataJson = originalLegacy;
    statsData.getAdIdDetails = originalAd;
    delete require.cache[require.resolve('../api/withdrawals')];
  }
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
      idempotency_key: ['withdraw', 'corrupt', 'test'].join('-'),
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
  assert.equal(res.body.code, 'SUPPORT_RECOVERY_REQUIRED');
  assert.equal(FakeRedis.values.has('nf_user_pass:tom'), false);
});

test('brand new accounts cannot pre-claim trusted source or login aliases', async () => {
  for (const username of ['Eliza_Star', 'Cons Espher', '@cons espher']) {
    const res = await invoke(register, {
      body: { username, password: 'Password1' },
    });
    assert.equal(res.statusCode, 409, username);
    assert.equal(res.body.code, 'SUPPORT_RECOVERY_REQUIRED', username);
  }

  assert.equal(FakeRedis.values.has('nf_user_pass:eliza_star'), false);
  assert.equal(FakeRedis.values.has('nf_user_pass:cons_espher'), false);
  assert.equal(FakeRedis.values.has('nf_user_pass:@cons espher'), false);
});
