/**
 * set-password — v2.6.3
 *
 * Security fixes:
 *  - Strong password policy: min 8 chars, must contain letter + digit
 *  - Strict type validation (no Object/Array → 400, no 500)
 *  - Do NOT set Access-Control-Allow-Credentials (M-01)
 */
const { handlePreflight } = require('../_lib/cors');
const { verifyAccessToken } = require('../_lib/jwt');
const { Redis } = require('@upstash/redis');
const { createPasswordHash, verifyPassword } = require('../_lib/password');
const { checkRateLimit, getClientIp, isDisabledUser } = require('../_lib/security');
const {
  bindPasswordPrincipal,
  canonicalizeLocalPrincipal,
  principalFromPayload,
} = require('../_lib/identity');
const { loadLocalLoginCredentials } = require('../_lib/login-identity');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function isStrongPassword(p) {
  if (typeof p !== 'string' || p.length < 8) return false;
  return /[A-Za-z]/.test(p) && /[0-9]/.test(p);
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: false })) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.split('=');
      if (name && rest.length > 0) cookies[name.trim()] = rest.join('=').trim();
    });

    const token = cookies['nf_token'];
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    const payload = verifyAccessToken(token);
    if (!payload) return res.status(401).json({ error: 'Invalid session' });

    const username = String(payload.username).toLowerCase();

    // Strict type validation
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const { password, oldPassword } = body;
    if (typeof password !== 'string') {
      return res.status(400).json({ error: 'Password must be a string' });
    }
    if (oldPassword !== undefined && oldPassword !== null && typeof oldPassword !== 'string') {
      return res.status(400).json({ error: 'Current password must be a string' });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and contain both a letter and a digit'
      });
    }
    if (password.length > 128) return res.status(400).json({ error: 'Password too long' });

    const redis = getRedis();
    if (!redis) return res.status(503).json({ error: 'Storage not available' });
    try {
      // Password changes do not mutate wallet balances. Permit the narrowly
      // reviewed healthy Cons read-only duplicate while still blocking any
      // disabled/merged wallet or owner mismatch.
      if (await isDisabledUser(redis, payload, {
        failClosed: true,
        allowSafeReadOnlyWalletConflict: true,
      })) {
        return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
      }
    } catch (_error) {
      return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
    }

    try {
      const allowed = await checkRateLimit(redis, `nf_rate:set_password:${username}`, 10, 900, { failClosed: true }) &&
        await checkRateLimit(redis, `nf_rate:set_password_ip:${getClientIp(req)}`, 30, 900, { failClosed: true });
      if (!allowed) return res.status(429).json({ error: 'Too many password attempts', code: 'RATE_LIMITED' });
    } catch (_error) {
      return res.status(503).json({ error: 'Password service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
    }

    // Check the canonical and explicitly reviewed historical credential keys.
    // When a legacy alias is the only credential, update that same key instead
    // of creating a second password record under the canonical username. This
    // keeps subsequent alias logins deterministic while still failing closed
    // when multiple credentials need manual reconciliation.
    let credentials;
    try {
      credentials = await loadLocalLoginCredentials(redis, username);
    } catch (_error) {
      return res.status(503).json({
        error: 'Account identity lookup is temporarily unavailable',
        code: 'ACCOUNT_IDENTITY_UNAVAILABLE',
      });
    }
    if (credentials.records.length > 1) {
      return res.status(409).json({ error: 'Account credential recovery is required', code: 'ACCOUNT_CREDENTIAL_CONFLICT' });
    }
    const credentialStorageUsername = credentials.records[0]?.storageUsername || username;
    const credentialUsername = credentialStorageUsername.toLowerCase();
    const storedHash = credentials.records[0]?.hash || null;
    const principal = principalFromPayload(payload);
    const canonicalPrincipal = principal
      ? canonicalizeLocalPrincipal(principal, credentialUsername)
      : null;
    const passwordOwner = await redis.get('nf_user_pass_owner:' + credentialUsername);
    if (passwordOwner && canonicalizeLocalPrincipal(passwordOwner, credentialUsername) !== canonicalPrincipal) {
      return res.status(409).json({ error: 'Password belongs to another sign-in identity', code: 'ACCOUNT_IDENTITY_CONFLICT' });
    }
    if (storedHash && oldPassword) {
      // Changing password - verify old password first (any length accepted for legacy pwds)
      if (typeof oldPassword !== 'string' || oldPassword.length < 1) {
        return res.status(401).json({ error: 'Current password is wrong' });
      }
      const verification = await verifyPassword(oldPassword, storedHash);
      if (!verification.valid) return res.status(401).json({ error: 'Current password is wrong' });
    } else if (storedHash && !oldPassword) {
      return res.status(400).json({ error: 'Current password required to change', hasPassword: true });
    }

    // Set new password
    if (!principal || !await bindPasswordPrincipal(redis, credentialUsername, principal)) {
      return res.status(409).json({ error: 'Account identity recovery required', code: 'ACCOUNT_IDENTITY_CONFLICT' });
    }
    await redis.set('nf_user_pass:' + credentialStorageUsername, await createPasswordHash(password));

    return res.status(200).json({ success: true, message: 'Password set successfully' });
  } catch (error) {
    console.error('Set password error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
