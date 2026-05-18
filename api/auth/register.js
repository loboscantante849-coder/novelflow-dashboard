const crypto = require('crypto');

const CLIENT_SECRET = process.env.JWT_SECRET || 'novelflow-secret-2026';

// Generate JWT token
function generateJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', CLIENT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

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
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { username, novelFlowId } = req.body;
    
    // Validate input
    if (!username || !novelFlowId) {
      return res.status(400).json({ error: 'Username and NovelFlow ID are required' });
    }
    
    // Trim and sanitize
    const cleanUsername = username.trim().substring(0, 50);
    const cleanNFId = novelFlowId.trim().toUpperCase().substring(0, 20);
    
    if (!cleanUsername || !cleanNFId) {
      return res.status(400).json({ error: 'Invalid username or NovelFlow ID' });
    }
    
    // Generate JWT payload
    const payload = {
      type: 'local',
      username: cleanUsername,
      novelFlowId: cleanNFId,
      iat: Math.floor(Date.now() / 1000)
    };
    
    // Generate token
    const token = generateJWT(payload);
    
    // Set cookie (30 days)
    res.setHeader('Set-Cookie', [
      `nf_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `nf_user=${encodeURIComponent(JSON.stringify({ username: cleanUsername, novelFlowId: cleanNFId }))}; Path=/; Max-Age=2592000`
    ]);
    
    return res.status(200).json({
      success: true,
      username: cleanUsername,
      novelFlowId: cleanNFId,
      isNewUser: true
    });
    
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
