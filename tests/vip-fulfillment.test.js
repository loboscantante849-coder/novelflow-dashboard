const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.CRON_SECRET = 'vip-worker-test-secret';

const memberPath = require.resolve('../api/_lib/novelflow-member');
const originalMemberExports = require(memberPath);
let resolveMember;
let grantVip;
require.cache[memberPath].exports = {
  ...originalMemberExports,
  resolveNovelFlowMember: (...args) => resolveMember(...args),
  grantVipDays: (...args) => grantVip(...args),
};
delete require.cache[require.resolve('../api/vip-fulfillment')];
const vipFulfillment = require('../api/vip-fulfillment');

const USER_ID = '67e519c3da10a5c772ca196e';

function pendingEvent(overrides = {}) {
  return {
    version: 1,
    event_id: 'vip_test_event',
    username: 'vip-worker-user',
    user_id: USER_ID,
    source: 'limited_subsidy',
    source_id: 'limited-subsidy-v1',
    days: 2,
    status: 'pending',
    attempts: 0,
    created_at: '2026-08-11T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

function workerRequest() {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  resolveMember = async () => ({ user_id: USER_ID, member_end_time: '2026-08-20T00:00:00.000Z' });
  grantVip = async () => ({ success: true, request_id: 'request-success' });
});

test.after(() => {
  require.cache[memberPath].exports = originalMemberExports;
});

test('VIP worker records a successful upstream grant exactly once', async () => {
  const event = pendingEvent();
  FakeRedis.values.set(`nf_vip_event:v1:${event.event_id}`, JSON.stringify(event));
  let grants = 0;
  grantVip = async () => {
    grants += 1;
    return { success: true, request_id: 'request-success' };
  };

  const response = await invoke(vipFulfillment, workerRequest());
  const retry = await invoke(vipFulfillment, workerRequest());
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.succeeded, 1);
  assert.equal(retry.body.processed, 0);
  assert.equal(grants, 1);
  const saved = JSON.parse(FakeRedis.values.get(`nf_vip_event:v1:${event.event_id}`));
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.attempts, 1);
  assert.equal(saved.upstream_request_id, 'request-success');
});

test('an upstream timeout is marked for reconciliation instead of automatic retry', async () => {
  const event = pendingEvent();
  FakeRedis.values.set(`nf_vip_event:v1:${event.event_id}`, JSON.stringify(event));
  let grants = 0;
  grantVip = async () => {
    grants += 1;
    const error = new Error('timed out');
    error.code = 'UPSTREAM_TIMEOUT';
    throw error;
  };

  const first = await invoke(vipFulfillment, workerRequest());
  const second = await invoke(vipFulfillment, workerRequest());
  assert.equal(first.body.reconciliation_required, 1);
  assert.equal(second.body.processed, 0);
  assert.equal(grants, 1);
  const saved = JSON.parse(FakeRedis.values.get(`nf_vip_event:v1:${event.event_id}`));
  assert.equal(saved.status, 'reconciliation_required');
  assert.equal(saved.reconciliation_reason, 'UPSTREAM_TIMEOUT');
});

test('an unknown post-grant result remains non-retryable without a manual decision', async () => {
  const event = pendingEvent();
  FakeRedis.values.set(`nf_vip_event:v1:${event.event_id}`, JSON.stringify(event));
  let lookups = 0;
  let grants = 0;
  resolveMember = async () => {
    lookups += 1;
    if (lookups > 1) {
      const error = new Error('post-grant lookup unavailable');
      error.code = 'UPSTREAM_UNAVAILABLE';
      throw error;
    }
    return { user_id: USER_ID, member_end_time: '2026-08-20T00:00:00.000Z' };
  };
  grantVip = async () => {
    grants += 1;
    return { success: true, request_id: 'possibly-applied' };
  };

  const first = await invoke(vipFulfillment, workerRequest());
  const second = await invoke(vipFulfillment, workerRequest());
  assert.equal(first.body.reconciliation_required, 1);
  assert.equal(second.body.processed, 0);
  assert.equal(grants, 1);
  const saved = JSON.parse(FakeRedis.values.get(`nf_vip_event:v1:${event.event_id}`));
  assert.equal(saved.status, 'reconciliation_required');
  assert.equal(saved.reconciliation_reason, 'UPSTREAM_UNAVAILABLE');
});

test('a pre-existing delivering event is never retried blindly', async () => {
  const event = pendingEvent({
    status: 'delivering',
    attempts: 1,
    delivery_started_at: '2026-08-11T00:01:00.000Z',
  });
  FakeRedis.values.set(`nf_vip_event:v1:${event.event_id}`, JSON.stringify(event));
  let grants = 0;
  grantVip = async () => {
    grants += 1;
    return { success: true, request_id: 'must-not-run' };
  };

  const response = await invoke(vipFulfillment, workerRequest());
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.processed, 0);
  assert.equal(grants, 0);
  assert.equal(JSON.parse(FakeRedis.values.get(`nf_vip_event:v1:${event.event_id}`)).status, 'delivering');
});
