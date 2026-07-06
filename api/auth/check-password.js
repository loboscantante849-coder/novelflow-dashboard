/**
 * check-password — v2.5.1
 * Rate-limited (IP) to prevent account enumeration / brute-force oracle.
 */
const { setCORSHeaders } = require('../_lib/cors');
const { getRedis, checkRateLimit, validateString, stripHtml, getClientIp } = require('../_lib/security');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const redis = getRedis();
    const ip = getClientIp(req);
    // 30 requests per minute per IP is plenty for a human-driven form
    if (redis) {
      const allowed = await checkRateLimit(redis, 'nf_checkpw:' + ip, 30, 60);
      if (!allowed) return res.status(429).json({ error: 'Too many requests', retryAfter: 60 });
    }

    const raw = req.body && req.body.username;
    const v = validateString(raw, { name: 'username', maxLen: 50, required: true });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const cleanName = stripHtml(v.value.trim());

    if (!redis) return res.status(200).json({ hasPassword: false, userExists: false });

    const [storedHash, userData] = await Promise.all([
      redis.get('nf_user_pass:' + cleanName),
      redis.get('nf_user_data:' + cleanName),
    ]);
    return res.status(200).json({
      hasPassword: !!storedHash,
      userExists: !!(storedHash || userData),
    });
  } catch (error) {
    console.error('Check password error:', error);
    return res.status(200).json({ hasPassword: false, userExists: false });
  }
};
