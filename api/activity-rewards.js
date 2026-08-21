const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { handlePreflight } = require('./_lib/cors');
const {
  assertAccountIdentity,
  checkRateLimit,
  getAuthPayload,
  getClientIp,
  isAdminUser,
  isDisabledUser,
} = require('./_lib/security');
const {
  ACTIVITY_VERSION,
  activityWindow,
  hashValue,
  loadEligibility,
  normalizePublicSocialUrl,
} = require('./_lib/activity-eligibility');
const { getAdIdDetails } = require('./_lib/stats-data');
const { inspectApprovedSourceWalletOwner, loadSourceOwnerIndex } = require('./_lib/income-source-owners');
const { resolveWalletStorageIdentity } = require('./_lib/wallet-identity');
const { ensureReferralCode } = require('./_lib/referrals');
const { grossIncomeSince, referralCommissionStatement, roundMoney } = require('./_lib/referral-commission');
const { resolveNovelFlowMember } = require('./_lib/novelflow-member');
const { bindNovelFlowMember, buildVipEntitlement, createVipEntitlement, eventKey: vipEventKey } = require('./_lib/vip-entitlements');

const NS = 'nf_activity_claim:v1';
const UNIQUE_NS = 'nf_activity_unique:v1';
const EVENT_NS = 'nf_activity_event:v1';
const BINDING_NS = 'nf_activity_binding:v1';
const RECOMMENDER_NS = 'nf_recommender:v1';
const MAX_CLAIM_BYTES = 32 * 1024;
const LIMITED_SUBSIDY_DAILY_CAP = 100;
const LIMITED_SUBSIDY_CAP_NS = 'nf_activity_vip2_daily:v1';
const VIP2_CLAIM_RESERVE_SCRIPT = `
-- NF_ACTIVITY_VIP2_DAILY_CAP_V1
local existing = redis.call('get', KEYS[3])
if existing then return 2 end
local owner = redis.call('get', KEYS[2])
if owner and owner ~= ARGV[1] then return -1 end
local count = redis.call('incr', KEYS[1])
if count == 1 then redis.call('expire', KEYS[1], tonumber(ARGV[3])) end
if count > tonumber(ARGV[2]) then
  redis.call('decr', KEYS[1])
  return 0
end
if not owner then redis.call('set', KEYS[2], ARGV[1]) end
redis.call('set', KEYS[3], ARGV[4])
if redis.call('exists', KEYS[4]) == 0 then redis.call('set', KEYS[4], ARGV[5]) end
return 1
`;

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function usernameKey(value) {
  return String(value || '').trim().toLowerCase();
}

async function verifiedBinding(redis, username, rawId, source) {
  const member = await resolveNovelFlowMember(rawId);
  return bindNovelFlowMember(redis, username, member, { source });
}

function memberLookupError(error) {
  const code = error && error.code || 'NOVELFLOW_LOOKUP_FAILED';
  const status = ['INVALID_NOVELFLOW_USER_ID', 'NOVELFLOW_USER_NOT_FOUND'].includes(code) ? 400
    : (['NOVELFLOW_ID_ALREADY_BOUND', 'NOVELFLOW_BINDING_IMMUTABLE'].includes(code) ? 409 : 503);
  return { status, code, message: error && error.message || 'NovelFlow ID could not be verified' };
}

function claimKey(task, username) {
  return `${NS}:${task}:${usernameKey(username)}`;
}

function uniqueKey(task, value) {
  return `${UNIQUE_NS}:${task}:${hashValue(value)}`;
}

function bindingKey(task, username) {
  return `${BINDING_NS}:${task}:${usernameKey(username)}`;
}

function eventKey(task, username, eventId) {
  return `${EVENT_NS}:${task}:${usernameKey(username)}:${eventId}`;
}

function lockKey(task, scope = 'global') {
  return `${NS}:lock:${task}:${hashValue(scope).slice(0, 20)}`;
}

async function acquireActivityLock(redis, task, scope = 'global') {
  const key = lockKey(task, scope);
  const token = crypto.randomUUID();
  const result = await redis.set(key, token, { nx: true, ex: 20 });
  return result === 'OK' || result === true ? { key, token } : null;
}

