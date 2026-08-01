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
const { getRedis, isDisabledUser } = require('../_lib/security');
const { resolveDiscordIdentity } = require('../_lib/identity');
const {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  readCookie,
  statesMatch,
} = require('../_lib/oauth-state');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1504779503237333033';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

function getRedirectUri() {
  return process.env.DISCORD_REDIRECT_URI || 'https://novelflow.top/api/auth/callback';
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);

  var code = req.query.code;
  var oauthError = req.query.error;
  var receivedState = req.query.state;
  var expectedState = readCookie(req, OAUTH_STATE_COOKIE);

  clearOAuthStateCookie(res);

  if (!statesMatch(expectedState, receivedState)) {
    return res.redirect('/app-v2?auth=error');
  }

  if (oauthError) {
    return res.redirect('/app-v2?auth=cancelled');
  }

  if (!code) {
    return res.redirect('/app-v2?auth=error');
  }

  if (!CLIENT_SECRET) {
    console.error('[auth/callback] DISCORD_CLIENT_SECRET not configured');
    return res.redirect('/app-v2?auth=error');
  }

  try {
    var REDIRECT_URI = getRedirectUri();
    
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

    var redis = getRedis();
    if (!redis) {
      return res.redirect('/app-v2?auth=error');
    }
    var identity = await resolveDiscordIdentity(redis, userData.id, userData.username);
    if (!identity) {
      return res.redirect('/app-v2?auth=identity_conflict');
    }
    var identityPayload = {
      type: 'discord',
      username: identity.username,
      discordId: userData.id,
      principal: identity.principal,
    };
    try {
      if (await isDisabledUser(redis, identityPayload, { failClosed: true })) {
        return res.redirect('/app-v2?auth=error');
      }
    } catch (_error) {
      return res.redirect('/app-v2?auth=error');
    }

    var userPayload = buildUserPayload({
      type: 'discord',
      discordId: userData.id,
      username: identity.username,
      globalName: userData.global_name || userData.username,
      avatar: userData.avatar,
      discriminator: userData.discriminator,
      principal: identity.principal,
    });

    var accessToken = signAccessToken(userPayload);
    var refreshToken = signRefreshToken(userPayload);
    var userInfo = extractUserInfo(userPayload);

    setAuthCookies(res, accessToken, refreshToken, userInfo);
    clearOAuthStateCookie(res);

    return res.redirect('/app-v2?auth=success');

  } catch (error) {
    console.error('[auth/callback] Error:', error);
    return res.redirect('/app-v2?auth=error');
  }
};
