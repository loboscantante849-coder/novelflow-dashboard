/**
 * GET /api/ac/video/list?pageSize=10&pageIndex=1
 * 查询AC视频任务列表
 */
const { proxyRequest, buildResponse, extractToken } = require('../_lib');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Token required (x-ac-token header)' });
  }

  const pageSize = req.query.pageSize || '10';
  const pageIndex = req.query.pageIndex || '1';
  const path = `/creative/paged-list?PageSize=${pageSize}&PageIndex=${pageIndex}`;

  const result = await proxyRequest(path, { method: 'GET' }, token);
  const resp = buildResponse(result.status, result.data, result.newToken);
  res.status(resp.status);
  Object.entries(resp.headers).forEach(([k, v]) => res.setHeader(k, v));
  res.end(resp.body);
};
