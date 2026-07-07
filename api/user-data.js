/**
 * GET /api/user-data — Load user data from Redis
 * POST /api/user-data — Save CLIENT-WRITABLE-ONLY user data to Redis
 *
 * Security fix 2026-07-07: Sensitive fields (points, bonus_balance, vip_days,
 * bind_id, checkin, bonus_campaign1_claimed, streak_grand_claimed, disabled,
 * accountType, total_income_override) are SERVER-MANAGED and cannot be written
 * by the client. Client may only write safe UI-state fields.
 * Use /api/rewards for all reward/balance mutations.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { verifyJWT } = require('./_lib/jwt');
const { Redis } = require('@upstash/redis');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function getUserFromRequest(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/nf_token=([^;]+)/);
  if (match) {
    const payload = verifyJWT(match[1]);
    if (payload && payload.username) return payload.username;
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const payload = verifyJWT(authHeader.slice(7));
    if (payload && payload.username) return payload.username;
  }
  return null;
}

// CLIENT_WRITABLE_FIELDS: Only UI-state fields the client may sync.
// All financial/balance/auth fields are SERVER-ONLY and must be changed via
// admin tools or the /api/rewards endpoint with server-side validation.
const CLIENT_WRITABLE_FIELDS = ['myBooks', 'claimed', 'lastSyncAt'];

module.exports = async (req, res) => {
  setCORSHeaders(req, res, { credentials: true });

  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Cloud sync not available' });
  }

  const username = getUserFromRequest(req);
  if (!username) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const redisKey = `nf_user_data:${String(username).toLowerCase()}`;

  try {
    if (req.method === 'GET') {
      const data = await redis.get(redisKey);
      if (!data) {
        return res.status(200).json({ exists: false, data: null });
      }
      // Parse if string
      let parsed = data;
      if (typeof data === 'string') {
        try { parsed = JSON.parse(data); } catch { parsed = {}; }
      }
      return res.status(200).json({ exists: true, data: parsed });
    }

    if (req.method === 'POST') {
      const { data } = req.body;
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'No data provided' });
      }

      // Fetch existing server data first (merge strategy: client cannot overwrite server-managed fields)
      let existing = await redis.get(redisKey);
      if (existing) {
        if (typeof existing === 'string') {
          try { existing = JSON.parse(existing); } catch { existing = {}; }
        }
      }
      if (!existing || typeof existing !== 'object') existing = {};

      // Build cleanData by copying ONLY client-writable fields from the request
      const cleanData = { ...existing };
      for (const key of CLIENT_WRITABLE_FIELDS) {
        if (data[key] !== undefined) {
          // Deep-merge myBooks by code (union, deduplicated)
          if (key === 'myBooks' && Array.isArray(data[key]) && Array.isArray(existing.myBooks)) {
            const bookMap = new Map();
            for (const b of existing.myBooks) {
              const k = b.code ? String(b.code) : (b.id || b.bookId || b.title);
              if (k) bookMap.set(k, b);
            }
            for (const b of data[key]) {
              const k = b.code ? String(b.code) : (b.id || b.bookId || b.title);
              if (k) {
                if (bookMap.has(k)) {
                  bookMap.set(k, { ...bookMap.get(k), ...b });
                } else {
                  bookMap.set(k, b);
                }
              }
            }
            cleanData.myBooks = Array.from(bookMap.values());
          }
          // Merge claimed (union of keys)
          else if (key === 'claimed' && typeof data[key] === 'object' && existing.claimed) {
            cleanData.claimed = { ...existing.claimed, ...data[key] };
          }
          else {
            cleanData[key] = data[key];
          }
        }
      }
      cleanData.lastSyncAt = Date.now();

      // Ensure server-managed fields are preserved and cannot be tampered with
      const SERVER_MANAGED = ['points', 'bonus_balance', 'vip_days', 'bind_id', 'checkin',
        'bonus_campaign1_claimed', 'streak_grand_claimed', 'disabled', 'accountType',
        'total_income_override', 'withdrawals'];
      for (const sf of SERVER_MANAGED) {
        if (existing[sf] !== undefined) {
          cleanData[sf] = existing[sf];
        }
      }

      await redis.set(redisKey, JSON.stringify(cleanData));

      return res.status(200).json({ success: true, lastSyncAt: cleanData.lastSyncAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('User data sync error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
