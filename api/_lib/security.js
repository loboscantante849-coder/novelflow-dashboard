/**
 * Shared security helpers: rate limiting, input validation, auth extraction.
 * v2.5.2 - Security fixes - 2026-07-09
 * - Removed STATIC_ADMINS hardcoded whitelist; admin status is Redis-driven only.
 */
const { verifyAccessToken } = require('./auth');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { assertAccountIdentity, principalFromPayload } = require('./identity');
const { canonicalizeLocalSessionPayload } = require('./login-identity');
const { isSystemStatsBucket } = require('./promoter-access');
const {
  resolveReadOnlyWalletStorageIdentity,
  resolveWalletStorageIdentity,
  walletIdentityConflict,
} = require('./wallet-identity');

// Reserved usernames that cannot be registered
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'xujt', 'system', 'novelflow',
  'api', 'verifycron', 'support', 'help', 'moderator', 'mod',
  'official', 'staff', 'owner', 'webmaster', 'null', 'undefined',
  '_unmapped'
]);

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try {
    return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  } catch (_e) { return null; }
}

function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  h.split(';').forEach(c => {
    const [name, ...rest] = c.split('=');
    if (name && rest.length) out[name.trim()] = rest.join('=').trim();
  });
  return out;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.connection && req.connection.remoteAddress) ||
         (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Extract JWT payload from Authorization header or nf_token cookie.
 * Returns payload or null.
 */
function getAuthPayload(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const p = verifyAccessToken(authHeader.slice(7).trim());
    if (p) return canonicalizeLocalSessionPayload(p);
  }
  const cookies = parseCookies(req);
  if (cookies['nf_token']) {
    const p = verifyAccessToken(cookies['nf_token']);
    if (p) return canonicalizeLocalSessionPayload(p);
  }
  return null;
}

async function getAccountWalletData(redis, username, {
  allowSafeReadOnlyWalletConflict = false,
  expectedPrincipal = null,
} = {}) {
  const identity = allowSafeReadOnlyWalletConflict
    ? await resolveReadOnlyWalletStorageIdentity(redis, username, { expectedPrincipal })
    : await resolveWalletStorageIdentity(redis, username);
  if (identity.conflict) throw walletIdentityConflict(identity);
  const raw = await redis.get(`nf_user_data:${identity.storageUsername}`);
  if (!raw) return null;
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const error = new Error('Invalid account record');
    error.code = 'INVALID_ACCOUNT_RECORD';
    throw error;
  }
  return data;
}

function parseAccountStatusRecord(raw) {
  if (raw === null || raw === undefined) return null;
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const error = new Error('Invalid account status record');
    error.code = 'ACCOUNT_STATUS_UNAVAILABLE';
    throw error;
  }
  return data;
}

/**
 * Read server-managed account flags without making a healthy, reviewed
 * historical wallet duplicate block authentication. Any disabled/merged
 * record still wins; malformed records and unresolved conflicts fail closed.
 */
async function getAccountStatusRecords(redis, username, {
  allowSafeReadOnlyWalletConflict = false,
  expectedPrincipal = null,
} = {}) {
  const identity = await resolveWalletStorageIdentity(redis, username);
  if (!identity.conflict) {
    const raw = await redis.get(`nf_user_data:${identity.storageUsername}`);
    const record = parseAccountStatusRecord(raw);
    return record ? [record] : [];
  }
  if (!allowSafeReadOnlyWalletConflict) throw walletIdentityConflict(identity);

  const matched = Array.from(new Set(identity.matches || []));
  const keys = matched.map(storageUsername => `nf_user_data:${storageUsername}`);
  const values = typeof redis.mget === 'function'
    ? await redis.mget(...keys)
    : await Promise.all(keys.map(key => redis.get(key)));
  if (!Array.isArray(values) || values.length !== keys.length) {
    const error = new Error('Account status lookup returned an invalid response');
    error.code = 'ACCOUNT_STATUS_UNAVAILABLE';
    throw error;
  }
  const records = values.map(parseAccountStatusRecord);
  if (records.length !== matched.length || records.some(record => !record)) {
    const error = new Error('Account status record disappeared during lookup');
    error.code = 'ACCOUNT_STATUS_UNAVAILABLE';
    throw error;
  }
  const canonicalIndex = matched.indexOf(String(username).toLowerCase());
  if (process.env.VERCEL_ENV === 'production' && canonicalIndex >= 0 &&
      (records[canonicalIndex].disabled || records[canonicalIndex].wallet_merged_into)) {
    return [records[canonicalIndex]];
  }
  // Preserve strict local/test behavior: a disabled legacy duplicate remains
  // visible and blocks the account until it is explicitly reconciled.
  if (process.env.VERCEL_ENV !== 'production' &&
      records.some(record => record.disabled || record.wallet_merged_into)) return records;

  // Only the narrowly reviewed read-only alias exception may proceed when
  // every duplicate is healthy and bound to one local principal.
  const safeIdentity = await resolveReadOnlyWalletStorageIdentity(redis, username, { expectedPrincipal });
  if (safeIdentity.conflict) throw walletIdentityConflict(safeIdentity);
  if (safeIdentity.readOnlyLegacyConflict === 'canonical-only') {
    const selectedIndex = matched.indexOf(safeIdentity.storageUsername);
    return selectedIndex >= 0 ? [records[selectedIndex]] : records;
  }

  // A disabled/merged tombstone must never be hidden by a healthy duplicate.
  if (records.some(record => record.disabled || record.wallet_merged_into)) return records;
  return records;
}

