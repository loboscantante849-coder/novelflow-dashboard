/**
 * Registration Endpoint (local accounts) - v2.7.0
 *
 * POST /api/auth/register
 *
 * Registration and authentication are intentionally separate contracts:
 * - Existing password accounts must use /api/auth/login.
 * - Passwordless historical accounts must use the authenticated
 *   /api/auth/set-password recovery flow.
 * - Only a confirmed new-account attempt consumes nf_register_ip quota.
 *
 * Wallet, earnings, and promotion records are read only here. New-account
 * side effects are limited to the existing identity, referral, member, and
 * signup-outbox flows.
 */

const {
  signAccessToken,
  signRefreshToken,
  buildUserPayload,
  extractUserInfo,
  setAuthCookies,
} = require('../_lib/auth');

const { handlePreflight } = require('../_lib/cors');
const { Redis } = require('@upstash/redis');
const { createPasswordHash } = require('../_lib/password');
const { isDisabledUser, isReservedUsername } = require('../_lib/security');
const { bindPasswordPrincipal, claimIdentity, resolvePasswordPrincipal } = require('../_lib/identity');
const { isProtectedPromoterUsername } = require('../_lib/promoter-access');
const { extractReferralCode, finalizePendingReferral, stageReferral, validateReferral } = require('../_lib/referrals');
const { ensureMemberIdentity } = require('../_lib/member-identity');
const { createAccountWithSignupEvent, deliverSignupEvent, enrichSignupEvent, signupEventId } = require('../_lib/signup-outbox');
const { getLiveAdIdDetails } = require('../_lib/stats-data');
const {
  credentialOwnerKeys,
  loadLocalLoginCredentials,
  localLoginCredentialCandidates,
  resolveLocalLoginPrincipal,
} = require('../_lib/login-identity');
const {
  findCaseVariantWallets,
  resolveReadOnlyWalletStorageIdentity,
  walletStorageCandidates,
} = require('../_lib/wallet-identity');

const CASE_VARIANT_SCAN_PAGE_LIMIT = 16;

async function findCaseVariantOwnerAliases(redis, prefixes, candidates) {
  if (!redis || typeof redis.scan !== 'function') return [];
  const expected = new Set((candidates || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean));
  const matches = new Set();
  let pages = 0;
  for (const prefix of prefixes) {
    for (const candidate of expected) {
      let cursor = '0';
      const pattern = `${prefix}:${candidate.replace(/[a-z]/gi, '?')}`;
      do {
        if (++pages > CASE_VARIANT_SCAN_PAGE_LIMIT) {
          const error = new Error('Registration identity lookup exceeded its bounded scan');
          error.code = 'ACCOUNT_IDENTITY_UNAVAILABLE';
          throw error;
        }
        const result = await redis.scan(cursor, { match: pattern, count: 200 });
        if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
          const error = new Error('Registration identity lookup returned an invalid response');
          error.code = 'ACCOUNT_IDENTITY_UNAVAILABLE';
          throw error;
        }
        cursor = String(result[0] || '0');
        for (const key of result[1]) {
          const value = String(key);
          if (value.startsWith(`${prefix}:`)) {
            const alias = value.slice(prefix.length + 1);
            if (expected.has(alias.toLowerCase())) matches.add(alias);
          }
        }
      } while (cursor !== '0');
    }
  }
  return Array.from(matches);
}

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  } catch (_error) {
    return null;
  }
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const value = fwd ? String(fwd).split(',')[0].trim() :
    ((req.connection && req.connection.remoteAddress) ||
     (req.socket && req.socket.remoteAddress) || 'unknown');
  return String(value).slice(0, 128);
}

// Fixed-window limiter. A missing expiry on an old counter is treated as
// stale state and restarted instead of blocking registration forever.
async function rlCheck(redis, key, limit, windowSec) {
  try {
    const rawCount = await redis.incr(key);
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count < 1) throw new Error('Invalid registration rate-limit counter');
    if (count === 1) await redis.expire(key, windowSec);
    if (count > limit) {
      const ttl = Number(await redis.ttl(key));
      if (!Number.isFinite(ttl)) throw new Error('Invalid registration rate-limit TTL');
      if (ttl < 0) {
        await redis.set(key, '1', { ex: windowSec });
        return { allowed: true };
      }
      return { allowed: false, retryAfter: Math.max(1, ttl) };
    }
    return { allowed: true };
  } catch (_error) {
    return { allowed: false, unavailable: true };
  }
}

