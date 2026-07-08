/**
 * POST /api/ac-retry
 * 重试AC视频任务
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Get token from Redis (same as ac-list), fall back to headers
  let token = null;
  let Redis = null, redis = null;
  try {
    Redis = require('@upstash/redis').Redis;
    if (process.env.KV_REST_API_URL) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      token = await redis.get('ac_token');
    }
  } catch(e) {}
  if (!token) token = req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', '')) ||
    (req.body && req.body.token);
  if (!token) return res.status(401).json({ error: 'AC Token not configured' });

  const tid = req.body?.threadId;
  if (!tid) return res.status(400).json({ error: 'threadId required' });

  try {
    const r = await fetch(AC_BASE + `/creative/${tid}/retry`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006', 'Content-Type': 'application/json' }
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    // Auto-rotate token in Redis
    if (newToken && redis) {
      redis.set('ac_token', newToken).catch(e => console.warn('Redis token save failed:', e.message));
    }
    res.setHeader('x-ac-token', newToken || '');
    return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data, newToken: newToken || undefined });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