async function releaseActivityLock(redis, lock) {
  if (!redis || !lock) return;
  try {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [lock.key],
      [lock.token],
    );
  } catch (_error) {
    // The lock TTL is the final fallback.
  }
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

async function readClaim(redis, task, username) {
  return parseJson(await redis.get(claimKey(task, username)), null);
}

async function reserveUnique(redis, task, value, username) {
  const key = uniqueKey(task, value);
  const owner = usernameKey(username);
  const created = await redis.set(key, owner, { nx: true });
  if (created === 'OK' || created === true) return { key, created: true, owner };
  const existing = String(await redis.get(key) || '').toLowerCase();
  if (existing === owner) return { key, created: false };
  const error = new Error('This identifier has already been used');
  error.code = 'IDENTIFIER_ALREADY_USED';
  throw error;
}

async function releaseUnique(redis, reservation) {
  if (!redis || !reservation || !reservation.created) return;
  try {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [reservation.key],
      [reservation.owner],
    );
  } catch (_error) {
    // A leaked reservation is preferable to releasing another user's claim.
  }
}

async function saveClaim(redis, task, username, record) {
  const key = claimKey(task, username);
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_CLAIM_BYTES) throw new Error('Claim is too large');
  const created = await redis.set(key, serialized, { nx: true });
  if (created === 'OK' || created === true) return record;
  return parseJson(await redis.get(key), record);
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilNextUtcDay() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

async function reserveLimitedSubsidyClaim(redis, username, id, record, event) {
  const serialized = JSON.stringify(record);
  const serializedEvent = JSON.stringify(event);
  if (serialized.length > MAX_CLAIM_BYTES) throw new Error('Claim is too large');
  const result = Number(await redis.eval(
    VIP2_CLAIM_RESERVE_SCRIPT,
    [
      `${LIMITED_SUBSIDY_CAP_NS}:${utcDay()}`,
      uniqueKey('vip2', id.key),
      claimKey('vip2', username),
      vipEventKey(event.event_id),
    ],
    [usernameKey(username), String(LIMITED_SUBSIDY_DAILY_CAP), String(secondsUntilNextUtcDay()), serialized, serializedEvent],
  ));
  if (result === 0) {
    const error = new Error("Today's activity is full");
    error.code = 'DAILY_SUBSIDY_FULL';
    throw error;
  }
  if (result === -1) {
    const error = new Error('This identifier has already been used');
    error.code = 'IDENTIFIER_ALREADY_USED';
    throw error;
  }
  if (![1, 2].includes(result)) {
    const error = new Error('Activity claim could not be reserved');
    error.code = 'ACTIVITY_CLAIM_RESERVE_FAILED';
    throw error;
  }
  return { created: result === 1, claim: parseJson(await redis.get(claimKey('vip2', username)), record) };
}

async function updateClaim(redis, task, username, record) {
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_CLAIM_BYTES) throw new Error('Claim is too large');
  await redis.set(claimKey(task, username), serialized);
  return record;
}

