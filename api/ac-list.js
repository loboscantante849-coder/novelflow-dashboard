/**
 * GET /api/ac-list
 * 查询AC视频任务列表
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ac-token, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Use KV first → env var → header
  let token = null;
  try { const kv = require('@vercel/kv'); token = await kv.get('ac_token'); } catch(e) {}
  if (!token) token = process.env.AC_TOKEN || req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', ''));
  if (!token) return res.status(401).json({ error: 'AC Token not configured. Set via /api/ac-kv' });

  const ps = req.query.pageSize || '10';
  const pi = req.query.pageIndex || '1';

  try {
    const r = await fetch(AC_BASE + `/creative/paged-list?PageSize=${ps}&PageIndex=${pi}`, {
      headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    // Auto-rotate: save new token to KV for next request
    if (newToken) {
      try { const kv = require('@vercel/kv'); await kv.set('ac_token', newToken); console.log('AC token rotated in KV'); } catch(e) { console.warn('KV save failed:', e.message); }
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('x-ac-token', newToken || '');
    return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data, newToken: newToken || undefined });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
