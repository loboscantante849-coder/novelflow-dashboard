/**
 * GET /api/ac-result?threadId=xxx
 * 查询AC视频任务结果（已鉴权 + threadId ownership校验）
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser } = require('./_lib/security');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const username = payload.username;

  let redis = null;
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    }
  } catch(e) {}

  let token = null;
  try { if (redis) token = await redis.get('ac_token'); } catch(e) {}
  if (!token) token = process.env.AC_TOKEN;
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  const tid = req.query.threadId;
  if (!tid) return res.status(400).json({ error: 'threadId required' });

  // Ownership check
  if (redis) {
    try {
      const isAdm = await isAdminUser(redis, username);
      if (!isAdm) {
        const owner = await redis.get('ac_thread_owner:' + tid);
        if (owner && owner !== username) {
          return res.status(403).json({ error: 'Not authorized to view this task' });
        }
      }
    } catch(e) { /* fail closed */ }
  }

  try {
    const r = await fetch(AC_BASE + `/creative/${tid}/result`, {
      headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    if (newToken && redis) {
      redis.set('ac_token', newToken).catch(e => console.warn('Redis save failed:', e.message));
    }

    return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
