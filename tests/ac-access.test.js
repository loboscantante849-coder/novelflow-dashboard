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

test('AC creation stores bounded book metadata for each accepted task response shape', async () => {
  const originalFetch = global.fetch;
  const username = 'reel-metadata-user';
  global.fetch = async () => response({ data: { task_id: 'created-task-1' } });
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      ac_token: 'test-ac-token',
    });
    const created = await invoke(acCreate, {
      method: 'POST',
      headers: authHeaders(username),
      body: { book_id: 'book-1', book_title: 'A Searchable Book' },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(FakeRedis.values.get('ac_thread_owner:created-task-1'), username);
    assert.deepEqual(JSON.parse(FakeRedis.values.get('ac_thread_book:created-task-1')), {
      bookId: 'book-1', bookName: 'A Searchable Book',
    });
    assert.equal(FakeRedis.expiries.get('ac_thread_book:created-task-1'), 180 * 86400);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC list attaches stored book metadata only after filtering to the signed-in owner', async () => {
  const originalFetch = global.fetch;
  const username = 'reel-search-owner';
  const threadId = 'reel-search-thread';
  global.fetch = async () => response({
    pageCount: 1,
    items: [
      { thread_id: threadId, remark: `nf_${username}_1700000000000` },
      { thread_id: 'other-thread', remark: 'nf_another-user_1700000000000' },
    ],
  });
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      ac_token: 'test-ac-token',
      [`ac_thread_book:${threadId}`]: JSON.stringify({ bookId: 'book-1', bookName: 'Searchable Book' }),
      'ac_thread_book:other-thread': JSON.stringify({ bookId: 'book-2', bookName: 'Private Book' }),
    });
    const listed = await invoke(acList, { method: 'GET', headers: authHeaders(username) });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.data.items.length, 1);
    assert.equal(listed.body.data.items[0].book_name, 'Searchable Book');
    assert.equal(FakeRedis.values.get('ac_thread_owner:other-thread'), undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC list reuses a short server cache instead of repeating page fanout', async () => {
  const originalFetch = global.fetch;
  const username = 'cached-list-user';
  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls += 1;
    return response({
      pageCount: 1,
      items: [{ thread_id: 'cached-thread', remark: `nf_${username}_1700000000000` }],
    });
  };
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      ac_token: 'test-ac-token',
    });
    const first = await invoke(acList, { method: 'GET', headers: authHeaders(username) });
    const second = await invoke(acList, { method: 'GET', headers: authHeaders(username) });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(upstreamCalls, 1);
    assert.deepEqual(second.body.data.items.map(item => item.thread_id), ['cached-thread']);
    assert.equal(FakeRedis.expiries.get(`nf_ac_list_cache:${username}`), 45);
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

