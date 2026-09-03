/**
 * Discord Activity Auth
 * 
 * POST /api/auth/discord-activity
 * 
 * For Discord Embedded App SDK (Activity) authentication.
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
const { extractReferralCode, finalizePendingReferral, stageReferral } = require('../_lib/referrals');
const { ensureMemberIdentity } = require('../_lib/member-identity');
const { deliverSignupEvent, stageSignupEvent } = require('../_lib/signup-outbox');
const { getLiveAdIdDetails } = require('../_lib/stats-data');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1504779503237333033';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!CLIENT_SECRET) {
    console.error('[discord-activity] DISCORD_CLIENT_SECRET not configured');
    return res.status(503).json({ error: 'Auth service unavailable' });
  }

  try {
    const { code } = req.body;
    const referralCode = extractReferralCode(req);

    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
      }),
    });

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return res.status(401).json({ error: 'Failed to exchange code for token' });
    }

    const tokenData = await tokenResponse.json();

    // Get user info from Discord
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userResponse.ok) {
      console.error('Failed to get user info:', await userResponse.text());
      return res.status(401).json({ error: 'Failed to get user info' });
    }

    const userData = await userResponse.json();

    const redis = getRedis();
    if (!redis) {
      return res.status(503).json({ error: 'Auth service unavailable' });
    }
    const mappingKey = `nf_discord_username:${String(userData.id || '').trim()}`;
    const previousMapping = await redis.get(mappingKey);
    const candidateUsername = String(previousMapping || userData.username || '').trim().toLowerCase();
    const hadUserData = candidateUsername ? Boolean(await redis.get(`nf_user_data:${candidateUsername}`)) : false;
    let runtimePromoterSnapshot = null;
    if (!previousMapping) {
      try { runtimePromoterSnapshot = await getLiveAdIdDetails(); } catch (_error) {}
      if (!runtimePromoterSnapshot || !runtimePromoterSnapshot.by_promoter) {
        return res.status(503).json({ error: 'Auth service unavailable', code: 'PROMOTER_IDENTITY_UNAVAILABLE' });
      }
    }
    const identity = await resolveDiscordIdentity(redis, userData.id, userData.username, { adData: runtimePromoterSnapshot });
    if (!identity) {
      return res.status(409).json({ error: 'Account identity recovery required', code: 'ACCOUNT_IDENTITY_CONFLICT' });
    }
    const identityPayload = {
      type: 'discord',
      username: identity.username,
      discordId: userData.id,
      principal: identity.principal,
    };
    try {
      if (await isDisabledUser(redis, identityPayload, { failClosed: true })) {
        return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
      }
    } catch (_error) {
      return res.status(503).json({ error: 'Auth service unavailable' });
    }

    if (!previousMapping && !hadUserData && referralCode) {
      try {
        await stageReferral(redis, identity.username, referralCode);
        await finalizePendingReferral(redis, identity.username);
      } catch (error) {
        console.warn('[discord-activity] Referral binding deferred:', error && error.code || error && error.message);
      }
    }
    let member = null;
    const isNewUser = !previousMapping && !hadUserData;
    try {
      member = await ensureMemberIdentity(redis, identity.username, {
        source: 'discord',
        createdAt: isNewUser ? new Date().toISOString() : null,
      });
    } catch (error) {
      console.warn('[discord-activity] Member ID allocation deferred:', error && error.code || error && error.message);
    }
    if (isNewUser) {
      try {
        const signupEvent = await stageSignupEvent(redis, {
          username: identity.username,
          memberId: member && member.id || null,
          referralCode: referralCode || '',
          ip: req.headers && req.headers['x-forwarded-for'] || '',
          userAgent: req.headers && req.headers['user-agent'] || '',
        });
        await deliverSignupEvent(redis, signupEvent);
      } catch (error) {
        console.warn('[discord-activity] Signup outbox deferred:', error && error.message);
      }
    }

    // Build token payload
    const userPayload = buildUserPayload({
      type: 'discord',
      discordId: userData.id,
      username: identity.username,
      globalName: userData.global_name || userData.username,
      avatar: userData.avatar,
      discriminator: userData.discriminator,
      principal: identity.principal,
    });

    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);

    setAuthCookies(res, accessToken, refreshToken, userInfo);

    console.log('[discord-activity] User authenticated:', userInfo.username);

    return res.status(200).json({
      success: true,
      user: {
        id: userData.id,
        memberId: member && member.id || null,
        username: userData.username,
        global_name: userData.global_name || userData.username,
        avatar: userData.avatar,
      }
    });

  } catch (error) {
    console.error('[discord-activity] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
