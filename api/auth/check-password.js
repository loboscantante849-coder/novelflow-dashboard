/**
 * check-password — v2.6.3
 *
 * Security fix (H-05): no longer reveals user existence or password status.
 * The client-side login flow does NOT need this oracle; the register/login
 * endpoint always returns the correct `needPassword` signal for the actual user.
 *
 * To prevent username enumeration:
 *  - Always returns the same response { hasPassword: false } regardless of input
 *  - Strict IP rate limit: 10 requests / 15 min (plenty for legitimate use)
 *  - Strict input validation (string type + length) — no Object/Array 500s
 */
const { handlePreflight } = require('../_lib/cors');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const { Redis } = require('@upstash/redis');
  try { return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN }); }
  catch { return null; }
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.connection && req.connection.remoteAddress) ||
         (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Fixed-window rate limit
async function rlCheck(redis, key, limit, windowSec) {
  if (!redis) return { allowed: true };
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    if (count > limit) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retryAfter: Math.max(1, ttl) };
    }
    return { allowed: true };
  } catch { return { allowed: true }; }
}

const OBFUSCATED_RESPONSE = { hasPassword: false, userExists: false };

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: false })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Strict input validation
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json(OBFUSCATED_RESPONSE);
    }
    const username = body.username;
    if (username !== undefined && username !== null && typeof username !== 'string') {
      return res.status(400).json(OBFUSCATED_RESPONSE);
    }
    if (typeof username === 'string' && username.length > 50) {
      return res.status(400).json(OBFUSCATED_RESPONSE);
    }

    // Rate limit (IP)
    const redis = getRedis();
    const ip = getClientIp(req);
    if (redis) {
      const rl = await rlCheck(redis, 'nf_checkpw_v2:' + ip, 10, 900);
      if (!rl.allowed) {
        return res.status(429).json({ error: 'Too many requests', retryAfter: rl.retryAfter });
      }
    }

    // Always return the same obfuscated response — no enumeration possible
    return res.status(200).json(OBFUSCATED_RESPONSE);
  } catch (error) {
    console.error('[auth/check-password] Error:', error);
    return res.status(200).json(OBFUSCATED_RESPONSE);
  }
};
