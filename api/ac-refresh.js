/**
 * POST /api/ac-refresh
 * 服务端自检 AC token 有效性并刷新（管理员通过 header 触发，不接受客户端传 token）
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser, checkAdminKey } = require('./_lib/security');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Only admin (JWT or x-admin-key) can trigger server-side token refresh
  const payload = getAuthPayload(req);
  let isAdm = checkAdminKey(req);
  let redis = null;
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    }
  } catch(e) {}
  if (!isAdm && payload && redis) {
    isAdm = await isAdminUser(redis, payload.username);
  }
  if (!isAdm) return res.status(403).json({ error: 'Admin only' });

  let token = null;
  try { if (redis) token = await redis.get('ac_token'); } catch(e) {}
  if (!token) token = process.env.AC_TOKEN;
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  try {
    const r = await fetch(AC_BASE + '/creative/paged-list?PageSize=5&PageIndex=1', {
      headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    if (r.status !== 200) {
      return res.status(r.status).json({ success: false, error: 'Token invalid' });
    }

    if (newToken && redis) {
      await redis.set('ac_token', newToken).catch(e => console.warn('Redis save failed:', e.message));
    }
    return res.status(200).json({ success: true, message: 'Token valid' });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
