/**
 * POST /api/rewards
 *
 * Server-side reward processing — all point/bonus/VIP/checkin mutations MUST go here.
 * Client submits an action; server validates eligibility, applies rewards atomically.
 *
 * Actions:
 *   - checkin         : Daily check-in (award streak points)
 *   - claim_mission   : Claim a completed mission (share1=20pts, share3=50pts, bindId=30pts)
 *   - bind_id         : Save NovelFlow ID (bind_id) — validated client-side, server stores it
 *   - exchange_vip    : Spend 1000 points for 3 VIP days
 *   - claim_streak_grand : Claim the 7-day streak cash bonus (+$0.5)
 *   - confirm_streak_vip : Confirm delivery of the separate 2-day VIP reward
 *
 * Auth: JWT required. All mutations apply ONLY to the authenticated user.
 */
const { handlePreflight } = require('./_lib/cors');
const { assertAccountIdentity, getAuthPayload, getRedis, checkRateLimit, getClientIp } = require('./_lib/security');
const { principalFromPayload } = require('./_lib/identity');
const { Redis } = require('@upstash/redis');
const { commitUserDataUnderLock, releaseUserDataLock } = require('./_lib/user-data-lock');
const { normalizeRedisKeys } = require('./_lib/redis-values');
const { isSafeMoneyValue, splitStoredBonus } = require('./_lib/commission-policy');
const { resolveNovelFlowMember } = require('./_lib/novelflow-member');
const { getAdIdDetails, buildAdIdLookup, submissionAssetIds } = require('./_lib/stats-data');
const { acquireWalletCreationSourceGuard } = require('./_lib/income-source-owners');
const { localLoginCredentialCandidates } = require('./_lib/login-identity');
const {
  acquireCheckinWalletDataLock,
  acquireWalletDataLock,
  resolveUsernameAlias,
} = require('./_lib/wallet-identity');
const {
  bindNovelFlowMember,
  buildVipEntitlement,
  commitUserDataWithVipEntitlement,
  loadVerifiedNovelFlowBinding,
} = require('./_lib/vip-entitlements');

