const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'activity-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
const tokenPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
process.env.NOVELSPA_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${tokenPayload}.test-signature`;
delete process.env.OIDC_USERNAME;
delete process.env.OIDC_PASSWORD;
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
  normalizePublicSocialUrl,
} = require('../api/_lib/activity-eligibility');

const TEST_NF_USER_ID = '67e519c3da10a5c772ca196e';

function mockMemberLookup() {
  global.fetch = async url => {
    if (!String(url).includes('/usermanage/userinfo/page')) throw new Error(`Unexpected fetch: ${url}`);
    const requested = new URL(String(url)).searchParams.get('userId');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 200, data: { data: [{
        applicationId: '642fc1ace309494378a774a6', userId: requested,
        accountRegistTime: '2025-01-01 00:00:00', memberEndTime: null,
      }] } }),
    };
  };
}

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
  mockMemberLookup();
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

test('concurrent referral allocation gives one account exactly one primary code', async () => {
  const invites = await Promise.all(Array.from({ length: 50 }, () =>
    ensureReferralCode(new FakeRedis(), 'concurrent-parent')));
  const codes = new Set(invites.map(invite => invite.referral_code));
  const reverseMappings = Array.from(FakeRedis.values.entries())
    .filter(([key, value]) => key.startsWith('nf_referral_code:v1:code:') && value === 'concurrent-parent');

  assert.equal(codes.size, 1);
  assert.equal(reverseMappings.length, 1);
  const [code] = codes;
  assert.equal(await new FakeRedis().get('nf_referral_code:v1:user:concurrent-parent'), code);
  assert.equal(await new FakeRedis().get(`nf_referral_code:v1:code:${code}`), 'concurrent-parent');
});

test('referral allocation resolves a forced random-code collision without sharing ownership', async () => {
  const crypto = require('node:crypto');
  const originalRandomBytes = crypto.randomBytes;
  const values = [Buffer.alloc(9, 1), Buffer.alloc(9, 1), Buffer.alloc(9, 2)];
  crypto.randomBytes = () => values.shift() || Buffer.alloc(9, 3);
  try {
    const first = await ensureReferralCode(new FakeRedis(), 'collision-one');
    const second = await ensureReferralCode(new FakeRedis(), 'collision-two');
    assert.notEqual(first.referral_code, second.referral_code);
    assert.equal(await new FakeRedis().get(`nf_referral_code:v1:code:${first.referral_code}`), 'collision-one');
    assert.equal(await new FakeRedis().get(`nf_referral_code:v1:code:${second.referral_code}`), 'collision-two');
  } finally {
    crypto.randomBytes = originalRandomBytes;
  }
});

test('a lost allocation response retries to the same code without an orphan alias', async () => {
  const redis = new FakeRedis();
  const originalEval = redis.eval.bind(redis);
  let loseFirstResponse = true;
  redis.eval = async (...args) => {
    const result = await originalEval(...args);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error('simulated response loss');
    }
    return result;
  };

  await assert.rejects(() => ensureReferralCode(redis, 'retry-parent'), /simulated response loss/);
  const invite = await ensureReferralCode(redis, 'retry-parent');
  const reverseMappings = Array.from(FakeRedis.values.entries())
    .filter(([key, value]) => key.startsWith('nf_referral_code:v1:code:') && value === 'retry-parent');
  assert.equal(reverseMappings.length, 1);
  assert.equal(reverseMappings[0][0], `nf_referral_code:v1:code:${invite.referral_code}`);
});

test('a valid legacy recommender code becomes the stable primary invite code', async () => {
  FakeRedis.reset({
    'nf_recommender:v1:application:legacy-primary': JSON.stringify({ referral_code: 'nfref_legacyprimary' }),
    'nf_recommender:v1:code:nfref_legacyprimary': 'legacy-primary',
  });
  const invites = await Promise.all(Array.from({ length: 20 }, () =>
    ensureReferralCode(new FakeRedis(), 'legacy-primary')));

  assert.deepEqual(new Set(invites.map(invite => invite.referral_code)), new Set(['nfref_legacyprimary']));
  assert.equal(await new FakeRedis().get('nf_referral_code:v1:user:legacy-primary'), 'nfref_legacyprimary');
  assert.equal(await new FakeRedis().get('nf_referral_code:v1:code:nfref_legacyprimary'), 'legacy-primary');
});

test('activity invite codes are scoped to the verified JWT account and ignore username overrides', async () => {
  const first = await invoke(activityRewards, {
    method: 'GET',
    headers: authHeaders('jwt-owner-one'),
    query: { username: 'jwt-owner-two', ref: 'nfref_untrusted_override' },
    body: { username: 'jwt-owner-two' },
  });
  const second = await invoke(activityRewards, {
    method: 'GET',
    headers: authHeaders('jwt-owner-two'),
    query: { username: 'jwt-owner-one' },
    body: { username: 'jwt-owner-one' },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.notEqual(first.body.invite.referral_code, second.body.invite.referral_code);
  assert.equal(await new FakeRedis().get(`nf_referral_code:v1:code:${first.body.invite.referral_code}`), 'jwt-owner-one');
  assert.equal(await new FakeRedis().get(`nf_referral_code:v1:code:${second.body.invite.referral_code}`), 'jwt-owner-two');

  const retry = await invoke(activityRewards, {
    method: 'GET',
    headers: authHeaders('jwt-owner-one'),
    query: { username: 'jwt-owner-two' },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.invite.referral_code, first.body.invite.referral_code);
});

test('verified app referrals drive VIP and can satisfy recommender eligibility without website signups', async () => {
  await new FakeRedis().sadd('nf_app_referrals:v1:campaign-parent', 'app-child-1', 'app-child-2');
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
  await new FakeRedis().sadd('nf_app_referrals:v1:campaign-parent', 'app-child-3', 'app-child-4', 'app-child-5');
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

test('public social URLs accept any HTTPS platform but reject local, private, credentialed, and unsafe URLs', () => {
  assert.equal(normalizePublicSocialUrl('https://www.instagram.com/p/NovelFlow123/#comments'), 'https://www.instagram.com/p/NovelFlow123/');
  assert.equal(normalizePublicSocialUrl('https://www.tiktok.com/@reader/video/123?lang=en#share'), 'https://www.tiktok.com/@reader/video/123?lang=en');
  assert.equal(normalizePublicSocialUrl('https://m.facebook.com/groups/NovelFlowReaders/posts/123456/?mibextid=abc'), 'https://www.facebook.com/groups/novelflowreaders/posts/123456');
  for (const value of [
    'http://x.com/reader/status/123',
    'https://localhost/post/1',
    'https://127.0.0.1/post/1',
    'https://10.0.0.8/post/1',
    'https://192.168.1.8/post/1',
    'https://172.20.0.8/post/1',
    'https://user:pass@example.com/post/1',
    'javascript:alert(1)',
  ]) assert.equal(normalizePublicSocialUrl(value), null, value);
});

test('general social submission keeps the legacy Facebook claim key and accepts old action payloads', async () => {
  const social = await invoke(activityRewards, {
    method: 'POST',
    headers: authHeaders('social-promoter'),
    body: { action: 'submit_social', novelflow_id: TEST_NF_USER_ID, social_url: 'https://www.instagram.com/p/novelflow-post/' },
  });
  assert.equal(social.statusCode, 200);
  assert.equal(social.body.claim.task, 'facebook');
  assert.equal(social.body.claim.social_url, 'https://www.instagram.com/p/novelflow-post/');
  assert.equal(social.body.claim.facebook_url, social.body.claim.social_url);

  const read = await invoke(activityRewards, { method: 'GET', headers: authHeaders('social-promoter') });
  assert.equal(read.body.claims.facebook.social_url, social.body.claim.social_url);

  const legacy = await invoke(activityRewards, {
    method: 'POST',
    headers: authHeaders('legacy-facebook-promoter'),
    body: { action: 'submit_facebook', novelflow_id: '67e519c3da10a5c772ca196f', facebook_url: 'https://facebook.com/groups/NovelFlowReaders/posts/654321' },
  });
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.body.claim.social_url, 'https://www.facebook.com/groups/novelflowreaders/posts/654321');
});

test('register captures referral codes while login never creates accounts', async () => {
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
  assert.equal(loginResponse.statusCode, 401);
  assert.equal(FakeRedis.values.has('nf_referrer_of:v1:login-child'), false);
  assert.equal(await getCampaignReferralCount(new FakeRedis(), 'campaign-parent'), 1);

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
  assert.equal(invalidLogin.statusCode, 401);
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

test('incremental invite VIP uses verified app users and append-only fulfillment events', async () => {
  await new FakeRedis().sadd('nf_app_referrals:v1:campaign-parent', 'app-child-1', 'app-child-2');
  const request = {
    headers: authHeaders('campaign-parent'),
    body: { action: 'claim_invite_vip', novelflow_id: TEST_NF_USER_ID },
  };
  const first = await invoke(activityRewards, request);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.fulfillment_event.reward_days, 3);
  assert.equal(first.body.claim.total_claimed_days, 3);

  await new FakeRedis().sadd('nf_app_referrals:v1:campaign-parent', 'app-child-3', 'app-child-4');
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

  await new FakeRedis().sadd('nf_app_referrals:v1:campaign-parent', 'app-child-5', 'app-child-6');
  const changedId = await invoke(activityRewards, {
    ...request,
    body: { action: 'claim_invite_vip', novelflow_id: '67e519c3da10a5c772ca196f' },
  });
  assert.equal(changedId.statusCode, 409);
  assert.equal(changedId.body.code, 'NOVELFLOW_BINDING_IMMUTABLE');
  assert.equal(events.length, 2);
});

test('an invite VIP retry recreates a missing entitlement for the existing activity event', async () => {
  await new FakeRedis().sadd('nf_app_referrals:v1:campaign-parent', 'app-child-1', 'app-child-2');
  const request = {
    headers: authHeaders('campaign-parent'),
    body: { action: 'claim_invite_vip', novelflow_id: TEST_NF_USER_ID },
  };
  const first = await invoke(activityRewards, request);
  assert.equal(first.statusCode, 200);
  const vipEventKey = `nf_vip_event:v1:${first.body.fulfillment_event.vip_event_id}`;
  await new FakeRedis().del(vipEventKey);

  const retry = await invoke(activityRewards, request);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.fulfillment_event.event_id, first.body.fulfillment_event.event_id);
  assert.ok(FakeRedis.values.has(vipEventKey));
  assert.equal(JSON.parse(FakeRedis.values.get(vipEventKey)).days, 3);
});

test('a Limited Subsidy retry backfills a missing VIP entitlement', async () => {
  FakeRedis.reset({
    'nf_activity_claim:v1:vip2:subsidy-retry': JSON.stringify({
      version: 1,
      task: 'vip2',
      username: 'subsidy-retry',
      claim_id: 'act_existing_claim',
      novelflow_id: TEST_NF_USER_ID,
      reward_days: 2,
      status: 'pending_fulfillment',
    }),
  });
  const response = await invoke(activityRewards, {
    method: 'POST',
    headers: authHeaders('subsidy-retry'),
    body: { action: 'claim_vip2', novelflow_id: TEST_NF_USER_ID },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.idempotent, true);
  assert.match(response.body.claim.vip_event_id, /^vip_/);
  const event = JSON.parse(FakeRedis.values.get(`nf_vip_event:v1:${response.body.claim.vip_event_id}`));
  assert.equal(event.metadata.claim_id, 'act_existing_claim');
  assert.equal(event.days, 2);
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

test('referral commission includes verified invite-code income', () => {
  const { grossIncomeSince } = require('../api/_lib/referral-commission');
  const data = {
    by_promoter: {
      referred_child: { links: [], codes: [], invites: ['90031'] },
    },
    ad_ids: {
      '90031': {
        ad_id: '90031',
        channel: 'code',
        daily: [{ dt: '2026-08-11', dn_income: 999 }],
      },
      'invite:90031': {
        ad_id: '90031',
        channel: 'invite',
        daily: [
          { dt: '2026-08-09', dn_income: 100 },
          { dt: '2026-08-10', dn_income: 12 },
          { dt: '2026-08-11', dn_income: 8 },
        ],
      },
    },
  };

  assert.deepEqual(grossIncomeSince(data, 'referred_child', '2026-08-10'), {
    gross: 20,
    days: 2,
  });
});
