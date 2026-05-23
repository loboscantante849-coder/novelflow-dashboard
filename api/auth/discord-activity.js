const { setCORSHeaders } = require('../_lib/cors');
const { createJWT } = require('../_lib/jwt');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1504779503237333033';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!CLIENT_SECRET) {
    return res.status(500).json({ error: 'Discord OAuth not configured' });
  }

  try {
    const { access_token } = req.body || {};
    
    if (!access_token) {
      return res.status(400).json({ error: 'Access token required' });
    }

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userResponse.ok) {
      return res.status(401).json({ error: 'Invalid Discord token' });
    }

    const userData = await userResponse.json();

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

    res.setHeader('Set-Cookie', [
      `nf_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `nf_user=${encodeURIComponent(JSON.stringify({ username: userData.global_name || userData.username, avatar: userData.avatar }))}; Path=/; Max-Age=2592000`
    ]);

    return res.status(200).json({
      success: true,
      username: userData.global_name || userData.username,
      avatar: userData.avatar,
    });
  } catch (error) {
    console.error('Discord activity error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
