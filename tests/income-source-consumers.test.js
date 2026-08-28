const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'income-source-consumers-test-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

let currentAdData;
const statsData = require('../api/_lib/stats-data');
const originals = {
  getAdIdDetails: statsData.getAdIdDetails,
  getLegacyDataJson: statsData.getLegacyDataJson,
  getLegacyLinkStats: statsData.getLegacyLinkStats,
};
statsData.getAdIdDetails = async () => currentAdData;
statsData.getLegacyDataJson = async () => ({
  last_updated: '2026-08-20T00:00:00.000Z',
  users: { foo_bar: { links: [{ ad_id: 'legacy-link', dn: 99 }] } },
});
statsData.getLegacyLinkStats = async () => ({
  last_updated: '2026-08-20T00:00:00.000Z',
  links: { 'legacy-link': { dn_income: 99 } },
});

delete require.cache[require.resolve('../api/my-stats')];
delete require.cache[require.resolve('../api/per-link-stats')];
const myStats = require('../api/my-stats');
const perLinkStats = require('../api/per-link-stats');
const confirm = require('../api/confirm');
const { signAccessToken } = require('../api/_lib/auth');

function authHeaders(username) {
  return {
    authorization: `Bearer ${signAccessToken({ type: 'local', username, principal: `local:${username}` })}`,
  };
}

function sourceData() {
  return {
    last_updated: '2026-08-20T00:00:00.000Z',
    by_promoter: {
      foo_bar: { display_name: 'Foo Bar', links: ['trusted-link'], codes: [], invites: [] },
    },
    ad_ids: {
      'trusted-link': {
        username: 'Foo.Bar',
        username_canon: 'foo_bar',
        stats: { pull_uv: 4, new_uv: 2, dn_income: 8 },
        daily: [],
      },
    },
  };
}

test.beforeEach(() => {
  currentAdData = sourceData();
  FakeRedis.reset({ 'nf_user_data:foo.bar': JSON.stringify({}) });
});

test.after(() => {
  Object.assign(statsData, originals);
});

test('stats consumers accept one verified wallet owner', async () => {
  const headers = authHeaders('foo.bar');
  const [summary, links] = await Promise.all([
    invoke(myStats, { method: 'GET', headers, query: {} }),
    invoke(perLinkStats, { method: 'GET', headers, query: {} }),
  ]);
  assert.equal(summary.statusCode, 200);
  assert.equal(links.statusCode, 200);
});

test('stats consumers accept an authenticated Discord display-name hint without changing the account target', async () => {
  const token = signAccessToken({
    type: 'discord',
    username: 'foo.bar',
    globalName: 'Foo Bar',
    principal: 'discord:foo-display-1',
    discordId: 'foo-display-1',
  });
  const headers = { authorization: `Bearer ${token}` };
  const [summary, links] = await Promise.all([
    invoke(myStats, { method: 'GET', headers, query: { username: 'Foo Bar' } }),
    invoke(perLinkStats, { method: 'GET', headers, query: { username: 'Foo Bar' } }),
  ]);
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.body.username, 'foo.bar');
  assert.equal(summary.body.total_visits, 4);
  assert.equal(links.statusCode, 200);
  assert.equal(links.body.username, 'foo.bar');
  assert.equal(links.body.total_visits, 4);
});

test('stats consumers read a sole historical Cons wallet key through the canonical session', async () => {
  currentAdData = {
    last_updated: '2026-08-20T00:00:00.000Z',
    by_promoter: {
      cons_espher: { display_name: 'Cons Espher', links: ['cons-link'], codes: [], invites: [] },
    },
    ad_ids: {
      'cons-link': {
        username: '@Cons Espher',
        username_canon: 'cons_espher',
        stats: { pull_uv: 7, new_uv: 3, dn_income: 6 },
        daily: [],
      },
    },
  };
  FakeRedis.reset({ 'nf_user_data:@cons espher': JSON.stringify({}) });
  const token = signAccessToken({
    type: 'discord',
    username: 'cons_espher',
    globalName: 'Cons Espher',
    principal: 'discord:cons-1',
    discordId: 'cons-1',
  });
  const headers = { authorization: `Bearer ${token}` };
  const [summary, links] = await Promise.all([
    invoke(myStats, { method: 'GET', headers, query: {} }),
    invoke(perLinkStats, { method: 'GET', headers, query: {} }),
  ]);
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.body.username, 'cons_espher');
  assert.equal(summary.body.total_visits, 7);
  assert.equal(links.statusCode, 200);
  assert.equal(links.body.username, 'cons_espher');
  assert.equal(links.body.total_visits, 7);
});

