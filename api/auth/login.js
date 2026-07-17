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
const { getRedis, validateString, stripHtml, getClientIp, isReservedUsername } = require('../_lib/security');
const { createPasswordHash, verifyPassword } = require('../_lib/password');

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
    const usernameKey = cleanUsername.toLowerCase();

    const redis = getRedis();
    if (!redis) return res.status(503).json({ error: 'Authentication service unavailable' });
    const ip = getClientIp(req);
    const failKey = 'nf_login_fail:' + ip;
    const lockKey = 'nf_login_lock:' + ip;

    // Check lockout
    const locked = await redis.get(lockKey);
    if (locked) {
      const ttl = await redis.ttl(lockKey);
      return res.status(429).json({ error: 'Too many failed attempts. Try again in ' + Math.max(1, ttl) + 's.', retryAfter: ttl });
    }

    const passwordKey = 'nf_user_pass:' + usernameKey;
    const legacyPasswordKey = cleanUsername !== usernameKey
      ? 'nf_user_pass:' + cleanUsername
      : null;
    const [canonicalHash, legacyHash] = await Promise.all([
      redis.get(passwordKey),
      legacyPasswordKey ? redis.get(legacyPasswordKey) : null,
    ]);
    const storedHash = canonicalHash || legacyHash;
    if (storedHash) {
      const vP = validateString(rawPass, { name: 'password', maxLen: 200, required: true });
      if (!vP.ok) return res.status(401).json({ error: 'Password required', needPassword: true });
      const verification = await verifyPassword(vP.value, storedHash);
      if (!verification.valid) {
        const fails = await redis.incr(failKey);
        if (fails === 1) await redis.expire(failKey, 15 * 60);
        if (fails >= 5) {
          await redis.set(lockKey, '1', { ex: 15 * 60 });
          await redis.del(failKey);
        }
        return res.status(401).json({ error: 'Wrong password', needPassword: true });
      }
      if (verification.needsRehash || (!canonicalHash && legacyHash)) {
        await redis.set(passwordKey, await createPasswordHash(vP.value));
      }
    } else {
      // New user — must set password (min 8, strong)
      if (isReservedUsername(cleanUsername)) {
        return res.status(400).json({ error: 'This username is not available' });
      }
      const vP = validateString(rawPass, { name: 'password', minLen: 8, maxLen: 200, required: true });
      if (!vP.ok) return res.status(400).json({ error: 'Please set a password (min 8 characters with letter+digit)', needPassword: true, mustSetPassword: true });
      if (!/[A-Za-z]/.test(vP.value) || !/[0-9]/.test(vP.value)) {
        return res.status(400).json({ error: 'Password must contain at least one letter and one digit', needPassword: true, mustSetPassword: true });
      }
      await redis.set(passwordKey, await createPasswordHash(vP.value));
    }

    // Clear failure counter on success
    await redis.del(failKey).catch(() => {});

    const userPayload = buildUserPayload({ type: 'local', username: usernameKey });
    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);
    setAuthCookies(res, accessToken, refreshToken, userInfo);

    return res.status(200).json({ success: true, username: usernameKey, user: userInfo });
  } catch (error) {
    console.error('[auth/login] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
