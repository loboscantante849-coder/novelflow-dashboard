const { setCORSHeaders } = require('./_lib/cors');
const { verifyJWT } = require('./_lib/jwt');
const { Redis } = require('@upstash/redis');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/nf_token=([^;]+)/);
  const authHeader = req.headers.authorization;
  let username = null;
  if (cookieMatch) { const p = verifyJWT(cookieMatch[1]); if (p?.username) username = p.username; }
  if (!username && authHeader?.startsWith('Bearer ')) { const p = verifyJWT(authHeader.slice(7)); if (p?.username) username = p.username; }
  if (!username || !['admin','xujt'].includes(username.toLowerCase())) return res.status(403).json({ error: 'Admin only' });

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  try {
    const allKeys = await redis.keys('*');
    const result = {};
    for (const key of allKeys) {
      if (key.startsWith('oidc:') || key.startsWith('trending:')) continue;
      const val = await redis.get(key);
      result[key] = val;
    }
    return res.status(200).json({ success: true, keys: Object.keys(result).length, data: result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
