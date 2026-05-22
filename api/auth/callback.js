const crypto = require('crypto');

const CLIENT_ID = '1504779503237333033';
const CLIENT_SECRET = 'MWBTsNd-5Ot-0gQ8CzzeYbucCUjQdmxS';
const REDIRECT_URI = 'https://novelflow-dashboard.vercel.app/api/auth/callback';

// Simple JWT implementation using Node.js built-in crypto
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

const { setCORSHeaders } = require('../../_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, error } = req.query;

  // Handle OAuth error (user denied access)
  if (error) {
    return res.redirect('/app.html?login=cancelled');
  }

  // Require authorization code
  if (!code) {
    return res.redirect('/app.html?login=error');
  }

  try {
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
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return res.redirect('/app.html?login=error');
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
      return res.redirect('/app.html?login=error');
    }

    const userData = await userResponse.json();

    // Create JWT with user info
    const jwtPayload = {
      discordId: userData.id,
      username: userData.username,
      globalName: userData.global_name || userData.username,
      avatar: userData.avatar,
      discriminator: userData.discriminator,
      iat: Math.floor(Date.now() / 1000),
    };

    const jwt = createJWT(jwtPayload);

    // Set cookie with the JWT
    res.setHeader('Set-Cookie', [
      `nf_token=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `nf_user=${encodeURIComponent(JSON.stringify({
        id: userData.id,
        username: userData.username,
        globalName: userData.global_name || userData.username,
        avatar: userData.avatar,
        discriminator: userData.discriminator,
      }))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
    ]);

    // Redirect to app with success message
    return res.redirect('/app.html?login=success');
  } catch (error) {
    console.error('OAuth callback error:', error);
    return res.redirect('/app.html?login=error');
  }
};
