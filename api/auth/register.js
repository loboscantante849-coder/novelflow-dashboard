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
const { ensureMemberIdentity } = require('../_lib/member-identity');
const { createAccountWithSignupEvent, deliverSignupEvent, enrichSignupEvent, signupEventId } = require('../_lib/signup-outbox');
const { getLiveAdIdDetails } = require('../_lib/stats-data');
const {
  consolidateEquivalentCredentials,
  loadLocalLoginCredentials,
  localLoginCredentialCandidates,
  resolveLocalLoginPrincipal,
} = require('../_lib/login-identity');
const { resolveReadOnlyWalletStorageIdentity } = require('../_lib/wallet-identity');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const value = fwd ? String(fwd).split(',')[0].trim() :
    ((req.connection && req.connection.remoteAddress) ||
     (req.socket && req.socket.remoteAddress) || 'unknown');
  return String(value).slice(0, 128);
}

// Sliding-window-ish rate limit: incr + expire on first hit
async function rlCheck(redis, key, limit, windowSec) {
  if (!redis) return { allowed: true };
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    if (count > limit) {
      const ttl = await redis.ttl(key);
      // Historical counters were occasionally written without an expiry.
      // They are not valid rate-limit windows and would otherwise block this
      // IP forever, so restart only that stale counter with the normal TTL.
      if (ttl < 0) {
        await redis.set(key, '1', { ex: windowSec });
        return { allowed: true };
      }
      return { allowed: false, retryAfter: Math.max(1, ttl) };
    }
    return { allowed: true };
  } catch { return { allowed: false, unavailable: true }; }
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
    const { username, password, referral_code: bodyReferralCode, legacy_recovery: legacyRecovery } = body;
    if (typeof username !== 'string') {
      return res.status(400).json({ error: 'Username must be a string' });
    }
    if (password !== undefined && password !== null && typeof password !== 'string') {
      return res.status(400).json({ error: 'Password must be a string' });
    }
    if (bodyReferralCode !== undefined && bodyReferralCode !== null && typeof bodyReferralCode !== 'string') {
      return res.status(400).json({ error: 'Referral code must be a string', code: 'INVALID_REFERRAL_CODE' });
    }
    if (legacyRecovery !== undefined && legacyRecovery !== null && (typeof legacyRecovery !== 'object' || Array.isArray(legacyRecovery))) {
      return res.status(400).json({ error: 'Invalid legacy recovery proof', code: 'INVALID_RECOVERY_PROOF' });
    }
    const recoveryRequested = legacyRecovery !== undefined && legacyRecovery !== null;
    const referralCode = extractReferralCode(req);

    const cleanUsername = username.trim();
    if (!USERNAME_RE.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Invalid username (use letters, numbers, Chinese chars, underscore, dot, @, space, hyphen; 1-50 chars)'
      });
    }
    // Historical promotion codes and links are public data, not proof of
    // account ownership. Keep the legacy field parseable for old clients,
    // but route every such request to human support before any Redis access.
    if (recoveryRequested) {
      return res.status(409).json({
        error: 'Please contact support to recover this account',
        code: 'SUPPORT_RECOVERY_REQUIRED',
      });
    }
    const loginIdentity = localLoginCredentialCandidates(cleanUsername);
    const usernameKey = loginIdentity.primaryUsername;

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
      if (ipRL.unavailable) {
        return res.status(503).json({ error: 'Registration service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
      }
      if (!ipRL.allowed) {
        return res.status(429).json({ error: 'Too many login attempts', code: 'RATE_LIMITED', retryAfter: ipRL.retryAfter });
      }
      // Username-based lockout: 5 failures / 15 min. Lock state is
      // authoritative; a Redis outage must become a generic 503.
      try {
        const acctLock = await redis.get('nf_login_lock:' + usernameKey);
        if (acctLock) {
          const ttl = await redis.ttl('nf_login_lock:' + usernameKey);
          if (ttl > 0) {
            return res.status(429).json({ error: 'Account temporarily locked', code: 'RATE_LIMITED', retryAfter: ttl });
          }
          // This lock type is always created with a 15-minute TTL. A surviving
          // no-expiry key is stale legacy state, not an intentional account ban.
          await redis.del('nf_login_lock:' + usernameKey);
        }
      } catch (_error) {
        return res.status(503).json({ error: 'Registration service temporarily unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
      }
    }

    // ---------- Business logic ----------
    let isNewUser = false;
    let passedAuth = false;
    let authenticatedPayload = null;
    let credentialUsername = usernameKey;
    let needsRehashCredential = null;
    let referralToBind = null;
    let signupEvent = null;

    {
      const passwordKey = 'nf_user_pass:' + usernameKey;
      let credentialIdentity;
      try {
        credentialIdentity = await loadLocalLoginCredentials(redis, cleanUsername);
      } catch (_error) {
        return res.status(503).json({ error: 'Account identity lookup is temporarily unavailable', code: 'ACCOUNT_IDENTITY_UNAVAILABLE' });
      }
      const credentialRecords = credentialIdentity.records;
      try {
        if (await isDisabledUser(redis, usernameKey, { failClosed: true, allowSafeReadOnlyWalletConflict: true })) {
          return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        }
      } catch (_error) {
        return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
      }
      let walletIdentity;
      try {
        walletIdentity = await resolveReadOnlyWalletStorageIdentity(redis, usernameKey);
      } catch (_error) {
        return res.status(503).json({ error: 'Account identity lookup is temporarily unavailable', code: 'ACCOUNT_IDENTITY_UNAVAILABLE' });
      }
      if (walletIdentity.conflict) {
        return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
      }
      let userData;
      try {
        userData = await redis.get(`nf_user_data:${walletIdentity.storageUsername}`);
      } catch (_error) {
        return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
      }
      const storedCredentials = credentialRecords.filter(record => record.hash);
      if (storedCredentials.length) {
        // Existing user with password → must verify
        if (!password) {
          return res.status(401).json({ error: 'Password required', needPassword: true });
        }
        if (typeof password !== 'string' || password.length < 1) {
          return res.status(401).json({ error: 'Invalid username or password', code: 'INVALID_CREDENTIALS' });
        }
        // NOTE: do NOT enforce strong-password policy on existing-user login;
        // old users may have shorter legacy passwords. Brute force is blocked
        // by the per-account lockout (5 fails / 15 min) above.
        const verifiedCredentials = [];
        for (const record of storedCredentials) {
          const verification = await verifyPassword(password, record.hash);
          if (verification.valid) verifiedCredentials.push({ ...record, verification });
        }
        if (!verifiedCredentials.length) {
          // Record failure → lock after 5
          try {
            const fails = await redis.incr('nf_login_fail:' + usernameKey);
            if (fails === 1) await redis.expire('nf_login_fail:' + usernameKey, 900);
            if (fails >= 5) {
              await redis.set('nf_login_lock:' + usernameKey, '1', { ex: 900 });
              await redis.del('nf_login_fail:' + usernameKey);
            }
          } catch (_error) {
            return res.status(503).json({ error: 'Registration service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
          }
          return res.status(401).json({ error: 'Invalid username or password', code: 'INVALID_CREDENTIALS' });
        }
        if (verifiedCredentials.length !== storedCredentials.length) {
          return res.status(409).json({ error: 'Account credential recovery is required', code: 'ACCOUNT_CREDENTIAL_CONFLICT' });
        }
        let principalForCredentials;
        try {
          principalForCredentials = await resolveLocalLoginPrincipal(
            redis,
            usernameKey,
            usernameKey,
            authenticatedPayload,
            resolvePasswordPrincipal,
          );
        } catch (_error) {
          return res.status(503).json({ error: 'Account identity lookup is temporarily unavailable', code: 'ACCOUNT_IDENTITY_UNAVAILABLE' });
        }
        if (!principalForCredentials) {
          return res.status(409).json({ error: 'Account identity recovery is required', code: 'ACCOUNT_IDENTITY_CONFLICT' });
        }
        if (storedCredentials.length > 1) {
          let consolidated;
          try {
            consolidated = await consolidateEquivalentCredentials(
              redis,
              usernameKey,
              storedCredentials,
              password,
              createPasswordHash,
              principalForCredentials,
            );
          } catch (_error) {
            return res.status(503).json({ error: 'Account identity update is temporarily unavailable', code: 'ACCOUNT_IDENTITY_UNAVAILABLE' });
          }
          if (!consolidated) {
            return res.status(409).json({ error: 'Account credential recovery is required', code: 'ACCOUNT_CREDENTIAL_CONFLICT' });
          }
          credentialUsername = usernameKey;
        } else {
          const matchedCredential = verifiedCredentials[0];
          // Keep the exact legacy key for owner checks; the identity helpers
          // normalize the username when they write canonical indexes.
          credentialUsername = matchedCredential.storageUsername;
          if (matchedCredential.verification.needsRehash) needsRehashCredential = matchedCredential.storageUsername;
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
          if (isProtectedPromoterUsername(usernameKey)) {
            return res.status(409).json({
              error: 'Please contact support to recover this account',
              code: 'SUPPORT_RECOVERY_REQUIRED',
            });
          }
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
        const createdEvent = await createAccountWithSignupEvent(
          redis,
          passwordKey,
          await createPasswordHash(password),
          {
            username: usernameKey,
            referralCode: referralToBind || '',
            ip,
            userAgent: (req.headers && req.headers['user-agent']) || '',
          },
        );
        const created = Boolean(createdEvent);
        if (!created) {
          return res.status(409).json({ error: 'Password status changed. Please sign in again.', code: 'PASSWORD_ALREADY_SET' });
        }
        authenticatedPayload = session;
        passedAuth = true;
      } else {
        let runtimePromoterSnapshot;
        try {
          runtimePromoterSnapshot = await getLiveAdIdDetails();
        } catch (_error) {
          runtimePromoterSnapshot = null;
        }
        if (!runtimePromoterSnapshot || !runtimePromoterSnapshot.by_promoter) {
          return res.status(503).json({
            error: 'Registration identity verification is temporarily unavailable',
            code: 'PROMOTER_IDENTITY_UNAVAILABLE',
          });
        }
        const protectedPromoter = isProtectedPromoterUsername(usernameKey, runtimePromoterSnapshot);
        if (protectedPromoter) {
          // Do not disclose or create a protected historical account through
          // normal registration. Public promotion assets are not proof of
          // ownership; human support must perform recovery.
          return res.status(409).json({
            error: 'Please contact support to recover this account',
            code: 'SUPPORT_RECOVERY_REQUIRED',
          });
        } else {
          // Brand new user → require a password to register.
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
            if (error && error.code === 'SELF_REFERRAL') {
              return res.status(409).json({ error: 'You cannot refer yourself', code: 'SELF_REFERRAL' });
            }
            if (error && error.code === 'INVALID_REFERRAL_CODE') {
              return res.status(400).json({ error: 'Invalid referral code', code: 'INVALID_REFERRAL_CODE' });
            }
            return res.status(503).json({ error: 'Registration service temporarily unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
          }
          let claimed;
          try {
            claimed = await claimIdentity(redis, usernameKey, `local:${usernameKey}`);
          } catch (_error) {
            return res.status(503).json({ error: 'Account identity update is temporarily unavailable', code: 'ACCOUNT_IDENTITY_UNAVAILABLE' });
          }
          if (!claimed) {
            return res.status(409).json({ error: 'This username belongs to another sign-in method', code: 'ACCOUNT_IDENTITY_CONFLICT' });
          }
          try {
            signupEvent = await createAccountWithSignupEvent(
              redis,
              passwordKey,
              await createPasswordHash(password),
              {
                username: usernameKey,
                referralCode: referralToBind || '',
                ip,
                userAgent: (req.headers && req.headers['user-agent']) || '',
              },
            );
          } catch (_error) {
            return res.status(503).json({ error: 'Registration service temporarily unavailable', code: 'ACCOUNT_IDENTITY_UNAVAILABLE' });
          }
          if (!signupEvent) {
            return res.status(409).json({ error: 'Account already exists. Please sign in.', code: 'ACCOUNT_ALREADY_EXISTS' });
          }
          passedAuth = true;
        }
      }
    }

    if (!passedAuth) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    let passwordPrincipal;
    let identityBound = false;
    try {
      passwordPrincipal = await resolveLocalLoginPrincipal(
        redis,
        usernameKey,
        credentialUsername,
        authenticatedPayload,
        resolvePasswordPrincipal,
      );
      identityBound = Boolean(passwordPrincipal &&
        await claimIdentity(redis, usernameKey, passwordPrincipal) &&
        await claimIdentity(redis, credentialUsername, passwordPrincipal) &&
        await bindPasswordPrincipal(redis, credentialUsername, passwordPrincipal));
    } catch (_error) {
      return res.status(503).json({ error: 'Account identity update is temporarily unavailable', code: 'ACCOUNT_IDENTITY_UNAVAILABLE' });
    }
    if (!identityBound) {
      return res.status(409).json({ error: 'Account identity recovery is required', code: 'ACCOUNT_IDENTITY_CONFLICT' });
    }
    // Delay legacy-hash migration until the credential owner has been
    // validated and bound, so a conflicting alias cannot mutate its hash.
    if (needsRehashCredential) {
      try {
        await redis.set(`nf_user_pass:${needsRehashCredential}`, await createPasswordHash(password));
      } catch (_error) {
        return res.status(503).json({ error: 'Account identity update is temporarily unavailable', code: 'ACCOUNT_IDENTITY_UNAVAILABLE' });
      }
    }
    let finalizedReferral = null;
    try {
      if (isNewUser && referralToBind) await stageReferral(redis, usernameKey, referralToBind);
      finalizedReferral = await finalizePendingReferral(redis, usernameKey);
    } catch (error) {
      console.warn('[auth/register] Referral binding deferred:', error && error.code || error && error.message);
    }
    let member = null;
    try {
      member = await ensureMemberIdentity(redis, usernameKey, {
        source: 'local',
        createdAt: isNewUser ? new Date().toISOString() : null,
      });
    } catch (error) {
      // Identity numbering is repaired by /auth/me, member insights, and the
      // admin registration sync. A transient counter outage must not strand a
      // successfully authenticated account without cookies.
      console.warn('[auth/register] Member ID allocation deferred:', error && error.code || error && error.message);
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

      // Persist the independent registration sink before returning. Delivery
      // is best-effort, but a failed call remains in Redis for a cron retry.
      try {
        const enrichedSignupEvent = await enrichSignupEvent(redis, signupEvent || {
          event_id: signupEventId(usernameKey),
        }, {
          member_id: member && member.id || null,
          referral_code: finalizedReferral && finalizedReferral.referral_code || referralToBind || '',
          inviter: finalizedReferral && finalizedReferral.parent || '',
        });
        await deliverSignupEvent(redis, enrichedSignupEvent);
      } catch (error) {
        console.warn('[auth/register] Signup outbox staging failed:', error && error.message);
      }
    }

    return res.status(200).json({
      success: true,
      username: usernameKey,
      memberId: member && member.id || null,
      isNewUser
    });

  } catch (error) {
    console.error('[auth/register] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
