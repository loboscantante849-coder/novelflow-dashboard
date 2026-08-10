const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'activity-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
delete process.env.FEISHU_SIGNUP_WEBHOOK;

const RealDate = Date;
const FIXED_NOW = '2026-08-11T08:00:00.000Z';
class FixedDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [FIXED_NOW]));
  }

  static now() {
    return RealDate.parse(FIXED_NOW);
  }
}
global.Date = FixedDate;

let currentAdData;
const statsData = require('../api/_lib/stats-data');
statsData.getAdIdDetails = async () => currentAdData;

delete require.cache[require.resolve('../api/_lib/activity-eligibility')];
delete require.cache[require.resolve('../api/activity-rewards')];

const activityRewards = require('../api/activity-rewards');
const register = require('../api/auth/register');
const login = require('../api/auth/login');
const { buildUserPayload, signAccessToken } = require('../api/_lib/auth');
const {
  ACTIVITY_REFERRAL_INDEX_NS,
  ensureReferralCode,
  finalizePendingReferral,
  getCampaignReferralCount,
  stageReferral,
} = require('../api/_lib/referrals');
const {
  eligibilityFromAdData,
  loadEligibility,
  normalizeFacebookUrl,
} = require('../api/_lib/activity-eligibility');

function sampleAdData() {
  return {
    last_updated: '2026-08-11T07:30:00.000Z',
    date_range: { from: '2026-02-01', to: '2026-08-11' },
    by_promoter: {
      campaign_parent: { display_name: 'Campaign Parent', total_new: 9, total_dn: 50 },
      referred_child: { display_name: 'Referred Child', total_new: 1, total_dn: 130 },
    },
    ad_ids: {
      child_link: {
        username_canon: 'referred_child',
        daily: [
          { dt: '2026-08-09', dn_income: 100 },
          { dt: '2026-08-10', dn_income: 10 },
          { dt: '2026-08-11', dn_income: 20 },
        ],
      },
    },
  };
}

function authHeaders(username) {
  const payload = buildUserPayload({ type: 'local', username, principal: `local:${username}` });
  return {
    authorization: `Bearer ${signAccessToken(payload)}`,
    'x-forwarded-for': '192.0.2.44',
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  currentAdData = sampleAdData();
});

test.after(() => {
  global.Date = RealDate;
});

test('generic referral codes are stable and existing relationships repair both indexes', async () => {
  const first = await ensureReferralCode(new FakeRedis(), 'campaign-parent');
  const second = await ensureReferralCode(new FakeRedis(), 'campaign-parent');
  assert.equal(second.referral_code, first.referral_code);
  assert.match(first.referral_url, /^https:\/\/novelflow\.top\/\?ref=nfref_/);

  await stageReferral(new FakeRedis(), 'campaign-child', first.referral_code);
  const relationship = await finalizePendingReferral(new FakeRedis(), 'campaign-child');
  assert.equal(relationship.parent, 'campaign-parent');
  assert.equal(await getCampaignReferralCount(new FakeRedis(), 'campaign-parent'), 1);

  await new FakeRedis().del('nf_referrals:v1:campaign-parent');
  await new FakeRedis().del(`${ACTIVITY_REFERRAL_INDEX_NS}:campaign-parent`);
  await finalizePendingReferral(new FakeRedis(), 'campaign-child');
  assert.deepEqual(await new FakeRedis().smembers('nf_referrals:v1:campaign-parent'), ['campaign-child']);
  assert.equal(await getCampaignReferralCount(new FakeRedis(), 'campaign-parent'), 1);
});

