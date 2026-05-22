const crypto = require('crypto');

const CLIENT_ID = '1504779503237333033';
const CLIENT_SECRET = 'MWBTsNd-5Ot-0gQ8CzzeYbucCUjQdmxS';

// Simple JWT implementation
function createJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  
  const signature = crypto
    .createHmac('sha256', CLIENT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

// Exchange code for user info (for Discord Activity / Embedded App SDK)
const { setCORSHeaders } = require('../../_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { code } = req.body;

    // Require authorization code
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
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
    const accessToken = tokenData.access_token;

    // Get user info from Discord
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userResponse.ok) {
      console.error('Failed to get user info:', await userResponse.text());
      return res.status(401).json({ error: 'Failed to get user info' });
    }

    const userData = await userResponse.json();

    // Create user object
    const user = {
      id: userData.id,
      username: userData.username,
      global_name: userData.global_name || userData.username,
      avatar: userData.avatar,
    };

    // Create JWT
    const jwtPayload = {
      discordId: userData.id,
      username: userData.username,
      globalName: userData.global_name || userData.username,
      avatar: userData.avatar,
      iat: Math.floor(Date.now() / 1000),
    };

    const jwt = createJWT(jwtPayload);

    // Set cookies
    res.setHeader('Set-Cookie', [
      `nf_token=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `nf_user=${encodeURIComponent(JSON.stringify(user))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
    ]);

    console.log('[discord-activity] User authenticated:', user.username);

    return res.status(200).json({
      success: true,
      user: user,
      token: jwt
    });

  } catch (error) {
    console.error('[discord-activity] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
