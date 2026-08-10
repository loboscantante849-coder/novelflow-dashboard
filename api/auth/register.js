/**
 * Register / Login Endpoint (local accounts) — v2.6.3
 * 
 * POST /api/auth/register
 * 
 * Security fixes (v2.6.3):
 *  - Username regex: allow letters/CJK/digits/_.@ -/space, 1-50 chars; blocks HTML/SQL injection chars
 *  - Password min 8 chars, must contain letter + digit
 *  - IP rate limit: 10 attempts / 15 min (prevents brute force)
 *  - Account lockout: 5 failed attempts / 15 min per username
 *  - Strict type checks (rejects Object/Array/non-string payloads → 400, not 500)
 *  - Fuzzy error message on wrong password (no user enumeration via "user not found")
 */

const {
  signAccessToken,
  signRefreshToken,
  buildUserPayload,
  extractUserInfo,
  setAuthCookies
} = require('../_lib/auth');

const { handlePreflight } = require('../_lib/cors');
const { Redis } = require('@upstash/redis');
const { createPasswordHash, verifyPassword } = require('../_lib/password');
const { getAuthPayload, isDisabledUser, isReservedUsername } = require('../_lib/security');
const { bindPasswordPrincipal, claimIdentity, resolvePasswordPrincipal } = require('../_lib/identity');
const { isProtectedPromoterUsername } = require('../_lib/promoter-access');
const { extractReferralCode, finalizePendingReferral, stageReferral, validateReferral } = require('../_lib/referrals');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.connection && req.connection.remoteAddress) ||
         (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Sliding-window-ish rate limit: incr + expire on first hit
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

const USERNAME_RE = /^[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9_.@\- ]{1,50}$/;
const PASSWORD_MIN = 8;
function isValidPassword(p) {
  if (typeof p !== 'string' || p.length < PASSWORD_MIN) return false;
  return /[A-Za-z]/.test(p) && /[0-9]/.test(p);
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: true })) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ---------- Strict type validation (no 500s from Object/Array payloads) ----------
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const { username, password, referral_code: bodyReferralCode } = body;
    if (typeof username !== 'string') {
      return res.status(400).json({ error: 'Username must be a string' });
    }
    if (password !== undefined && password !== null && typeof password !== 'string') {
      return res.status(400).json({ error: 'Password must be a string' });
    }
    if (bodyReferralCode !== undefined && bodyReferralCode !== null && typeof bodyReferralCode !== 'string') {
      return res.status(400).json({ error: 'Referral code must be a string', code: 'INVALID_REFERRAL_CODE' });
    }
    const referralCode = extractReferralCode(req);

    const cleanUsername = username.trim();
    if (!USERNAME_RE.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Invalid username (use letters, numbers, Chinese chars, underscore, dot, @, space, hyphen; 1-50 chars)'
      });
    }
    const usernameKey = cleanUsername.toLowerCase();

    // Reject reserved usernames to prevent admin privilege escalation
    if (isReservedUsername(usernameKey)) {
      return res.status(400).json({ error: 'This username is not available' });
    }

    const redis = getRedis();
    if (!redis) return res.status(503).json({ error: 'Authentication service unavailable' });
    const ip = getClientIp(req);

    // ---------- Rate limiting ----------
    if (redis) {
      // IP-based global limit: 10 attempts / 15 min
      const ipRL = await rlCheck(redis, 'nf_login_ip:' + ip, 10, 900);
      if (!ipRL.allowed) {
        return res.status(429).json({ error: 'Too many login attempts', retryAfter: ipRL.retryAfter });
      }
      // Username-based lockout: 5 failures / 15 min
      const acctLock = await redis.get('nf_login_lock:' + usernameKey);
      if (acctLock) {
        const ttl = await redis.ttl('nf_login_lock:' + usernameKey);
        return res.status(429).json({ error: 'Account temporarily locked', retryAfter: Math.max(1, ttl) });
      }
    }

    // ---------- Business logic ----------
    let isNewUser = false;
    let passedAuth = false;
    let authenticatedPayload = null;
    let referralToBind = null;

    {
      const passwordKey = 'nf_user_pass:' + usernameKey;
      const legacyPasswordKey = cleanUsername !== usernameKey
        ? 'nf_user_pass:' + cleanUsername
        : null;
      const [canonicalHash, legacyHash, userData] = await Promise.all([
        redis.get(passwordKey),
        legacyPasswordKey ? redis.get(legacyPasswordKey) : null,
        redis.get('nf_user_data:' + usernameKey)
      ]);
      try {
        if (await isDisabledUser(redis, usernameKey, { failClosed: true })) {
          return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        }
      } catch (_error) {
        return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
      }
      const storedHash = canonicalHash || legacyHash;

      if (storedHash) {
        // Existing user with password → must verify
        if (!password) {
          return res.status(401).json({ error: 'Password required', needPassword: true });
        }
        if (typeof password !== 'string' || password.length < 1) {
          return res.status(401).json({ error: 'Invalid username or password' });
        }
        // NOTE: do NOT enforce strong-password policy on existing-user login;
        // old users may have shorter legacy passwords. Brute force is blocked
        // by the per-account lockout (5 fails / 15 min) above.
        const verification = await verifyPassword(password, storedHash);
        if (!verification.valid) {
          // Record failure → lock after 5
          const fails = await redis.incr('nf_login_fail:' + usernameKey);
          if (fails === 1) await redis.expire('nf_login_fail:' + usernameKey, 900);
          if (fails >= 5) {
            await redis.set('nf_login_lock:' + usernameKey, '1', { ex: 900 });
            await redis.del('nf_login_fail:' + usernameKey);
          }
          return res.status(401).json({ error: 'Invalid username or password' });
        }
        if (verification.needsRehash || (!canonicalHash && legacyHash)) {
          await redis.set(passwordKey, await createPasswordHash(password));
        }
        // Success → clear failure counter
        await redis.del('nf_login_fail:' + usernameKey);
        passedAuth = true;
      } else if (userData) {
        // Existing passwordless data must only be claimed by its current
        // authenticated session. A username alone is not proof of ownership.
        const session = getAuthPayload(req);
        const sessionUsername = String(session && session.username || '').trim().toLowerCase();
        if (sessionUsername !== usernameKey) {
          return res.status(409).json({
            error: 'Account recovery is required before setting a password',
            code: 'ACCOUNT_RECOVERY_REQUIRED',
          });
        }
        if (!password) {
          return res.status(400).json({
            error: 'Password setup required',
            needPassword: true,
            mustSetPassword: true,
          });
        }
        if (!isValidPassword(password)) {
          return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and a number', needPassword: true, mustSetPassword: true });
        }
        const created = await redis.set(passwordKey, await createPasswordHash(password), { nx: true });
        if (!created) {
          return res.status(409).json({ error: 'Password status changed. Please sign in again.', code: 'PASSWORD_ALREADY_SET' });
        }
        authenticatedPayload = session;
        passedAuth = true;
      } else {
        // Brand new user → require a password to register
        if (isProtectedPromoterUsername(usernameKey)) {
          return res.status(409).json({
            error: 'This promoter account requires identity recovery',
            code: 'PROMOTER_RECOVERY_REQUIRED',
          });
        }
        isNewUser = true;
        if (!password) {
          return res.status(400).json({ error: 'Password required (min 8 characters with a letter and a number)', needPassword: true, mustSetPassword: true });
        }
        if (!isValidPassword(password)) {
          return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and a number', needPassword: true, mustSetPassword: true });
        }
        try {
          const validatedReferral = await validateReferral(redis, usernameKey, referralCode);
          referralToBind = validatedReferral && validatedReferral.referral_code;
        } catch (error) {
          return res.status(error && error.code === 'SELF_REFERRAL' ? 409 : 400).json({
            error: error.message || 'Invalid referral code',
            code: error.code || 'INVALID_REFERRAL_CODE',
          });
        }
        if (!await claimIdentity(redis, usernameKey, `local:${usernameKey}`)) {
          return res.status(409).json({ error: 'This username belongs to another sign-in method', code: 'ACCOUNT_IDENTITY_CONFLICT' });
        }
        const created = await redis.set(passwordKey, await createPasswordHash(password), { nx: true });
        if (!created) {
          return res.status(409).json({ error: 'Account already exists. Please sign in.', code: 'ACCOUNT_ALREADY_EXISTS' });
        }
        passedAuth = true;
      }
    }

    if (!passedAuth) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

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
      console.warn('[auth/register] Referral binding deferred:', error && error.code || error && error.message);
    }

    // ---------- Issue tokens ----------
    const userPayload = buildUserPayload({ type: 'local', username: usernameKey, principal: passwordPrincipal });
    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);

    setAuthCookies(res, accessToken, refreshToken, userInfo);

    // ---------- New user notification (Feishu webhook) ----------
    if (isNewUser) {
      const feishuWebhook = process.env.FEISHU_SIGNUP_WEBHOOK;
      if (feishuWebhook) {
        // Best-effort fire-and-forget, don't block response
        const ref = referralCode ||
                    (req.query && (req.query.ref || req.query.linkId)) ||
                    (req.headers && req.headers['x-referral']) ||
                    (req.headers && req.headers.referer && (() => {
                      try { const u = new URL(req.headers.referer); return u.searchParams.get('code') || u.searchParams.get('linkId') || ''; } catch { return ''; } })()) ||
                    '';
        const ua = (req.headers && req.headers['user-agent']) || '';
        const payload = {
          msg_type: 'interactive',
          card: {
            header: { title: { tag: 'plain_text', content: '🎉 新用户注册' }, template: 'green' },
            elements: [
              { tag: 'div', text: { tag: 'lark_md', content: `**用户名：** ${cleanUsername}\n**来源IP：** ${ip}\n**归因code/link：** ${ref || '自然流量'}\n**UA：** ${ua.slice(0,200)}` } }
            ]
          }
        };
        fetch(feishuWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(() => {});
      }
    }

    return res.status(200).json({
      success: true,
      username: usernameKey,
      isNewUser
    });

  } catch (error) {
    console.error('[auth/register] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
