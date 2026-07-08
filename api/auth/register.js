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
const crypto = require('crypto');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function hashPassword(password) {
  return crypto.createHash('sha256').update('nf_' + password + '_salt2026').digest('hex');
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
    const { username, password } = body;
    if (typeof username !== 'string') {
      return res.status(400).json({ error: 'Username must be a string' });
    }
    if (password !== undefined && password !== null && typeof password !== 'string') {
      return res.status(400).json({ error: 'Password must be a string' });
    }

    const cleanUsername = username.trim();
    if (!USERNAME_RE.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Invalid username (use letters, numbers, Chinese chars, underscore, dot, @, space, hyphen; 1-50 chars)'
      });
    }

    const redis = getRedis();
    const ip = getClientIp(req);

    // ---------- Rate limiting ----------
    if (redis) {
      // IP-based global limit: 10 attempts / 15 min
      const ipRL = await rlCheck(redis, 'nf_login_ip:' + ip, 10, 900);
      if (!ipRL.allowed) {
        return res.status(429).json({ error: 'Too many login attempts', retryAfter: ipRL.retryAfter });
      }
      // Username-based lockout: 5 failures / 15 min
      const acctLock = await redis.get('nf_login_lock:' + cleanUsername.toLowerCase());
      if (acctLock) {
        const ttl = await redis.ttl('nf_login_lock:' + cleanUsername.toLowerCase());
        return res.status(429).json({ error: 'Account temporarily locked', retryAfter: Math.max(1, ttl) });
      }
    }

    // ---------- Business logic ----------
    let isNewUser = false;
    let mustSetPassword = false;
    let passedAuth = false;

    if (redis) {
      const [storedHash, userData] = await Promise.all([
        redis.get('nf_user_pass:' + cleanUsername),
        redis.get('nf_user_data:' + cleanUsername)
      ]);
      const userExists = !!(storedHash || userData);

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
        const inputHash = hashPassword(password);
        if (inputHash !== storedHash) {
          // Record failure → lock after 5
          const fails = await redis.incr('nf_login_fail:' + cleanUsername.toLowerCase());
          if (fails === 1) await redis.expire('nf_login_fail:' + cleanUsername.toLowerCase(), 900);
          if (fails >= 5) {
            await redis.set('nf_login_lock:' + cleanUsername.toLowerCase(), '1', { ex: 900 });
            await redis.del('nf_login_fail:' + cleanUsername.toLowerCase());
          }
          return res.status(401).json({ error: 'Invalid username or password' });
        }
        // Success → clear failure counter
        await redis.del('nf_login_fail:' + cleanUsername.toLowerCase());
        passedAuth = true;
      } else if (userData) {
        // Old user without password (has data but no pass hash)
        mustSetPassword = true;
        if (password) {
          if (!isValidPassword(password)) {
            return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and a number', needPassword: true, mustSetPassword: true });
          }
          const newHash = hashPassword(password);
          await redis.set('nf_user_pass:' + cleanUsername, newHash);
        }
        passedAuth = true;
      } else {
        // Brand new user → require a password to register
        isNewUser = true;
        if (!password) {
          return res.status(400).json({ error: 'Password required (min 8 characters with a letter and a number)', needPassword: true, mustSetPassword: true });
        }
        if (!isValidPassword(password)) {
          return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and a number', needPassword: true, mustSetPassword: true });
        }
        const newHash = hashPassword(password);
        await redis.set('nf_user_pass:' + cleanUsername, newHash);
        passedAuth = true;
      }
    } else {
      // No Redis → require password; treat all as new users (fail-open minimal)
      if (!password) {
        return res.status(400).json({ error: 'Password required (min 8 characters with a letter and a number)', needPassword: true, mustSetPassword: true });
      }
      if (!isValidPassword(password)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters with a letter and a number', needPassword: true, mustSetPassword: true });
      }
      isNewUser = true;
      passedAuth = true;
    }

    if (!passedAuth) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // ---------- Issue tokens ----------
    const userPayload = buildUserPayload({ type: 'local', username: cleanUsername });
    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);

    setAuthCookies(res, accessToken, refreshToken, userInfo);

    return res.status(200).json({
      success: true,
      username: cleanUsername,
      isNewUser,
      ...(mustSetPassword ? { mustSetPassword: true } : {})
    });

  } catch (error) {
    console.error('[auth/register] Error:', error);
    // Never leak stack traces; return generic 400 instead of 500 for bad input
    return res.status(400).json({ error: 'Invalid request' });
  }
};
