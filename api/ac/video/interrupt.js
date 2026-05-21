/**
 * POST /api/ac/video/interrupt
 * 中断AC视频任务
 * 
 * Body: { "threadId": "xxx" }
 * 或 Query: ?threadId=xxx
 */
const { proxyRequest, buildResponse, extractToken } = require('../_lib');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Token required' });
  }

  const threadId = req.body?.threadId || req.query?.threadId;
  if (!threadId) {
    return res.status(400).json({ success: false, error: 'threadId required' });
  }

  const path = `/creative/${threadId}/interrupt`;
  const result = await proxyRequest(path, { method: 'POST' }, token);
  const resp = buildResponse(result.status, result.data, result.newToken);
  res.status(resp.status);
  Object.entries(resp.headers).forEach(([k, v]) => res.setHeader(k, v));
  res.end(resp.body);
};
