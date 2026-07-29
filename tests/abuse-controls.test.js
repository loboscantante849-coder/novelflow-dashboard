'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'abuse-controls-test-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.AC_TOKEN = 'test-ac-token';
process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';

let bookstoreCalls = 0;
const bookstoreModulePath = require.resolve('../api/_lib/bookstore-fetch');
require(bookstoreModulePath);
require.cache[bookstoreModulePath].exports = {
  bookstoreFetch: async () => {
    bookstoreCalls += 1;
    return {
      response: {
        ok: true,
        status: 200,
        async json() {
          return {
            code: 200,
            data: { data: [{ bookId: 'book-1', title: 'Target Book' }] },
          };
        },
      },
      authUnavailable: false,
    };
  },
};

delete require.cache[require.resolve('../api/submit')];
const submit = require('../api/submit');
const confirm = require('../api/confirm');
const acCreate = require('../api/ac-create');
const acUpload = require('../api/ac-upload');
const claimLinks = require('../api/claim-links');
const { signAccessToken, signRefreshToken } = require('../api/_lib/auth');

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
    headers: { get: () => null },
    async json() { return body; },
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  bookstoreCalls = 0;
  process.env.KV_REST_API_URL = 'https://redis.invalid';
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.AC_TOKEN = 'test-ac-token';
  process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';
  global.fetch = async () => {
    throw new Error('Unexpected upstream request');
  };
});

test.after(() => {
  global.fetch = originalFetch;
});

test('book candidate search requires an active access-token account', async () => {
  const anonymous = await invoke(submit, {
    method: 'POST', body: { bookName: 'Target Book', lang: 'en' },
  });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(bookstoreCalls, 0);

  const refreshToken = signRefreshToken({ username: 'alice' });
  const refreshOnly = await invoke(submit, {
    method: 'POST',
    headers: { authorization: `Bearer ${refreshToken}` },
    body: { bookName: 'Target Book', lang: 'en' },
  });
  assert.equal(refreshOnly.statusCode, 401);

  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({ disabled: true }) });
  const disabled = await invoke(submit, {
    method: 'POST', headers: authHeaders(), body: { bookName: 'Target Book', lang: 'en' },
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(bookstoreCalls, 0);
});

test('book candidate search enforces user and IP limits before bookstore calls', async () => {
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({}),
    'nf_rate:submit_user:alice': 12,
  });
  const limited = await invoke(submit, {
    method: 'POST',
    headers: authHeaders('alice', { 'x-forwarded-for': '192.0.2.10' }),
    body: { bookName: 'Target Book', lang: 'en' },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(bookstoreCalls, 0);

  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({}) });
  const invalidLanguage = await invoke(submit, {
    method: 'POST', headers: authHeaders(), body: { bookName: 'Target Book', lang: 'fr' },
  });
  assert.equal(invalidLanguage.statusCode, 400);
});

test('promotion creation fails closed without storage or rate-limit state', async () => {
  const request = {
    method: 'POST',
    headers: authHeaders('alice', { 'x-forwarded-for': '192.0.2.11' }),
    body: {
      bookName: 'Target Book',
      bookId: 'book-1',
      bookTitle: 'Target Book',
      lang: 'en',
    },
  };

  delete process.env.KV_REST_API_URL;
  const noStorage = await invoke(confirm, request);
  assert.equal(noStorage.statusCode, 503);
  assert.equal(noStorage.body.code, 'STORAGE_UNAVAILABLE');

  process.env.KV_REST_API_URL = 'https://redis.invalid';
  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({}) });
  FakeRedis.error = new Error('temporary storage failure');
  const unknownLimit = await invoke(confirm, request);
  assert.equal(unknownLimit.statusCode, 503);
  assert.equal(unknownLimit.body.code, 'RATE_LIMIT_UNAVAILABLE');
  assert.equal(bookstoreCalls, 0);
});

