const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();
const {
  buildSignupEvent,
  deliverSignupEvent,
  outboxKey,
  stageSignupEvent,
  _resetForTests,
} = require('../api/_lib/signup-outbox');
const fs = require('node:fs');
const path = require('node:path');

const envKeys = [
  'NF_FEISHU_REGISTRATION_APP_ID',
  'NF_FEISHU_REGISTRATION_APP_SECRET',
  'NF_FEISHU_REGISTRATION_BASE_TOKEN',
  'NF_FEISHU_REGISTRATION_TABLE_ID',
];

test.beforeEach(() => {
  FakeRedis.reset();
  _resetForTests();
  for (const key of envKeys) delete process.env[key];
});

test('signup events are deterministic and retain only hashed network metadata', async () => {
  const redis = new FakeRedis();
  const first = await stageSignupEvent(redis, {
    username: 'Alice', memberId: 100, referralCode: 'nfref_parent', inviter: 'parent',
    ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone)',
  });
  const second = await stageSignupEvent(redis, { username: 'alice', ip: '198.51.100.3' });

  assert.equal(first.event_id, second.event_id);
  assert.equal(first.username, 'alice');
  assert.equal(first.device, 'iOS');
  assert.match(first.ip_hash, /^[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(first).includes('203.0.113.7'), false);
});

test('delivery reconciles an existing event before creating another row', async () => {
  Object.assign(process.env, {
    NF_FEISHU_REGISTRATION_APP_ID: 'app-id',
    NF_FEISHU_REGISTRATION_APP_SECRET: 'app-secret',
    NF_FEISHU_REGISTRATION_BASE_TOKEN: 'base-token',
    NF_FEISHU_REGISTRATION_TABLE_ID: 'table-id',
  });
  const redis = new FakeRedis();
  const event = buildSignupEvent({ username: 'alice', ip: '203.0.113.7' });
  await redis.set(outboxKey(event.event_id), JSON.stringify(event));
  const originalFetch = global.fetch;
  let createCalls = 0;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('tenant_access_token')) {
      return { ok: true, text: async () => JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }) };
    }
    if (options.method === 'POST') createCalls += 1;
    return { ok: true, text: async () => JSON.stringify({ code: 0, data: { items: [{ record_id: 'rec-1' }] } }) };
  };
  try {
    const result = await deliverSignupEvent(redis, event);
    assert.equal(result.status, 'delivered');
    assert.equal(result.remote_record_id, 'rec-1');
    assert.equal(createCalls, 0, 'an existing row must skip record creation');
  } finally {
    global.fetch = originalFetch;
  }
});

test('an ambiguous delivery failure stops for reconciliation instead of blind retry', async () => {
  Object.assign(process.env, {
    NF_FEISHU_REGISTRATION_APP_ID: 'app-id',
    NF_FEISHU_REGISTRATION_APP_SECRET: 'app-secret',
    NF_FEISHU_REGISTRATION_BASE_TOKEN: 'base-token',
    NF_FEISHU_REGISTRATION_TABLE_ID: 'table-id',
  });
  const redis = new FakeRedis();
  const event = buildSignupEvent({ username: 'alice', ip: '203.0.113.7' });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async url => {
    calls += 1;
    if (String(url).includes('tenant_access_token')) {
      return { ok: true, text: async () => JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }) };
    }
    if (calls === 2) return { ok: true, text: async () => JSON.stringify({ code: 0, data: { items: [] } }) };
    throw new Error('network outcome unknown');
  };
  try {
    const result = await deliverSignupEvent(redis, event);
    assert.equal(result.status, 'reconciliation_required');
    const stored = JSON.parse(FakeRedis.values.get(outboxKey(event.event_id)));
    assert.equal(stored.status, 'reconciliation_required');
  } finally {
    global.fetch = originalFetch;
  }
});

test('every account-creation entry point stages the independent signup outbox', () => {
  for (const file of ['api/auth/register.js', 'api/auth/discord-activity.js', 'api/auth/callback.js']) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    assert.match(source, /signup-outbox/);
    assert.match(source, /deliverSignupEvent/);
  }
  const loginSource = fs.readFileSync(path.resolve(__dirname, '../api/auth/login.js'), 'utf8');
  assert.doesNotMatch(loginSource, /createAccountWithSignupEvent|stageSignupEvent/);
});
