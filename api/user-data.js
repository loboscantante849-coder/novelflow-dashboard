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
const { handlePreflight } = require('./_lib/cors');
const { verifyAccessToken } = require('./_lib/jwt');
const { Redis } = require('@upstash/redis');
const { mergeBookState } = require('./_lib/sync');
const { acquireUserDataLock, releaseUserDataLock } = require('./_lib/user-data-lock');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function getUserFromRequest(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/nf_token=([^;]+)/);
  if (match) {
    const payload = verifyAccessToken(match[1]);
    if (payload && payload.username) return payload.username;
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const payload = verifyAccessToken(authHeader.slice(7));
    if (payload && payload.username) return payload.username;
  }
  return null;
}

// CLIENT_WRITABLE_FIELDS: Only UI-state fields the client may sync.
// All financial/balance/auth fields are SERVER-ONLY and must be changed via
// admin tools or the /api/rewards endpoint with server-side validation.
const CLIENT_WRITABLE_FIELDS = ['myBooks', 'deletedBooks', 'lastSyncAt'];

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: true })) return;

  

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
        try { parsed = JSON.parse(data); } catch {
          return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_CORRUPT' });
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_CORRUPT' });
      }
      return res.status(200).json({ exists: true, data: parsed });
    }

    if (req.method === 'POST') {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Invalid request body' });
      }
      const { data } = req.body;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ error: 'No data provided' });
      }

      let lock;
      try {
        lock = await acquireUserDataLock(redis, username);
      } catch (_error) {
        return res.status(503).json({ error: 'User data storage is temporarily unavailable', code: 'USER_DATA_UNAVAILABLE' });
      }
      if (!lock) {
        return res.status(409).json({ error: 'User data is being updated', code: 'USER_DATA_BUSY' });
      }

      try {
        // Fetch existing server data first (merge strategy: client cannot overwrite server-managed fields)
        let existing = await redis.get(redisKey);
        if (existing) {
          if (typeof existing === 'string') {
            try { existing = JSON.parse(existing); } catch {
              return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_CORRUPT' });
            }
          }
          if (existing && (typeof existing !== 'object' || Array.isArray(existing))) {
            return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_CORRUPT' });
          }
        }
        if (!existing || typeof existing !== 'object') existing = {};
        if (existing.disabled) {
          return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        }

        // Build cleanData by copying ONLY client-writable fields from the request.
        const cleanData = { ...existing };
        const bookState = mergeBookState(existing, data);
        cleanData.myBooks = bookState.myBooks;
        cleanData.deletedBooks = bookState.deletedBooks;
        for (const key of CLIENT_WRITABLE_FIELDS) {
          if (data[key] !== undefined) {
            if (key === 'myBooks' || key === 'deletedBooks') {
              continue;
            } else if (key === 'claimed' && typeof data[key] === 'object' && existing.claimed) {
              cleanData.claimed = { ...existing.claimed, ...data[key] };
            }
            else {
              cleanData[key] = data[key];
            }
          }
        }
        cleanData.lastSyncAt = Date.now();

        // Ensure server-managed fields are preserved and cannot be tampered with
        const SERVER_MANAGED = ['points', 'bonus_balance', 'vip_days', 'bind_id', 'checkin', 'claimed', 'reward_history',
          'bonus_campaign1_claimed', 'streak_grand_claimed', 'disabled', 'accountType',
          'total_income_override', 'withdrawals'];
        for (const sf of SERVER_MANAGED) {
          if (existing[sf] !== undefined) {
            cleanData[sf] = existing[sf];
          }
        }

        await redis.set(redisKey, JSON.stringify(cleanData));

        return res.status(200).json({
          success: true,
          lastSyncAt: cleanData.lastSyncAt,
          deletedBooks: cleanData.deletedBooks,
        });
      } finally {
        await releaseUserDataLock(redis, lock);
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('User data sync error:', error);
    return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_UNAVAILABLE' });
  }
};
