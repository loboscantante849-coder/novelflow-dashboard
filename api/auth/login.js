const { setCORSHeaders } = require('../_lib/cors');
const { createJWT } = require('../_lib/jwt');
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function hashPassword(password) {
  return crypto.createHash('sha256').update('nf_' + password + '_salt2026').digest('hex');
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username, password } = req.body;
    if (!username) return res.status(400).json({ error: 'Username is required' });

    const cleanUsername = username.trim().substring(0, 50);
    if (!cleanUsername) return res.status(400).json({ error: 'Invalid username' });

    const redis = getRedis();
    if (redis) {
      const storedHash = await redis.get('nf_user_pass:' + cleanUsername);
      if (storedHash) {
        // User has a password - must verify
        if (!password) return res.status(401).json({ error: 'Password required', needPassword: true });
        const inputHash = hashPassword(password);
        if (inputHash !== storedHash) return res.status(401).json({ error: 'Wrong password', needPassword: true });
      }
    }

    // Generate JWT
    const iat = Math.floor(Date.now() / 1000);
    const payload = { type: 'local', username: cleanUsername, novelFlowId: 'NF' + String(iat).slice(-6) + Math.random().toString(36).substr(2, 4).toUpperCase(), iat };
    const token = createJWT(payload);

    res.setHeader('Set-Cookie', [
      `nf_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `nf_user=${encodeURIComponent(JSON.stringify({ username: cleanUsername }))}; Path=/; Max-Age=2592000`
    ]);

    return res.status(200).json({ success: true, username: cleanUsername, message: 'Login successful' });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
