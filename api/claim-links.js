/**
 * POST /api/claim-links
 * 
 * Reassign Anonymous entries in KV to the authenticated user.
 * Body: { codes: string[] }
 * Auth: JWT token matching username
 */
const { setCORSHeaders } = require('./_lib/cors');
const { verifyJWT } = require('./_lib/jwt');
const { Redis } = require('@upstash/redis');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify auth
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/nf_token=([^;]+)/);
  const authHeader = req.headers.authorization;
  let username = null;

  if (cookieMatch) { const p = verifyJWT(cookieMatch[1]); if (p?.username) username = p.username; }
  if (!username && authHeader?.startsWith('Bearer ')) { const p = verifyJWT(authHeader.slice(7)); if (p?.username) username = p.username; }

  if (!username) return res.status(401).json({ error: 'Not authenticated' });

  const { codes } = req.body || {};
  if (!codes || !Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: 'codes array required' });
  }

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  try {
    // Get all submissions matching the codes
    const values = await redis.hmget('nf_subs', ...codes.map(c => String(c)));
    let changed = 0;
    const claimed = [];
    const updates = {};

    for (let i = 0; i < codes.length; i++) {
      const code = String(codes[i]);
      const raw = values[i];
      if (!raw) continue;
      const sub = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if ((sub.discordUsername || '').toLowerCase() === 'anonymous') {
        sub.discordUsername = username;
        updates[code] = JSON.stringify(sub);
        claimed.push(code);
        changed++;
        // Also add to user's set
        await redis.sadd(`nf_user_subs:${username.toLowerCase()}`, code);
        // Remove from anonymous set
        await redis.srem('nf_user_subs:anonymous', code);
      }
    }

    if (changed === 0) {
      return res.status(200).json({ success: true, changed: 0, message: 'No Anonymous entries to claim' });
    }

    // Update all claimed entries in one HSET
    await redis.hset('nf_subs', updates);

    return res.status(200).json({ success: true, changed, claimed, username });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
