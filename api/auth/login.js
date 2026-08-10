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
const { getAuthPayload, getRedis, validateString, stripHtml, getClientIp, isReservedUsername, isDisabledUser } = require('../_lib/security');
const { createPasswordHash, verifyPassword } = require('../_lib/password');
const { bindPasswordPrincipal, claimIdentity, resolvePasswordPrincipal } = require('../_lib/identity');
const { isProtectedPromoterUsername } = require('../_lib/promoter-access');
const { extractReferralCode, finalizePendingReferral, stageReferral, validateReferral } = require('../_lib/referrals');

const USERNAME_RE = /^[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9_.@\- ]{1,50}$/;

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: true })) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const rawUser = req.body && req.body.username;
    const rawPass = req.body && req.body.password;
    const rawReferralCode = req.body && req.body.referral_code;
    if (rawReferralCode !== undefined && rawReferralCode !== null && typeof rawReferralCode !== 'string') {
      return res.status(400).json({ error: 'Referral code must be a string', code: 'INVALID_REFERRAL_CODE' });
    }
    const referralCode = extractReferralCode(req);
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
    const [canonicalHash, legacyHash, userData] = await Promise.all([
      redis.get(passwordKey),
      legacyPasswordKey ? redis.get(legacyPasswordKey) : null,
      redis.get('nf_user_data:' + usernameKey),
    ]);
    try {
      if (await isDisabledUser(redis, usernameKey, { failClosed: true })) {
        return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
      }
    } catch (_error) {
      return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
    }
    const storedHash = canonicalHash || legacyHash;
    let authenticatedPayload = null;
    let isNewUser = false;
    let referralToBind = null;
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
      if (userData) {
        const session = getAuthPayload(req);
        const sessionUsername = String(session && session.username || '').trim().toLowerCase();
        if (sessionUsername !== usernameKey) {
          return res.status(409).json({
            error: 'Account recovery is required before setting a password',
            code: 'ACCOUNT_RECOVERY_REQUIRED',
          });
        }
        authenticatedPayload = session;
      }

      if (isReservedUsername(cleanUsername)) {
        return res.status(400).json({ error: 'This username is not available' });
      }
      if (!userData && isProtectedPromoterUsername(usernameKey)) {
        return res.status(409).json({
          error: 'This promoter account requires identity recovery',
          code: 'PROMOTER_RECOVERY_REQUIRED',
        });
      }
      if (!userData && !USERNAME_RE.test(cleanUsername)) {
        return res.status(400).json({ error: 'Invalid username' });
      }
      const vP = validateString(rawPass, { name: 'password', minLen: 8, maxLen: 200, required: true });
      if (!vP.ok) return res.status(400).json({ error: 'Please set a password (min 8 characters with letter+digit)', needPassword: true, mustSetPassword: true });
      if (!/[A-Za-z]/.test(vP.value) || !/[0-9]/.test(vP.value)) {
        return res.status(400).json({ error: 'Password must contain at least one letter and one digit', needPassword: true, mustSetPassword: true });
      }
      const newPrincipal = authenticatedPayload
        ? await resolvePasswordPrincipal(redis, usernameKey, authenticatedPayload)
        : `local:${usernameKey}`;
      if (!userData) {
        isNewUser = true;
        try {
          const validatedReferral = await validateReferral(redis, usernameKey, referralCode);
          referralToBind = validatedReferral && validatedReferral.referral_code;
        } catch (error) {
          return res.status(error && error.code === 'SELF_REFERRAL' ? 409 : 400).json({
            error: error.message || 'Invalid referral code',
            code: error.code || 'INVALID_REFERRAL_CODE',
          });
        }
      }
      if (!newPrincipal || !await claimIdentity(redis, usernameKey, newPrincipal)) {
        return res.status(409).json({ error: 'This username belongs to another sign-in method', code: 'ACCOUNT_IDENTITY_CONFLICT' });
      }
      const created = await redis.set(passwordKey, await createPasswordHash(vP.value), { nx: true });
      if (!created) {
        return res.status(409).json({ error: 'Account already exists. Please sign in.', code: 'ACCOUNT_ALREADY_EXISTS' });
      }
    }

    // Clear failure counter on success
    await redis.del(failKey).catch(() => {});

    const passwordPrincipal = await resolvePasswordPrincipal(redis, usernameKey, authenticatedPayload);
    if (!passwordPrincipal ||
        !await claimIdentity(redis, usernameKey, passwordPrincipal) ||
        !await bindPasswordPrincipal(redis, usernameKey, passwordPrincipal)) {
      return res.status(409).json({ error: 'Account identity recovery is required', code: 'ACCOUNT_IDENTITY_CONFLICT' });
    }
    try {
      if (isNewUser && referralToBind) await stageReferral(redis, usernameKey, referralToBind);
      await finalizePendingReferral(redis, usernameKey);
    } catch (error) {
      console.warn('[auth/login] Referral binding deferred:', error && error.code || error && error.message);
    }

    const userPayload = buildUserPayload({ type: 'local', username: usernameKey, principal: passwordPrincipal });
    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);
    setAuthCookies(res, accessToken, refreshToken, userInfo);

    return res.status(200).json({ success: true, username: usernameKey, user: userInfo, isNewUser });
  } catch (error) {
    console.error('[auth/login] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
