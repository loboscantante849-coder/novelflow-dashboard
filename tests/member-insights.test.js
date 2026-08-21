const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'member-insights-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

let currentAdData;
const statsData = require('../api/_lib/stats-data');
statsData.getAdIdDetails = async () => currentAdData;
delete require.cache[require.resolve('../api/member-insights')];

const memberInsights = require('../api/member-insights');
const { signAccessToken } = require('../api/_lib/auth');
const { ensureMemberIdentity } = require('../api/_lib/member-identity');

function authHeaders(username) {
  return {
    authorization: `Bearer ${signAccessToken({ type: 'local', username, principal: `local:${username}` })}`,
    'x-forwarded-for': '192.0.2.80',
  };
}

test.beforeEach(() => {
  FakeRedis.reset({ 'nf_user_data:invited-user': JSON.stringify({}) });
  currentAdData = {
    last_updated: '2026-08-12T10:00:00.000Z',
    by_promoter: {
      invited_user: { total_dn: 30, total_new: 4, links: ['child-link'], codes: [] },
    },
    ad_ids: {
      'child-link': {
        ad_id: 'child-link',
        username: 'invited-user',
        username_canon: 'invited_user',
        daily: [
          { dt: '2026-08-09', dn_income: 20 },
          { dt: '2026-08-10', dn_income: 10 },
        ],
      },
    },
  };
});

test('member IDs start at 100 and remain stable under concurrent reads', async () => {
  const redis = new FakeRedis();
  const repeated = await Promise.all(Array.from({ length: 20 }, () => ensureMemberIdentity(redis, 'Alice')));
  assert.deepEqual(new Set(repeated.map(member => member.id)), new Set([100]));

  const bob = await ensureMemberIdentity(redis, 'bob');
  assert.equal(bob.id, 101);
  assert.equal(await redis.get('nf_member_id:v1:id:100'), 'alice');
  assert.equal(await redis.get('nf_member_id:v1:id:101'), 'bob');
});

test('an existing forward member ID repairs its reverse index before new allocation', async () => {
  FakeRedis.reset({ 'nf_member_id:v1:user:legacy': '100' });
  const redis = new FakeRedis();
  assert.equal((await ensureMemberIdentity(redis, 'legacy')).id, 100);
  assert.equal(await redis.get('nf_member_id:v1:id:100'), 'legacy');
  assert.equal((await ensureMemberIdentity(redis, 'next-user')).id, 101);
});

test('member insights only expose the authenticated account referral tree', async () => {
  const redis = new FakeRedis();
  await redis.sadd('nf_referrals:v1:owner', 'invited-user');
  await redis.sadd('nf_app_referrals:v1:owner', '67e519c3da10a5c772ca196e');
  await redis.sadd('nf_referrals:v1:other-owner', 'private-child');
  await redis.set('nf_referrer_of:v1:invited-user', JSON.stringify({
    parent: 'owner', child: 'invited-user', referral_code: 'nfref_owner', bound_at: '2026-08-09T00:00:00.000Z',
  }));
  await redis.set('nf_referrer_of:v1:private-child', JSON.stringify({
    parent: 'other-owner', child: 'private-child', referral_code: 'nfref_other', bound_at: '2026-08-09T00:00:00.000Z',
  }));

  const response = await invoke(memberInsights, { method: 'GET', headers: authHeaders('owner') });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.member.id, 100);
  assert.equal(response.body.referrals.total, 1);
  assert.equal(response.body.referrals.website_registrations, 1);
  assert.equal(response.body.referrals.app_registrations, 1);
  assert.equal(response.body.referrals.members[0].username, 'invited-user');
  assert.match(response.body.recommender.referral_url, /^https:\/\/novelflow\.top\/\?ref=nfref_/);
  assert.match(response.body.recommender.referral_code, /^nfref_/);
  assert.equal(response.body.recommender.tier, 'standard');
  assert.doesNotMatch(JSON.stringify(response.body), /private-child/);
  assert.doesNotMatch(JSON.stringify(response.body), /payment_account|password|novelflow_id/i);
});

