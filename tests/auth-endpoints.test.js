const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'endpoint-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
delete process.env.FEISHU_SIGNUP_WEBHOOK;

const login = require('../api/auth/login');
const register = require('../api/auth/register');
const { legacyPasswordHash } = require('../api/_lib/password');

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

test('register requires a password before issuing a legacy user session', async () => {
  const originalData = JSON.stringify({ myBooks: [{ code: '1001' }], points: 25 });
  FakeRedis.reset({ 'nf_user_data:legacy-user': originalData });

  const missing = await invoke(register, {
    body: { username: 'legacy-user' },
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.mustSetPassword, true);
  assert.equal(missing.headers['set-cookie'], undefined);

  const configured = await invoke(register, {
    body: { username: 'legacy-user', password: 'Password1' },
  });
  assert.equal(configured.statusCode, 200);
  assert.equal(configured.body.mustSetPassword, true);
  assert.equal(FakeRedis.values.get('nf_user_data:legacy-user'), originalData);
  assert.match(FakeRedis.values.get('nf_user_pass:legacy-user'), /^scrypt\$/);
});

test('username case variants resolve to one password and data identity', async () => {
  const originalData = JSON.stringify({ myBooks: [{ code: '1002' }], points: 30 });
  FakeRedis.reset({ 'nf_user_data:alice': originalData });

  const configured = await invoke(register, {
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

test('register rejects reserved new usernames', async () => {
  const res = await invoke(register, {
    body: { username: 'Admin', password: 'Password1' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'This username is not available');
  assert.equal(FakeRedis.values.has('nf_user_pass:Admin'), false);
});
