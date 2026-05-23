const { setCORSHeaders } = require('../_lib/cors');
const { createJWT } = require('../_lib/jwt');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1504779503237333033';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
// Dynamic redirect: derive from request or fallback
function getRedirectUri(req) {
  if (req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${req.headers.host}/api/auth/callback`;
  }
  return process.env.DISCORD_REDIRECT_URI || 'https://novelflow-dashboard.vercel.app/api/auth/callback';
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);

  const { code } = req.query || {};

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  if (!CLIENT_SECRET) {
    console.error('DISCORD_CLIENT_SECRET not configured');
    return res.status(500).json({ error: 'Discord OAuth not configured' });
  }

  try {
    const REDIRECT_URI = getRedirectUri(req);
    
    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      console.error('Discord token exchange failed:', tokenResponse.status);
      return res.redirect('/app-v2?auth=error');
    }

    const tokenData = await tokenResponse.json();

    // Get user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userResponse.ok) {
      console.error('Discord user fetch failed:', userResponse.status);
      return res.redirect('/app-v2?auth=error');
    }

    const userData = await userResponse.json();

    // Generate JWT with shared module
    const payload = {
      type: 'discord',
      discordId: userData.id,
      username: userData.username,
      globalName: userData.global_name,
      avatar: userData.avatar,
      discriminator: userData.discriminator,
      iat: Math.floor(Date.now() / 1000),
    };

    const token = createJWT(payload);

    // Set cookies (nf_user is NOT HttpOnly so frontend can read username)
    res.setHeader('Set-Cookie', [
      `nf_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `nf_user=${encodeURIComponent(JSON.stringify({ username: userData.global_name || userData.username, avatar: userData.avatar }))}; Path=/; Max-Age=2592000`
    ]);

    return res.redirect('/app-v2?auth=success');
  } catch (error) {
    console.error('Discord OAuth error:', error);
    return res.redirect('/app-v2?auth=error');
  }
};
