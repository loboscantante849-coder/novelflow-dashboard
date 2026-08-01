'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'api-boundary-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.XMP_CLIENT_ID = 'test-xmp-client';
process.env.XMP_CLIENT_SECRET = 'test-xmp-secret';
process.env.ADMIN_KEY = 'test-admin-key';

let hgetallCalls = 0;
let acTokenReads = 0;
const originalRedisGet = FakeRedis.prototype.get;

FakeRedis.prototype.get = async function get(key) {
  if (key === 'ac_token') acTokenReads += 1;
  return originalRedisGet.call(this, key);
};

FakeRedis.prototype.hgetall = async function hgetall(key) {
  this._checkError();
  hgetallCalls += 1;
  if (FakeRedis.errorsByKey.has(key)) throw FakeRedis.errorsByKey.get(key);
  return FakeRedis.values.get(key) ?? null;
};

const { signAccessToken, signRefreshToken } = require('../api/_lib/auth');
const xmpMaterials = require('../api/xmp-materials');
const submissions = require('../api/submissions');
const acKv = require('../api/ac-kv');
const updateStats = require('../api/update-stats');
const socialStore = require('../api/social-store');

const originalFetch = global.fetch;

function authHeaders(username = 'alice', extra = {}) {
  return {
    authorization: `Bearer ${signAccessToken({ username })}`,
    ...extra,
  };
}

function upstreamResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  hgetallCalls = 0;
  acTokenReads = 0;
  process.env.KV_REST_API_URL = 'https://redis.invalid';
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.XMP_CLIENT_ID = 'test-xmp-client';
  process.env.XMP_CLIENT_SECRET = 'test-xmp-secret';
  process.env.ADMIN_KEY = 'test-admin-key';
  global.fetch = async () => {
    throw new Error('Unexpected upstream request');
  };
});

test.after(() => {
  global.fetch = originalFetch;
});

test('XMP requires an access token before checking configuration or calling upstream', async () => {
  delete process.env.XMP_CLIENT_SECRET;
  const unauthenticated = await invoke(xmpMaterials, {
    method: 'GET',
    query: { action: 'list' },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const refreshToken = signRefreshToken({ username: 'alice' });
  const refreshOnly = await invoke(xmpMaterials, {
    method: 'GET',
    headers: { authorization: `Bearer ${refreshToken}` },
    query: { action: 'list' },
  });
  assert.equal(refreshOnly.statusCode, 401);
});

test('XMP fails closed for disabled accounts and account-status storage errors', async () => {
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({ disabled: true }),
  });
  const disabled = await invoke(xmpMaterials, {
    method: 'GET', headers: authHeaders(), query: { action: 'list' },
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.body.code, 'ACCOUNT_DISABLED');

  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({}) });
  FakeRedis.errorsByKey.set('nf_user_data:alice', new Error('storage secret detail'));
  const unavailable = await invoke(xmpMaterials, {
    method: 'GET', headers: authHeaders(), query: { action: 'list' },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.code, 'ACCOUNT_STATUS_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unavailable.body), /secret|redis|upstash/i);
});

test('XMP rejects malformed or oversized query parameters before calling upstream', async () => {
  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({}) });
  const invalidQueries = [
    { action: 'delete' },
    { action: ['list'] },
    { action: 'list', page: '0' },
    { action: 'list', page: '1.5' },
    { action: 'list', page: '1001' },
    { action: 'list', page_size: '51' },
    { action: 'list', folder_id: 'not-a-number' },
    { action: 'list', folder_id: Array.from({ length: 21 }, (_, i) => String(i + 1)) },
    { action: 'list', keyword: ['book'] },
    { action: 'list', keyword: 'x'.repeat(101) },
    { action: 'list', material_type: 'audio' },
  ];

  for (const query of invalidQueries) {
    const response = await invoke(xmpMaterials, {
      method: 'GET', headers: authHeaders(), query,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(query));
  }
});

