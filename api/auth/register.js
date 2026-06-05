/**
 * Register / Login Endpoint (local accounts)
 * 
 * POST /api/auth/register
 * 
 * Creates a local account (username only) and issues access + refresh tokens.
 * Supports password verification for existing users.
 */

const {
  signAccessToken,
  signRefreshToken,
  buildUserPayload,
  extractUserInfo,
  setAuthCookies
} = require('../_lib/auth');

const { setCORSHeaders } = require('../_lib/cors');
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

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const cleanUsername = username.trim().substring(0, 50);
    if (!cleanUsername) {
      return res.status(400).json({ error: 'Invalid username' });
    }

    const redis = getRedis();

    // Check if user already has a password set
    if (redis) {
      const storedHash = await redis.get('nf_user_pass:' + cleanUsername);
      if (storedHash) {
        // User exists with password - must verify
        if (!password) {
          return res.status(401).json({ error: 'Password required', needPassword: true });
        }
        const inputHash = hashPassword(password);
        if (inputHash !== storedHash) {
          return res.status(401).json({ error: 'Wrong password', needPassword: true });
        }
      } else if (password && password.length >= 4) {
        // New user setting a password, or existing user adding password
        const newHash = hashPassword(password);
        await redis.set('nf_user_pass:' + cleanUsername, newHash);
      }
    }

    // Build token payload
    const userPayload = buildUserPayload({ type: 'local', username: cleanUsername });
    const accessToken = signAccessToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);
    const userInfo = extractUserInfo(userPayload);

    setAuthCookies(res, accessToken, refreshToken, userInfo);

    return res.status(200).json({
      success: true,
      username: cleanUsername,
      isNewUser: !redis ? true : !(await redis.exists('nf_user_pass:' + cleanUsername))
    });

  } catch (error) {
    console.error('[auth/register] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
