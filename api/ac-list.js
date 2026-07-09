/**
 * GET /api/ac-list
 * 查询AC视频任务列表（已鉴权）
 * Auto-paginates AC's paged-list to collect all reels belonging to the current user.
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser } = require('./_lib/security');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ---- AUTH ----
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const currentUser = payload.username;

  // ---- TOKEN ----
  let token = null;
  let redis = null;
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      token = await redis.get('ac_token');
    }
  } catch(e) {}
  if (!token) token = process.env.AC_TOKEN;
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  // ---- Check admin ----
  let isAdm = false;
  try {
    if (redis) isAdm = await isAdminUser(redis, currentUser);
  } catch(e) { isAdm = false; }

  const prefix = 'nf_' + currentUser + '_';

  const clientPs = Math.max(5, Math.min(parseInt(req.query.pageSize) || 50, 100));
  const clientPi = Math.max(1, parseInt(req.query.pageIndex) || 1);
  const TARGET_USER_REELS = 50;
  const MAX_PAGES = 30;

  try {
    let allItems = [];
    let newToken = null;
    let acTotal = 0;

    if (isAdm) {
      const ps = clientPs, pi = clientPi;
      const r = await fetch(AC_BASE + `/creative/paged-list?PageSize=${ps}&PageIndex=${pi}`, {
        headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
      });
      newToken = r.headers.get('accesstoken') || null;
      const data = await r.json().catch(() => null);
      if (newToken && redis) {
        redis.set('ac_token', newToken).catch(()=>{});
      }
      return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data });
    }

    for (let pi = 1; pi <= MAX_PAGES; pi++) {
      const ps = 100;
      const r = await fetch(AC_BASE + `/creative/paged-list?PageSize=${ps}&PageIndex=${pi}`, {
        headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
      });
      if (!newToken) newToken = r.headers.get('accesstoken') || null;
      if (r.status < 200 || r.status >= 300) {
        return res.status(r.status).json({ success: false, error: 'AC API error' });
      }
      const data = await r.json().catch(() => null);
      if (!data || !Array.isArray(data.items)) break;
      if (pi === 1) { acTotal = data.total || 0; }

      const matching = data.items.filter(it => it && it.remark && String(it.remark).startsWith(prefix));
      allItems.push(...matching);

      if (allItems.length >= TARGET_USER_REELS) break;
      if (pi >= (data.pageCount || 1)) break;
      if (data.items.length === 0) break;
    }

    if (newToken && redis) {
      redis.set('ac_token', newToken).catch(e => console.warn('Redis token save failed:', e.message));
    }

    const result = {
      pageIndex: clientPi,
      pageSize: allItems.length,
      total: allItems.length,
      pageCount: 1,
      items: allItems
    };

    return res.status(200).json({ success: true, data: result });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
