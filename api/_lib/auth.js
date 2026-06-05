/**
 * Shared Auth Module - Access Token + Refresh Token
 * 
 * Access Token: 24h expiry, sent with every request
 * Refresh Token: 30d expiry, only sent to /api/auth/refresh
 * Sliding window: refresh renews both tokens, so active users never need to re-login
 */

const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;

const ACCESS_MAX_AGE = 24 * 60 * 60;        // 24 hours
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;   // 30 days

// ========== JWT Core ==========

function signJWT(payload, maxAge) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not configured');
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + maxAge
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyJWT(token) {
  try {
    if (!JWT_SECRET) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    if (signature !== expectedSignature) return null;

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());

    // Check proper exp claim
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;

    // Legacy: tokens with only iat (no exp), allow 30 day max
    if (!payload.exp && payload.iat && (Date.now() / 1000 - payload.iat) > 2592000) return null;

    return payload;
  } catch (e) {
    return null;
  }
}

// ========== Token Helpers ==========

function signAccessToken(payload) {
  return signJWT(payload, ACCESS_MAX_AGE);
}

function signRefreshToken(payload) {
  return signJWT({ ...payload, _refresh: true }, REFRESH_MAX_AGE);
}

function buildUserPayload(user) {
  /** Build a clean payload for tokens, stripping internal fields */
  const p = {};
  if (user.type) p.type = user.type;
  if (user.username) p.username = user.username;
  if (user.discordId) p.discordId = user.discordId;
  if (user.globalName) p.globalName = user.globalName;
  if (user.avatar) p.avatar = user.avatar;
  if (user.discriminator) p.discriminator = user.discriminator;
  if (user.novelFlowId) p.novelFlowId = user.novelFlowId;
  return p;
}

function extractUserInfo(payload) {
  /** Extract frontend-safe user info from token payload */
  if (payload.type === 'local') {
    return {
      username: payload.username,
      accountType: 'local',
      novelFlowId: payload.novelFlowId
    };
  }
  // Discord
  return {
    username: payload.globalName || payload.username,
    accountType: 'discord',
    discordId: payload.discordId,
    avatar: payload.avatar,
    discriminator: payload.discriminator
  };
}

// ========== Cookie Helpers ==========

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.split('=');
    if (name && rest.length > 0) {
      cookies[name.trim()] = rest.join('=').trim();
    }
  });
  return cookies;
}

function setAuthCookies(res, accessToken, refreshToken, userInfo) {
  res.setHeader('Set-Cookie', [
    `nf_token=${accessToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ACCESS_MAX_AGE}`,
    `nf_refresh=${refreshToken}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=${REFRESH_MAX_AGE}`,
    `nf_user=${encodeURIComponent(JSON.stringify(userInfo))}; Path=/; Max-Age=${REFRESH_MAX_AGE}`
  ]);
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    'nf_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    'nf_refresh=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0',
    'nf_user=; Path=/; Max-Age=0'
  ]);
}

function getUserFromCookies(req) {
  const cookies = parseCookies(req);
  const token = cookies['nf_token'];
  if (!token) return null;
  return verifyJWT(token);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyJWT,
  buildUserPayload,
  extractUserInfo,
  parseCookies,
  setAuthCookies,
  clearAuthCookies,
  getUserFromCookies,
  ACCESS_MAX_AGE,
  REFRESH_MAX_AGE
};
