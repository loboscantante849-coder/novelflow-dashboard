/**
 * POST /api/ac-refresh
 * 验证/注入AC token
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') {
    // CORS handled by setCORSHeaders;
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.body?.token || req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', ''));
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    const r = await fetch(AC_BASE + '/creative/paged-list?PageSize=5&PageIndex=1', {
      headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    if (r.status !== 200) {
      return res.status(r.status).json({ error: 'Token invalid', detail: data });
    }

    // CORS handled by setCORSHeaders;
    res.setHeader('x-ac-token', newToken || '');
    return res.status(200).json({ success: true, data: { message: 'Token valid' }, newToken: newToken || undefined });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
