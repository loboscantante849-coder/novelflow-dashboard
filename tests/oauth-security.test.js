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

const statsData = require('../api/_lib/stats-data');
statsData.getAdIdDetails = async () => require('../ad_id_details.json');
statsData.getLiveAdIdDetails = statsData.getAdIdDetails;

const discordStart = require('../api/auth/discord-start');
const callback = require('../api/auth/callback');
const discordActivity = require('../api/auth/discord-activity');
const register = require('../api/auth/register');
const { verifyJWT } = require('../api/_lib/auth');
const { ensureReferralCode } = require('../api/_lib/referrals');

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
  FakeRedis.reset({
    'nf_discord_username:discord-1': 'discord-user',
    'nf_identity_owner:discord-user': 'discord:discord-1',
    'nf_user_data:discord-user': JSON.stringify({}),
  });
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

test('a new Discord account binds the HttpOnly referral hint once', async () => {
  const invite = await ensureReferralCode(new FakeRedis(), 'campaign-parent');
  const start = await invokeRedirect(discordStart, { query: { ref: invite.referral_code } });
  const startCookies = start.headers['set-cookie'];
  assert.ok(Array.isArray(startCookies));
  const stateCookie = startCookies.find(cookie => cookie.startsWith('nf_oauth_state='));
  const referralCookie = startCookies.find(cookie => cookie.startsWith('nf_referral_code='));
  const state = stateCookie.match(/^nf_oauth_state=([^;]+)/)[1];
  assert.ok(referralCookie);

  global.fetch = async url => {
    if (String(url).includes('/oauth2/token')) return response({ access_token: 'discord-access-token' });
    return response({ id: 'discord-referred', username: 'discord-child', global_name: 'Discord Child', avatar: null });
  };
  const result = await invokeRedirect(callback, {
    headers: { cookie: `nf_oauth_state=${state}; nf_referral_code=${invite.referral_code}` },
    query: { code: 'authorization-code', state },
  });
  assert.equal(result.headers.location, '/app-v2?auth=success');
  assert.equal(JSON.parse(FakeRedis.values.get('nf_referrer_of:v1:discord-child')).parent, 'campaign-parent');
  assert.ok(result.headers['set-cookie'].some(cookie => cookie.startsWith('nf_referral_code=;')));
});

test('Discord activity rejects disabled accounts and never returns access tokens', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('/oauth2/token')) return response({ access_token: 'discord-access-token' });
    return response({ id: 'discord-1', username: 'discord-user', global_name: 'Discord User', avatar: null });
  };

  FakeRedis.reset({
    'nf_discord_username:discord-1': 'discord-user',
    'nf_identity_owner:discord-user': 'discord:discord-1',
    'nf_user_data:discord-user': JSON.stringify({ disabled: true }),
  });
  const disabled = await invokeRedirect(discordActivity, {
    method: 'POST', body: { code: 'authorization-code' },
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.body.code, 'ACCOUNT_DISABLED');
  assert.equal(disabled.headers['set-cookie'], undefined);

  FakeRedis.reset({
    'nf_discord_username:discord-1': 'discord-user',
    'nf_identity_owner:discord-user': 'discord:discord-1',
    'nf_user_data:discord-user': JSON.stringify({}),
  });
  const success = await invokeRedirect(discordActivity, {
    method: 'POST', body: { code: 'authorization-code' },
  });
  assert.equal(success.statusCode, 200);
  assert.equal(success.body.success, true);
  assert.equal(Object.hasOwn(success.body, 'token'), false);
  assert.ok(Array.isArray(success.headers['set-cookie']));
});

