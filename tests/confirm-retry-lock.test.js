const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'confirm-retry-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
const tokenPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
process.env.NOVELSPA_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${tokenPayload}.test-signature`;
delete process.env.OIDC_USERNAME;
delete process.env.OIDC_PASSWORD;

const hashes = new Map();
const sets = new Map();

FakeRedis.prototype.hget = async function (key, field) {
  return hashes.get(key)?.get(field) ?? null;
};
FakeRedis.prototype.hset = async function (key, values) {
  if (!hashes.has(key)) hashes.set(key, new Map());
  for (const [field, value] of Object.entries(values)) hashes.get(key).set(field, value);
  return Object.keys(values).length;
};
FakeRedis.prototype.smembers = async function (key) {
  return Array.from(sets.get(key) || []);
};
FakeRedis.prototype.sadd = async function (key, value) {
  if (!sets.has(key)) sets.set(key, new Set());
  sets.get(key).add(value);
  return 1;
};

const confirm = require('../api/confirm');
const { signAccessToken } = require('../api/_lib/auth');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function request(token) {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': '192.0.2.50',
    },
    body: {
      bookName: 'Test Book',
      bookId: 'book-1',
      bookTitle: 'Test Book',
      lang: 'en',
    },
  };
}

function requestWithId(token, requestId) {
  const req = request(token);
  req.body.requestId = requestId;
  return req;
}

function bookstoreBookResponse(cover = 'https://cdn.example/book-1.jpg') {
  return response({ data: { data: [{ bookId: 'book-1', cover }] } });
}

test('a network retry cannot allocate a second code while the first request is running', async () => {
  FakeRedis.reset();
  hashes.clear();
  sets.clear();

  const originalFetch = global.fetch;
  let releaseCodeRequest;
  let markCodeRequestStarted;
  const codeRequestStarted = new Promise(resolve => { markCodeRequestStarted = resolve; });

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) {
      markCodeRequestStarted();
      await new Promise(resolve => { releaseCodeRequest = resolve; });
      return response({ data: true });
    }
    if (target.includes('/book/booklist?')) return bookstoreBookResponse();
    if (target.includes('SocialMediaChannelConfig')) return response({ data: { data: [] } });
    if (target.endsWith('/SocialMediaLinkConfig') && !options.body) return response({}, 404);
    if (target.endsWith('/SocialMediaLinkConfig')) return response({ code: 200, data: 'link-id-1234567890' });
    if (target.includes('/SocialMediaLinkConfig/link-id-1234567890')) {
      return response({ code: 200, data: { shortUrl: 'social.example/s/test' } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const token = signAccessToken({ username: 'alice' });
    const first = invoke(confirm, request(token));
    await codeRequestStarted;

    const retry = await invoke(confirm, request(token));
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.status, 'pending');
    assert.match(retry.body.message, /being created/i);

    releaseCodeRequest();
    const completed = await first;
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.body.status, 'completed');
    assert.equal(completed.body.code, 1000);

    const dedup = JSON.parse(FakeRedis.values.get('nf_confirm_dedup:alice:book-1'));
    assert.equal(dedup.code, '1000');
    assert.equal(dedup.pending, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('occupied codes advance atomically across a dense collision range', async () => {
  FakeRedis.reset({ nf_next_code: 5555 });
  hashes.clear();
  sets.clear();

  const originalFetch = global.fetch;
  const attemptedCodes = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) {
      const code = JSON.parse(options.body).keyword;
      attemptedCodes.push(code);
      return response({ data: code === '5656' });
    }
    if (target.includes('/book/booklist?')) return bookstoreBookResponse();
    if (target.includes('SocialMediaChannelConfig')) return response({ data: { data: [] } });
    if (target.endsWith('/SocialMediaLinkConfig') && options.body) return response({ code: 200, data: 'link-id-1234567890' });
    if (target.includes('/SocialMediaLinkConfig/link-id-1234567890')) {
      return response({ code: 200, data: { shortUrl: 'social.example/s/test' } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const token = signAccessToken({ username: 'alice' });
    const result = await invoke(confirm, request(token));
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'completed');
    assert.equal(result.body.code, 5656);
    assert.deepEqual(attemptedCodes, ['5555', '5656']);
    assert.equal(FakeRedis.values.get('nf_next_code'), 5557);
  } finally {
    global.fetch = originalFetch;
  }
});

test('one book can have multiple independent promotion links and codes', async () => {
  FakeRedis.reset();
  hashes.clear();
  sets.clear();
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) return response({ data: true });
    if (target.includes('/book/booklist?')) return bookstoreBookResponse();
    if (target.includes('SocialMediaChannelConfig')) return response({ data: { data: [] } });
    if (target.endsWith('/SocialMediaLinkConfig') && options.body) {
      const code = JSON.parse(options.body).linkName.slice(0, 4);
      return response({ code: 200, data: `link-id-${code}-123456` });
    }
    if (target.includes('/SocialMediaLinkConfig/link-id-')) return response({ code: 200, data: { shortUrl: `social.example/s/${Date.now()}` } });
    throw new Error(`Unexpected fetch: ${target}`);
  };
  try {
    const token = signAccessToken({ username: 'alice' });
    const first = await invoke(confirm, requestWithId(token, 'request-one-123'));
    const second = await invoke(confirm, requestWithId(token, 'request-two-456'));
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.notEqual(String(first.body.code), String(second.body.code));
    const saved = JSON.parse(FakeRedis.values.get('nf_user_data:alice'));
    assert.equal(saved.myBooks.filter(book => book.bookId === 'book-1').length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('bookstore 400 keyword collisions advance to the next code', async () => {
  FakeRedis.reset({ nf_next_code: 5557 });
  hashes.clear();
  sets.clear();

  const originalFetch = global.fetch;
  const attemptedCodes = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) {
      const code = JSON.parse(options.body).keyword;
      attemptedCodes.push(code);
      if (code !== '5658') {
        const body = { code: 400, msg: `Keyword: ${code} have existed!` };
        return { ...response(body, 400), clone() { return this; } };
      }
      return response({ data: true });
    }
    if (target.includes('/book/booklist?')) return bookstoreBookResponse();
    if (target.includes('SocialMediaChannelConfig')) return response({ data: { data: [] } });
    if (target.endsWith('/SocialMediaLinkConfig') && options.body) return response({ code: 200, data: 'link-id-1234567890' });
    if (target.includes('/SocialMediaLinkConfig/link-id-1234567890')) {
      return response({ code: 200, data: { shortUrl: 'social.example/s/test' } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const token = signAccessToken({ username: 'alice' });
    const result = await invoke(confirm, request(token));
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'completed');
    assert.equal(result.body.code, 5658);
    assert.deepEqual(attemptedCodes, ['5557', '5658']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('allocation failure releases the lock so a retry can create the link', async () => {
  FakeRedis.reset();
  hashes.clear();
  sets.clear();

  const originalFetch = global.fetch;
  let allocationShouldSucceed = false;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) return response({ data: allocationShouldSucceed });
    if (target.includes('/book/booklist?')) return bookstoreBookResponse();
    if (target.includes('SocialMediaChannelConfig')) return response({ data: { data: [] } });
    if (target.endsWith('/SocialMediaLinkConfig') && options.body) return response({ code: 200, data: 'link-id-1234567890' });
    if (target.includes('/SocialMediaLinkConfig/link-id-1234567890')) {
      return response({ code: 200, data: { shortUrl: 'social.example/s/test' } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const token = signAccessToken({ username: 'alice' });
    const failed = await invoke(confirm, request(token));
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.body.code, 'CODE_ALLOCATION_FAILED');
    assert.equal(FakeRedis.values.has('nf_confirm_dedup:alice:book-1'), false);

    allocationShouldSucceed = true;
    const retried = await invoke(confirm, request(token));
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.body.status, 'completed');
    assert.ok(retried.body.code);
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejected bookstore authentication is retryable and does not leave a pending lock', async () => {
  FakeRedis.reset();
  hashes.clear();
  sets.clear();

  const originalFetch = global.fetch;
  global.fetch = async url => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) return response({}, 401);
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const token = signAccessToken({ username: 'alice' });
    const result = await invoke(confirm, request(token));
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, 'UPSTREAM_AUTH_UNAVAILABLE');
    assert.equal(FakeRedis.values.has('nf_confirm_dedup:alice:book-1'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a legacy 24-hour pending failure is cleared and retried immediately', async () => {
  const dedupKey = 'nf_confirm_dedup:alice:book-1';
  FakeRedis.reset({
    [dedupKey]: JSON.stringify({ pending: true, submissionId: 'legacy-failed-request' }),
  });
  FakeRedis.expiries.set(dedupKey, 86400);
  hashes.clear();
  sets.clear();

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) return response({ data: true });
    if (target.includes('/book/booklist?')) return bookstoreBookResponse();
    if (target.includes('SocialMediaChannelConfig')) return response({ data: { data: [] } });
    if (target.endsWith('/SocialMediaLinkConfig') && options.body) return response({ code: 200, data: 'link-id-1234567890' });
    if (target.includes('/SocialMediaLinkConfig/link-id-1234567890')) {
      return response({ code: 200, data: { shortUrl: 'social.example/s/test' } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const token = signAccessToken({ username: 'alice' });
    const result = await invoke(confirm, request(token));
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'completed');
    assert.ok(result.body.code);
    assert.notEqual(JSON.parse(FakeRedis.values.get(dedupKey)).submissionId, 'legacy-failed-request');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a retry restores the submission index after a transient persistence failure', async () => {
  FakeRedis.reset();
  hashes.clear();
  sets.clear();

  const originalFetch = global.fetch;
  const originalHset = FakeRedis.prototype.hset;
  let failedWrites = 0;
  let codeCreationCalls = 0;
  FakeRedis.prototype.hset = async function (key, values) {
    if (key === 'nf_subs' && failedWrites < 2) {
      failedWrites += 1;
      throw new Error('temporary persistence failure');
    }
    return originalHset.call(this, key, values);
  };
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) {
      codeCreationCalls += 1;
      return response({ data: true });
    }
    if (target.includes('/book/booklist?')) return bookstoreBookResponse();
    if (target.includes('SocialMediaChannelConfig')) return response({ data: { data: [] } });
    if (target.endsWith('/SocialMediaLinkConfig') && options.body) return response({ code: 200, data: 'link-id-1234567890' });
    if (target.includes('/SocialMediaLinkConfig/link-id-1234567890')) {
      return response({ code: 200, data: { shortUrl: 'social.example/s/test' } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const token = signAccessToken({ username: 'alice' });
    const failed = await invoke(confirm, request(token));
    assert.equal(failed.statusCode, 502);

    const recovery = JSON.parse(FakeRedis.values.get('nf_confirm_dedup:alice:book-1'));
    assert.equal(recovery.code, '1000');
    assert.equal(recovery.submission.code, '1000');
    assert.equal(hashes.get('nf_book_covers').get('book-1'), 'https://cdn.example/book-1.jpg');

    const retried = await invoke(confirm, request(token));
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.body.status, 'existing');
    assert.equal(retried.body.code, '1000');
    assert.equal(codeCreationCalls, 1);
    assert.ok(hashes.get('nf_subs').has('1000'));
    assert.ok(sets.get('nf_user_subs:alice').has('1000'));
  } finally {
    FakeRedis.prototype.hset = originalHset;
    global.fetch = originalFetch;
  }
});

test('a successful confirmation stores the trusted bookstore cover everywhere', async () => {
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({
      myBooks: [{ bookId: 'book-1', title: 'Old title', cover: 'https://cdn.example/cover.jpg' }],
    }),
  });
  hashes.clear();
  sets.clear();

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) return response({ data: true });
    if (target.includes('/book/booklist?')) return bookstoreBookResponse('http://cdn.example/fresh-cover.jpg');
    if (target.includes('SocialMediaChannelConfig')) return response({ data: { data: [] } });
    if (target.endsWith('/SocialMediaLinkConfig') && options.body) return response({ code: 200, data: 'link-id-1234567890' });
    if (target.includes('/SocialMediaLinkConfig/link-id-1234567890')) {
      return response({ code: 200, data: { shortUrl: 'social.example/s/test' } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const token = signAccessToken({ username: 'alice' });
    const result = await invoke(confirm, request(token));
    assert.equal(result.statusCode, 200);
    const saved = JSON.parse(FakeRedis.values.get('nf_user_data:alice'));
    assert.equal(saved.myBooks.length, 2);
    const createdBook = saved.myBooks.find(book => book.code === '1000');
    assert.equal(createdBook.cover, 'https://cdn.example/fresh-cover.jpg');
    assert.equal(createdBook.code, '1000');
    const submission = JSON.parse(hashes.get('nf_subs').get('1000'));
    assert.equal(submission.cover, 'https://cdn.example/fresh-cover.jpg');
    assert.equal(hashes.get('nf_book_covers').get('book-1'), 'https://cdn.example/fresh-cover.jpg');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a bookstore cover failure preserves an existing synced cover', async () => {
  FakeRedis.reset({
    'nf_user_data:alice': JSON.stringify({
      myBooks: [{ bookId: 'book-1', title: 'Old title', cover: 'https://cdn.example/existing.jpg' }],
    }),
  });
  hashes.clear();
  sets.clear();

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('savebookpromotionkeywords')) return response({ data: true });
    if (target.includes('/book/booklist?')) return response({ data: { data: [] } });
    if (target.includes('SocialMediaChannelConfig')) return response({ data: { data: [] } });
    if (target.endsWith('/SocialMediaLinkConfig') && options.body) return response({ code: 200, data: 'link-id-1234567890' });
    if (target.includes('/SocialMediaLinkConfig/link-id-1234567890')) {
      return response({ code: 200, data: { shortUrl: 'social.example/s/test' } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const token = signAccessToken({ username: 'alice' });
    const result = await invoke(confirm, request(token));
    assert.equal(result.statusCode, 200);
    const saved = JSON.parse(FakeRedis.values.get('nf_user_data:alice'));
    assert.equal(saved.myBooks.find(book => book.code === '1000').cover, 'https://cdn.example/existing.jpg');
    const submission = JSON.parse(hashes.get('nf_subs').get('1000'));
    assert.equal(submission.cover, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});
