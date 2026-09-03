const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'runtime-promoter-protection-test-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

let liveSnapshot;
const statsData = require('../api/_lib/stats-data');
const originalLiveLoader = statsData.getLiveAdIdDetails;
statsData.getLiveAdIdDetails = async () => liveSnapshot;
delete require.cache[require.resolve('../api/auth/register')];

const register = require('../api/auth/register');
const { resolveDiscordIdentity } = require('../api/_lib/identity');

function futureSnapshot() {
  return {
    by_promoter: {
      zz_runtime_future_creator_20260821: { display_name: 'Future Creator' },
    },
    ad_ids: {
      future_raw: {
        username: 'zz.runtime.handle.20260821',
        username_canon: 'zz_runtime_future_creator_20260821',
      },
    },
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  liveSnapshot = futureSnapshot();
});

test.after(() => {
  statsData.getLiveAdIdDetails = originalLiveLoader;
});

test('brand-new local accounts cannot pre-claim live-only source or raw identities', async () => {
  for (const username of ['zz_runtime_future_creator_20260821', 'zz.runtime.handle.20260821']) {
    FakeRedis.reset();
    const response = await invoke(register, {
      headers: { 'x-forwarded-for': `192.0.2.${username.includes('.') ? 202 : 201}` },
      body: { username, password: 'Password1' },
    });
    assert.equal(response.statusCode, 409, username);
    assert.equal(response.body.code, 'SUPPORT_RECOVERY_REQUIRED', username);
    assert.equal(Array.from(FakeRedis.values.keys()).some(key => key.startsWith('nf_user_pass:')), false);
    assert.equal(Array.from(FakeRedis.values.keys()).some(key => key.startsWith('nf_identity_owner:')), false);
  }
});

test('brand-new local registration fails closed when the live owner snapshot is unavailable', async () => {
  liveSnapshot = null;
  const response = await invoke(register, {
    headers: { 'x-forwarded-for': '192.0.2.203' },
    body: { username: 'ordinary-runtime-user', password: 'Password1' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'PROMOTER_IDENTITY_UNAVAILABLE');
  assert.equal(FakeRedis.values.has('nf_user_pass:ordinary-runtime-user'), false);
});

test('brand-new Discord identities respect live-only protection while existing mappings still sign in', async () => {
  const redis = new FakeRedis();
  const blocked = await resolveDiscordIdentity(
    redis,
    'discord-new-protected',
    'zz.runtime.handle.20260821',
    { adData: liveSnapshot },
  );
  assert.equal(blocked, null);
  assert.equal(FakeRedis.values.has('nf_discord_username:discord-new-protected'), false);

  FakeRedis.reset({ 'nf_discord_username:discord-existing': 'zz.runtime.handle.20260821' });
  const existing = await resolveDiscordIdentity(
    new FakeRedis(),
    'discord-existing',
    'changed-display-name',
    { adData: liveSnapshot },
  );
  assert.equal(existing.username, 'zz.runtime.handle.20260821');
  assert.equal(existing.principal, 'discord:discord-existing');
});
