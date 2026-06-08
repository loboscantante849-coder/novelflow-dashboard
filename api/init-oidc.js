/**
 * POST /api/init-oidc — Store OIDC credentials in Vercel KV
 * GET /api/init-oidc — Check if OIDC creds are available (from env or KV)
 */
const { setCORSHeaders } = require('./_lib/cors');
const { Redis } = require('@upstash/redis');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = getRedis();
  
  if (req.method === 'GET') {
    // Check current OIDC status
    const envUsername = process.env.OIDC_USERNAME || null;
    const envPassword = process.env.OIDC_PASSWORD || null;
    
    let kvUsername = null;
    let kvPassword = null;
    if (redis) {
      try {
        kvUsername = await redis.get('oidc:username');
        kvPassword = await redis.get('oidc:password');
      } catch (e) {
        console.error('KV read error:', e.message);
      }
    }
    
    return res.status(200).json({
      env: {
        OIDC_USERNAME: envUsername || 'NOT_SET',
        OIDC_PASSWORD: envPassword ? 'SET (' + envPassword.length + ' chars)' : 'NOT_SET'
      },
      kv: {
        username: kvUsername || 'NOT_SET',
        password: kvPassword ? 'SET (' + kvPassword.length + ' chars)' : 'NOT_SET',
        available: !!redis
      },
      source: kvUsername ? 'kv' : (envUsername ? 'env' : 'none')
    });
  }

  if (req.method === 'POST') {
    // Store OIDC creds in KV
    const { username, password } = req.body || {};
    
    if (!username || !password) {
      // Try to read from env vars first
      const envUsername = process.env.OIDC_USERNAME;
      const envPassword = process.env.OIDC_PASSWORD;
      
      if (envUsername && envPassword && redis) {
        await redis.set('oidc:username', envUsername);
        await redis.set('oidc:password', envPassword);
        return res.status(200).json({ 
          success: true, 
          message: 'Stored OIDC creds from env vars to KV',
          username: envUsername 
        });
      }
      
      return res.status(400).json({ 
        error: 'Provide username and password in request body, or ensure OIDC_USERNAME/OIDC_PASSWORD env vars are set' 
      });
    }
    
    if (!redis) {
      return res.status(503).json({ error: 'KV store not available' });
    }
    
    await redis.set('oidc:username', username);
    await redis.set('oidc:password', password);
    
    return res.status(200).json({ 
      success: true, 
      message: 'OIDC credentials stored in KV',
      username: username 
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
