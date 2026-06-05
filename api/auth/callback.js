/**
 * Discord OAuth Callback
 * 
 * GET /api/auth/callback
 * 
 * Exchanges Discord OAuth code for user info, issues access + refresh tokens.
 */

const {
  signAccessToken,
  signRefreshToken,
  buildUserPayload,
  extractUserInfo,
  setAuthCookies
} = require('../_lib/auth');

const { setCORSHeaders } = require('../../_lib/cors');

const CLIENT_ID = '1504779503237333033';
const CLIENT_SECRET = 'MWBTsNd-5Ot-0gQ8CzzeYbucCUjQdmxS';
const REDIRECT_URI = 'https://novelflow-dashboard.vercel.app/api/auth/callback';

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, error } = req.query;

  if (error) {
    return res.redirect('/app.html?login=cancelled');
  }

  if (!code) {
    return res.redirect('/app.html?login=error');
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return res.redirect('/app.html?login=error');
    }

    const tokenData = await tokenResponse.json();

    // Get user info from Discord
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userResponse.ok) {
      console.error('Failed to get user info:', await userResponse.text());
      return res.redirect('/app.html?login=error');
    }

    const userData = await userResponse.json();

    // Build token payload
    const userPayload = buildUserPayload({
      discordId: userData.id,
      username: userData.username,
      globalName: userData.global_name || userData.username,
      avatar: userData.avatar,
      discriminator: userData.discriminator,
    });

    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);

    setAuthCookies(res, accessToken, refreshToken, userInfo);

    return res.redirect('/app.html?login=success');

  } catch (error) {
    console.error('[auth/callback] Error:', error);
    return res.redirect('/app.html?login=error');
  }
};
