/**
 * POST /api/ac-interrupt
 * 中断AC视频任务
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

  const token = req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', '')) ||
    (req.body && req.body.token);
  if (!token) return res.status(401).json({ error: 'Token required' });

  const tid = req.body?.threadId || req.query?.threadId;
  if (!tid) return res.status(400).json({ error: 'threadId required' });

  try {
    const r = await fetch(AC_BASE + `/creative/${tid}/interrupt`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006', 'Content-Type': 'application/json' }
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    // CORS handled by setCORSHeaders;
    res.setHeader('x-ac-token', newToken || '');
    return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data, newToken: newToken || undefined });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
