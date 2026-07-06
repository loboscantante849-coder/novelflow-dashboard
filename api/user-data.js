/**
 * GET /api/user-data?username=xxx — Load user data from Redis
 * POST /api/user-data — Save user data to Redis
 * 
 * Syncs localStorage data across devices using Upstash Redis.
 * Authentication: JWT via nf_token cookie or Authorization header
 */
const { setCORSHeaders } = require('./_lib/cors');
const { verifyJWT } = require('./_lib/jwt');
const { Redis } = require('@upstash/redis');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function getUserFromRequest(req) {
  // Try cookie first
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/nf_token=([^;]+)/);
  if (match) {
    const payload = verifyJWT(match[1]);
    if (payload && payload.username) return payload.username;
  }
  // Try Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const payload = verifyJWT(authHeader.slice(7));
    if (payload && payload.username) return payload.username;
  }
  return null;
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Cloud sync not available' });
  }

  const username = getUserFromRequest(req);
  if (!username) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const redisKey = `nf_user_data:${username}`;

  try {
    if (req.method === 'GET') {
      const data = await redis.get(redisKey);
      if (!data) {
        return res.status(200).json({ exists: false, data: null });
      }
      return res.status(200).json({ exists: true, data });
    }

    if (req.method === 'POST') {
      const { data } = req.body;
      if (!data) {
        return res.status(400).json({ error: 'No data provided' });
      }

      // Validate data structure - only allow known fields
      const allowedKeys = ['myBooks', 'checkin', 'points', 'claimed', 'bind_id', 'vip_days', 'lastSyncAt', 'bonus_balance', 'bonus_campaign1_claimed', 'streak_grand_claimed', 'total_income_override'];
      const cleanData = {};
      for (const key of allowedKeys) {
        if (data[key] !== undefined) {
          cleanData[key] = data[key];
        }
      }
      cleanData.lastSyncAt = Date.now();

      // Store as JSON string to preserve types
      await redis.set(redisKey, JSON.stringify(cleanData));

      return res.status(200).json({ success: true, lastSyncAt: cleanData.lastSyncAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('User data sync error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
