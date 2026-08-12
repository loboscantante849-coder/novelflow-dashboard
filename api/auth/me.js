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
const { ensureMemberIdentity } = require('../_lib/member-identity');

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
      const username = String(payload.username || '').trim().toLowerCase();
      if (!username) {
        clearAuthCookies(res);
        return res.status(200).json({ loggedIn: false });
      }
      const redis = getRedis();
      if (!redis) {
        return res.status(503).json({ loggedIn: false, code: 'ACCOUNT_STATUS_UNAVAILABLE' });
      }
      try {
        if (await isDisabledUser(redis, payload, { failClosed: true })) {
          clearAuthCookies(res);
          return res.status(403).json({ loggedIn: false, code: 'ACCOUNT_DISABLED' });
        }
        const hasPassword = Boolean(await redis.get('nf_user_pass:' + username));
        let member = null;
        try {
          member = await ensureMemberIdentity(redis, username, { source: payload.type === 'discord' ? 'discord' : 'local' });
        } catch (error) {
          console.warn('[auth/me] Member ID allocation deferred:', error && error.code || error && error.message);
        }
        userInfo.hasPassword = hasPassword;
        userInfo.memberId = member && member.id || null;
      } catch (_error) {
        if (_error && _error.code === 'ACCOUNT_IDENTITY_CONFLICT') {
          clearAuthCookies(res);
          return res.status(409).json({ loggedIn: false, code: _error.code });
        }
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