const STREAK_POINTS = [5, 5, 5, 5, 5, 10, 15]; // day 1-7
const MISSION_POINTS = { share1: 20, share3: 50, bindId: 30 };
const VIP_COST = 1000;
const VIP_DAYS_AWARDED = 3;
const STREAK_GRAND_BONUS = 0.50;
const STREAK_GRAND_VIP = 2;
const STREAK_GRAND_REQUIRED = 7;
const STREAK_GRAND_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const PER_USER_ACTION_LIMIT = 60; // per hour per user (generous, prevents abuse)
const RATE_WINDOW = 3600;
const MAX_REWARD_HISTORY = 100;

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function safeParse(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

async function getUserData(redis, username) {
  const raw = await redis.get(`nf_user_data:${username}`);
  if (!raw) return {};
  const parsed = safeParse(raw, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('User data is corrupt');
    error.code = 'USER_DATA_CORRUPT';
    throw error;
  }
  return parsed;
}

async function saveUserData(redis, username, data, locks) {
  await commitUserDataUnderLock(redis, `nf_user_data:${username}`, data, locks);
}

function normalizeUserData(data) {
  if (!data || typeof data !== 'object') data = {};
  const numericFields = [
    ['points', data.points],
    ['bonus_balance', data.bonus_balance],
    ['vip_days', data.vip_days],
  ];
  for (const [field, raw] of numericFields) {
    // Only a genuinely absent legacy field defaults to zero. Explicit null or
    // empty values may be evidence of an earlier non-finite serialization and
    // must never be normalized away by a reward write.
    const value = raw === undefined ? 0 : Number(raw);
    if ((raw !== undefined && !isSafeMoneyValue(raw)) || !isSafeMoneyValue(value) || value < 0) {
      const error = new Error(`Reward account field ${field} requires reconciliation`);
      error.code = 'REWARD_DATA_RECONCILIATION_REQUIRED';
      error.field = field;
      throw error;
    }
    data[field] = value;
  }
  if (!data.checkin || typeof data.checkin !== 'object' || Array.isArray(data.checkin)) {
    data.checkin = { streak: 0, lastCheckin: null, history: [] };
  }
  if (!data.claimed || typeof data.claimed !== 'object' || Array.isArray(data.claimed)) {
    data.claimed = {};
  }
  data.reward_history = Array.isArray(data.reward_history) ? data.reward_history : [];
  if (!Array.isArray(data.checkin.history)) data.checkin.history = [];
  if (data.bind_id !== undefined && typeof data.bind_id !== 'string') data.bind_id = null;
  return data;
}

function rewardState(data) {
  return {
    points: Number(data.points) || 0,
    streak: Number(data.checkin && data.checkin.streak) || 0,
    vip_days: Number(data.vip_days) || 0,
    bonus_balance: Number(data.bonus_balance) || 0,
  };
}

function appendRewardHistory(data, action, before, details = {}) {
  const after = rewardState(data);
  const entry = {
    action,
    timestamp: new Date().toISOString(),
    points_before: before.points,
    points_after: after.points,
    points_delta: after.points - before.points,
    streak_before: before.streak,
    streak_after: after.streak,
    vip_days_before: before.vip_days,
    vip_days_after: after.vip_days,
    bonus_before: before.bonus_balance,
    bonus_after: after.bonus_balance,
    ...details,
  };
  data.reward_history = [...data.reward_history, entry].slice(-MAX_REWARD_HISTORY);
}

async function loadVerifiedPromotionCount(redis, username) {
  // Promotion indexes predate the canonical local-login namespace. Read the
  // narrow, reviewed aliases for the authenticated account so a historical
  // submission under `@cons espher` is not invisible to the canonical
  // `cons_espher` account. Do not scan arbitrary keys or trust a client alias.
  const identity = localLoginCredentialCandidates(username);
  const candidates = Array.from(new Set((identity.usernames || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean)));
  if (!candidates.length) return 0;
  const indexed = await Promise.all(candidates.map(candidate =>
    redis.smembers(`nf_user_subs:${candidate}`),
  ));
  const keys = normalizeRedisKeys(indexed.flat()).slice(0, 1000);
  if (!keys.length) return 0;

  let rows;
  if (typeof redis.pipeline === 'function') {
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.hget('nf_subs', key);
    rows = await pipeline.exec();
  } else {
    rows = await Promise.all(keys.map(key => redis.hget('nf_subs', key)));
  }

  const books = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index];
    if (!raw) continue;
    let submission;
    try {
      submission = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_error) {
      continue;
    }
    if (!submission || typeof submission !== 'object' || submission.status !== 'completed') continue;
    const owner = String(submission.discordUsername || submission.username || '').trim().toLowerCase();
    if (owner) {
      const ownerIdentity = localLoginCredentialCandidates(owner);
      const ownerPrimary = String(ownerIdentity.primaryUsername || '').trim().toLowerCase();
      if (!candidates.includes(owner) && !candidates.includes(ownerPrimary)) continue;
    }
    const bookId = String(submission.bookId || '').trim();
    const title = String(submission.matchedBookName || submission.bookName || '').trim().toLowerCase();
    const assetId = String(submission.linkId || submission.inviteCode || submission.code || '').trim();
    if (!assetId) continue;
    const identity = bookId ? `book:${bookId}` : title ? `title:${title}` : assetId ? `asset:${assetId}` : '';
    if (identity) books.add(identity);
  }
  return books.size;
}

async function loadVerifiedPromotionEligibility(redis, username) {
  const assetCount = await loadVerifiedPromotionCount(redis, username);
  if (!assetCount) return { assetCount: 0, newUsers: 0 };
  const adData = await getAdIdDetails();
  if (!adData) return { assetCount, newUsers: 0 };
  const identity = localLoginCredentialCandidates(username);
  const candidates = Array.from(new Set((identity.usernames || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean)));
  const indexed = await Promise.all(candidates.map(candidate => redis.smembers(`nf_user_subs:${candidate}`)));
  const keys = normalizeRedisKeys(indexed.flat()).slice(0, 1000);
  const rows = typeof redis.pipeline === 'function'
    ? await (async () => { const p = redis.pipeline(); keys.forEach(key => p.hget('nf_subs', key)); return p.exec(); })()
    : await Promise.all(keys.map(key => redis.hget('nf_subs', key)));
  const assetIds = new Set();
  for (const raw of rows) {
    const sub = safeParse(raw, null);
    if (!sub || sub.status !== 'completed') continue;
    for (const id of submissionAssetIds(sub)) assetIds.add(String(id));
  }
  const lookup = buildAdIdLookup(adData, null, true, []);
  let newUsers = 0;
  for (const id of assetIds) if (lookup.byAdId[id]) newUsers += Number(lookup.byAdId[id].new_uv) || 0;
  return { assetCount, newUsers };
}