test('AC creation rejects oversized client controls before upstream work', async () => {
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({}),
    ac_token: 'test-ac-token',
  });
  const invalidBodies = [
    { book_id: 'book-1', num: 999 },
    { book_id: 'book-1', template: 'arbitrary-template' },
    { book_id: 'book-1', start_chapter: 20, end_chapter: 2 },
    { book_id: 'book-1', ad_copy: 'x'.repeat(4001) },
    { book_id: 'book-1', reference_picture_list: ['javascript:alert(1)'] },
    { book_id: 'book-1', reference_picture_list: Array(5).fill('https://example.com/ref.jpg') },
  ];

  for (const body of invalidBodies) {
    const response = await invoke(acCreate, {
      method: 'POST', headers: authHeaders(), body,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(body).slice(0, 200));
  }
});

test('AC creation reserves atomic user and IP quotas and sends bounded values', async () => {
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({}),
    ac_token: 'test-ac-token',
  });
  let upstreamCalls = 0;
  global.fetch = async (_url, options) => {
    upstreamCalls += 1;
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.num, 3);
    assert.equal(body.relatedBook.book_id, 'book-1');
    assert.equal(body.template, 'Comic');
    assert.deepEqual(body.reference_picture_list, ['https://example.com/ref.jpg']);
    return upstreamResponse({ threadId: 'thread-1' });
  };

  const created = await invoke(acCreate, {
    method: 'POST',
    headers: authHeaders('alice', { 'x-forwarded-for': '192.0.2.20' }),
    body: {
      book_id: 'book-1', template: 'Comic', num: 3,
      reference_picture_list: ['https://example.com/ref.jpg'],
    },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(upstreamCalls, 1);
  const dayKey = [...FakeRedis.values.keys()].find(key => key.startsWith('reels_count_v2:alice:'));
  const ipKey = [...FakeRedis.values.keys()].find(key => key.startsWith('reels_ip_count_v2:192.0.2.20:'));
  assert.equal(FakeRedis.values.get(dayKey), 1);
  assert.equal(FakeRedis.values.get(ipKey), 1);
  assert.equal(FakeRedis.values.get('ac_thread_owner:thread-1'), 'alice');
});

test('AC daily quota cannot be bypassed by another concurrent increment', async () => {
  const today = (() => {
    const now = new Date();
    const laNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    return `${laNow.getFullYear()}-${String(laNow.getMonth() + 1).padStart(2, '0')}-${String(laNow.getDate()).padStart(2, '0')}`;
  })();
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({}),
    ac_token: 'test-ac-token',
    [`reels_count_v2:alice:${today}`]: 7,
  });

  const limited = await invoke(acCreate, {
    method: 'POST',
    headers: authHeaders('alice', { 'x-forwarded-for': '192.0.2.30' }),
    body: { book_id: 'book-1', num: 1 },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(FakeRedis.values.get(`reels_count_v2:alice:${today}`), 8);
});

test('AC upload rejects declared and streamed oversized requests before Blob writes', async () => {
  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({}) });
  const declared = await invoke(acUpload, {
    method: 'POST',
    headers: authHeaders('alice', {
      'content-type': 'multipart/form-data; boundary=test-boundary',
      'content-length': String(11 * 1024 * 1024),
    }),
  });
  assert.equal(declared.statusCode, 413);

  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({}) });
  const streamed = await invoke(acUpload, {
    method: 'POST',
    headers: authHeaders('alice', {
      'content-type': 'multipart/form-data; boundary=test-boundary',
    }),
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(11 * 1024 * 1024);
    },
  });
  assert.equal(streamed.statusCode, 413);
});

test('legacy anonymous code claiming is closed without mutating business data', async () => {
  FakeRedis.reset({
    nf_subs: { '10001': JSON.stringify({ discordUsername: 'Anonymous' }) },
  });
  const response = await invoke(claimLinks, {
    method: 'POST', headers: authHeaders(), body: { codes: ['10001'] },
  });
  assert.equal(response.statusCode, 410);
  assert.deepEqual(FakeRedis.values.get('nf_subs'), {
    '10001': JSON.stringify({ discordUsername: 'Anonymous' }),
  });
});
