const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'confirm-retry-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.NOVELSPA_TOKEN = 'bookstore-test-token';
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