const USERNAME_RE = /^[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9_.@\- ]{1,50}$/;
const PASSWORD_MIN = 8;

function isValidPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return false;
  return /[A-Za-z]/.test(password) && /[0-9]/.test(password);
}

function responseForExistingAccount(res) {
  return res.status(409).json({
    error: 'Account already exists. Please sign in through the login form.',
    code: 'ACCOUNT_EXISTS_USE_LOGIN',
  });
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: true })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ---------- Strict request validation ----------
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const {
      username,
      password,
      referral_code: bodyReferralCode,
      legacy_recovery: legacyRecovery,
    } = body;
    if (typeof username !== 'string') {
      return res.status(400).json({ error: 'Username must be a string' });
    }
    if (password !== undefined && password !== null && typeof password !== 'string') {
      return res.status(400).json({ error: 'Password must be a string' });
    }
    if (bodyReferralCode !== undefined && bodyReferralCode !== null && typeof bodyReferralCode !== 'string') {
      return res.status(400).json({ error: 'Referral code must be a string', code: 'INVALID_REFERRAL_CODE' });
    }
    if (legacyRecovery !== undefined && legacyRecovery !== null &&
        (typeof legacyRecovery !== 'object' || Array.isArray(legacyRecovery))) {
      return res.status(400).json({ error: 'Invalid legacy recovery proof', code: 'INVALID_RECOVERY_PROOF' });
    }

    // Historical promotion codes and links are public data, not ownership
    // proof. Keep the field parseable for old clients, but route recovery to
    // support before any Redis read or mutation.
    if (legacyRecovery !== undefined && legacyRecovery !== null) {
      return res.status(409).json({
        error: 'Please contact support to recover this account',
        code: 'SUPPORT_RECOVERY_REQUIRED',
      });
    }

    const referralCode = extractReferralCode(req);
    const cleanUsername = username.trim();
    if (!USERNAME_RE.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Invalid username (use letters, numbers, Chinese chars, underscore, dot, @, space, hyphen; 1-50 chars)',
      });
    }

    const loginIdentity = localLoginCredentialCandidates(cleanUsername);
    const usernameKey = loginIdentity.primaryUsername;
    if (isReservedUsername(usernameKey)) {
      return res.status(400).json({ error: 'This username is not available' });
    }

    const redis = getRedis();
    if (!redis) return res.status(503).json({ error: 'Authentication service unavailable' });
    const ip = getClientIp(req);

    // ---------- Existing-account guard (read only) ----------
    // Scan bounded case variants so a historical display-case password cannot
    // be shadowed by a newly registered lowercase account.
    let credentialIdentity;
    try {
      credentialIdentity = await loadLocalLoginCredentials(redis, cleanUsername, {
        scanCaseVariants: true,
      });
    } catch (_error) {
      return res.status(503).json({
        error: 'Account identity lookup is temporarily unavailable',
        code: 'ACCOUNT_IDENTITY_UNAVAILABLE',
      });
    }

    try {
      if (await isDisabledUser(redis, usernameKey, {
        failClosed: true,
        allowSafeReadOnlyWalletConflict: true,
      })) {
        return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
      }
    } catch (_error) {
      return res.status(503).json({
        error: 'Account status unavailable',
        code: 'ACCOUNT_STATUS_UNAVAILABLE',
      });
    }

    let walletIdentity;
    try {
      walletIdentity = await resolveReadOnlyWalletStorageIdentity(redis, usernameKey);
    } catch (_error) {
      return res.status(503).json({
        error: 'Account identity lookup is temporarily unavailable',
        code: 'ACCOUNT_IDENTITY_UNAVAILABLE',
      });
    }
    if (walletIdentity.conflict) {
      return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
    }

    let userData = null;
    try {
      userData = await redis.get(`nf_user_data:${walletIdentity.storageUsername}`);
    } catch (_error) {
      return res.status(503).json({
        error: 'Account status unavailable',
        code: 'ACCOUNT_STATUS_UNAVAILABLE',
      });
    }

    // Treat any existing Redis value as an account claim, including a
    // malformed/empty legacy hash. Otherwise a corrupt key could consume the
    // registration quota and race the atomic create script before returning a
    // misleading "new account" response.
    let credentialKeyPresent = false;
    try {
      const credentialValues = await Promise.all((credentialIdentity.usernames || []).map(username =>
        redis.get(`nf_user_pass:${username}`)));
      credentialKeyPresent = credentialValues.some(value => value !== null && value !== undefined);
    } catch (_error) {
      return res.status(503).json({
        error: 'Account identity lookup is temporarily unavailable',
        code: 'ACCOUNT_IDENTITY_UNAVAILABLE',
      });
    }
    if (credentialKeyPresent || credentialIdentity.records.some(record => record.hash)) {
      return responseForExistingAccount(res);
    }

    const userDataPresent = userData !== null && userData !== undefined;
    if (userDataPresent) {
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

    // The wallet resolver intentionally avoids scanning unknown public names
    // to keep ordinary login requests O(1). Registration must additionally
    // prevent a historical display-case wallet (for example `Alice`) from
    // being shadowed by a new lowercase account, so perform the same bounded
    // read-only case-variant scan used by recovery flows.
    try {
      const walletCandidates = Array.from(new Set([
        usernameKey,
        ...(loginIdentity.usernames || []),
        ...walletStorageCandidates(usernameKey),
      ].filter(Boolean)));
      const caseVariantWallets = await findCaseVariantWallets(redis, walletCandidates);
      if (caseVariantWallets.length) {
        const walletValues = typeof redis.mget === 'function'
          ? await redis.mget(...caseVariantWallets.map(alias => `nf_user_data:${alias}`))
          : await Promise.all(caseVariantWallets.map(alias => redis.get(`nf_user_data:${alias}`)));
        let invalidWallet = false;
        const disabledWallet = walletValues.some(raw => {
          if (typeof raw !== 'string') return Boolean(raw && (raw.disabled || raw.wallet_merged_into));
          try {
            const record = JSON.parse(raw);
            if (!record || typeof record !== 'object' || Array.isArray(record)) {
              invalidWallet = true;
              return false;
            }
            return Boolean(record.disabled || record.wallet_merged_into);
          } catch (_error) {
            invalidWallet = true;
            return false;
          }
        });
        if (invalidWallet) {
          return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
        }
        if (disabledWallet) {
          return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        }
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
    } catch (_error) {
      return res.status(503).json({
        error: 'Account identity lookup is temporarily unavailable',
        code: 'ACCOUNT_IDENTITY_UNAVAILABLE',
      });
    }

    // A stale identity owner is still a claim. Never overwrite a Discord or
    // local identity merely because its wallet/password record is absent.
    try {
      const aliases = Array.from(new Set([
        usernameKey,
        ...(loginIdentity.usernames || []),
        ...(credentialIdentity.usernames || []),
      ]));
      const ownerKeys = credentialOwnerKeys(aliases);
      const ownerValues = typeof redis.mget === 'function'
        ? await redis.mget(...ownerKeys)
        : await Promise.all(ownerKeys.map(key => redis.get(key)));
      if (ownerValues.some(value => value !== null && value !== undefined)) {
        return res.status(409).json({
          error: 'This username belongs to another sign-in method',
          code: 'ACCOUNT_IDENTITY_CONFLICT',
        });
      }
      const ownerAliases = await findCaseVariantOwnerAliases(
        redis,
        ['nf_identity_owner', 'nf_user_pass_owner'],
        aliases,
      );
      if (ownerAliases.length) {
        return res.status(409).json({
          error: 'This username belongs to another sign-in method',
          code: 'ACCOUNT_IDENTITY_CONFLICT',
        });
      }
    } catch (_error) {
      return res.status(503).json({
        error: 'Account identity lookup is temporarily unavailable',
        code: 'ACCOUNT_IDENTITY_UNAVAILABLE',
      });
    }

    // Runtime promotion identities are protected even when no wallet/password
    // row exists yet. This check must happen before consuming registration
    // quota, because the request cannot create an account.
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
    if (isProtectedPromoterUsername(usernameKey, runtimePromoterSnapshot)) {
      return res.status(409).json({
        error: 'Please contact support to recover this account',
        code: 'SUPPORT_RECOVERY_REQUIRED',
      });
    }

    // ---------- Independent registration rate limit ----------
    // Normal logins never read or increment the registration quota. Legacy
    // login counters are intentionally ignored and are not migrated here.
    const registrationRL = await rlCheck(redis, `nf_register_ip:${ip}`, 10, 900);
    if (registrationRL.unavailable) {
      return res.status(503).json({
        error: 'Registration service temporarily unavailable',
        code: 'RATE_LIMIT_UNAVAILABLE',
      });
    }
    if (!registrationRL.allowed) {
      return res.status(429).json({
        error: 'Too many registration attempts',
        code: 'RATE_LIMITED',
        retryAfter: registrationRL.retryAfter,
      });
    }

    // ---------- New-account validation ----------
    if (!password) {
      return res.status(400).json({
        error: 'Password required (min 8 characters with a letter and a number)',
        needPassword: true,
        mustSetPassword: true,
      });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters with a letter and a number',
        needPassword: true,
        mustSetPassword: true,
      });
    }

    let referralToBind = null;
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
      return res.status(503).json({
        error: 'Registration service temporarily unavailable',
        code: 'ACCOUNT_STATUS_UNAVAILABLE',
      });
    }

    // Claim the identity before the atomic password+outbox write. This keeps
    // the established owner contract and prevents a concurrent registration
    // from taking over a just-created account.
    try {
      if (!await claimIdentity(redis, usernameKey, `local:${usernameKey}`)) {
        return res.status(409).json({
          error: 'This username belongs to another sign-in method',
          code: 'ACCOUNT_IDENTITY_CONFLICT',
        });
      }
    } catch (_error) {
      return res.status(503).json({
        error: 'Account identity update is temporarily unavailable',
        code: 'ACCOUNT_IDENTITY_UNAVAILABLE',
      });
    }

    const passwordKey = `nf_user_pass:${usernameKey}`;
    let signupEvent;
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
      return res.status(503).json({
        error: 'Registration service temporarily unavailable',
        code: 'ACCOUNT_IDENTITY_UNAVAILABLE',
      });
    }
    if (!signupEvent) return responseForExistingAccount(res);

    // ---------- Bind the new local principal ----------
    let passwordPrincipal;
    try {
      passwordPrincipal = await resolveLocalLoginPrincipal(
        redis,
        usernameKey,
        usernameKey,
        null,
        resolvePasswordPrincipal,
      );
      const identityBound = Boolean(passwordPrincipal &&
        await claimIdentity(redis, usernameKey, passwordPrincipal) &&
        await bindPasswordPrincipal(redis, usernameKey, passwordPrincipal));
      if (!identityBound) {
        return res.status(409).json({
          error: 'Account identity recovery is required',
          code: 'ACCOUNT_IDENTITY_CONFLICT',
        });
      }
    } catch (_error) {
      return res.status(503).json({
        error: 'Account identity update is temporarily unavailable',
        code: 'ACCOUNT_IDENTITY_UNAVAILABLE',
      });
    }

    let finalizedReferral = null;
    try {
      if (referralToBind) await stageReferral(redis, usernameKey, referralToBind);
      finalizedReferral = await finalizePendingReferral(redis, usernameKey);
    } catch (error) {
      console.warn('[auth/register] Referral binding deferred:', error && error.code || error && error.message);
    }

    let member = null;
    try {
      member = await ensureMemberIdentity(redis, usernameKey, {
        source: 'local',
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      // Member numbering is repaired by /auth/me and admin sync; it must not
      // strand a successfully created account without an auth session.
      console.warn('[auth/register] Member ID allocation deferred:', error && error.code || error && error.message);
    }

    const userPayload = buildUserPayload({
      type: 'local',
      username: usernameKey,
      principal: passwordPrincipal,
    });
    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);
    setAuthCookies(res, accessToken, refreshToken, userInfo);

    // ---------- New-user notification ----------
    const feishuWebhook = process.env.FEISHU_SIGNUP_WEBHOOK;
    if (feishuWebhook) {
      const ref = referralCode ||
        (req.query && (req.query.ref || req.query.linkId)) ||
        (req.headers && req.headers['x-referral']) ||
        (req.headers && req.headers.referer && (() => {
          try {
            const url = new URL(req.headers.referer);
            return url.searchParams.get('code') || url.searchParams.get('linkId') || '';
          } catch (_error) {
            return '';
          }
        })()) || '';
      const ua = (req.headers && req.headers['user-agent']) || '';
      const payload = {
        msg_type: 'interactive',
        card: {
          header: { title: { tag: 'plain_text', content: '🎉 新用户注册' }, template: 'green' },
          elements: [{
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**用户名：** ${cleanUsername}\n**来源IP：** ${ip}\n**归因code/link：** ${ref || '自然流量'}\n**UA：** ${ua.slice(0, 200)}`,
            },
          }],
        },
      };
      fetch(feishuWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    }

    // Persist the independent registration sink before returning. Delivery is
    // best-effort; failed events remain queued for the cron retry path.
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

    return res.status(200).json({
      success: true,
      username: usernameKey,
      memberId: member && member.id || null,
      isNewUser: true,
    });
  } catch (error) {
    console.error('[auth/register] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