test('XMP sends only bounded values upstream and filters the compatible response', async () => {
  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({}) });
  let upstreamCalls = 0;
  global.fetch = async (url, options) => {
    upstreamCalls += 1;
    assert.match(String(url), /\/v2\/media\/material\/list$/);
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.page, 2);
    assert.equal(body.page_size, 10);
    assert.deepEqual(body.folder_id, [123, 456]);
    assert.equal(body.client_id, 'test-xmp-client');
    return upstreamResponse({
      code: 0,
      data: [
        { material_name: 'Target Book clip', material_type: 'video' },
        { material_name: 'Target Book cover', material_type: 'image' },
        { material_name: 'Other clip', material_type: 'video' },
      ],
    });
  };

  const response = await invoke(xmpMaterials, {
    method: 'GET',
    headers: authHeaders('alice', { 'x-forwarded-for': '192.0.2.20' }),
    query: {
      action: 'list',
      page: '2',
      page_size: '10',
      folder_id: ['123', '456'],
      keyword: 'target book',
      material_type: 'video',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.deepEqual(response.body.data, [
    { material_name: 'Target Book clip', material_type: 'video' },
  ]);
  assert.equal(upstreamCalls, 1);
  assert.equal(FakeRedis.values.get('nf_rate:xmp_user:alice'), 1);
  assert.equal(FakeRedis.values.get('nf_rate:xmp_ip:192.0.2.20'), 1);
});

test('XMP enforces both user and IP limits before calling upstream', async () => {
  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls += 1;
    return upstreamResponse({ code: 0, data: [] });
  };

  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({}),
    'nf_rate:xmp_user:alice': 30,
  });
  const userLimited = await invoke(xmpMaterials, {
    method: 'GET',
    headers: authHeaders('alice', { 'x-forwarded-for': '192.0.2.30' }),
    query: { action: 'list' },
  });
  assert.equal(userLimited.statusCode, 429);

  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({}),
    'nf_rate:xmp_ip:192.0.2.31': 60,
  });
  const ipLimited = await invoke(xmpMaterials, {
    method: 'GET',
    headers: authHeaders('alice', { 'x-forwarded-for': '192.0.2.31' }),
    query: { action: 'list' },
  });
  assert.equal(ipLimited.statusCode, 429);
  assert.equal(upstreamCalls, 0);
});

test('XMP timeout and configuration failures do not expose upstream or secret details', async () => {
  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({}) });
  global.fetch = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    const error = new Error('test-xmp-secret upstream detail');
    error.name = 'AbortError';
    throw error;
  };
  const timeout = await invoke(xmpMaterials, {
    method: 'GET', headers: authHeaders(), query: { action: 'list' },
  });
  assert.equal(timeout.statusCode, 504);
  assert.deepEqual(timeout.body, { error: 'Asset service timed out' });

  delete process.env.XMP_CLIENT_SECRET;
  const unavailable = await invoke(xmpMaterials, {
    method: 'GET', headers: authHeaders(), query: { action: 'list' },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.body, { error: 'Asset service unavailable' });
  assert.doesNotMatch(JSON.stringify(unavailable.body), /client|secret|environment|configured/i);
});

test('submissions authenticates an admin before reading the full hash', async () => {
  const anonymous = await invoke(submissions, { method: 'GET' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(hgetallCalls, 0);

  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({}) });
  const regularUser = await invoke(submissions, {
    method: 'GET', headers: authHeaders(),
  });
  assert.equal(regularUser.statusCode, 403);
  assert.equal(hgetallCalls, 0);

  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({ accountType: 'admin' }),
    nf_subs: {
      '10001': JSON.stringify({ bookName: 'Book A', discordUsername: 'private-user' }),
    },
  });
  const admin = await invoke(submissions, {
    method: 'GET', headers: authHeaders(),
  });
  assert.equal(admin.statusCode, 200);
  assert.equal(admin.body[0].discordUsername, 'private-user');
  assert.equal(hgetallCalls, 1);
});

