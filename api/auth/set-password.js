/**
 * set-password — v2.6.3
 *
 * Security fixes:
 *  - Strong password policy: min 8 chars, must contain letter + digit
 *  - Strict type validation (no Object/Array → 400, no 500)
 *  - Do NOT set Access-Control-Allow-Credentials (M-01)
 */
const { handlePreflight } = require('../_lib/cors');
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

function isStrongPassword(p) {
  if (typeof p !== 'string' || p.length < 8) return false;
  return /[A-Za-z]/.test(p) && /[0-9]/.test(p);
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: false })) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
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

    // Strict type validation
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const { password, oldPassword } = body;
    if (typeof password !== 'string') {
      return res.status(400).json({ error: 'Password must be a string' });
    }
    if (oldPassword !== undefined && oldPassword !== null && typeof oldPassword !== 'string') {
      return res.status(400).json({ error: 'Current password must be a string' });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and contain both a letter and a digit'
      });
    }
    if (password.length > 128) return res.status(400).json({ error: 'Password too long' });

    const redis = getRedis();
    if (!redis) return res.status(500).json({ error: 'Storage not available' });

    // Check if user already has a password
    const storedHash = await redis.get('nf_user_pass:' + username);
    if (storedHash && oldPassword) {
      // Changing password - verify old password first (any length accepted for legacy pwds)
      if (typeof oldPassword !== 'string' || oldPassword.length < 1) {
        return res.status(401).json({ error: 'Current password is wrong' });
      }
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
    return res.status(400).json({ error: 'Invalid request' });
  }
};
