/**
 * Shared security helpers: rate limiting, input validation, auth extraction.
 * v2.5.1 - Security P0 fixes - 2026-07-06
 */
const { verifyJWT } = require('./auth');
const { Redis } = require('@upstash/redis');

// Static admin usernames (also honored via nf_user_data:<u>.accountType === 'admin')
const STATIC_ADMINS = ['xujt', 'admin'];

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
 * Uses static list + optional nf_user_data:<u>.accountType==='admin'.
 * This is async because it may touch Redis for non-static users.
 */
async function isAdminUser(redis, username) {
  const u = String(username || '').toLowerCase();
  if (!u) return false;
  if (STATIC_ADMINS.includes(u)) return true;
  if (!redis) return false;
  try {
    const raw = await redis.get('nf_user_data:' + u);
    if (!raw) return false;
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return data && (data.accountType === 'admin' || data.isAdmin === true);
  } catch { return false; }
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

module.exports = {
  STATIC_ADMINS,
  getRedis,
  parseCookies,
  getClientIp,
  getAuthPayload,
  isAdminUser,
  checkRateLimit,
  validateString,
  stripHtml,
  isStrongPassword,
};