test('stats consumers still reject a display-name hint belonging to another account', async () => {
  const token = signAccessToken({
    type: 'discord',
    username: 'foo.bar',
    globalName: 'Foo Bar',
    principal: 'discord:foo-display-2',
    discordId: 'foo-display-2',
  });
  const response = await invoke(myStats, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    query: { username: 'other.account' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'FORBIDDEN');

  // Per-link stats deliberately ignore a non-admin target hint and remain
  // scoped to the JWT account; the hint must never select another account.
  const perLinkResponse = await invoke(perLinkStats, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    query: { username: 'other.account' },
  });
  assert.equal(perLinkResponse.statusCode, 200);
  assert.equal(perLinkResponse.body.username, 'foo.bar');
  assert.equal(perLinkResponse.body.total_visits, 4);
});

test('stats consumers reject multiple approved wallets for one source', async () => {
  currentAdData.ad_ids['trusted-alias'] = {
    username: '@Foo.Bar',
    username_canon: 'foo_bar',
    daily: [],
  };
  FakeRedis.values.set('nf_user_data:@foo.bar', JSON.stringify({}));
  const headers = authHeaders('foo.bar');
  const [summary, links] = await Promise.all([
    invoke(myStats, { method: 'GET', headers, query: {} }),
    invoke(perLinkStats, { method: 'GET', headers, query: {} }),
  ]);
  assert.equal(summary.statusCode, 409);
  assert.equal(summary.body.code, 'INCOME_SOURCE_OWNER_CONFLICT');
  assert.equal(links.statusCode, 409);
  assert.equal(links.body.code, 'INCOME_SOURCE_OWNER_CONFLICT');
});

test('ordinary stats fail closed instead of using legacy income without the owner snapshot', async () => {
  currentAdData = null;
  FakeRedis.reset({ 'nf_user_data:foo_bar': JSON.stringify({}) });
  const headers = authHeaders('foo_bar');
  const [summary, links] = await Promise.all([
    invoke(myStats, { method: 'GET', headers, query: {} }),
    invoke(perLinkStats, { method: 'GET', headers, query: {} }),
  ]);
  assert.equal(summary.statusCode, 503);
  assert.equal(summary.body.code, 'INCOME_SOURCE_OWNER_UNAVAILABLE');
  assert.equal(links.statusCode, 503);
  assert.equal(links.body.code, 'INCOME_SOURCE_OWNER_UNAVAILABLE');
});

test('promotion preflight establishes one source wallet before any upstream side effect', async () => {
  currentAdData = sourceData();
  currentAdData.ad_ids['trusted-alias'] = {
    username: '@Foo.Bar',
    username_canon: 'foo_bar',
    daily: [],
  };
  FakeRedis.reset();

  const attempts = await Promise.allSettled([
    confirm._test.establishWalletSourceOwnership(new FakeRedis(), 'foo.bar'),
    confirm._test.establishWalletSourceOwnership(new FakeRedis(), '@foo.bar'),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find(result => result.status === 'rejected');
  assert.ok(['INCOME_SOURCE_BUSY', 'INCOME_SOURCE_OWNER_CONFLICT'].includes(rejected.reason.code));
  const ownerWallets = ['nf_user_data:foo.bar', 'nf_user_data:@foo.bar']
    .filter(key => FakeRedis.values.has(key));
  assert.equal(ownerWallets.length, 1);
  assert.deepEqual(JSON.parse(FakeRedis.values.get(ownerWallets[0])), {});

  const losingUsername = ownerWallets[0] === 'nf_user_data:foo.bar' ? '@foo.bar' : 'foo.bar';
  await assert.rejects(
    () => confirm._test.establishWalletSourceOwnership(new FakeRedis(), losingUsername),
    error => error && error.code === 'INCOME_SOURCE_OWNER_CONFLICT',
  );
});
