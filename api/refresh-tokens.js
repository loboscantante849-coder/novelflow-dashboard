/**
 * GET/POST /api/refresh-tokens
 *
 * Admin diagnostic endpoint. OIDC credentials are the source of truth, so a
 * refresh only warms a verified process token. It deliberately never deletes
 * and recreates a Vercel environment variable: that sequence could leave a
 * deployment without a usable token if the second request failed.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { checkAdminKey } = require('./_lib/security');
const { getFreshToken } = require('./_lib/oidc-token');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAdminKey(req)) return res.status(403).json({ error: 'Admin key required' });
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = await getFreshToken();
    if (!token) return res.status(503).json({ error: 'OIDC token refresh failed', code: 'UPSTREAM_AUTH_UNAVAILABLE' });
    return res.status(200).json({ success: true, refreshed: true });
  } catch (error) {
    console.error('[refresh-tokens]', error.message);
    return res.status(503).json({ error: 'OIDC token refresh failed', code: 'UPSTREAM_AUTH_UNAVAILABLE' });
  }
};