async function resolveRewardVipBinding(redis, username, memberId, source) {
  const savedBinding = await loadVerifiedNovelFlowBinding(redis, username, memberId);
  if (savedBinding) return savedBinding;
  return bindNovelFlowMember(redis, username, await resolveNovelFlowMember(memberId), { source });
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });

  const username = resolveUsernameAlias(payload.username);
  const redis = redisClient();
  if (!redis) return res.status(503).json({ error: 'Database unavailable' });
  try {
    await assertAccountIdentity(redis, payload);
  } catch (error) {
    return res.status(error && error.code === 'ACCOUNT_IDENTITY_CONFLICT' ? 409 : 503).json({
      error: 'Account identity recovery required',
      code: error && error.code || 'ACCOUNT_STATUS_UNAVAILABLE',
    });
  }

  // Rate limit per user + IP
  const clientIp = getClientIp(req);
  const userKey = `nf_rate:rewards:${username}`;
  const ipKey = `nf_rate:rewards_ip:${clientIp}`;
  try {
    if (!await checkRateLimit(redis, userKey, PER_USER_ACTION_LIMIT, RATE_WINDOW, { failClosed: true }) ||
        !await checkRateLimit(redis, ipKey, 30, RATE_WINDOW, { failClosed: true })) {
      return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
    }
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
  }

  const { action } = req.body || {};
  if (typeof action !== 'string' || action.length > 40) {
    return res.status(400).json({ error: 'Invalid action', code: 'INVALID_ACTION' });
  }
  let walletLock;
  try {
    // A cloud-sync write can overlap a tap on Check In. Wait briefly for that
    // normal write to finish instead of failing the user-facing action.
    const lockOptions = {
      waitMs: action === 'checkin' ? 6000 : 0,
      retryDelayMs: 100,
    };
    walletLock = action === 'checkin'
      ? await acquireCheckinWalletDataLock(redis, username, {
        ...lockOptions,
        expectedPrincipal: principalFromPayload(payload),
      })
      : await acquireWalletDataLock(redis, username, lockOptions);
  } catch (error) {
    if (error && error.code === 'WALLET_IDENTITY_CONFLICT') {
      return res.status(409).json({ error: 'Account identity recovery required', code: error.code });
    }
    return res.status(503).json({ error: 'Reward storage is temporarily unavailable', code: 'REWARD_STORAGE_UNAVAILABLE' });
  }
  const { lock, identity } = walletLock;
  if (!lock) {
    return res.status(409).json({ error: 'User data is being updated', code: 'USER_DATA_BUSY' });
  }

  let sourceGuard = null;
  try {
    // Daily check-in changes only the already-established canonical wallet's
    // points/streak. A legacy case-only duplicate reporting key must not block
    // that non-financial action, but it must also never cause a new wallet to
    // be created. Financial rewards keep the strict source-owner guard.
    const establishedCheckinWallet = action === 'checkin' &&
      (identity.matches.length === 1 || identity.reviewedLegacyCheckinWallet === true);
    if (!establishedCheckinWallet) {
      sourceGuard = await acquireWalletCreationSourceGuard(redis, username, identity);
    }
    const walletUsername = identity.storageUsername;
    const data = normalizeUserData(await getUserData(redis, walletUsername));
    if (data.disabled) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
    if (data.wallet_merged_into) {
      return res.status(409).json({ error: 'Wallet merged into a primary account', code: 'WALLET_MERGED' });
    }
    const before = rewardState(data);
    let historyDetails = {};
    let result = { success: true, action };
    let vipEntitlementEvent = null;

    switch (action) {

      // ========== DAILY CHECK-IN ==========
      case 'checkin': {
        const today = todayStr();
        if (data.checkin.lastCheckin === today) {
          return res.status(400).json({ error: 'Already checked in today', code: 'ALREADY_CHECKED_IN' });
        }
        // Compute streak
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        if (data.checkin.lastCheckin === yesterday) {
          data.checkin.streak = (data.checkin.streak || 0) + 1;
        } else {
          data.checkin.streak = 1;
        }
        data.checkin.lastCheckin = today;
        if (!data.checkin.history.includes(today)) data.checkin.history.push(today);
        // Cap history to last 60 days
        if (data.checkin.history.length > 60) {
          data.checkin.history = data.checkin.history.slice(-60);
        }
        const dayPts = STREAK_POINTS[Math.min(data.checkin.streak, STREAK_POINTS.length) - 1] || 5;
        data.points += dayPts;
        result = {
          ...result,
          points_awarded: dayPts,
          streak: data.checkin.streak,
          total_points: data.points,
          message: `Check-in successful! +${dayPts} points, ${data.checkin.streak}-day streak!`,
        };
        break;
      }

      // ========== CLAIM MISSION REWARD (share1/share3/bindId) ==========
      case 'claim_mission': {
        const { missionId } = req.body || {};
        if (!MISSION_POINTS[missionId]) {
          return res.status(400).json({ error: 'Invalid mission ID', code: 'INVALID_MISSION' });
        }
        if (data.claimed[missionId]) {
          return res.status(400).json({ error: 'Mission already claimed', code: 'ALREADY_CLAIMED' });
        }
        // Validate mission completion server-side
        if (missionId === 'share1' || missionId === 'share3') {
          let promotionCount;
          try {
            promotionCount = await loadVerifiedPromotionCount(redis, username);
          } catch (_error) {
            return res.status(503).json({ error: 'Promotion status temporarily unavailable', code: 'PROMOTION_STATUS_UNAVAILABLE' });
          }
          const required = missionId === 'share1' ? 1 : 3;
          if (promotionCount < required) {
            const label = required === 1 ? '1 book' : '3 books';
            return res.status(400).json({ error: `Share at least ${label} first`, code: 'NOT_ELIGIBLE' });
          }
        } else if (missionId === 'bindId') {
          if (!data.bind_id) {
            return res.status(400).json({ error: 'Bind your NovelFlow ID first', code: 'NOT_ELIGIBLE' });
          }
        }
        const pts = MISSION_POINTS[missionId];
        data.points += pts;
        data.claimed[missionId] = Date.now();
        historyDetails = { mission_id: missionId };
        result = {
          ...result,
          points_awarded: pts,
          total_points: data.points,
          message: `Mission completed! +${pts} points`,
        };
        break;
      }

      // ========== BIND NOVELFLOW ID ==========
      case 'bind_id': {
        const { bind_id } = req.body || {};
        let member;
        try {
          member = await resolveNovelFlowMember(bind_id);
          await bindNovelFlowMember(redis, username, member, { source: 'rewards' });
        } catch (error) {
          const status = ['NOVELFLOW_USER_NOT_FOUND', 'INVALID_NOVELFLOW_USER_ID'].includes(error && error.code) ? 400
            : (['NOVELFLOW_ID_ALREADY_BOUND', 'NOVELFLOW_BINDING_IMMUTABLE'].includes(error && error.code) ? 409 : 503);
          return res.status(status).json({
            error: error.message || 'NovelFlow ID could not be verified',
            code: error.code || 'NOVELFLOW_LOOKUP_FAILED',
          });
        }
        data.bind_id = member.user_id;
        data.bind_id_verified_at = new Date().toISOString();
        historyDetails = { bind_id_verified: true };
        result = {
          ...result,
          bind_id: member.user_id,
          message: 'NovelFlow ID bound successfully!',
        };
        break;
      }

      // ========== EXCHANGE POINTS FOR VIP ==========
      case 'exchange_vip': {
        if (data.points < VIP_COST) {
          return res.status(400).json({ error: `Need ${VIP_COST} points, you have ${data.points}`, code: 'INSUFFICIENT_POINTS' });
        }
        if (!data.bind_id) {
          return res.status(400).json({ error: 'Bind your NovelFlow ID first', code: 'NO_BIND_ID' });
        }
        let binding;
        try {
          binding = await resolveRewardVipBinding(redis, username, data.bind_id, 'exchange');
        } catch (error) {
          const status = error && error.code === 'NOVELFLOW_BINDING_CONFLICT' ? 409 : 503;
          return res.status(status).json({ error: 'NovelFlow account verification is unavailable', code: error.code || 'NOVELFLOW_LOOKUP_FAILED' });
        }
        const exchangeSequence = Math.floor(Number(data.vip_exchange_sequence) || 0) + 1;
        vipEntitlementEvent = buildVipEntitlement({
          username, binding, source: 'points_exchange', sourceId: exchangeSequence,
          days: VIP_DAYS_AWARDED, metadata: { points_cost: VIP_COST },
        });
        data.points -= VIP_COST;
        data.vip_days += VIP_DAYS_AWARDED;
        data.vip_exchange_sequence = exchangeSequence;
        result = {
          ...result,
          points_spent: VIP_COST,
          vip_days_awarded: VIP_DAYS_AWARDED,
          total_points: data.points,
          total_vip_days: data.vip_days,
          fulfillment_status: vipEntitlementEvent.status,
          vip_event_id: vipEntitlementEvent.event_id,
          message: `Exchanged ${VIP_COST} points for ${VIP_DAYS_AWARDED} VIP days!`,
        };
        break;
      }

      // ========== 7-DAY STREAK GRAND PRIZE ==========
      case 'claim_streak_grand': {
        if ((data.checkin.streak || 0) < STREAK_GRAND_REQUIRED) {
          return res.status(400).json({ error: `Need ${STREAK_GRAND_REQUIRED}-day streak`, code: 'STREAK_NOT_MET' });
        }
        let promotionEligibility;
        try { promotionEligibility = await loadVerifiedPromotionEligibility(redis, username); }
        catch (_error) { return res.status(503).json({ error: 'Promotion status temporarily unavailable', code: 'PROMOTION_STATUS_UNAVAILABLE' }); }
        if (promotionEligibility.assetCount < 1) {
          return res.status(400).json({ error: 'Create at least 1 book link first', code: 'NO_LINK' });
        }
        if (promotionEligibility.newUsers < 1) {
          return res.status(400).json({ error: 'Invite at least 1 new reader through your link first', code: 'NO_NEW_USER' });
        }
        const claimedKeys = Object.keys(data.claimed || {});
        if (claimedKeys.length < 1) {
          return res.status(400).json({ error: 'Complete at least 1 mission first', code: 'NO_MISSION' });
        }
        const pendingVip = data.streak_grand_vip_pending && typeof data.streak_grand_vip_pending === 'object'
          && !Array.isArray(data.streak_grand_vip_pending)
          ? data.streak_grand_vip_pending : null;
        if (pendingVip) {
          result = {
            ...result,
            bonus_awarded: 0,
            vip_days_awarded: 0,
            vip_confirmation_required: true,
            message: 'The $0.50 bonus was already credited. Confirm VIP delivery separately.',
          };
          break;
        }
        const previousClaimedAt = Date.parse(data.streak_grand_claimed || '');
        const nextAvailableAt = Number.isFinite(previousClaimedAt) ? previousClaimedAt + STREAK_GRAND_COOLDOWN_MS : 0;
        if (nextAvailableAt > Date.now()) {
          return res.status(400).json({
            error: 'The 7-day prize can be claimed once every 7 days',
            code: 'STREAK_GRAND_COOLDOWN',
            available_at: new Date(nextAvailableAt).toISOString(),
          });
        }
        const streakGrandSequence = Math.max(0, Number(data.streak_grand_sequence) || 0) + 1;
        data.bonus_balance = Math.round((data.bonus_balance + STREAK_GRAND_BONUS) * 100) / 100;
        data.streak_grand_sequence = streakGrandSequence;
        data.streak_grand_claimed = new Date().toISOString();
        data.streak_grand_vip_pending = { sequence: streakGrandSequence, created_at: data.streak_grand_claimed };
        result = {
          ...result,
          bonus_awarded: STREAK_GRAND_BONUS,
          vip_days_awarded: 0,
          vip_confirmation_required: true,
          total_bonus: data.bonus_balance,
          total_vip_days: data.vip_days,
          message: `7-day streak cash bonus claimed! +$${STREAK_GRAND_BONUS}. Confirm VIP delivery separately.`,
        };
        break;
      }

      // ========== CONFIRM 7-DAY VIP DELIVERY ==========
      case 'confirm_streak_vip': {
        const pendingVip = data.streak_grand_vip_pending && typeof data.streak_grand_vip_pending === 'object'
          && !Array.isArray(data.streak_grand_vip_pending)
          ? data.streak_grand_vip_pending : null;
        if (!pendingVip || !Number.isSafeInteger(Number(pendingVip.sequence)) || Number(pendingVip.sequence) <= 0) {
          return res.status(400).json({ error: 'No pending 7-day VIP reward', code: 'NO_PENDING_STREAK_VIP' });
        }
        if (!data.bind_id) return res.status(400).json({ error: 'Bind your verified NovelFlow ID first', code: 'NO_BIND_ID' });
        let streakBinding;
        try {
          streakBinding = await resolveRewardVipBinding(redis, username, data.bind_id, 'streak');
        } catch (error) {
          const status = error && error.code === 'NOVELFLOW_BINDING_CONFLICT' ? 409 : 503;
          return res.status(status).json({ error: 'NovelFlow account verification is unavailable', code: error.code || 'NOVELFLOW_LOOKUP_FAILED' });
        }
        const streakGrandSequence = Number(pendingVip.sequence);
        vipEntitlementEvent = buildVipEntitlement({
          username, binding: streakBinding, source: 'streak_grand', sourceId: streakGrandSequence,
          days: STREAK_GRAND_VIP, metadata: { streak: STREAK_GRAND_REQUIRED },
        });
        data.vip_days += STREAK_GRAND_VIP;
        delete data.streak_grand_vip_pending;
        historyDetails = { streak_grand_vip_confirmed: true, vip_days_awarded: STREAK_GRAND_VIP };
        result = {
          ...result,
          bonus_awarded: 0,
          vip_days_awarded: STREAK_GRAND_VIP,
          total_bonus: data.bonus_balance,
          total_vip_days: data.vip_days,
          fulfillment_status: vipEntitlementEvent.status,
          vip_event_id: vipEntitlementEvent.event_id,
          message: `7-day VIP reward confirmed! +${STREAK_GRAND_VIP} VIP days.`,
        };
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}`, code: 'INVALID_ACTION' });
    }

    appendRewardHistory(data, action, before, historyDetails);

    // Never serialize an anomalous numeric state. JSON.stringify(Infinity)
    // becomes null, which would otherwise erase the evidence needed for
    // wallet reconciliation.
    normalizeUserData(data);

    // Include updated snapshot
    result.snapshot = {
      points: data.points,
      bonus_balance: data.bonus_balance,
      reward_income_total: splitStoredBonus(data).reward_income_total,
      vip_days: data.vip_days,
      checkin: data.checkin,
      bind_id: data.bind_id || null,
      claimed: data.claimed,
      bonus_campaign1_claimed: data.bonus_campaign1_claimed || null,
      streak_grand_claimed: data.streak_grand_claimed || null,
      streak_grand_vip_pending: data.streak_grand_vip_pending || null,
      streak_grand_sequence: Number(data.streak_grand_sequence) || 0,
    };

    if (vipEntitlementEvent) {
      await commitUserDataWithVipEntitlement(redis, {
        userDataKey: `nf_user_data:${walletUsername}`,
        userData: data,
        event: vipEntitlementEvent,
        lock,
        additionalLocks: sourceGuard ? [sourceGuard] : [],
      });
    } else {
      await saveUserData(redis, walletUsername, data, [lock, sourceGuard]);
    }
    return res.status(200).json(result);

  } catch (error) {
    console.error('[rewards] Error:', {
      action,
      username,
      code: error && error.code || 'UNKNOWN',
      message: error && error.message || 'Unknown reward error',
      owners: Array.isArray(error && error.owners) ? error.owners : undefined,
    });
    if (error?.code === 'USER_DATA_CORRUPT') {
      return res.status(503).json({ error: 'User data is temporarily unavailable', code: error.code });
    }
    if (error?.code === 'REWARD_DATA_RECONCILIATION_REQUIRED') {
      return res.status(409).json({
        error: 'Reward data requires reconciliation before it can be changed',
        code: error.code,
        field: error.field || null,
      });
    }
    if (error?.code === 'VIP_ENTITLEMENT_EXISTS') {
      return res.status(409).json({ error: 'This VIP reward is already queued', code: error.code });
    }
    if (['INCOME_SOURCE_OWNER_UNVERIFIED', 'INCOME_SOURCE_OWNER_CONFLICT', 'INCOME_SOURCE_BUSY'].includes(error?.code)) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    return res.status(503).json({ error: 'Reward service temporarily unavailable', code: 'REWARD_STORAGE_UNAVAILABLE' });
  } finally {
    await releaseUserDataLock(redis, sourceGuard);
    await releaseUserDataLock(redis, lock);
  }
};
