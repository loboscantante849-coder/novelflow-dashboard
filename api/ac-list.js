/**
 * GET /api/ac-list
 * 查询AC视频任务列表
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, getRedis } = require('./_lib/security');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ---- AUTH: Any logged-in user can list their own reels ----
  const payload = getAuthPayload(req);
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  const currentUser = payload.username;
  // (isAdminUser removed — regular users need this endpoint to see their own reels)

  // Use KV first → env var → header
  let token = null;
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL) {
      const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      token = await redis.get('ac_token');
    }
  } catch(e) {}
  if (!token) token = process.env.AC_TOKEN || req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', ''));
  if (!token) return res.status(401).json({ error: 'AC Token not configured. Set via /api/ac-kv' });

  const ps = Math.max(5, parseInt(req.query.pageSize) || 10).toString();
  const pi = req.query.pageIndex || '1';

  try {
    const r = await fetch(AC_BASE + `/creative/paged-list?PageSize=${ps}&PageIndex=${pi}`, {
      headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    // Auto-rotate: save new token to KV for next request
    if (newToken) {
      try {
      const { Redis } = require('@upstash/redis');
      if (process.env.KV_REST_API_URL) {
        const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
        await redis.set('ac_token', newToken);
        console.log('AC token rotated in Upstash');
      }
    } catch(e) { console.warn('Redis save failed:', e.message); }
    }

    // CORS handled by setCORSHeaders;
    res.setHeader('x-ac-token', newToken || '');

    // Server-side filter: only return items belonging to the current user.
    // Match by remark prefix ("nf_{username}_") so we never leak other users' reels.
    // Admins see everything.
    if (r.status >= 200 && r.status < 300 && data) {
      try {
        let isAdm = false;
        try {
          const { isAdminUser } = require('./_lib/security');
          const { Redis } = require('@upstash/redis');
          const r2 = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
          isAdm = await isAdminUser(r2, currentUser);
        } catch(e) { isAdm = false; }

        if (!isAdm) {
          const prefix = 'nf_' + currentUser + '_';
          // AC API returns items directly on `data` (top-level paged-list shape): {pageIndex,pageSize,total,pageCount,items:[...]}
          // We also handle nested shapes defensively.
          const bucket = Array.isArray(data?.items) ? data.items
                       : (data?.data && Array.isArray(data.data.items)) ? data.data.items
                       : (data?.data && Array.isArray(data.data.data)) ? data.data.data
                       : Array.isArray(data?.data) ? data.data
                       : Array.isArray(data) ? data : [];
          const filtered = bucket.filter(it => it && it.remark && String(it.remark).startsWith(prefix));
          // Write back preserving shape
          if (Array.isArray(data?.items)) { data.items = filtered; data.total = filtered.length; }
          else if (data?.data && Array.isArray(data.data.items)) { data.data.items = filtered; data.data.total = filtered.length; }
          else if (data?.data && Array.isArray(data.data.data)) { data.data.data = filtered; data.data.total = filtered.length; }
          else if (Array.isArray(data?.data)) { data.data = filtered; }
          else if (Array.isArray(data)) { /* in-place */ }
        }
      } catch (e) {
        console.warn('[ac-list] server-side filter failed:', e.message);
      }
    }

    return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data, newToken: newToken || undefined });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
