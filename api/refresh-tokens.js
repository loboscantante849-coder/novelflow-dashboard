/**
 * GET /api/refresh-tokens - Auto-refresh OIDC tokens (cron or manual)
 * Uses password grant to get new tokens and update Vercel env vars.
 * Requires ADMIN_KEY for security.
 */
const { setCORSHeaders } = require('./_lib/cors');

const OIDC_TOKEN_URL = 'https://sts.anystories.app/connect/token';
const OIDC_CLIENT_ID = 'AuthClient';

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin key required' });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const OIDC_USERNAME = process.env.OIDC_USERNAME;
  const OIDC_PASSWORD = process.env.OIDC_PASSWORD;
  const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
  const PROJECT_ID = 'prj_jqVG4SiqA2FNAzvLdJCcGa0hFAdI';

  if (!OIDC_USERNAME || !OIDC_PASSWORD) {
    return res.status(500).json({ error: 'OIDC credentials not configured (OIDC_USERNAME, OIDC_PASSWORD)' });
  }

  try {
    // Step 1: Get new token from OIDC
    const tokenResponse = await fetch(OIDC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: OIDC_CLIENT_ID,
        username: OIDC_USERNAME,
        password: OIDC_PASSWORD,
        scope: 'openid profile roles email offline_access'
      })
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      return res.status(500).json({ error: 'OIDC token refresh failed', details: errText });
    }

    const tokenData = await tokenResponse.json();
    const newToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in;

    const result = {
      success: true,
      new_token_length: newToken.length,
      expires_in: expiresIn,
      vercel_update: null
    };

    // Step 2: Update Vercel env var if VERCEL_TOKEN is available
    if (VERCEL_TOKEN) {
      try {
        // First, try to delete the existing env var
        const listUrl = `https://api.vercel.com/v10/projects/${PROJECT_ID}/env`;
        const listResp = await fetch(listUrl, {
          headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` }
        });
        const listData = await listResp.json();
        const existing = (listData.envs || []).find(e => e.key === 'NOVELSPA_TOKEN');
        
        if (existing) {
          // Delete old one
          await fetch(`${listUrl}/${existing.id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` }
          });
        }

        // Create new one
        const createResp = await fetch(listUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${VERCEL_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            key: 'NOVELSPA_TOKEN',
            value: newToken,
            target: ['production', 'preview', 'development'],
            type: 'encrypted'
          })
        });

        result.vercel_update = createResp.ok ? 'success' : `failed: ${createResp.status}`;
      } catch(e) {
        result.vercel_update = `error: ${e.message}`;
      }
    } else {
      result.vercel_update = 'skipped (no VERCEL_TOKEN)';
      result.manual_action = 'Set NOVELSPA_TOKEN env var in Vercel with the new token';
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('Token refresh error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
