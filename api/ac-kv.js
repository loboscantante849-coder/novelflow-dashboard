/**
 * AC Token KV Store - Admin Only
 * Uses Upstash Redis to persist and auto-rotate AC tokens
 * 
 * POST /api/ac-kv  - Set token: { action: 'set', token: 'xxx' } (requires x-admin-key header)
 * GET  /api/ac-kv  - Health check only (never exposes token value)
 */

const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const { setCORSHeaders } = require('./_lib/cors');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

// Timing-safe admin key check; only accepts x-admin-key header (no body/query)
function isAdmin(req) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return false;
  const provided = req.headers['x-admin-key'];
  if (!provided || typeof provided !== 'string') return false;
  const bufA = Buffer.from(provided);
  const bufB = Buffer.from(adminKey);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Upstash Redis not configured' });
  }

  if (req.method === 'GET') {
    try {
      const token = await redis.get('ac_token');
      return res.status(200).json({ configured: !!token, status: 'ok' });
    } catch (e) {
      return res.status(200).json({ configured: false, status: 'error' });
    }
  }

  if (req.method === 'POST') {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: 'Admin key required. Set x-admin-key header.' });
    }
    
    const { action, token } = req.body || {};
    if (action === 'set' && token && typeof token === 'string') {
      await redis.set('ac_token', token);
      return res.status(200).json({ success: true, message: 'Token saved' });
    }
    return res.status(400).json({ error: 'Invalid action. Use {action:"set", token:"xxx"}' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
