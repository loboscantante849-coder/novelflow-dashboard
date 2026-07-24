/**
 * Refresh Token Endpoint
 * 
 * POST /api/auth/refresh
 * 
 * Called when access token (nf_token) is expired.
 * Uses refresh token (nf_refresh) to issue new access + refresh tokens.
 * Sliding window: each refresh extends the session by 30 days.
 */

const {
  verifyJWT,
  signAccessToken,
  signRefreshToken,
  buildUserPayload,
  extractUserInfo,
  parseCookies,
  setAuthCookies,
  clearAuthCookies,
  REFRESH_MAX_AGE
} = require('../_lib/auth');

const { handlePreflight } = require('../_lib/cors');
const { Redis } = require('@upstash/redis');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

async function isDisabledAccount(payload) {
  const username = String(payload && (payload.username || payload.globalName) || '').trim().toLowerCase();
  const redis = getRedis();
  if (!username || !redis) return false;
  try {
    const raw = await redis.get(`nf_user_data:${username}`);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Boolean(data && data.disabled);
  } catch (_) {
    return false;
  }
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: true })) return;

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cookies = parseCookies(req);
    const refreshToken = cookies['nf_refresh'];

    if (!refreshToken) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'No refresh token', code: 'NO_REFRESH' });
    }

    const payload = verifyJWT(refreshToken);

    if (!payload || !payload._refresh) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Invalid refresh token', code: 'INVALID_REFRESH' });
    }

    const sessionStartedAt = Number(payload.session_started_at || payload.iat || 0);
    const now = Math.floor(Date.now() / 1000);
    if (!sessionStartedAt || now - sessionStartedAt > REFRESH_MAX_AGE) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
    }
    if (await isDisabledAccount(payload)) {
      clearAuthCookies(res);
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }

    // Keep a fixed maximum session lifetime; active refreshes must not extend
    // a compromised token indefinitely.
    const userPayload = { ...buildUserPayload(payload), session_started_at: sessionStartedAt };
    const newAccessToken = signAccessToken(userPayload);
    const newRefreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(payload);

    setAuthCookies(res, newAccessToken, newRefreshToken, userInfo);

    return res.status(200).json({
      success: true,
      user: userInfo
    });

  } catch (error) {
    console.error('[auth/refresh] Error:', error);
    clearAuthCookies(res);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