test('campaign referrals drive VIP and can satisfy recommender eligibility without stale history', async () => {
  await new FakeRedis().sadd(`${ACTIVITY_REFERRAL_INDEX_NS}:campaign-parent`, 'child-1', 'child-2');
  const eligibility = await loadEligibility('campaign-parent', { redis: new FakeRedis(), adData: currentAdData });
  assert.equal(eligibility.verifiedNewUsers, 2);
  assert.equal(eligibility.campaignInvites, 2);
  assert.equal(eligibility.totalDays, 3);
  assert.equal(eligibility.historicalNewUsers, 9);
  assert.equal(eligibility.recommenderMeasuredNewUsers, 9);
  assert.equal(eligibility.recommenderEligible, true);

  const pure = eligibilityFromAdData(currentAdData, 'campaign-parent', 0);
  assert.equal(pure.totalDays, 0);
  assert.equal(pure.historicalNewUsers, 9);

  currentAdData.by_promoter.campaign_parent.total_new = 0;
  await new FakeRedis().sadd(`${ACTIVITY_REFERRAL_INDEX_NS}:campaign-parent`, 'child-3', 'child-4', 'child-5');
  const exactFive = await loadEligibility('campaign-parent', { redis: new FakeRedis(), adData: currentAdData });
  assert.equal(exactFive.campaignInvites, 5);
  assert.equal(exactFive.recommenderMeasuredNewUsers, 5);
  assert.equal(exactFive.recommenderEligible, true);
});

