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
  normalizeFacebookUrl,
  normalizeNovelFlowId,
} = require('./_lib/activity-eligibility');
const { getAdIdDetails, resolvePromoterKey } = require('./_lib/stats-data');
const { isSystemStatsBucket } = require('./_lib/promoter-access');
const { ensureReferralCode } = require('./_lib/referrals');

const NS = 'nf_activity_claim:v1';
const UNIQUE_NS = 'nf_activity_unique:v1';
const EVENT_NS = 'nf_activity_event:v1';
const BINDING_NS = 'nf_activity_binding:v1';
const RECOMMENDER_NS = 'nf_recommender:v1';
const MAX_CLAIM_BYTES = 32 * 1024;

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function usernameKey(value) {
  return String(value || '').trim().toLowerCase();
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
      'facebook_url', 'reward_days', 'reward_bonus', 'total_awarded_days', 'campaign_invites', 'measured_new_users',
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

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function grossIncomeSince(adData, promoterKey, effectiveDate) {
  if (!promoterKey || isSystemStatsBucket(promoterKey)) return { gross: 0, days: 0 };
  let gross = 0;
  const days = new Set();
  const promoterEntry = adData.by_promoter && adData.by_promoter[promoterKey];
  const allowedAssets = new Set([
    ...((promoterEntry && promoterEntry.links) || []).map(String),
    ...((promoterEntry && promoterEntry.codes) || []).map(String),
  ]);
  for (const [assetKey, entry] of Object.entries(adData.ad_ids || {})) {
    const taggedOwner = String(entry && entry.username_canon || '').toLowerCase();
    const assetId = String(entry && (entry.ad_id || entry.id || assetKey) || '');
    if (allowedAssets.size && !allowedAssets.has(assetId) && taggedOwner !== promoterKey) continue;
    if (!allowedAssets.size && taggedOwner !== promoterKey) continue;
    const dailyRows = Array.isArray(entry.daily)
      ? entry.daily
      : Object.entries(entry.daily || {}).map(([dt, values]) => ({ dt, ...(values || {}) }));
    for (const row of dailyRows) {
      const date = String(row && row.dt || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < effectiveDate) continue;
      gross += Number(row.dn_income) || 0;
      days.add(date);
    }
  }
  return { gross: roundMoney(gross), days: days.size };
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
  const rows = [];
  for (const { value: relationship } of relationshipRows) {
    const parent = usernameKey(relationship.parent);
    const child = usernameKey(relationship.child);
    const application = applications.get(parent);
    if (!application || !child || child === parent) continue;
    const effectiveAt = [relationship.bound_at, application.created_at]
      .filter(Boolean)
      .sort()
      .at(-1);
    if (!effectiveAt) continue;
    const effectiveDate = String(effectiveAt).slice(0, 10);
    const promoterKey = resolvePromoterKey(child, adData);
    const income = grossIncomeSince(adData, promoterKey, effectiveDate);
    const commission = roundMoney(income.gross * 0.05);
    rows.push({
      relationship_id: `nfr_${hashValue(`${ACTIVITY_VERSION}:${parent}:${child}:${effectiveAt}`).slice(0, 24)}`,
      parent,
      child,
      referral_code: relationship.referral_code,
      relationship_bound_at: relationship.bound_at,
      recommender_activated_at: application.created_at,
      effective_date: effectiveDate,
      child_promoter_key: promoterKey && !isSystemStatsBucket(promoterKey) ? promoterKey : '',
      gross_dn_income: income.gross,
      commission_rate: 0.05,
      commission_accrued_cumulative: commission,
      covered_days: income.days,
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
        const id = normalizeNovelFlowId(body.novelflow_id);
        if (!id) return res.status(400).json({ error: 'Enter a valid NovelFlow ID', code: 'INVALID_NOVELFLOW_ID' });
        lock = await acquireActivityLock(redis, task, username);
        if (!lock) return res.status(409).json({ error: 'Another activity claim is being processed', code: 'ACTIVITY_BUSY' });
        const existing = await readClaim(redis, task, username);
        if (existing) return res.status(200).json({ success: true, idempotent: true, claim: existing, eligibility, invite });
        const reservation = await reserveUnique(redis, task, id.key, username);
        let claim;
        try {
          claim = await saveClaim(redis, task, username, claimBase(username, task, {
            novelflow_id: id.display,
            novelflow_id_hash: hashValue(id.key),
            reward_days: 2,
            fulfillment: 'batch_vip',
          }));
        } catch (error) {
          await releaseUnique(redis, reservation);
          throw error;
        }
        return res.status(200).json({ success: true, claim, eligibility, invite });
      }

      if (action === 'submit_facebook') {
        task = 'facebook';
        const id = normalizeNovelFlowId(body.novelflow_id);
        const facebookUrl = normalizeFacebookUrl(body.facebook_url);
        if (!id) return res.status(400).json({ error: 'Enter a valid NovelFlow ID', code: 'INVALID_NOVELFLOW_ID' });
        if (!facebookUrl) return res.status(400).json({ error: 'Enter a Facebook group post URL', code: 'INVALID_FACEBOOK_URL' });
        lock = await acquireActivityLock(redis, task, username);
        if (!lock) return res.status(409).json({ error: 'Another activity claim is being processed', code: 'ACTIVITY_BUSY' });
        const existing = await readClaim(redis, task, username);
        if (existing) return res.status(200).json({ success: true, idempotent: true, claim: existing, eligibility, invite });
        const idReservation = await reserveUnique(redis, task, id.key, username);
        let urlReservation;
        try {
          urlReservation = await reserveUnique(redis, 'facebook_url', facebookUrl, username);
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
            facebook_url: facebookUrl,
            facebook_url_hash: hashValue(facebookUrl),
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
        const id = normalizeNovelFlowId(body.novelflow_id);
        if (!id) return res.status(400).json({ error: 'Enter a valid NovelFlow ID', code: 'INVALID_NOVELFLOW_ID' });
        lock = await acquireActivityLock(redis, task, username);
        if (!lock) return res.status(409).json({ error: 'Another activity claim is being processed', code: 'ACTIVITY_BUSY' });
        const existing = await readClaim(redis, task, username);
        const events = await readInviteEvents(redis, username);
        const claimedDays = awardedInviteDays(events);
        const remainingDays = Math.max(0, eligibility.totalDays - claimedDays);
        if (remainingDays <= 0) {
          const matchingEvent = events.find(event => Number(event.entitlement_total_days) === eligibility.totalDays);
          if (matchingEvent) {
            return res.status(200).json({ success: true, idempotent: true, claim: existing, fulfillment_event: matchingEvent, eligibility, invite });
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
    if (error && ['STATS_STALE', 'PROMOTION_STATS_UNAVAILABLE'].includes(error.code)) {
      return res.status(503).json({ error: error.message, code: error.code, stats_last_updated: error.statsLastUpdated || null });
    }
    if (error && error.code === 'IDENTIFIER_ALREADY_USED') return res.status(409).json({ error: error.message, code: error.code });
    if (error && error.code === 'NOVELFLOW_ID_IMMUTABLE') return res.status(409).json({ error: error.message, code: error.code });
    if (error && error.code === 'RECOMMENDER_SLOTS_FULL') return res.status(409).json({ error: error.message, code: error.code });
    if (error && error.code === 'ACCOUNT_IDENTITY_CONFLICT') return res.status(409).json({ error: 'Account identity recovery required', code: error.code });
    return res.status(503).json({ error: 'Activity service temporarily unavailable', code: 'ACTIVITY_STORAGE_UNAVAILABLE' });
  }
};

module.exports._test = {
  awardedInviteDays,
  grossIncomeSince,
  scanJson,
};
