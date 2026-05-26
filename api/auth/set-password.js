const { setCORSHeaders } = require('../_lib/cors');
const { verifyJWT } = require('../_lib/jwt');
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
    // Verify user is logged in via JWT cookie
    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.split('=');
      if (name && rest.length > 0) cookies[name.trim()] = rest.join('=').trim();
    });

    const token = cookies['nf_token'];
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    const payload = verifyJWT(token);
    if (!payload) return res.status(401).json({ error: 'Invalid session' });

    const username = payload.username;
    const { password, oldPassword } = req.body;

    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    if (password.length > 50) return res.status(400).json({ error: 'Password too long' });

    const redis = getRedis();
    if (!redis) return res.status(500).json({ error: 'Storage not available' });

    // Check if user already has a password
    const storedHash = await redis.get('nf_user_pass:' + username);
    if (storedHash && oldPassword) {
      // Changing password - verify old password first
      const oldHash = hashPassword(oldPassword);
      if (oldHash !== storedHash) return res.status(401).json({ error: 'Current password is wrong' });
    } else if (storedHash && !oldPassword) {
      return res.status(400).json({ error: 'Current password required to change', hasPassword: true });
    }

    // Set new password
    const newHash = hashPassword(password);
    await redis.set('nf_user_pass:' + username, newHash);

    return res.status(200).json({ success: true, message: 'Password set successfully' });
  } catch (error) {
    console.error('Set password error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
