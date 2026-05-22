/**
 * AC Token KV Store
 * Uses Vercel KV (@vercel/kv) to persist and auto-rotate AC tokens
 * 
 * POST /api/ac-kv  - Set initial token: { action: 'set', token: 'xxx' }
 * GET  /api/ac-kv  - Get current token (internal use)
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Try to use Vercel KV
  let kv = null;
  try {
    kv = require('@vercel/kv');
  } catch (e) {
    // KV not available
  }

  if (!kv) {
    return res.status(503).json({ error: 'Vercel KV not configured. Run: vercel env add KV_REST_API_URL' });
  }

  if (req.method === 'POST') {
    const { action, token } = req.body || {};
    if (action === 'set' && token) {
      await kv.set('ac_token', token);
      return res.status(200).json({ success: true, message: 'Token saved' });
    }
    return res.status(400).json({ error: 'Invalid action' });
  }

  if (req.method === 'GET') {
    const token = await kv.get('ac_token');
    return res.status(200).json({ token: token || null });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