test('submissions permits x-admin-key while disabled admins remain blocked', async () => {
  FakeRedis.reset({
    nf_subs: { '10001': JSON.stringify({ bookName: 'Book A' }) },
  });
  const byKey = await invoke(submissions, {
    method: 'GET', headers: { 'x-admin-key': 'test-admin-key' },
  });
  assert.equal(byKey.statusCode, 200);

  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({ accountType: 'admin', disabled: true }),
    nf_subs: { '10001': JSON.stringify({ bookName: 'Book A' }) },
  });
  hgetallCalls = 0;
  const disabled = await invoke(submissions, {
    method: 'GET', headers: authHeaders(),
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(hgetallCalls, 0);
});

test('AC KV health does not disclose configuration before admin authorization', async () => {
  delete process.env.KV_REST_API_URL;
  const anonymousWithoutStorage = await invoke(acKv, { method: 'GET' });
  assert.equal(anonymousWithoutStorage.statusCode, 401);
  process.env.KV_REST_API_URL = 'https://redis.invalid';

  FakeRedis.reset({ ac_token: 'private-ac-token' });
  const anonymous = await invoke(acKv, { method: 'GET' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(acTokenReads, 0);

  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({}),
    ac_token: 'private-ac-token',
  });
  const regularUser = await invoke(acKv, {
    method: 'GET', headers: authHeaders(),
  });
  assert.equal(regularUser.statusCode, 403);
  assert.equal(acTokenReads, 0);

  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({ accountType: 'admin' }),
    ac_token: 'private-ac-token',
  });
  const admin = await invoke(acKv, {
    method: 'GET', headers: authHeaders(),
  });
  assert.equal(admin.statusCode, 200);
  assert.deepEqual(admin.body, { configured: true, status: 'ok' });
  assert.equal(acTokenReads, 1);
});

test('AC KV health permits x-admin-key and rejects refresh-token authentication', async () => {
  FakeRedis.reset({ ac_token: 'private-ac-token' });
  const byKey = await invoke(acKv, {
    method: 'GET', headers: { 'x-admin-key': 'test-admin-key' },
  });
  assert.equal(byKey.statusCode, 200);

  acTokenReads = 0;
  const refreshToken = signRefreshToken({ username: 'alice' });
  const refreshOnly = await invoke(acKv, {
    method: 'GET', headers: { authorization: `Bearer ${refreshToken}` },
  });
  assert.equal(refreshOnly.statusCode, 401);
  assert.equal(acTokenReads, 0);
});

test('retired update-stats endpoint returns only a generic 410 response', async () => {
  const response = await invoke(updateStats, { method: 'GET' });
  assert.equal(response.statusCode, 410);
  assert.deepEqual(response.body, { error: 'Endpoint retired' });
  assert.doesNotMatch(JSON.stringify(response.body), /repo|github|pipeline|source|cron/i);
});

test('legacy social storage never falls back to the core user-data Redis', async () => {
  delete process.env.SOCIAL_KV_REST_API_URL;
  delete process.env.SOCIAL_KV_REST_API_TOKEN;
  process.env.SOCIAL_STORE_SECRET = 'social-test-secret';
  const result = await invoke(socialStore, {
    method: 'POST',
    headers: { authorization: 'Bearer social-test-secret' },
    body: { op: 'get', args: { key: 'nf_social:test' } },
  });
  assert.equal(result.statusCode, 410);
  assert.equal(result.body.code, 'SOCIAL_STORE_RETIRED');
});

test('AC and wallet endpoints never return internal exception messages', () => {
  const files = [
    'api/ac-retry.js',
    'api/ac-interrupt.js',
    'api/ac-refresh.js',
    'api/ac-list.js',
    'api/ac-result.js',
    'api/withdrawals.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /detail:\s*(?:e|err|error)\.message/);
  }
});
