/**
 * Register / Login Endpoint (local accounts)
 * 
 * POST /api/auth/register
 * 
 * Creates a local account (username only) and issues access + refresh tokens.
 */

const {
  signAccessToken,
  signRefreshToken,
  buildUserPayload,
  extractUserInfo,
  setAuthCookies
} = require('../_lib/auth');

const { setCORSHeaders } = require('../../_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const cleanUsername = username.trim().substring(0, 50);
    if (!cleanUsername) {
      return res.status(400).json({ error: 'Invalid username' });
    }

    // Build token payload
    const userPayload = buildUserPayload({ type: 'local', username: cleanUsername });
    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);

    setAuthCookies(res, accessToken, refreshToken, userInfo);

    return res.status(200).json({
      success: true,
      username: cleanUsername,
      isNewUser: true
    });

  } catch (error) {
    console.error('[auth/register] Error:', error);
    if (error.message === 'JWT_SECRET not configured') {
      return res.status(500).json({ error: 'Server auth not configured' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
};
