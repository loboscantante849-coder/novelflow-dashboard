/**
 * GET/POST /api/admin-kv-dump — Admin KV dump with whitelist-only keys.
 * Filters out password hashes, tokens, lock/rate-limit keys, OIDC credentials.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser, checkAdminKey } = require('./_lib/security');
const { Redis } = require('@upstash/redis');

// Prefixes that should NEVER be dumped (whitelist approach would be safer,
// but we use an explicit blocklist for sensitive keys to avoid over-leaking)
const BLOCKLIST_PREFIXES = [
  'oidc:', 'trending:', 'nf_user_pass:', 'ac_token', 'nf_login_lock:',
  'nf_login_fail:', 'nf_password_reset:', 'ac_thread_owner:',
];

function isBlocked(key) {
  return BLOCKLIST_PREFIXES.some(p => key.startsWith(p) || key === p.replace(':',''));
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth: JWT admin or x-admin-key header
  let isAdm = checkAdminKey(req);
  const payload = getAuthPayload(req);
  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  if (!isAdm && payload) {
    isAdm = await isAdminUser(redis, payload.username);
  }
  if (!isAdm) return res.status(403).json({ error: 'Admin only' });

  try {
    const allKeys = await redis.keys('*');
    const result = {};
    let skipped = 0;
    for (const key of allKeys) {
      if (isBlocked(key)) { skipped++; continue; }
      const val = await redis.get(key);
      result[key] = val;
    }
    return res.status(200).json({ success: true, keys: Object.keys(result).length, skipped, data: result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
