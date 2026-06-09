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

    const rawUsername = username.trim().substring(0, 50);
    // XSS prevention: strip HTML tags
    const cleanUsername = rawUsername.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
    if (!cleanUsername || cleanUsername.length < 1) {
      return res.status(400).json({ error: 'Invalid username' });
    }

    const redis = getRedis();

    // Check if user already has a password set
    if (redis) {
      const [storedHash, userData] = await Promise.all([
        redis.get('nf_user_pass:' + cleanUsername),
        redis.get('nf_user_data:' + cleanUsername)
      ]);
      const userExists = !!(storedHash || userData);

      if (storedHash) {
        // User exists with password - must verify
        if (!password) {
          return res.status(401).json({ error: 'Password required', needPassword: true });
        }
        const inputHash = hashPassword(password);
        if (inputHash !== storedHash) {
          return res.status(401).json({ error: 'Wrong password', needPassword: true });
        }
      } else if (userExists) {
        // Old user without password (has data but no pass) - allow login, prompt to set password
        if (!password) {
          const userPayload = buildUserPayload({ type: 'local', username: cleanUsername });
          const accessToken = signAccessToken(userPayload);
          const refreshToken = signRefreshToken(userPayload);
          const userInfo = extractUserInfo(userPayload);
          setAuthCookies(res, accessToken, refreshToken, userInfo);
          return res.status(200).json({
            success: true,
            username: cleanUsername,
            isNewUser: false,
            mustSetPassword: true
          });
        }
        // User provided a password - set it
        if (password.length < 4) {
          return res.status(400).json({ error: 'Password must be at least 4 characters', needPassword: true, mustSetPassword: true });
        }
        const newHash = hashPassword(password);
        await redis.set('nf_user_pass:' + cleanUsername, newHash);
      } else {
        // Brand new user - must set password
        if (!password || password.length < 4) {
          return res.status(400).json({ error: 'Password required (min 4 characters)', needPassword: true, mustSetPassword: true });
        }
        const newHash = hashPassword(password);
        await redis.set('nf_user_pass:' + cleanUsername, newHash);
      }
    } else {
      // No Redis - still require password for new users
      if (!password || password.length < 4) {
        return res.status(400).json({ error: 'Password required (min 4 characters)', needPassword: true, mustSetPassword: true });
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