test('AC list rate limits expensive upstream reads before calling AC', async () => {
  const originalFetch = global.fetch;
  let upstreamCalls = 0;
  const username = 'ac-rate-limited-user';
  global.fetch = async () => {
    upstreamCalls += 1;
    return response({ pageCount: 1, items: [] });
  };
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      [`nf_rate:ac_list_user:${username}`]: 6,
      ac_token: 'test-ac-token',
    });
    const listed = await invoke(acList, { method: 'GET', headers: authHeaders(username) });
    assert.equal(listed.statusCode, 429);
    assert.equal(listed.body.code, 'RATE_LIMITED');
    assert.equal(upstreamCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC retry and interrupt reject malformed ids and enforce action limits', async () => {
  const originalFetch = global.fetch;
  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls += 1;
    return response({ ok: true });
  };
  try {
    const username = 'ac-action-limited-user';
    const headers = authHeaders(username);
    FakeRedis.reset({ [`nf_user_data:${username}`]: JSON.stringify({}) });
    const malformed = await invoke(acRetry, {
      method: 'POST', headers, body: { threadId: '../other-task' },
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.body.code, 'INVALID_THREAD_ID');

    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      'ac_thread_owner:owned-task': username,
      [`nf_rate:ac_retry_user:${username}`]: 10,
      [`nf_rate:ac_interrupt_user:${username}`]: 30,
      ac_token: 'test-ac-token',
    });
    const retry = await invoke(acRetry, {
      method: 'POST', headers, body: { threadId: 'owned-task' },
    });
    const interrupt = await invoke(acInterrupt, {
      method: 'POST', headers, body: { threadId: 'owned-task' },
    });
    assert.equal(retry.statusCode, 429);
    assert.equal(interrupt.statusCode, 429);
    assert.equal(upstreamCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC result rejects path-like thread ids before any upstream or Redis read', async () => {
  const originalFetch = global.fetch;
  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls += 1;
    return response({ final_result: [] });
  };
  try {
    const username = 'ac-thread-validation-user';
    FakeRedis.reset({ [`nf_user_data:${username}`]: JSON.stringify({}) });
    const result = await invoke(acResult, {
      method: 'GET', headers: authHeaders(username), query: { threadId: '../other-task' },
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, 'THREAD_ID_REQUIRED');
    assert.equal(upstreamCalls, 0);
    assert.equal(FakeRedis.values.has('nf_rate:ac_read_user:' + username), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC list fetches required pages in bounded batches and preserves page order/filtering', async () => {
  const originalFetch = global.fetch;
  const username = 'batched-list-user';
  const requestedPages = [];
  let active = 0;
  let maxActive = 0;
  const pageResponse = (pageIndex) => ({
    status: 200,
    ok: true,
    headers: {
      get: (name) => String(name).toLowerCase() === 'accesstoken'
        ? `refreshed-token-${pageIndex}`
        : null,
    },
    async json() {
      return {
        pageCount: 5,
        items: [
          { thread_id: `owned-${pageIndex}`, remark: `nf_${username}_170000000000${pageIndex}` },
          { thread_id: `other-${pageIndex}`, remark: 'nf_other-user_1700000000000' },
        ],
      };
    },
  });

  global.fetch = async (url) => {
    const pageIndex = Number(new URL(url).searchParams.get('PageIndex'));
    requestedPages.push(pageIndex);
    if (pageIndex === 1) return pageResponse(pageIndex);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, (6 - pageIndex) * 4));
    active -= 1;
    return pageResponse(pageIndex);
  };
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      ac_token: 'test-ac-token',
    });
    const listed = await invoke(acList, { method: 'GET', headers: authHeaders(username) });

    assert.equal(listed.statusCode, 200);
    assert.equal(maxActive, 4);
    assert.deepEqual(requestedPages, [1, 2, 3, 4, 5]);
    assert.deepEqual(
      listed.body.data.items.map(item => item.thread_id),
      ['owned-1', 'owned-2', 'owned-3', 'owned-4', 'owned-5'],
    );
    assert.equal(listed.body.data.items.some(item => item.thread_id.startsWith('other-')), false);
    assert.equal(FakeRedis.values.get('ac_token'), 'refreshed-token-1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AC list fails the whole request when a required page fails', async () => {
  const originalFetch = global.fetch;
  const username = 'failed-page-user';
  global.fetch = async (url) => {
    const pageIndex = Number(new URL(url).searchParams.get('PageIndex'));
    if (pageIndex === 3) return response({ error: 'upstream failure' }, 503);
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      async json() {
        return {
          pageCount: 4,
          items: [{ thread_id: `owned-${pageIndex}`, remark: `nf_${username}_170000000000${pageIndex}` }],
        };
      },
    };
  };
  try {
    FakeRedis.reset({
      [`nf_user_data:${username}`]: JSON.stringify({}),
      ac_token: 'test-ac-token',
    });
    const listed = await invoke(acList, { method: 'GET', headers: authHeaders(username) });

    assert.equal(listed.statusCode, 503);
    assert.equal(listed.body.success, false);
    assert.equal(listed.body.error, 'AC API error');
    assert.equal(FakeRedis.values.has('ac_thread_owner:owned-1'), false);
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
