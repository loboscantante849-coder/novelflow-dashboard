const { Redis } = require('@upstash/redis');
const { handlePreflight } = require('./_lib/cors');
const {
  assertAccountIdentity,
  checkRateLimit,
  getAuthPayload,
  getClientIp,
  isDisabledUser,
} = require('./_lib/security');
const { getAdIdDetails, resolvePromoterKey } = require('./_lib/stats-data');
const { ensureMemberIdentity, memberMetaKey } = require('./_lib/member-identity');
const { ensureReferralCode } = require('./_lib/referrals');
const { referralCommissionStatement, roundMoney } = require('./_lib/referral-commission');

const RECOMMENDER_NS = 'nf_recommender:v1';
const MAX_REFERRAL_DETAILS = 250;

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return null; }
}

function usernameKey(value) {
  return String(value || '').trim().toLowerCase();
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: true })) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const username = usernameKey(payload.username);
  const redis = redisClient();
  if (!redis || !username) return res.status(503).json({ error: 'Member data unavailable', code: 'MEMBER_DATA_UNAVAILABLE' });

  try {
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
    await assertAccountIdentity(redis, payload);
    const allowed = await checkRateLimit(redis, `nf_rate:member_insights:${username}`, 120, 3600, { failClosed: true }) &&
      await checkRateLimit(redis, `nf_rate:member_insights_ip:${getClientIp(req)}`, 600, 3600, { failClosed: true });
    if (!allowed) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });

    const [member, childNames, application, adData, invite] = await Promise.all([
      ensureMemberIdentity(redis, username),
      redis.smembers(`nf_referrals:v1:${username}`),
      redis.get(`${RECOMMENDER_NS}:application:${username}`).then(parseJson),
      getAdIdDetails(),
      ensureReferralCode(redis, username),
    ]);
    const appReferralIds = await redis.smembers(`nf_app_referrals:v1:${username}`);
    const children = Array.from(new Set((childNames || []).map(usernameKey).filter(child => child && child !== username))).sort();
    const selectedChildren = children.slice(0, MAX_REFERRAL_DETAILS);
    const statsAvailable = Boolean(adData && adData.by_promoter);
    const activeApplication = application && application.status === 'active' ? application : null;

    const members = await Promise.all(selectedChildren.map(async child => {
      const [childIdentity, metaValue, relationValue] = await Promise.all([
        ensureMemberIdentity(redis, child),
        redis.get(memberMetaKey(child)),
        redis.get(`nf_referrer_of:v1:${child}`),
      ]);
      const meta = parseJson(metaValue) || childIdentity;
      const relationship = parseJson(relationValue) || { parent: username, child };
      const promoterKey = statsAvailable ? resolvePromoterKey(child, adData) : null;
      const promoter = promoterKey && adData.by_promoter[promoterKey];
      const commission = statsAvailable && activeApplication
        ? referralCommissionStatement(adData, relationship, activeApplication, 0.05)
        : null;
      return {
        member_id: childIdentity.id,
        username: child,
        registered_at: meta.created_at || relationship.bound_at || null,
        promotion_income: statsAvailable ? roundMoney(promoter && promoter.total_dn) : null,
        app_new_users: statsAvailable ? Math.max(0, Number(promoter && promoter.total_new) || 0) : null,
        commission_accrued: commission
          ? commission.commission_accrued_cumulative
          : (activeApplication && statsAvailable ? 0 : null),
        commission_effective_date: commission ? commission.effective_date : null,
      };
    }));

    const tier = activeApplication ? 'premium' : (children.length > 0 ? 'standard' : 'none');
    const networkReaderUsers = statsAvailable
      ? Math.max(0, members.reduce((sum, child) => sum + (Number(child.app_new_users) || 0), 0))
      : null;
    const networkPromotionIncome = statsAvailable
      ? roundMoney(members.reduce((sum, child) => sum + (Number(child.promotion_income) || 0), 0))
      : null;
    return res.status(200).json({
      success: true,
      member: {
        id: member.id,
        username,
        created_at: member.created_at || null,
        source: member.source || 'legacy',
      },
      referrals: {
        total: children.length,
        website_registrations: children.length,
        app_registrations: Array.from(new Set((appReferralIds || []).map(String).filter(Boolean))).length,
        returned: members.length,
        truncated: children.length > members.length,
        stats_available: statsAvailable,
        reader_new_users: networkReaderUsers,
        promotion_income: networkPromotionIncome,
        members,
      },
      recommender: {
        tier,
        active: Boolean(activeApplication),
        slot: activeApplication ? Number(activeApplication.slot) || null : null,
        commission_rate: activeApplication ? 0.05 : 0,
        commission_accrued: activeApplication && statsAvailable
          ? roundMoney(members.reduce((sum, child) => sum + (Number(child.commission_accrued) || 0), 0))
          : null,
        activated_at: activeApplication ? activeApplication.created_at || null : null,
        referral_code: invite.referral_code,
        referral_url: invite.referral_url,
      },
      stats_last_updated: statsAvailable ? adData.last_updated || null : null,
    });
  } catch (error) {
    console.error('[member-insights] error:', error);
    if (error && error.code === 'ACCOUNT_IDENTITY_CONFLICT') {
      return res.status(409).json({ error: 'Account identity recovery required', code: error.code });
    }
    if (error && error.code === 'RATE_LIMIT_UNAVAILABLE') {
      return res.status(503).json({ error: 'Member data unavailable', code: error.code });
    }
    return res.status(503).json({ error: 'Member data unavailable', code: error.code || 'MEMBER_DATA_UNAVAILABLE' });
  }
};
