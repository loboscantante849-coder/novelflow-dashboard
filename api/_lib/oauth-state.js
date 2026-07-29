'use strict';

const crypto = require('crypto');

const OAUTH_STATE_COOKIE = 'nf_oauth_state';
const OAUTH_STATE_MAX_AGE = 600;

function createOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

function readCookie(req, name) {
  const header = String(req && req.headers && req.headers.cookie || '');
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return '';
}

function statesMatch(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string' || !expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function buildOAuthStateCookie(value, maxAge = OAUTH_STATE_MAX_AGE) {
  return `${OAUTH_STATE_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/callback; Max-Age=${maxAge}`;
}

function clearOAuthStateCookie(res) {
  const clearCookie = buildOAuthStateCookie('', 0);
  const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null;
  if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, clearCookie]);
  else if (existing) res.setHeader('Set-Cookie', [existing, clearCookie]);
  else res.setHeader('Set-Cookie', clearCookie);
}

module.exports = {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE,
  buildOAuthStateCookie,
  clearOAuthStateCookie,
  createOAuthState,
  readCookie,
  statesMatch,
};
