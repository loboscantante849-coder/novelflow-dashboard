/**
 * GET /api/admin-kv-dump — Dump all KV user data (admin only)
 */
const { setCORSHeaders } = require('./_lib/cors');
const { verifyJWT } = require('./_lib/jwt');
const { Redis } = require('@upstash/redis');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/nf_token=([^;]+)/);
  const authHeader = req.headers.authorization;
  let username = null;
  if (cookieMatch) { const p = verifyJWT(cookieMatch[1]); if (p?.username) username = p.username; }
  if (!username && authHeader?.startsWith('Bearer ')) { const p = verifyJWT(authHeader.slice(7)); if (p?.username) username = p.username; }
  if (!username || !['admin','xujt'].includes(username.toLowerCase())) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Redis not available' });

  try {
    // Use Upstash Redis KEYS command to find all user data keys
    const keys = await redis.keys('nf_user_data:*');
    const allData = {};
    for (const key of keys) {
      const val = await redis.get(key);
      const uname = key.replace('nf_user_data:', '');
      allData[uname] = val;
    }
    return res.status(200).json({ success: true, users: Object.keys(allData).length, data: allData });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
