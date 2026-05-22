/**
 * AC Token KV Store
 * Uses Upstash Redis to persist and auto-rotate AC tokens
 * 
 * POST /api/ac-kv  - Set initial token: { action: 'set', token: 'xxx' }
 * GET  /api/ac-kv  - Get current token
 */
const { Redis } = require('@upstash/redis');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Upstash Redis not configured. Connect Upstash to this project in Vercel Storage.' });
  }

  if (req.method === 'POST') {
    const { action, token } = req.body || {};
    if (action === 'set' && token) {
      await redis.set('ac_token', token);
      return res.status(200).json({ success: true, message: 'Token saved to Upstash Redis' });
    }
    return res.status(400).json({ error: 'Invalid action. Use {action:"set", token:"xxx"}' });
  }

  if (req.method === 'GET') {
    const token = await redis.get('ac_token');
    return res.status(200).json({ token: token || null });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