function claimBase(username, task, extra = {}) {
  return {
    version: 1,
    activity_version: ACTIVITY_VERSION,
    task,
    username: usernameKey(username),
    claim_id: `act_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    submitted_at: new Date().toISOString(),
    status: 'pending_fulfillment',
    ...extra,
  };
}

async function scanJson(redis, match) {
  const rows = [];
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, { match, count: 200 });
    cursor = String(result && result[0] || '0');
    const keys = Array.isArray(result && result[1]) ? result[1] : [];
    if (keys.length) {
      const values = await redis.mget(...keys);
      keys.forEach((key, index) => {
        const value = parseJson(values[index], null);
        if (value) rows.push({ key: String(key), value });
      });
    }
  } while (cursor !== '0');
  return rows;
}

async function reserveRecommender(redis, username, eligibility, invite) {
  const normalizedUsername = usernameKey(username);
  const key = `${RECOMMENDER_NS}:application:${normalizedUsername}`;
  const existing = parseJson(await redis.get(key), null);
  if (existing) return existing;
  const applications = await scanJson(redis, `${RECOMMENDER_NS}:application:*`);
  if (applications.length >= 50) {
    const error = new Error('The first 50 recommender positions are full');
    error.code = 'RECOMMENDER_SLOTS_FULL';
    throw error;
  }
  const slot = applications.reduce((maximum, row) => Math.max(maximum, Number(row.value.slot) || 0), 0) + 1;
  const record = {
    version: 1,
    activity_version: ACTIVITY_VERSION,
    username: normalizedUsername,
    status: 'active',
    slot,
    badge: 'NovelFlow Recommender',
    referral_code: invite.referral_code,
    referral_url: invite.referral_url,
    commission_rate: 0.05,
    commission_basis: 'gross_dn_income_after_activation',
    historical_new_users: eligibility.historicalNewUsers,
    campaign_invites: eligibility.campaignInvites,
    measured_new_users: eligibility.recommenderMeasuredNewUsers,
    stats_last_updated: eligibility.statsLastUpdated,
    created_at: new Date().toISOString(),
  };
  const created = await redis.set(key, JSON.stringify(record), { nx: true });
  const saved = created === 'OK' || created === true ? record : parseJson(await redis.get(key), null);
  if (!saved) throw new Error('Could not save recommender application');
  await redis.set(`${RECOMMENDER_NS}:code:${saved.referral_code}`, normalizedUsername, { nx: true });
  await redis.set(`${RECOMMENDER_NS}:next_slot`, String(Math.max(slot, Number(await redis.get(`${RECOMMENDER_NS}:next_slot`)) || 0)));
  return saved;
}

async function ensureInviteBinding(redis, username, id, existingClaim = null) {
  const key = bindingKey('invite_vip', username);
  let binding = parseJson(await redis.get(key), null);
  if (!binding && existingClaim && existingClaim.novelflow_id_hash) {
    binding = {
      version: 1,
      activity_version: ACTIVITY_VERSION,
      task: 'invite_vip',
      username: usernameKey(username),
      novelflow_id: existingClaim.novelflow_id,
      novelflow_id_key: String(existingClaim.novelflow_id || '').trim().toLowerCase(),
      novelflow_id_hash: existingClaim.novelflow_id_hash,
      bound_at: existingClaim.submitted_at || new Date().toISOString(),
    };
    await redis.set(key, JSON.stringify(binding), { nx: true });
    binding = parseJson(await redis.get(key), binding);
  }
  if (binding) {
    if (binding.novelflow_id_hash !== hashValue(id.key)) {
      const error = new Error('The NovelFlow ID for this invite reward cannot be changed');
      error.code = 'NOVELFLOW_ID_IMMUTABLE';
      throw error;
    }
    return binding;
  }
  const reservation = await reserveUnique(redis, 'invite_vip', id.key, username);
  const record = {
    version: 1,
    activity_version: ACTIVITY_VERSION,
    task: 'invite_vip',
    username: usernameKey(username),
    novelflow_id: id.display,
    novelflow_id_key: id.key,
    novelflow_id_hash: hashValue(id.key),
    bound_at: new Date().toISOString(),
  };
  try {
    await redis.set(key, JSON.stringify(record), { nx: true });
  } catch (error) {
    await releaseUnique(redis, reservation);
    throw error;
  }
  const saved = parseJson(await redis.get(key), null);
  if (!saved || saved.novelflow_id_hash !== record.novelflow_id_hash) {
    await releaseUnique(redis, reservation);
    const error = new Error('The NovelFlow ID for this invite reward cannot be changed');
    error.code = 'NOVELFLOW_ID_IMMUTABLE';
    throw error;
  }
  return saved;
}

async function readInviteEvents(redis, username) {
  const rows = await scanJson(redis, `${EVENT_NS}:invite_vip:${usernameKey(username)}:*`);
  return rows.map(row => row.value).sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')));
}

function awardedInviteDays(events) {
  return events.reduce((sum, event) => sum + Math.max(0, Number(event.reward_days) || 0), 0);
}

async function saveInviteEvent(redis, username, claim, binding, eligibility, rewardDays, totalAfter) {
  const eventId = `invite_${hashValue(`${usernameKey(username)}:${eligibility.totalDays}`).slice(0, 20)}`;
  const key = eventKey('invite_vip', username, eventId);
  const existing = parseJson(await redis.get(key), null);
  if (existing) return { event: existing, created: false };
  const event = {
    version: 1,
    record_type: 'fulfillment_event',
    activity_version: ACTIVITY_VERSION,
    task: 'invite_vip',
    event_id: eventId,
    claim_id: claim.claim_id,
    username: usernameKey(username),
    status: 'pending_fulfillment',
    novelflow_id: binding.novelflow_id,
    novelflow_id_hash: binding.novelflow_id_hash,
    reward_days: rewardDays,
    total_awarded_days: totalAfter,
    entitlement_total_days: eligibility.totalDays,
      campaign_invites: eligibility.campaignInvites,
    submitted_at: new Date().toISOString(),
    fulfillment: 'batch_vip',
  };
  const created = await redis.set(key, JSON.stringify(event), { nx: true });
  return created === 'OK' || created === true
    ? { event, created: true }
    : { event: parseJson(await redis.get(key), event), created: false };
}

async function updateInviteEvent(redis, username, event) {
  await redis.set(eventKey('invite_vip', username, event.event_id), JSON.stringify(event));
  return event;
}

async function ensureInviteVipEntitlement(redis, username, verifiedBinding, activityEvent) {
  const entitlement = await createVipEntitlement(redis, {
    username,
    binding: verifiedBinding,
    source: 'invite_vip',
    sourceId: activityEvent.event_id,
    days: Number(activityEvent.reward_days || 0),
    metadata: { activity_event_id: activityEvent.event_id },
  });
  const event = await updateInviteEvent(redis, username, {
    ...activityEvent,
    status: entitlement.event.status,
    vip_event_id: entitlement.event.event_id,
    fulfillment: 'vip_outbox',
    updated_at: new Date().toISOString(),
  });
  return { entitlement, event };
}

function csvEscape(value) {
  let raw = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(raw)) raw = `'${raw}`;
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function toCsv(rows, fields) {
  return [fields.join(','), ...rows.map(row => fields.map(field => csvEscape(row[field])).join(','))].join('\n');
}

async function adminClaimsExport(req, res, redis) {
  const [claimRows, eventRows, applicationRows] = await Promise.all([
    scanJson(redis, `${NS}:*:*`),
    scanJson(redis, `${EVENT_NS}:*:*:*`),
    scanJson(redis, `${RECOMMENDER_NS}:application:*`),
  ]);
  const claims = claimRows.map(row => row.value);
  const fulfillmentEvents = eventRows.map(row => row.value);
  const applications = applicationRows.map(row => row.value);
  const query = req.query || {};
  if (String(query.format || '').toLowerCase() === 'csv') {
    const rows = [
      ...claims.filter(claim => claim.task !== 'invite_vip').map(claim => ({ record_type: 'claim', ...claim })),
      ...fulfillmentEvents,
      ...applications.map(application => ({ record_type: 'recommender_application', task: 'recommender', ...application })),
    ].sort((a, b) => String(a.submitted_at || a.created_at || '').localeCompare(String(b.submitted_at || b.created_at || '')));
    const fields = [
      'record_type', 'task', 'username', 'claim_id', 'event_id', 'status', 'novelflow_id',
      'social_url', 'facebook_url', 'reward_days', 'reward_bonus', 'total_awarded_days', 'campaign_invites', 'measured_new_users',
      'slot', 'referral_code', 'submitted_at', 'created_at',
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).end(toCsv(rows, fields));
  }
  return res.status(200).json({
    success: true,
    activity_version: ACTIVITY_VERSION,
    total: claims.length + fulfillmentEvents.length + applications.length,
    claims,
    fulfillment_events: fulfillmentEvents,
    recommender_applications: applications,
  });
}

async function adminCommissionExport(req, res, redis) {
  const [relationshipRows, applicationRows, adData] = await Promise.all([
    scanJson(redis, 'nf_referrer_of:v1:*'),
    scanJson(redis, `${RECOMMENDER_NS}:application:*`),
    getAdIdDetails(),
  ]);
  if (!adData || !adData.by_promoter) {
    return res.status(503).json({ error: 'Promotion stats are unavailable', code: 'PROMOTION_STATS_UNAVAILABLE' });
  }
  const applications = new Map(applicationRows
    .map(row => row.value)
    .filter(application => application.status === 'active')
    .map(application => [usernameKey(application.username), application]));
  const ownerIndex = await loadSourceOwnerIndex(redis, adData);
  const rows = [];
  let ownerConflictsExcluded = 0;
  for (const { value: relationship } of relationshipRows) {
    const parent = usernameKey(relationship.parent);
    const child = usernameKey(relationship.child);
    const application = applications.get(parent);
    if (!application || !child || child === parent) continue;
    const walletIdentity = await resolveWalletStorageIdentity(redis, child);
    if (walletIdentity.conflict) {
      ownerConflictsExcluded += 1;
      continue;
    }
    const ownership = await inspectApprovedSourceWalletOwner(
      redis,
      adData,
      child,
      walletIdentity.storageUsername,
      ownerIndex,
    );
    if (!ownership.authorized) {
      ownerConflictsExcluded += 1;
      continue;
    }
    const statement = referralCommissionStatement(adData, relationship, application, 0.05, ownership);
    if (!statement) continue;
    rows.push({
      relationship_id: `nfr_${hashValue(`${ACTIVITY_VERSION}:${parent}:${child}:${statement.effective_at}`).slice(0, 24)}`,
      parent,
      child,
      referral_code: relationship.referral_code,
      relationship_bound_at: relationship.bound_at,
      recommender_activated_at: application.created_at,
      effective_date: statement.effective_date,
      child_promoter_key: statement.child_promoter_key,
      gross_dn_income: statement.gross_dn_income,
      commission_rate: statement.commission_rate,
      commission_accrued_cumulative: statement.commission_accrued_cumulative,
      covered_days: statement.covered_days,
      stats_last_updated: adData.last_updated || '',
      calculation_mode: 'read_only_cumulative_not_a_payout_instruction',
    });
  }
  rows.sort((a, b) => a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child));
  const query = req.query || {};
  if (String(query.format || '').toLowerCase() === 'csv') {
    const fields = [
      'relationship_id', 'parent', 'child', 'referral_code', 'relationship_bound_at',
      'recommender_activated_at', 'effective_date', 'child_promoter_key', 'gross_dn_income',
      'commission_rate', 'commission_accrued_cumulative', 'covered_days', 'stats_last_updated', 'calculation_mode',
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).end(toCsv(rows, fields));
  }
  return res.status(200).json({
    success: true,
    read_only: true,
    writes_performed: false,
    activity_version: ACTIVITY_VERSION,
    stats_last_updated: adData.last_updated || null,
    total_relationships: rows.length,
    total_gross_dn_income: roundMoney(rows.reduce((sum, row) => sum + row.gross_dn_income, 0)),
    total_commission_accrued_cumulative: roundMoney(rows.reduce((sum, row) => sum + row.commission_accrued_cumulative, 0)),
    payout_instruction: false,
    requires_prior_payout_reconciliation: true,
    owner_conflicts_excluded: ownerConflictsExcluded,
    commission_statements: rows,
  });
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: true })) return;
  res.setHeader('Cache-Control', 'private, no-store');
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const redis = redisClient();
  if (!redis) return res.status(503).json({ error: 'Activity storage unavailable', code: 'ACTIVITY_STORAGE_UNAVAILABLE' });
  const username = usernameKey(payload.username);

  try {
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
    await assertAccountIdentity(redis, payload);
    const admin = await isAdminUser(redis, username);
    const query = req.query || {};
    const exportMode = String(query.admin_export || '').toLowerCase();
    if (req.method === 'GET' && exportMode) {
      if (!admin) return res.status(403).json({ error: 'Admin only', code: 'ADMIN_ONLY' });
      const exportAllowed = await checkRateLimit(
        redis,
        `nf_rate:activity_export:${username}`,
        12,
        3600,
        { failClosed: true },
      );
      if (!exportAllowed) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
      if (exportMode === 'commission' || exportMode === 'commissions') {
        return adminCommissionExport(req, res, redis);
      }
      return adminClaimsExport(req, res, redis);
    }
    if (req.method === 'GET') {
      const readAllowed = await checkRateLimit(
        redis,
        `nf_rate:activity_read:${username}`,
        120,
        3600,
        { failClosed: true },
      ) && await checkRateLimit(
        redis,
        `nf_rate:activity_read_ip:${getClientIp(req)}`,
        600,
        3600,
        { failClosed: true },
      );
      if (!readAllowed) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
      const [eligibility, invite, vip2, facebook, inviteVip, inviteEvents, recommender] = await Promise.all([
        loadEligibility(username, { redis }),
        ensureReferralCode(redis, username),
        readClaim(redis, 'vip2', username),
        readClaim(redis, 'facebook', username),
        readClaim(redis, 'invite_vip', username),
        readInviteEvents(redis, username),
        redis.get(`${RECOMMENDER_NS}:application:${username}`).then(value => parseJson(value, null)),
      ]);
      return res.status(200).json({
        success: true,
        window: activityWindow(),
        eligibility,
        invite: {
          ...invite,
          campaign_invites: eligibility.campaignInvites,
          reward_days_available: Math.max(0, eligibility.totalDays - awardedInviteDays(inviteEvents)),
        },
        claims: { vip2, facebook, invite_vip: inviteVip },
        fulfillment_events: { invite_vip: inviteEvents },
        recommender,
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const allowed = await checkRateLimit(redis, `nf_rate:activity:${username}`, 30, 3600, { failClosed: true }) &&
      await checkRateLimit(redis, `nf_rate:activity_ip:${getClientIp(req)}`, 120, 3600, { failClosed: true });
    if (!allowed) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
    const window = activityWindow();
    if (window.upcoming) return res.status(400).json({ error: 'This activity has not started', code: 'ACTIVITY_NOT_STARTED', window });
    if (window.ended) return res.status(400).json({ error: 'This activity has ended', code: 'ACTIVITY_ENDED', window });

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const action = String(body.action || '').trim();
    const [eligibility, invite] = await Promise.all([
      loadEligibility(username, { redis, requireFresh: action === 'apply_recommender' }),
      ensureReferralCode(redis, username),
    ]);
    let task;
    let lock;
    try {
      if (action === 'claim_vip2') {
        task = 'vip2';
        let binding;
        try { binding = await verifiedBinding(redis, username, body.novelflow_id, 'limited_subsidy'); }
        catch (error) { const failure = memberLookupError(error); return res.status(failure.status).json({ error: failure.message, code: failure.code }); }
        const id = { display: binding.user_id, key: binding.user_id };
        lock = await acquireActivityLock(redis, task, username);
        if (!lock) return res.status(409).json({ error: 'Another activity claim is being processed', code: 'ACTIVITY_BUSY' });
        const existing = await readClaim(redis, task, username);
        if (existing) {
          const entitlement = await createVipEntitlement(redis, {
            username, binding, source: 'limited_subsidy', sourceId: ACTIVITY_VERSION,
            days: 2, metadata: { claim_id: existing.claim_id },
          });
          const repairedClaim = await updateClaim(redis, task, username, {
            ...existing,
            status: entitlement.event.status,
            vip_event_id: entitlement.event.event_id,
            fulfillment: 'vip_outbox',
            updated_at: new Date().toISOString(),
          });
          return res.status(200).json({ success: true, idempotent: true, claim: repairedClaim, eligibility, invite });
        }
        let claim = claimBase(username, task, {
          novelflow_id: id.display,
          novelflow_id_hash: hashValue(id.key),
          reward_days: 2,
          fulfillment: 'batch_vip',
        });
        const entitlementEvent = buildVipEntitlement({
          username, binding, source: 'limited_subsidy', sourceId: ACTIVITY_VERSION,
          days: 2, metadata: { claim_id: claim.claim_id },
        });
        const reservation = await reserveLimitedSubsidyClaim(redis, username, id, claim, entitlementEvent);
        claim = reservation.claim;
        const entitlement = { event: entitlementEvent, created: reservation.created };
        claim = await updateClaim(redis, task, username, {
          ...claim,
          status: entitlement.event.status,
          vip_event_id: entitlement.event.event_id,
          fulfillment: 'vip_outbox',
        });
        return res.status(200).json({ success: true, idempotent: !entitlement.created, claim, eligibility, invite });
      }

      if (action === 'submit_social' || action === 'submit_facebook') {
        task = 'facebook';
        let binding;
        try { binding = await verifiedBinding(redis, username, body.novelflow_id, 'social_claim'); }
        catch (error) { const failure = memberLookupError(error); return res.status(failure.status).json({ error: failure.message, code: failure.code }); }
        const id = { display: binding.user_id, key: binding.user_id };
        const socialUrl = normalizePublicSocialUrl(body.social_url || body.facebook_url);
        if (!id) return res.status(400).json({ error: 'Enter a valid NovelFlow ID', code: 'INVALID_NOVELFLOW_ID' });
        if (!socialUrl) return res.status(400).json({ error: 'Enter a public HTTPS social post URL', code: 'INVALID_SOCIAL_URL' });
        lock = await acquireActivityLock(redis, task, username);
        if (!lock) return res.status(409).json({ error: 'Another activity claim is being processed', code: 'ACTIVITY_BUSY' });
        const existing = await readClaim(redis, task, username);
        if (existing) return res.status(200).json({ success: true, idempotent: true, claim: existing, eligibility, invite });
        const idReservation = await reserveUnique(redis, task, id.key, username);
        let urlReservation;
        try {
          // Keep the legacy reservation namespace so an old Facebook claim
          // cannot be submitted again through the generalized social action.
          urlReservation = await reserveUnique(redis, 'facebook_url', socialUrl, username);
        } catch (error) {
          await releaseUnique(redis, idReservation);
          throw error;
        }
        let claim;
        try {
          claim = await saveClaim(redis, task, username, claimBase(username, task, {
            status: 'pending_review',
            novelflow_id: id.display,
            novelflow_id_hash: hashValue(id.key),
            social_url: socialUrl,
            social_url_hash: hashValue(socialUrl),
            // Retained for exports and records created before the social task
            // was expanded beyond Facebook.
            facebook_url: socialUrl,
            facebook_url_hash: hashValue(socialUrl),
            reward_bonus: 1,
            fulfillment: 'manual_review_then_bonus',
          }));
        } catch (error) {
          await releaseUnique(redis, idReservation);
          await releaseUnique(redis, urlReservation);
          throw error;
        }
        return res.status(200).json({ success: true, claim, eligibility, invite });
      }

      if (action === 'claim_invite_vip') {
        task = 'invite_vip';
        let verifiedMemberBinding;
        try { verifiedMemberBinding = await verifiedBinding(redis, username, body.novelflow_id, 'invite_vip'); }
        catch (error) { const failure = memberLookupError(error); return res.status(failure.status).json({ error: failure.message, code: failure.code }); }
        const id = { display: verifiedMemberBinding.user_id, key: verifiedMemberBinding.user_id };
        lock = await acquireActivityLock(redis, task, username);
        if (!lock) return res.status(409).json({ error: 'Another activity claim is being processed', code: 'ACTIVITY_BUSY' });
        const existing = await readClaim(redis, task, username);
        const events = await readInviteEvents(redis, username);
        const claimedDays = awardedInviteDays(events);
        const remainingDays = Math.max(0, eligibility.totalDays - claimedDays);
        if (remainingDays <= 0) {
          const matchingEvent = events.find(event => Number(event.entitlement_total_days) === eligibility.totalDays);
          if (matchingEvent) {
            const repaired = await ensureInviteVipEntitlement(redis, username, verifiedMemberBinding, matchingEvent);
            const baseClaim = existing || claimBase(username, task, {
              claim_id: matchingEvent.claim_id,
              novelflow_id: matchingEvent.novelflow_id,
              novelflow_id_hash: matchingEvent.novelflow_id_hash,
            });
            const repairedClaim = await updateClaim(redis, task, username, {
              ...baseClaim,
              status: 'pending_fulfillment',
              total_claimed_days: claimedDays,
              last_reward_days: Number(repaired.event.reward_days || 0),
              campaign_invites: eligibility.campaignInvites,
              pair_days: eligibility.pairDays,
              milestone_days: eligibility.milestoneDays,
              updated_at: new Date().toISOString(),
              fulfillment: 'batch_vip_events',
            });
            return res.status(200).json({
              success: true,
              idempotent: true,
              claim: repairedClaim,
              fulfillment_event: repaired.event,
              eligibility,
              invite,
            });
          }
          return res.status(400).json({ error: 'No new invite reward is available', code: 'NO_REWARD_AVAILABLE', eligibility, claim: existing, invite });
        }
        const binding = await ensureInviteBinding(redis, username, id, existing);
        const claim = existing || claimBase(username, task, {
          novelflow_id: binding.novelflow_id,
          novelflow_id_hash: binding.novelflow_id_hash,
        });
        const savedEvent = await saveInviteEvent(
          redis,
          username,
          claim,
          binding,
          eligibility,
          remainingDays,
          claimedDays + remainingDays,
        );
        const ensured = await ensureInviteVipEntitlement(
          redis,
          username,
          verifiedMemberBinding,
          savedEvent.event,
        );
        savedEvent.event = ensured.event;
        const updatedClaim = await updateClaim(redis, task, username, {
          ...claim,
          novelflow_id: binding.novelflow_id,
          novelflow_id_hash: binding.novelflow_id_hash,
          status: 'pending_fulfillment',
          total_claimed_days: claimedDays + Number(savedEvent.event.reward_days || 0),
          last_reward_days: Number(savedEvent.event.reward_days || 0),
          campaign_invites: eligibility.campaignInvites,
          pair_days: eligibility.pairDays,
          milestone_days: eligibility.milestoneDays,
          updated_at: new Date().toISOString(),
          fulfillment: 'batch_vip_events',
        });
        return res.status(200).json({
          success: true,
          idempotent: !savedEvent.created,
          claim: updatedClaim,
          fulfillment_event: savedEvent.event,
          eligibility,
          invite,
        });
      }

      if (action === 'apply_recommender') {
        task = 'recommender';
        if (!eligibility.recommenderEligible) {
          return res.status(400).json({ error: 'You need at least 5 measured new users', code: 'RECOMMENDER_NOT_ELIGIBLE', eligibility, invite });
        }
        lock = await acquireActivityLock(redis, task, 'recommender');
        if (!lock) return res.status(409).json({ error: 'Another recommender application is being processed', code: 'ACTIVITY_BUSY' });
        const application = await reserveRecommender(redis, username, eligibility, invite);
        return res.status(200).json({ success: true, application, eligibility, invite });
      }

      return res.status(400).json({ error: 'Unknown activity action', code: 'INVALID_ACTIVITY_ACTION' });
    } finally {
      await releaseActivityLock(redis, lock);
    }
  } catch (error) {
    console.error('[activity-rewards] error:', error);
    if (error && ['STATS_STALE', 'PROMOTION_STATS_UNAVAILABLE', 'INCOME_SOURCE_OWNER_UNAVAILABLE', 'INCOME_SOURCE_UNAVAILABLE'].includes(error.code)) {
      return res.status(503).json({ error: error.message, code: error.code, stats_last_updated: error.statsLastUpdated || null });
    }
    if (error && error.code === 'INCOME_SOURCE_OWNER_UNVERIFIED') {
      return res.status(403).json({ error: error.message, code: error.code });
    }
    if (error && ['INCOME_SOURCE_OWNER_CONFLICT', 'WALLET_IDENTITY_CONFLICT'].includes(error.code)) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    if (error && error.code === 'IDENTIFIER_ALREADY_USED') return res.status(409).json({ error: error.message, code: error.code });
    if (error && error.code === 'DAILY_SUBSIDY_FULL') return res.status(409).json({ error: error.message, code: error.code });
    if (error && error.code === 'NOVELFLOW_ID_IMMUTABLE') return res.status(409).json({ error: error.message, code: error.code });
    if (error && error.code === 'RECOMMENDER_SLOTS_FULL') return res.status(409).json({ error: error.message, code: error.code });
    if (error && error.code === 'ACCOUNT_IDENTITY_CONFLICT') return res.status(409).json({ error: 'Account identity recovery required', code: error.code });
    return res.status(503).json({ error: 'Activity service temporarily unavailable', code: 'ACTIVITY_STORAGE_UNAVAILABLE' });
  }
};

module.exports._test = {
  awardedInviteDays,
  grossIncomeSince,
  LIMITED_SUBSIDY_CAP_NS,
  scanJson,
};
