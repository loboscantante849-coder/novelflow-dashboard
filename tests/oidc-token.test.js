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