test('activity reads are rate limited per authenticated account', async () => {
  FakeRedis.values.set('nf_rate:activity_read:campaign-parent', 120);
  const response = await invoke(activityRewards, {
    method: 'GET',
    headers: authHeaders('campaign-parent'),
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.body.code, 'RATE_LIMITED');
});

test('Facebook group post URLs canonicalize host, path type, and query parameters', () => {
  const canonical = 'https://www.facebook.com/groups/novelflowreaders/posts/123456';
  assert.equal(normalizeFacebookUrl('https://m.facebook.com/groups/NovelFlowReaders/posts/123456/?mibextid=abc#comments'), canonical);
  assert.equal(normalizeFacebookUrl('https://facebook.com/groups/NovelFlowReaders/permalink/123456?ref=share'), canonical);
  assert.equal(normalizeFacebookUrl('https://facebook.com/groups/NovelFlowReaders'), null);
  assert.equal(normalizeFacebookUrl('https://facebook.com/groups/NovelFlowReaders/events/123456'), null);
});

test('register and login capture referral codes from server-visible request metadata', async () => {
  const invite = await ensureReferralCode(new FakeRedis(), 'campaign-parent');
  const registerResponse = await invoke(register, {
    headers: {
      referer: `https://novelflow.top/?ref=${invite.referral_code}`,
      'x-forwarded-for': '192.0.2.50',
    },
    body: { username: 'register-child', password: 'Password1' },
  });
  assert.equal(registerResponse.statusCode, 200);
  assert.equal(JSON.parse(FakeRedis.values.get('nf_referrer_of:v1:register-child')).parent, 'campaign-parent');

  const loginResponse = await invoke(login, {
    query: { ref: invite.referral_code },
    headers: { 'x-forwarded-for': '192.0.2.51' },
    body: { username: 'login-child', password: 'Password1' },
  });
  assert.equal(loginResponse.statusCode, 200);
  assert.equal(loginResponse.body.isNewUser, true);
  assert.equal(JSON.parse(FakeRedis.values.get('nf_referrer_of:v1:login-child')).parent, 'campaign-parent');
  assert.equal(await getCampaignReferralCount(new FakeRedis(), 'campaign-parent'), 2);

  const invalid = await invoke(register, {
    headers: { 'x-forwarded-for': '192.0.2.52' },
    body: { username: 'invalid-referral-child', password: 'Password1', referral_code: 'nfref_missingcode' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(FakeRedis.values.has('nf_user_pass:invalid-referral-child'), false);
  assert.equal(FakeRedis.values.has('nf_identity_owner:invalid-referral-child'), false);

  const invalidLogin = await invoke(login, {
    headers: { 'x-forwarded-for': '192.0.2.53' },
    body: { username: 'invalid-login-referral', password: 'Password1', referral_code: 'nfref_missingcode' },
  });
  assert.equal(invalidLogin.statusCode, 400);
  assert.equal(FakeRedis.values.has('nf_user_pass:invalid-login-referral'), false);
  assert.equal(FakeRedis.values.has('nf_identity_owner:invalid-login-referral'), false);
});

test('legacy referral ownership conflicts preserve the canonical owner', async () => {
  FakeRedis.reset({
    'nf_recommender:v1:application:legacy-owner': JSON.stringify({ referral_code: 'nfref_legacycode' }),
    'nf_recommender:v1:code:nfref_legacycode': 'legacy-owner',
    'nf_referral_code:v1:code:nfref_legacycode': 'conflicting-owner',
  });

  const invite = await ensureReferralCode(new FakeRedis(), 'legacy-owner');
  assert.notEqual(invite.referral_code, 'nfref_legacycode');
  assert.equal(await new FakeRedis().get(`nf_referral_code:v1:code:${invite.referral_code}`), 'legacy-owner');
  await stageReferral(new FakeRedis(), 'legacy-child', 'nfref_legacycode');
  const relationship = await finalizePendingReferral(new FakeRedis(), 'legacy-child');
  assert.equal(relationship.parent, 'conflicting-owner');
});

test('incremental invite VIP uses immutable IDs and append-only fulfillment events', async () => {
  await new FakeRedis().sadd(`${ACTIVITY_REFERRAL_INDEX_NS}:campaign-parent`, 'child-1', 'child-2');
  const request = {
    headers: authHeaders('campaign-parent'),
    body: { action: 'claim_invite_vip', novelflow_id: '218672' },
  };
  const first = await invoke(activityRewards, request);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.fulfillment_event.reward_days, 3);
  assert.equal(first.body.claim.total_claimed_days, 3);

  await new FakeRedis().sadd(`${ACTIVITY_REFERRAL_INDEX_NS}:campaign-parent`, 'child-3', 'child-4');
  const second = await invoke(activityRewards, request);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.fulfillment_event.reward_days, 3);
  assert.equal(second.body.claim.total_claimed_days, 6);

  const events = Array.from(FakeRedis.values.entries())
    .filter(([key]) => key.startsWith('nf_activity_event:v1:invite_vip:campaign-parent:'))
    .map(([, value]) => JSON.parse(value));
  const eventsAfterRejectedChange = Array.from(FakeRedis.values.keys())
    .filter(key => key.startsWith('nf_activity_event:v1:invite_vip:campaign-parent:'));
  assert.equal(eventsAfterRejectedChange.length, 2);
  assert.deepEqual(events.map(event => event.reward_days), [3, 3]);

  await new FakeRedis().sadd(`${ACTIVITY_REFERRAL_INDEX_NS}:campaign-parent`, 'child-5', 'child-6');
  const changedId = await invoke(activityRewards, {
    ...request,
    body: { action: 'claim_invite_vip', novelflow_id: '999999' },
  });
  assert.equal(changedId.statusCode, 409);
  assert.equal(changedId.body.code, 'NOVELFLOW_ID_IMMUTABLE');
  assert.equal(events.length, 2);
});

test('admin exports fulfillment events and a read-only 5 percent commission statement', async () => {
  FakeRedis.values.set('nf_user_data:ops-admin', JSON.stringify({ accountType: 'admin' }));
  FakeRedis.values.set('nf_recommender:v1:application:campaign-parent', JSON.stringify({
    username: 'campaign-parent',
    status: 'active',
    referral_code: 'nfref_parentcode',
    created_at: '2026-08-10T00:00:00.000Z',
  }));
  FakeRedis.values.set('nf_referrer_of:v1:referred-child', JSON.stringify({
    child: 'referred-child',
    parent: 'campaign-parent',
    referral_code: 'nfref_parentcode',
    bound_at: '2026-08-09T00:00:00.000Z',
  }));

  const commissions = await invoke(activityRewards, {
    method: 'GET',
    query: { admin_export: 'commission' },
    headers: authHeaders('ops-admin'),
  });
  assert.equal(commissions.statusCode, 200);
  assert.equal(commissions.body.read_only, true);
  assert.equal(commissions.body.writes_performed, false);
  assert.equal(commissions.body.commission_statements.length, 1);
  assert.equal(commissions.body.commission_statements[0].gross_dn_income, 30);
  assert.match(commissions.body.commission_statements[0].relationship_id, /^nfr_/);
  assert.equal(commissions.body.commission_statements[0].commission_accrued_cumulative, 1.5);
  assert.equal(commissions.body.payout_instruction, false);
  assert.equal(commissions.body.requires_prior_payout_reconciliation, true);
});
