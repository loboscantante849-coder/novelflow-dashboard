/**
 * Shared Auth Module - Access Token + Refresh Token
 * 
 * Access Token: 7d expiry, sent with every request
 * Refresh Token: 30d expiry, only sent to /api/auth/refresh
 * Sliding window: refresh renews both tokens, so active users never need to re-login
 */

const crypto = require('crypto');

const ACCESS_MAX_AGE = 7 * 24 * 60 * 60;    // 7 days
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;   // 30 days

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not configured');
  }
  return secret;
}

// ========== JWT Core ==========

function signJWT(payload, maxAge) {
  const secret = getSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + maxAge
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyJWT(token) {
  try {
    const secret = getSecret();
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (actualBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());

    const now = Date.now() / 1000;
    if (payload.exp !== undefined &&
        (typeof payload.exp !== 'number' || now > payload.exp)) return null;

    // Legacy: tokens with only iat (no exp), allow 30 day max
    if (payload.exp === undefined) {
      if (typeof payload.iat !== 'number' || now - payload.iat > 2592000) return null;
    }
    if (typeof payload.iat === 'number' && payload.iat > now + 300) return null;

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
  if (payload.type === 'local') {
    return {
      username: payload.username,
      accountType: 'local',
      novelFlowId: payload.novelFlowId
    };
  }
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
    `nf_user=${encodeURIComponent(JSON.stringify(userInfo))}; Secure; SameSite=Lax; Path=/; Max-Age=${REFRESH_MAX_AGE}`
  ]);
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    'nf_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    'nf_refresh=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0',
    'nf_user=; Secure; SameSite=Lax; Path=/; Max-Age=0'
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
