const assert = require('node:assert/strict');
const test = require('node:test');

const savedEnv = {
  username: process.env.OIDC_USERNAME,
  password: process.env.OIDC_PASSWORD,
  kvUrl: process.env.KV_REST_API_URL,
  kvToken: process.env.KV_REST_API_TOKEN,
};
process.env.OIDC_USERNAME = 'oidc-test-user';
process.env.OIDC_PASSWORD = 'oidc-test-password';
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const oidc = require('../api/_lib/oidc-token');
const { bookstoreFetch } = require('../api/_lib/bookstore-fetch');

test.after(() => {
  oidc._resetForTests();
  if (savedEnv.username === undefined) delete process.env.OIDC_USERNAME; else process.env.OIDC_USERNAME = savedEnv.username;
  if (savedEnv.password === undefined) delete process.env.OIDC_PASSWORD; else process.env.OIDC_PASSWORD = savedEnv.password;
  if (savedEnv.kvUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = savedEnv.kvUrl;
  if (savedEnv.kvToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = savedEnv.kvToken;
});

test('concurrent bookstore token requests use one OIDC refresh', async () => {
  const originalFetch = global.fetch;
  let refreshes = 0;
  global.fetch = async url => {
    assert.equal(String(url), 'https://sts.anystories.app/connect/token');
    refreshes += 1;
    return { ok: true, status: 200, json: async () => ({ access_token: 'token-one', expires_in: 3600 }) };
  };
  oidc._resetForTests();
  try {
    const [first, second] = await Promise.all([oidc.getBookstoreToken(), oidc.getBookstoreToken()]);
    assert.equal(first, 'token-one');
    assert.equal(second, 'token-one');
    assert.equal(refreshes, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a bookstore 401 refreshes the token and retries once', async () => {
  const originalFetch = global.fetch;
  let refreshes = 0;
  let upstreamCalls = 0;
  global.fetch = async url => {
    if (String(url) === 'https://sts.anystories.app/connect/token') {
      refreshes += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: `token-${refreshes}`, expires_in: 3600 }) };
    }
    upstreamCalls += 1;
    return { ok: upstreamCalls === 2, status: upstreamCalls === 1 ? 401 : 200 };
  };
  oidc._resetForTests();
  try {
    const result = await bookstoreFetch('https://bookstore.test/resource');
    assert.equal(result.response.status, 200);
    assert.equal(refreshes, 2);
    assert.equal(upstreamCalls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a bookstore 400 token-expired response refreshes the token and retries once', async () => {
  const originalFetch = global.fetch;
  let refreshes = 0;
  let upstreamCalls = 0;
  global.fetch = async url => {
    if (String(url) === 'https://sts.anystories.app/connect/token') {
      refreshes += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: `token-${refreshes}`, expires_in: 3600 }) };
    }
    upstreamCalls += 1;
    if (upstreamCalls === 1) {
      const body = { code: 401, msg: 'Token expired' };
      return { ok: false, status: 400, json: async () => body, clone() { return this; } };
    }
    return { ok: true, status: 200, json: async () => ({ data: true }), clone() { return this; } };
  };
  oidc._resetForTests();
  try {
    const result = await bookstoreFetch('https://bookstore.test/resource');
    assert.equal(result.response.status, 200);
    assert.equal(refreshes, 2);
    assert.equal(upstreamCalls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a forced refresh reloads rotated OIDC credentials', async () => {
  const originalFetch = global.fetch;
  const passwords = [];
  global.fetch = async (_url, options = {}) => {
    const body = new URLSearchParams(String(options.body || ''));
    passwords.push(body.get('password'));
    return { ok: true, status: 200, json: async () => ({ access_token: `token-${passwords.length}`, expires_in: 3600 }) };
  };
  oidc._resetForTests();
  process.env.OIDC_PASSWORD = 'old-password';
  try {
    assert.equal(await oidc.getBookstoreToken(), 'token-1');
    process.env.OIDC_PASSWORD = 'rotated-password';
    assert.equal(await oidc.getBookstoreToken({ forceRefresh: true }), 'token-2');
    assert.deepEqual(passwords, ['old-password', 'rotated-password']);
  } finally {
    process.env.OIDC_PASSWORD = 'oidc-test-password';
    global.fetch = originalFetch;
  }
});

test('callers can bound the OIDC refresh wait', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
  });
  oidc._resetForTests();
  const started = Date.now();
  try {
    const token = await oidc.getBookstoreToken({ forceRefresh: true, timeoutMs: 25 });
    assert.equal(token, null);
    assert.ok(Date.now() - started < 500, 'custom timeout should bound the refresh wait');
  } finally {
    global.fetch = originalFetch;
    oidc._resetForTests();
  }
});

test('a later caller keeps its own timeout while a refresh is already running', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
  });
  oidc._resetForTests();
  try {
    const first = oidc.getBookstoreToken({ forceRefresh: true, timeoutMs: 250 });
    await new Promise(resolve => setTimeout(resolve, 10));
    const started = Date.now();
    const second = await oidc.getBookstoreToken({ timeoutMs: 25 });
    assert.equal(second, null);
    assert.ok(Date.now() - started < 150, 'later caller should not inherit the first refresh timeout');
    await first;
  } finally {
    global.fetch = originalFetch;
    oidc._resetForTests();
  }
});
