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
 *   - claim_streak_grand : Claim 7-day streak grand prize (+$0.5 bonus + 2 VIP days)
 *
 * Auth: JWT required. All mutations apply ONLY to the authenticated user.
 */
const { handlePreflight } = require('./_lib/cors');
const { getAuthPayload, getRedis, checkRateLimit, getClientIp } = require('./_lib/security');
const { Redis } = require('@upstash/redis');

const STREAK_POINTS = [5, 5, 5, 5, 5, 10, 15]; // day 1-7
const MISSION_POINTS = { share1: 20, share3: 50, bindId: 30 };
const VIP_COST = 1000;
const VIP_DAYS_AWARDED = 3;
const STREAK_GRAND_BONUS = 0.50;
const STREAK_GRAND_VIP = 2;
const STREAK_GRAND_REQUIRED = 7;
const PER_USER_ACTION_LIMIT = 60; // per hour per user (generous, prevents abuse)
const RATE_WINDOW = 3600;

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
  return safeParse(raw, {});
}

async function saveUserData(redis, username, data) {
  await redis.set(`nf_user_data:${username}`, JSON.stringify(data));
}

function normalizeUserData(data) {
  if (!data || typeof data !== 'object') data = {};
  data.points = Number(data.points) || 0;
  data.bonus_balance = Number(data.bonus_balance) || 0;
  data.vip_days = Number(data.vip_days) || 0;
  data.checkin = data.checkin || { streak: 0, lastCheckin: null, history: [] };
  data.claimed = data.claimed || {};
  if (!Array.isArray(data.checkin.history)) data.checkin.history = [];
  if (data.bind_id !== undefined && typeof data.bind_id !== 'string') data.bind_id = null;
  return data;
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });

  const username = String(payload.username).toLowerCase();
  const redis = redisClient();
  if (!redis) return res.status(503).json({ error: 'Database unavailable' });

  // Check if account is disabled
  const preData = await getUserData(redis, username);
  if (preData && preData.disabled) {
    return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
  }

  // Rate limit per user + IP
  const clientIp = getClientIp(req);
  const userKey = `nf_rate:rewards:${username}`;
  const ipKey = `nf_rate:rewards_ip:${clientIp}`;
  if (!await checkRateLimit(redis, userKey, PER_USER_ACTION_LIMIT, RATE_WINDOW) ||
      !await checkRateLimit(redis, ipKey, 30, RATE_WINDOW)) {
    return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
  }

  const { action } = req.body || {};
  const data = normalizeUserData(await getUserData(redis, username));

  try {
    let result = { success: true, action };

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
        if (missionId === 'share1') {
          const myBooks = Array.isArray(data.myBooks) ? data.myBooks : [];
          if (myBooks.length < 1) {
            return res.status(400).json({ error: 'Share at least 1 book first', code: 'NOT_ELIGIBLE' });
          }
        } else if (missionId === 'share3') {
          const myBooks = Array.isArray(data.myBooks) ? data.myBooks : [];
          if (myBooks.length < 3) {
            return res.status(400).json({ error: 'Share at least 3 books first', code: 'NOT_ELIGIBLE' });
          }
        } else if (missionId === 'bindId') {
          if (!data.bind_id) {
            return res.status(400).json({ error: 'Bind your NovelFlow ID first', code: 'NOT_ELIGIBLE' });
          }
        }
        const pts = MISSION_POINTS[missionId];
        data.points += pts;
        data.claimed[missionId] = Date.now();
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
        if (!bind_id || typeof bind_id !== 'string' || bind_id.trim().length < 3) {
          return res.status(400).json({ error: 'Invalid bind ID (min 3 characters)', code: 'INVALID_ID' });
        }
        // Basic sanitization: alphanumerics, underscores, hyphens, colons, spaces allowed
        const clean = bind_id.trim().slice(0, 100);
        if (!/^[\w\-\s:]+$/.test(clean)) {
          return res.status(400).json({ error: 'Bind ID contains invalid characters', code: 'INVALID_ID' });
        }
        data.bind_id = clean;
        result = {
          ...result,
          bind_id: clean,
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
        data.points -= VIP_COST;
        data.vip_days += VIP_DAYS_AWARDED;
        result = {
          ...result,
          points_spent: VIP_COST,
          vip_days_awarded: VIP_DAYS_AWARDED,
          total_points: data.points,
          total_vip_days: data.vip_days,
          message: `Exchanged ${VIP_COST} points for ${VIP_DAYS_AWARDED} VIP days!`,
        };
        break;
      }

      // ========== 7-DAY STREAK GRAND PRIZE ==========
      case 'claim_streak_grand': {
        if ((data.checkin.streak || 0) < STREAK_GRAND_REQUIRED) {
          return res.status(400).json({ error: `Need ${STREAK_GRAND_REQUIRED}-day streak`, code: 'STREAK_NOT_MET' });
        }
        const myBooks = Array.isArray(data.myBooks) ? data.myBooks : [];
        if (myBooks.length < 1) {
          return res.status(400).json({ error: 'Create at least 1 book link first', code: 'NO_LINK' });
        }
        const claimedKeys = Object.keys(data.claimed || {});
        if (claimedKeys.length < 1) {
          return res.status(400).json({ error: 'Complete at least 1 mission first', code: 'NO_MISSION' });
        }
        if (data.streak_grand_claimed) {
          return res.status(400).json({ error: 'Already claimed grand prize', code: 'ALREADY_CLAIMED' });
        }
        data.bonus_balance = Math.round((data.bonus_balance + STREAK_GRAND_BONUS) * 100) / 100;
        data.vip_days += STREAK_GRAND_VIP;
        data.streak_grand_claimed = todayStr();
        result = {
          ...result,
          bonus_awarded: STREAK_GRAND_BONUS,
          vip_days_awarded: STREAK_GRAND_VIP,
          total_bonus: data.bonus_balance,
          total_vip_days: data.vip_days,
          message: `7-day streak grand prize claimed! +$${STREAK_GRAND_BONUS} +${STREAK_GRAND_VIP} VIP days!`,
        };
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}`, code: 'INVALID_ACTION' });
    }

    // Include updated snapshot
    result.snapshot = {
      points: data.points,
      bonus_balance: data.bonus_balance,
      vip_days: data.vip_days,
      checkin: data.checkin,
      bind_id: data.bind_id || null,
      claimed: data.claimed,
      streak_grand_claimed: data.streak_grand_claimed || null,
    };

    await saveUserData(redis, username, data);
    return res.status(200).json(result);

  } catch (error) {
    console.error('[rewards] Error:', error);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
};
