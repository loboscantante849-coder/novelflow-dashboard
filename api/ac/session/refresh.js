/**
 * POST /api/ac/session/refresh
 * 验证/注入AC token
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

async function proxyGet(path, token) {
  const res = await fetch(AC_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
  });
  const newToken = res.headers.get('accesstoken') || null;
  const data = await res.json().catch(() => null);
  return { status: res.status, data, newToken };
}

function getToken(req) {
  return req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', '')) ||
    (req.body && req.body.token) || null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ac-token, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.body?.token || getToken(req);
  if (!token) return res.status(400).json({ error: 'Token required' });

  const r = await proxyGet('/creative/paged-list?PageSize=1&PageIndex=1', token);
  if (r.status !== 200) return res.status(r.status).json({ error: 'Token invalid', detail: r.data });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('x-ac-token', r.newToken || '');
  res.status(200).json({ success: true, data: { message: 'Token valid' }, newToken: r.newToken || undefined });
}
