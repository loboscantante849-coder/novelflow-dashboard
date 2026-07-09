/**
 * Shared security helpers: rate limiting, input validation, auth extraction.
 * v2.5.2 - Security fixes - 2026-07-09
 * - Removed STATIC_ADMINS hardcoded whitelist; admin status is Redis-driven only.
 */
const { verifyJWT } = require('./auth');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

// Reserved usernames that cannot be registered
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'xujt', 'system', 'novelflow',
  'api', 'verifycron', 'support', 'help', 'moderator', 'mod',
  'official', 'staff', 'owner', 'webmaster', 'null', 'undefined'
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
    const p = verifyJWT(authHeader.slice(7).trim());
    if (p) return p;
  }
  const cookies = parseCookies(req);
  if (cookies['nf_token']) {
    const p = verifyJWT(cookies['nf_token']);
    if (p) return p;
  }
  return null;
}

/**
 * Check whether a username is an admin.
 * Admin status is determined SOLELY by nf_user_data:<u>.accountType === 'admin'
 * or nf_user_data:<u>.isAdmin === true in Redis. No hardcoded whitelist.
 */
async function isAdminUser(redis, username) {
  const u = String(username || '').toLowerCase();
  if (!u) return false;
  if (!redis) return false;
  try {
    const raw = await redis.get('nf_user_data:' + u);
    if (!raw) return false;
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return data && (data.accountType === 'admin' || data.isAdmin === true);
  } catch { return false; }
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
async function checkRateLimit(redis, key, limit, windowSec) {
  if (!redis) return true;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    return count <= limit;
  } catch { return true; } // fail-open on Redis error; don't break user flow
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
  return RESERVED_USERNAMES.has(String(username || '').toLowerCase());
}

module.exports = {
  RESERVED_USERNAMES,
  getRedis,
  parseCookies,
  getClientIp,
  getAuthPayload,
  isAdminUser,
  timingSafeEqual,
  checkAdminKey,
  checkRateLimit,
  validateString,
  stripHtml,
  isStrongPassword,
  isReservedUsername,
};
