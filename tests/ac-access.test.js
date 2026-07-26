const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'ac-access-test-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.AC_TOKEN = 'test-ac-token';
process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';

const { signAccessToken } = require('../api/_lib/auth');
const acCreate = require('../api/ac-create');
const acUpload = require('../api/ac-upload');
const acRetry = require('../api/ac-retry');
const acInterrupt = require('../api/ac-interrupt');
const acResult = require('../api/ac-result');
const acRefresh = require('../api/ac-refresh');

function authHeaders(username) {
  return { authorization: `Bearer ${signAccessToken({ username })}` };
}

function response(body = {}, status = 200) {
  return {
    status,
    headers: { get: () => null },
    async json() { return body; },
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  process.env.KV_REST_API_URL = 'https://redis.invalid';
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.AC_TOKEN = 'test-ac-token';
});

test('disabled accounts cannot create or upload AC work', async () => {
  let upstreamCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    upstreamCalls += 1;
    return response({ threadId: 'should-not-exist' });
  };
  try {
    const username = 'disabled-ac-user';
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({ disabled: true }),
      ac_token: 'test-ac-token',
    });
    const headers = authHeaders(username);

    const create = await invoke(acCreate, {
      method: 'POST', headers, body: { book_id: 'book-1' },
    });
    assert.equal(create.statusCode, 403);
    assert.equal(create.body.code, 'ACCOUNT_DISABLED');

    const upload = await invoke(acUpload, { method: 'POST', headers });
    assert.equal(upload.statusCode, 403);
    assert.equal(upload.body.code, 'ACCOUNT_DISABLED');
    assert.equal(upstreamCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC task ownership is required before calling the upstream service', async () => {
  let upstreamCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    upstreamCalls += 1;
    return response({ ok: true });
  };
  try {
    const username = 'ac-owner-user';
    FakeRedis.reset({ [`nf_user_data:${username}`]: JSON.stringify({}) });
    const headers = authHeaders(username);

    const retry = await invoke(acRetry, {
      method: 'POST', headers, body: { threadId: 'missing-owner' },
    });
    const interrupt = await invoke(acInterrupt, {
      method: 'POST', headers, body: { threadId: 'missing-owner' },
    });
    const result = await invoke(acResult, {
      method: 'GET', headers, query: { threadId: 'missing-owner' },
    });

    for (const res of [retry, interrupt, result]) {
      assert.equal(res.statusCode, 403);
      assert.match(res.body.error, /authorized/i);
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC ownership and token Redis failures fail closed', async () => {
  let upstreamCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    upstreamCalls += 1;
    return response({ ok: true });
  };
  try {
    const username = 'ac-storage-user';
    const headers = authHeaders(username);
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      [`ac_thread_owner:owner-error`]: 'owner-error',
      ac_token: 'test-ac-token',
    });
    FakeRedis.errorsByKey.set(`ac_thread_owner:owner-error`, new Error('temporary Redis failure'));
    const ownerError = await invoke(acRetry, {
      method: 'POST', headers, body: { threadId: 'owner-error' },
    });
    assert.equal(ownerError.statusCode, 503);
    assert.equal(ownerError.body.code, 'TASK_OWNER_UNAVAILABLE');

    FakeRedis.errorsByKey = new Map([[`ac_token`, new Error('temporary Redis failure')]]);
    FakeRedis.values.set(`ac_thread_owner:token-error`, username);
    const tokenError = await invoke(acRetry, {
      method: 'POST', headers, body: { threadId: 'token-error' },
    });
    assert.equal(tokenError.statusCode, 503);
    assert.equal(tokenError.body.code, 'AC_TOKEN_UNAVAILABLE');
    assert.equal(upstreamCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('disabled admin cannot refresh the AC token through a JWT', async () => {
  const originalFetch = global.fetch;
  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls += 1;
    return response({ ok: true });
  };
  try {
    const username = 'disabled-ac-admin';
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({ disabled: true, accountType: 'admin' }),
      ac_token: 'test-ac-token',
    });
    const result = await invoke(acRefresh, { method: 'POST', headers: authHeaders(username) });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.code, 'ACCOUNT_DISABLED');
    assert.equal(upstreamCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
