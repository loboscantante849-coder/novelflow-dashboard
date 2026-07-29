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
const acList = require('../api/ac-list');
const acResult = require('../api/ac-result');
const acRefresh = require('../api/ac-refresh');
const { isLegacyAcRemarkOwnedBy } = require('../api/_lib/ac-ownership');

function authHeaders(username) {
  return { authorization: `Bearer ${signAccessToken({ username })}` };
}

function response(body = {}, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
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

test('legacy AC remarks require an exact owner before the numeric timestamp', () => {
  assert.equal(isLegacyAcRemarkOwnedBy('nf_ann_1700000000000', 'ann'), true);
  assert.equal(isLegacyAcRemarkOwnedBy('nf_ann_x_1700000000000', 'ann_x'), true);
  assert.equal(isLegacyAcRemarkOwnedBy('nf_ann_x_1700000000000', 'ann'), false);
  assert.equal(isLegacyAcRemarkOwnedBy('nf_ann_not-a-timestamp', 'ann'), false);
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
    // Result checks the caller's own AC list once to support legacy tasks
    // whose Redis ownership record has expired; it must not call the task.
    assert.equal(upstreamCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a legacy reel in the current user AC list restores its expired result ownership', async () => {
  const originalFetch = global.fetch;
  const username = 'legacy-reel-user';
  const threadId = 'legacy-thread-1';
  let listCalls = 0;
  let resultCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/creative/paged-list')) {
      listCalls += 1;
      return response({ pageCount: 1, items: [{ thread_id: threadId, remark: `nf_${username}_1700000000000` }] });
    }
    if (String(url).includes(`/creative/${threadId}/result`)) {
      resultCalls += 1;
      return response({ final_result: [{ video_url: 'https://video.example/reel.mp4' }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      ac_token: 'test-ac-token',
    });
    const result = await invoke(acResult, {
      method: 'GET', headers: authHeaders(username), query: { threadId },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(resultCalls, 1);
    assert.equal(listCalls, 1);
    assert.equal(FakeRedis.values.get(`ac_thread_owner:${threadId}`), username);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC list hydrates result ownership for every signed user reel', async () => {
  const originalFetch = global.fetch;
  const username = 'list-owner-user';
  const threadId = 'listed-thread-1';
  global.fetch = async (url) => {
    assert.match(String(url), /creative\/paged-list/);
    return response({ pageCount: 1, items: [{ thread_id: threadId, remark: `nf_${username}_1700000000000` }] });
  };
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      ac_token: 'test-ac-token',
    });
    const listed = await invoke(acList, { method: 'GET', headers: authHeaders(username) });
    assert.equal(listed.statusCode, 200);
    assert.equal(FakeRedis.values.get(`ac_thread_owner:${threadId}`), username);
    assert.equal(FakeRedis.expiries.get(`ac_thread_owner:${threadId}`), 180 * 86400);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC list excludes another user whose name shares the current user prefix', async () => {
  const originalFetch = global.fetch;
  const username = 'ann';
  const ownThreadId = 'ann-thread';
  const collidingThreadId = 'ann-x-thread';
  global.fetch = async () => response({
    pageCount: 1,
    items: [
      { thread_id: ownThreadId, remark: 'nf_ann_1700000000000' },
      { thread_id: collidingThreadId, remark: 'nf_ann_x_1700000000000' },
    ],
  });
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      ac_token: 'test-ac-token',
    });
    const listed = await invoke(acList, { method: 'GET', headers: authHeaders(username) });

    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.body.data.items.map(item => item.thread_id), [ownThreadId]);
    assert.equal(FakeRedis.values.get(`ac_thread_owner:${ownThreadId}`), username);
    assert.equal(FakeRedis.values.has(`ac_thread_owner:${collidingThreadId}`), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('legacy result ownership cannot be restored from a colliding username prefix', async () => {
  const originalFetch = global.fetch;
  const username = 'ann';
  const threadId = 'ann-x-thread';
  let resultCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/creative/paged-list')) {
      return response({
        pageCount: 1,
        items: [{ thread_id: threadId, remark: 'nf_ann_x_1700000000000' }],
      });
    }
    resultCalls += 1;
    return response({ final_result: [] });
  };
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      ac_token: 'test-ac-token',
    });
    const result = await invoke(acResult, {
      method: 'GET', headers: authHeaders(username), query: { threadId },
    });

    assert.equal(result.statusCode, 403);
    assert.equal(resultCalls, 0);
    assert.equal(FakeRedis.values.has(`ac_thread_owner:${threadId}`), false);
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
