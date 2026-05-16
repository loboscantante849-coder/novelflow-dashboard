const crypto = require('crypto');

const CLIENT_SECRET = process.env.JWT_SECRET || 'novelflow-secret-2026';

// Verify JWT and extract payload
function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [encodedHeader, encodedPayload, signature] = parts;
    
    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', CLIENT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    
    if (signature !== expectedSignature) return null;
    
    // Decode payload
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
    
    // Check expiration (30 days max)
    const maxAge = 2592000; // 30 days in seconds
    if (payload.iat && (Date.now() / 1000 - payload.iat) > maxAge) {
      return null;
    }
    
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  // Set CORS headers for local development
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse cookies from header
    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.split('=');
      if (name && rest.length > 0) {
        cookies[name.trim()] = rest.join('=').trim();
      }
    });

    const token = cookies['nf_token'];
    
    if (!token) {
      return res.status(200).json({ loggedIn: false });
    }

    const payload = verifyJWT(token);
    
    if (!payload) {
      // Invalid token, clear cookie
      res.setHeader('Set-Cookie', 'nf_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
      return res.status(200).json({ loggedIn: false });
    }

    // Check account type and return appropriate user info
    if (payload.type === 'local') {
      // Local account (username + NovelFlow ID)
      return res.status(200).json({
        loggedIn: true,
        accountType: 'local',
        username: payload.username,
        novelFlowId: payload.novelFlowId,
      });
    } else {
      // Discord OAuth account
      return res.status(200).json({
        loggedIn: true,
        accountType: 'discord',
        discordId: payload.discordId,
        username: payload.globalName || payload.username,
        avatar: payload.avatar,
        discriminator: payload.discriminator,
      });
    }
  } catch (error) {
    console.error('Auth check error:', error);
    return res.status(200).json({ loggedIn: false });
  }
};
