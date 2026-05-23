const { setCORSHeaders } = require('../_lib/cors');
const { createJWT } = require('../_lib/jwt');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    const cleanUsername = username.trim().substring(0, 50);
    
    if (!cleanUsername) {
      return res.status(400).json({ error: 'Invalid username' });
    }
    
    // Generate JWT payload with novelFlowId
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
      type: 'local',
      username: cleanUsername,
      novelFlowId: 'NF' + String(iat).slice(-6) + Math.random().toString(36).substr(2, 4).toUpperCase(),
      iat
    };
    
    const token = createJWT(payload);
    
    // Set cookies (30 days)
    res.setHeader('Set-Cookie', [
      `nf_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `nf_user=${encodeURIComponent(JSON.stringify({ username: cleanUsername }))}; Path=/; Max-Age=2592000`
    ]);
    
    return res.status(200).json({
      success: true,
      username: cleanUsername,
      isNewUser: true,
      message: 'Login successful'
    });
    
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