test('active recommenders see only post-activation 5 percent commission', async () => {
  const redis = new FakeRedis();
  await redis.sadd('nf_referrals:v1:owner', 'invited-user');
  await redis.set('nf_referrer_of:v1:invited-user', JSON.stringify({
    parent: 'owner', child: 'invited-user', referral_code: 'nfref_owner', bound_at: '2026-08-08T00:00:00.000Z',
  }));
  await redis.set('nf_recommender:v1:application:owner', JSON.stringify({
    username: 'owner', status: 'active', slot: 7, created_at: '2026-08-10T00:00:00.000Z',
  }));

  const response = await invoke(memberInsights, { method: 'GET', headers: authHeaders('owner') });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.recommender.tier, 'premium');
  assert.equal(response.body.recommender.slot, 7);
  assert.equal(response.body.referrals.members[0].promotion_income, 30);
  assert.equal(response.body.referrals.members[0].commission_accrued, 0.5);
  assert.equal(response.body.recommender.commission_accrued, 0.5);
  assert.equal(response.body.referrals.reader_new_users, 4);
  assert.equal(response.body.referrals.promotion_income, 30);
  assert.match(response.body.recommender.referral_url, /^https:\/\/novelflow\.top\/\?ref=nfref_/);
});

test('member insights do not expose or commission a child source with duplicate owners', async () => {
  const redis = new FakeRedis();
  currentAdData.ad_ids['child-alias'] = {
    username: '@invited-user',
    username_canon: 'invited_user',
    daily: [{ dt: '2026-08-10', dn_income: 50 }],
  };
  FakeRedis.values.set('nf_user_data:@invited-user', JSON.stringify({}));
  await redis.sadd('nf_referrals:v1:owner', 'invited-user');
  await redis.set('nf_referrer_of:v1:invited-user', JSON.stringify({
    parent: 'owner', child: 'invited-user', referral_code: 'nfref_owner', bound_at: '2026-08-08T00:00:00.000Z',
  }));
  await redis.set('nf_recommender:v1:application:owner', JSON.stringify({
    username: 'owner', status: 'active', created_at: '2026-08-10T00:00:00.000Z',
  }));

  const response = await invoke(memberInsights, { method: 'GET', headers: authHeaders('owner') });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.referrals.stats_available, false);
  assert.equal(response.body.referrals.members[0].source_owner_verified, false);
  assert.equal(response.body.referrals.members[0].promotion_income, null);
  assert.equal(response.body.referrals.members[0].commission_accrued, null);
  assert.equal(response.body.recommender.commission_accrued, null);
});

test('member insights require a valid access token and fail closed for disabled accounts', async () => {
  const anonymous = await invoke(memberInsights, { method: 'GET' });
  assert.equal(anonymous.statusCode, 401);

  FakeRedis.reset({ 'nf_user_data:owner': JSON.stringify({ disabled: true }) });
  const disabled = await invoke(memberInsights, { method: 'GET', headers: authHeaders('owner') });
  assert.equal(disabled.statusCode, 403);
});

test('unavailable promotion data is not represented as zero commission', async () => {
  currentAdData = null;
  const redis = new FakeRedis();
  await redis.sadd('nf_referrals:v1:owner', 'invited-user');
  await redis.set('nf_referrer_of:v1:invited-user', JSON.stringify({
    parent: 'owner', child: 'invited-user', bound_at: '2026-08-09T00:00:00.000Z',
  }));
  await redis.set('nf_recommender:v1:application:owner', JSON.stringify({
    username: 'owner', status: 'active', created_at: '2026-08-10T00:00:00.000Z',
  }));
  const response = await invoke(memberInsights, { method: 'GET', headers: authHeaders('owner') });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.referrals.stats_available, false);
  assert.equal(response.body.referrals.members[0].commission_accrued, null);
  assert.equal(response.body.recommender.commission_accrued, null);
});