/**
 * Check whether a username is an admin.
 * Admin status is determined SOLELY by nf_user_data:<u>.accountType === 'admin'
 * or nf_user_data:<u>.isAdmin === true in Redis. No hardcoded whitelist.
 */
async function isAdminUser(redis, username, { failClosed = false } = {}) {
  const u = String(username || '').toLowerCase();
  if (!u || !redis) {
    if (failClosed) {
      const error = new Error('Account status unavailable');
      error.code = 'ACCOUNT_STATUS_UNAVAILABLE';
      throw error;
    }
    return false;
  }
  try {
    const data = await getAccountWalletData(redis, u);
    return Boolean(data && !data.wallet_merged_into && (data.accountType === 'admin' || data.isAdmin === true));
  } catch (cause) {
    if (failClosed) {
      if (cause && ['ACCOUNT_IDENTITY_CONFLICT', 'WALLET_IDENTITY_CONFLICT'].includes(cause.code)) throw cause;
      const error = new Error('Account status unavailable');
      error.code = 'ACCOUNT_STATUS_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    return false;
  }
}

/**
 * Check the server-managed account disable flag. Read-only session checks may
 * fail open during a Redis outage; mutating handlers can request fail-closed
 * behavior so an unknown account state never reaches an external API.
 */
async function isDisabledUser(redis, usernameOrPayload, {
  failClosed = false,
  allowSafeReadOnlyWalletConflict = false,
} = {}) {
  const payload = usernameOrPayload && typeof usernameOrPayload === 'object' ? usernameOrPayload : null;
  const u = String(payload ? payload.username : usernameOrPayload || '').toLowerCase();
  if (!u || !redis) {
    if (failClosed) {
      const error = new Error('Account status unavailable');
      error.code = 'ACCOUNT_STATUS_UNAVAILABLE';
      throw error;
    }
    return false;
  }
  try {
    if (payload) await assertAccountIdentity(redis, payload);
    if (allowSafeReadOnlyWalletConflict) {
      const records = await getAccountStatusRecords(redis, u, {
        allowSafeReadOnlyWalletConflict: true,
        expectedPrincipal: payload ? principalFromPayload(payload) : null,
      });
      return records.some(record => record.disabled || record.wallet_merged_into);
    }
    const data = await getAccountWalletData(redis, u);
    return Boolean(data && (data.disabled || data.wallet_merged_into));
  } catch (cause) {
    if (failClosed) {
      if (cause && ['ACCOUNT_IDENTITY_CONFLICT', 'WALLET_IDENTITY_CONFLICT'].includes(cause.code)) throw cause;
      const error = new Error('Account status unavailable');
      error.code = 'ACCOUNT_STATUS_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    return false;
  }
}

/** Timing-safe string comparison for admin keys etc. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a compare to avoid length oracle
    const dummy = Buffer.alloc(Math.max(bufA.length, bufB.length));
    return crypto.timingSafeEqual(dummy, Buffer.alloc(dummy.length)) && false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Validate x-admin-key header (timing-safe). Key must come from header, not query. */
function checkAdminKey(req) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return false;
  const provided = req.headers['x-admin-key'];
  if (!provided || typeof provided !== 'string') return false;
  return timingSafeEqual(provided, expected);
}

/**
 * KV-backed sliding-window-ish rate limiter (fixed-window via INCR+EXPIRE).
 * Returns true if allowed, false if over limit.
 */
async function checkRateLimit(redis, key, limit, windowSec, { failClosed = false } = {}) {
  if (!redis) {
    if (failClosed) {
      const error = new Error('Rate limit storage unavailable');
      error.code = 'RATE_LIMIT_UNAVAILABLE';
      throw error;
    }
    return true;
  }
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    return count <= limit;
  } catch (cause) {
    if (failClosed) {
      const error = new Error('Rate limit storage unavailable');
      error.code = 'RATE_LIMIT_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    return true; // Existing low-cost flows retain their fail-open behavior.
  }
}

/**
 * Strict type/length validator. Returns {ok:false,status,error} or {ok:true}.
 */
function validateString(value, { name, maxLen = 500, minLen = 0, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) return { ok: false, status: 400, error: `${name} is required` };
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, status: 400, error: `${name} must be a string` };
  }
  if (value.length > maxLen) {
    return { ok: false, status: 400, error: `${name} too long (max ${maxLen})` };
  }
  if (value.length < minLen) {
    return { ok: false, status: 400, error: `${name} too short (min ${minLen})` };
  }
  return { ok: true, value };
}

/** Strip all HTML tags and HTML-escape dangerous chars. */
function stripHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/<[^>]*>/g, '')        // remove tags
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .trim();
}

/** Basic password policy: 8+ chars, contains letter + digit. */
function isStrongPassword(pwd) {
  if (typeof pwd !== 'string') return false;
  if (pwd.length < 8) return false;
  return /[A-Za-z]/.test(pwd) && /[0-9]/.test(pwd);
}

/** Check whether a username is reserved (cannot be registered). */
function isReservedUsername(username) {
  const normalized = String(username || '').trim().toLowerCase();
  return RESERVED_USERNAMES.has(normalized) || isSystemStatsBucket(normalized);
}

module.exports = {
  RESERVED_USERNAMES,
  getRedis,
  parseCookies,
  getClientIp,
  getAuthPayload,
  getAccountStatusRecords,
  isAdminUser,
  isDisabledUser,
  assertAccountIdentity,
  timingSafeEqual,
  checkAdminKey,
  checkRateLimit,
  validateString,
  stripHtml,
  isStrongPassword,
  isReservedUsername,
};
