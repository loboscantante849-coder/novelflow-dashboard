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
  clearAuthCookies
} = require('../_lib/auth');

const { handlePreflight } = require('../_lib/cors');

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

    // Build new tokens with the same user info
    const userPayload = buildUserPayload(payload);
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
