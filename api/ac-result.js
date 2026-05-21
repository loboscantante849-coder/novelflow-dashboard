/**
 * GET /api/ac-result?threadId=xxx
 * 查询AC视频任务结果
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

  const token = req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', ''));
  if (!token) return res.status(401).json({ error: 'Token required' });

  const tid = req.query.threadId;
  if (!tid) return res.status(400).json({ error: 'threadId required' });

  try {
    const r = await fetch(AC_BASE + `/creative/${tid}/result`, {
      headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('x-ac-token', newToken || '');
    return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data, newToken: newToken || undefined });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
