/**
 * Check Login Status
 * 
 * GET /api/auth/me
 * 
 * Verifies access token. If expired but refresh token exists,
 * returns needsRefresh hint so the frontend can auto-refresh.
 */

const {
  verifyJWT,
  getUserFromCookies,
  parseCookies,
  clearAuthCookies,
  extractUserInfo
} = require('../_lib/auth');

const { handlePreflight } = require('../_lib/cors');
const { getRedis, isDisabledUser } = require('../_lib/security');

module.exports = async (req, res) => {
  // me is read by the same-origin frontend via credentials; no cross-origin credentialed reads allowed.
  // Do NOT enable Access-Control-Allow-Credentials (M-01 fix).
  if (handlePreflight(req, res, { credentials: false })) return;

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Try access token first
    const payload = getUserFromCookies(req);

    if (payload && !payload._refresh) {
      const userInfo = extractUserInfo(payload);
      const redis = getRedis();
      if (!redis) {
        return res.status(503).json({ loggedIn: false, code: 'ACCOUNT_STATUS_UNAVAILABLE' });
      }
      try {
        if (await isDisabledUser(redis, payload.username, { failClosed: true })) {
          clearAuthCookies(res);
          return res.status(403).json({ loggedIn: false, code: 'ACCOUNT_DISABLED' });
        }
      } catch (_error) {
        return res.status(503).json({ loggedIn: false, code: 'ACCOUNT_STATUS_UNAVAILABLE' });
      }
      // Valid access token
      return res.status(200).json({
        loggedIn: true,
        ...userInfo
      });
    }

    // Access token missing or expired - check if refresh token exists
    const cookies = parseCookies(req);
    const refreshToken = cookies['nf_refresh'];

    if (refreshToken) {
      const refreshPayload = verifyJWT(refreshToken);
      if (refreshPayload && refreshPayload._refresh) {
        return res.status(200).json({
          loggedIn: false,
          needsRefresh: true
        });
      }
    }

    // No valid tokens at all
    clearAuthCookies(res);
    return res.status(200).json({ loggedIn: false });

  } catch (error) {
    console.error('[auth/me] Error:', error);
    return res.status(200).json({ loggedIn: false });
  }
};
