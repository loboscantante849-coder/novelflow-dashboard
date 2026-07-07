/**
 * Login Endpoint (local accounts) — v2.5.1
 * - IP-based rate limit: 5 failures per 15 min; lockout 15 min.
 * - Password hashing + input validation.
 */
const {
  signAccessToken,
  signRefreshToken,
  buildUserPayload,
  extractUserInfo,
  setAuthCookies,
} = require('../_lib/auth');
const { handlePreflight } = require('../_lib/cors');
const { getRedis, checkRateLimit, validateString, stripHtml, getClientIp } = require('../_lib/security');
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update('nf_' + password + '_salt2026').digest('hex');
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: true })) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const rawUser = req.body && req.body.username;
    const rawPass = req.body && req.body.password;
    const vU = validateString(rawUser, { name: 'username', maxLen: 50, required: true });
    if (!vU.ok) return res.status(vU.status).json({ error: vU.error });
    const cleanUsername = stripHtml(vU.value.trim());
    if (!cleanUsername) return res.status(400).json({ error: 'Invalid username' });

    const redis = getRedis();
    const ip = getClientIp(req);
    const failKey = 'nf_login_fail:' + ip;
    const lockKey = 'nf_login_lock:' + ip;

    // Check lockout
    if (redis) {
      const locked = await redis.get(lockKey);
      if (locked) {
        const ttl = await redis.ttl(lockKey);
        return res.status(429).json({ error: 'Too many failed attempts. Try again in ' + Math.max(1, ttl) + 's.', retryAfter: ttl });
      }
    }

    const storedHash = redis ? await redis.get('nf_user_pass:' + cleanUsername) : null;
    if (storedHash) {
      const vP = validateString(rawPass, { name: 'password', maxLen: 200, required: true });
      if (!vP.ok) return res.status(401).json({ error: 'Password required', needPassword: true });
      const inputHash = hashPassword(vP.value);
      if (inputHash !== storedHash) {
        if (redis) {
          const fails = await redis.incr(failKey);
          if (fails === 1) await redis.expire(failKey, 15 * 60);
          if (fails >= 5) {
            await redis.set(lockKey, '1', { ex: 15 * 60 });
            await redis.del(failKey);
          }
        }
        return res.status(401).json({ error: 'Wrong password', needPassword: true });
      }
    } else {
      // New user — must set password (min 8, strong)
      const vP = validateString(rawPass, { name: 'password', minLen: 8, maxLen: 200, required: true });
      if (!vP.ok) return res.status(400).json({ error: 'Please set a password (min 8 characters with letter+digit)', needPassword: true, mustSetPassword: true });
      if (!/[A-Za-z]/.test(vP.value) || !/[0-9]/.test(vP.value)) {
        return res.status(400).json({ error: 'Password must contain at least one letter and one digit', needPassword: true, mustSetPassword: true });
      }
      if (redis) await redis.set('nf_user_pass:' + cleanUsername, hashPassword(vP.value));
    }

    // Clear failure counter on success
    if (redis) {
      await redis.del(failKey).catch(() => {});
    }

    const userPayload = buildUserPayload({ type: 'local', username: cleanUsername });
    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);
    setAuthCookies(res, accessToken, refreshToken, userInfo);

    return res.status(200).json({ success: true, username: cleanUsername, user: userInfo });
  } catch (error) {
    console.error('[auth/login] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
