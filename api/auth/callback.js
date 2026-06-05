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

const { setCORSHeaders } = require('../_lib/cors');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1504779503237333033';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'MWBTsNd-5Ot-0gQ8CzzeYbucCUjQdmxS';

function getRedirectUri(req) {
  if (req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return proto + '://' + req.headers.host + '/api/auth/callback';
  }
  return 'https://novelflow-dashboard.vercel.app/api/auth/callback';
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);

  var code = req.query.code;
  var oauthError = req.query.error;

  if (oauthError) {
    return res.redirect('/app-v2?auth=cancelled');
  }

  if (!code) {
    return res.redirect('/app-v2?auth=error');
  }

  try {
    var REDIRECT_URI = getRedirectUri(req);
    
    var tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
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
      console.error('[auth/callback] Token exchange failed:', tokenResponse.status);
      return res.redirect('/app-v2?auth=error');
    }

    var tokenData = await tokenResponse.json();

    var userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token },
    });

    if (!userResponse.ok) {
      console.error('[auth/callback] User fetch failed:', userResponse.status);
      return res.redirect('/app-v2?auth=error');
    }

    var userData = await userResponse.json();

    var userPayload = buildUserPayload({
      discordId: userData.id,
      username: userData.username,
      globalName: userData.global_name || userData.username,
      avatar: userData.avatar,
      discriminator: userData.discriminator,
    });

    var accessToken = signAccessToken(userPayload);
    var refreshToken = signRefreshToken(userPayload);
    var userInfo = extractUserInfo(userPayload);

    setAuthCookies(res, accessToken, refreshToken, userInfo);

    return res.redirect('/app-v2?auth=success');

  } catch (error) {
    console.error('[auth/callback] Error:', error);
    return res.redirect('/app-v2?auth=error');
  }
};
