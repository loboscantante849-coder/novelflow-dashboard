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

const { setCORSHeaders } = require('../_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Try access token first
    const payload = getUserFromCookies(req);

    if (payload && !payload._refresh) {
      // Valid access token
      const userInfo = extractUserInfo(payload);
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
