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
const { getRedis, validateString, stripHtml, getClientIp, isDisabledUser } = require('../_lib/security');
const { createPasswordHash, verifyPassword } = require('../_lib/password');
const { bindPasswordPrincipal, claimIdentity, resolvePasswordPrincipal } = require('../_lib/identity');
const { finalizePendingReferral } = require('../_lib/referrals');
const {
  consolidateEquivalentCredentials,
  localLoginCredentialCandidates,
  resolveLocalLoginPrincipal,
} = require('../_lib/login-identity');

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
    const loginIdentity = localLoginCredentialCandidates(cleanUsername);
    const usernameKey = loginIdentity.primaryUsername;

    const redis = getRedis();
    if (!redis) return res.status(503).json({ error: 'Authentication service unavailable' });
    const ip = getClientIp(req);
    const failKey = 'nf_login_fail:' + ip;
    const lockKey = 'nf_login_lock:' + ip;

    // Check lockout
    const locked = await redis.get(lockKey);
    if (locked) {
      const ttl = await redis.ttl(lockKey);
      if (ttl > 0) {
        return res.status(429).json({ error: 'Too many failed attempts. Try again in ' + ttl + 's.', retryAfter: ttl });
      }
      await redis.del(lockKey);
    }

    const credentialRecords = await Promise.all(loginIdentity.usernames.map(async storageUsername => ({
      storageUsername,
      hash: await redis.get(`nf_user_pass:${storageUsername}`),
    })));
    const userData = await redis.get('nf_user_data:' + usernameKey);
    try {
      if (await isDisabledUser(redis, usernameKey, { failClosed: true })) {
        return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
      }
    } catch (_error) {
      return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
    }
    let authenticatedPayload = null;
    let credentialUsername = usernameKey;
    const storedCredentials = credentialRecords.filter(record => record.hash);
    if (storedCredentials.length) {
      const vP = validateString(rawPass, { name: 'password', maxLen: 200, required: true });
      if (!vP.ok) return res.status(401).json({ error: 'Password required', needPassword: true });
      const verifiedCredentials = [];
      for (const record of storedCredentials) {
        const verification = await verifyPassword(vP.value, record.hash);
        if (verification.valid) verifiedCredentials.push({ ...record, verification });
      }
      if (verifiedCredentials.length === 0) {
        const fails = await redis.incr(failKey);
        if (fails === 1) await redis.expire(failKey, 15 * 60);
        if (fails >= 5) {
          await redis.set(lockKey, '1', { ex: 15 * 60 });
          await redis.del(failKey);
        }
        return res.status(401).json({ error: 'Wrong password', needPassword: true });
      }
      if (verifiedCredentials.length !== storedCredentials.length) {
        return res.status(409).json({
          error: 'Account credential recovery is required',
          code: 'ACCOUNT_CREDENTIAL_CONFLICT',
        });
      }
      const principalForCredentials = await resolveLocalLoginPrincipal(
        redis,
        usernameKey,
        usernameKey,
        authenticatedPayload,
        resolvePasswordPrincipal,
      );
      if (!principalForCredentials) {
        return res.status(409).json({ error: 'Account identity recovery is required', code: 'ACCOUNT_IDENTITY_CONFLICT' });
      }
      if (storedCredentials.length > 1) {
        const consolidated = await consolidateEquivalentCredentials(
          redis,
          usernameKey,
          storedCredentials,
          vP.value,
          createPasswordHash,
          principalForCredentials,
        );
        if (!consolidated) {
          return res.status(409).json({
            error: 'Account credential recovery is required',
            code: 'ACCOUNT_CREDENTIAL_CONFLICT',
          });
        }
        credentialUsername = usernameKey;
      } else {
        const matchedCredential = verifiedCredentials[0];
        credentialUsername = matchedCredential.storageUsername.toLowerCase();
        if (matchedCredential.verification.needsRehash) {
          await redis.set(`nf_user_pass:${matchedCredential.storageUsername}`, await createPasswordHash(vP.value));
        }
      }
    } else if (userData) {
      // Passwordless legacy records can only be upgraded through the explicit
      // registration/recovery endpoint with an existing owner session.
      return res.status(409).json({
        error: 'Account recovery is required before setting a password',
        code: 'ACCOUNT_RECOVERY_REQUIRED',
      });
    } else {
      // Login must never create accounts. Registration has its own quotas,
      // referral validation, identity allocation, and notification outbox.
      return res.status(401).json({
        error: 'Invalid username or password',
        code: 'INVALID_CREDENTIALS',
      });
    }

    // Clear failure counter on success
    await redis.del(failKey).catch(() => {});

    const passwordPrincipal = await resolveLocalLoginPrincipal(
      redis,
      usernameKey,
      credentialUsername,
      authenticatedPayload,
      resolvePasswordPrincipal,
    );
    if (!passwordPrincipal ||
        !await claimIdentity(redis, usernameKey, passwordPrincipal) ||
        !await claimIdentity(redis, credentialUsername, passwordPrincipal) ||
        !await bindPasswordPrincipal(redis, credentialUsername, passwordPrincipal)) {
      return res.status(409).json({ error: 'Account identity recovery is required', code: 'ACCOUNT_IDENTITY_CONFLICT' });
    }
    try {
      await finalizePendingReferral(redis, usernameKey);
    } catch (error) {
      console.warn('[auth/login] Referral binding deferred:', error && error.code || error && error.message);
    }
    let member = null;
    try {
      const { ensureMemberIdentity } = require('../_lib/member-identity');
      member = await ensureMemberIdentity(redis, usernameKey, { source: 'local' });
    } catch (error) {
      console.warn('[auth/login] Member ID allocation deferred:', error && error.code || error && error.message);
    }

    const userPayload = buildUserPayload({ type: 'local', username: usernameKey, principal: passwordPrincipal });
    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);
    setAuthCookies(res, accessToken, refreshToken, userInfo);

    return res.status(200).json({ success: true, username: usernameKey, memberId: member && member.id || null, user: userInfo, isNewUser: false });
  } catch (error) {
    console.error('[auth/login] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
