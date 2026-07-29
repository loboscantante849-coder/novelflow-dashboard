'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'oauth-security-test-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-discord-client';
process.env.DISCORD_CLIENT_SECRET = 'test-discord-secret';
process.env.DISCORD_REDIRECT_URI = 'https://novelflow.top/api/auth/callback';

const discordStart = require('../api/auth/discord-start');
const callback = require('../api/auth/callback');
const discordActivity = require('../api/auth/discord-activity');

const originalFetch = global.fetch;

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    redirect(statusOrUrl, maybeUrl) {
      if (typeof statusOrUrl === 'number') {
        this.statusCode = statusOrUrl;
        this.headers.location = maybeUrl;
      } else {
        this.statusCode = 302;
        this.headers.location = statusOrUrl;
      }
      this.ended = true;
      return this;
    },
    end() { this.ended = true; return this; },
  };
}

async function invokeRedirect(handler, request = {}) {
  const req = {
    method: 'GET', headers: {}, query: {}, body: {},
    ...request,
  };
  req.headers = request.headers || {};
  const res = createResponse();
  await handler(req, res);
  return res;
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  global.fetch = async () => {
    throw new Error('Unexpected external request');
  };
});

test.after(() => {
  global.fetch = originalFetch;
});

test('Discord OAuth starts with a browser-bound HttpOnly state cookie', async () => {
  const result = await invokeRedirect(discordStart);
  assert.equal(result.statusCode, 302);

  const location = new URL(result.headers.location);
  assert.equal(location.origin, 'https://discord.com');
  assert.equal(location.pathname, '/api/oauth2/authorize');
  assert.equal(location.searchParams.get('client_id'), 'test-discord-client');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://novelflow.top/api/auth/callback');
  assert.equal(location.searchParams.get('scope'), 'identify');

  const cookie = String(result.headers['set-cookie']);
  const state = cookie.match(/^nf_oauth_state=([^;]+)/)?.[1];
  assert.ok(state && state.length >= 40);
  assert.equal(location.searchParams.get('state'), state);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=600/);
});

test('Discord callback rejects missing or mismatched state before token exchange', async () => {
  let externalCalls = 0;
  global.fetch = async () => { externalCalls += 1; return response({}); };

  const missing = await invokeRedirect(callback, {
    query: { code: 'authorization-code' },
  });
  assert.equal(missing.statusCode, 302);
  assert.equal(missing.headers.location, '/app-v2?auth=error');
  assert.equal(externalCalls, 0);
  assert.match(String(missing.headers['set-cookie']), /nf_oauth_state=;/);

  const mismatch = await invokeRedirect(callback, {
    headers: { cookie: 'nf_oauth_state=expected-state' },
    query: { code: 'authorization-code', state: 'other-state' },
  });
  assert.equal(mismatch.headers.location, '/app-v2?auth=error');
  assert.equal(externalCalls, 0);
});

test('Discord callback consumes valid state and clears it alongside auth cookies', async () => {
  FakeRedis.reset({ 'nf_user_data:discord-user': JSON.stringify({}) });
  let externalCalls = 0;
  global.fetch = async (url) => {
    externalCalls += 1;
    if (String(url).includes('/oauth2/token')) return response({ access_token: 'discord-access-token' });
    if (String(url).includes('/users/@me')) {
      return response({ id: 'discord-1', username: 'discord-user', global_name: 'Discord User', avatar: null });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const state = 'valid-state-value';
  const result = await invokeRedirect(callback, {
    headers: { cookie: `nf_oauth_state=${state}` },
    query: { code: 'authorization-code', state },
  });
  assert.equal(result.statusCode, 302);
  assert.equal(result.headers.location, '/app-v2?auth=success');
  assert.equal(externalCalls, 2);

  const cookies = result.headers['set-cookie'];
  assert.ok(Array.isArray(cookies));
  assert.ok(cookies.some(cookie => cookie.startsWith('nf_token=')));
  assert.ok(cookies.some(cookie => cookie.startsWith('nf_refresh=')));
  assert.ok(cookies.some(cookie => cookie.startsWith('nf_oauth_state=;')));
});

test('Discord activity rejects disabled accounts and never returns access tokens', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('/oauth2/token')) return response({ access_token: 'discord-access-token' });
    return response({ id: 'discord-1', username: 'discord-user', global_name: 'Discord User', avatar: null });
  };

  FakeRedis.reset({ 'nf_user_data:discord-user': JSON.stringify({ disabled: true }) });
  const disabled = await invokeRedirect(discordActivity, {
    method: 'POST', body: { code: 'authorization-code' },
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.body.code, 'ACCOUNT_DISABLED');
  assert.equal(disabled.headers['set-cookie'], undefined);

  FakeRedis.reset({ 'nf_user_data:discord-user': JSON.stringify({}) });
  const success = await invokeRedirect(discordActivity, {
    method: 'POST', body: { code: 'authorization-code' },
  });
  assert.equal(success.statusCode, 200);
  assert.equal(success.body.success, true);
  assert.equal(Object.hasOwn(success.body, 'token'), false);
  assert.ok(Array.isArray(success.headers['set-cookie']));
});