test('Discord cannot claim a legacy account that predates identity ownership records', async () => {
  FakeRedis.reset({
    'nf_user_data:legacy-wallet-user': JSON.stringify({ bonus_balance: 40 }),
    'nf_user_pass:legacy-wallet-user': 'legacy-password-hash',
  });
  global.fetch = async url => {
    if (String(url).includes('/oauth2/token')) return response({ access_token: 'discord-access-token' });
    return response({ id: 'discord-attacker', username: 'legacy-wallet-user', global_name: 'Legacy Wallet User', avatar: null });
  };

  const state = 'legacy-wallet-conflict';
  const callbackResult = await invokeRedirect(callback, {
    headers: { cookie: `nf_oauth_state=${state}` },
    query: { code: 'authorization-code', state },
  });
  assert.equal(callbackResult.headers.location, '/app-v2?auth=identity_conflict');
  assert.equal(FakeRedis.values.has('nf_identity_owner:legacy-wallet-user'), false);
  assert.equal(String(callbackResult.headers['set-cookie']).includes('nf_token='), false);

  const activityResult = await invokeRedirect(discordActivity, {
    method: 'POST',
    body: { code: 'authorization-code' },
  });
  assert.equal(activityResult.statusCode, 409);
  assert.equal(activityResult.body.code, 'ACCOUNT_IDENTITY_CONFLICT');
  assert.equal(activityResult.headers['set-cookie'], undefined);
  assert.equal(FakeRedis.values.has('nf_discord_username:discord-attacker'), false);
});

test('Discord cannot claim a promoter reserved by the reporting snapshot', async () => {
  global.fetch = async url => {
    if (String(url).includes('/oauth2/token')) return response({ access_token: 'discord-access-token' });
    return response({ id: 'discord-promoter-collision', username: 'tom', global_name: 'Tom', avatar: null });
  };
  const state = 'protected-promoter-conflict';
  const result = await invokeRedirect(callback, {
    headers: { cookie: `nf_oauth_state=${state}` },
    query: { code: 'authorization-code', state },
  });

  assert.equal(result.headers.location, '/app-v2?auth=identity_conflict');
  assert.equal(FakeRedis.values.has('nf_identity_owner:tom'), false);
  assert.equal(FakeRedis.values.has('nf_discord_username:discord-promoter-collision'), false);
  assert.equal(String(result.headers['set-cookie']).includes('nf_token='), false);
});

test('a local account and Discord account cannot share one username identity', async () => {
  const local = await invokeRedirect(register, {
    method: 'POST',
    headers: { 'x-forwarded-for': '192.0.2.80' },
    body: { username: 'targetuser', password: 'Password1' },
  });
  assert.equal(local.statusCode, 200);
  assert.equal(FakeRedis.values.get('nf_identity_owner:targetuser'), 'local:targetuser');

  global.fetch = async url => {
    if (String(url).includes('/oauth2/token')) return response({ access_token: 'discord-access-token' });
    return response({ id: 'discord-target', username: 'targetuser', global_name: 'Target User', avatar: null });
  };
  const state = 'identity-conflict-state';
  const discord = await invokeRedirect(callback, {
    headers: { cookie: `nf_oauth_state=${state}` },
    query: { code: 'authorization-code', state },
  });

  assert.equal(discord.statusCode, 302);
  assert.equal(discord.headers.location, '/app-v2?auth=identity_conflict');
  assert.equal(FakeRedis.values.get('nf_identity_owner:targetuser'), 'local:targetuser');
  assert.equal(String(discord.headers['set-cookie']).includes('nf_token='), false);
});

test('Discord username changes retain the original storage identity', async () => {
  FakeRedis.reset({
    'nf_discord_username:discord-1': 'old-handle',
    'nf_identity_owner:old-handle': 'discord:discord-1',
    'nf_user_data:old-handle': JSON.stringify({ points: 25 }),
  });
  global.fetch = async url => {
    if (String(url).includes('/oauth2/token')) return response({ access_token: 'discord-access-token' });
    return response({ id: 'discord-1', username: 'new-handle', global_name: 'Display Name', avatar: null });
  };
  const state = 'discord-rename-state';
  const result = await invokeRedirect(callback, {
    headers: { cookie: `nf_oauth_state=${state}` },
    query: { code: 'authorization-code', state },
  });

  assert.equal(result.headers.location, '/app-v2?auth=success');
  const accessCookie = result.headers['set-cookie'].find(cookie => cookie.startsWith('nf_token='));
  const accessToken = accessCookie.match(/^nf_token=([^;]+)/)[1];
  const payload = verifyJWT(accessToken);
  assert.equal(payload.username, 'old-handle');
  assert.equal(payload.principal, 'discord:discord-1');
  assert.equal(FakeRedis.values.has('nf_user_data:new-handle'), false);
});
