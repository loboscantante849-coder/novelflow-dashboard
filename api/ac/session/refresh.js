/**
 * POST /api/ac/session/refresh
 * 注入/刷新AC token
 * 
 * Body: { "token": "从浏览器Console获取的实时JWT token" }
 * 
 * 验证token有效性：用token调一个轻量API（任务列表PageSize=1）
 */
const { proxyRequest, buildResponse, extractToken } = require('../_lib');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.body?.token || extractToken(req);
  if (!token) {
    return res.status(400).json({ success: false, error: 'Token required in body.token or x-ac-token header' });
  }

  // 验证token：调任务列表API（最轻量）
  const result = await proxyRequest('/creative/paged-list?PageSize=1&PageIndex=1', {
    method: 'GET',
  }, token);

  if (result.status !== 200) {
    return res.status(result.status).json({
      success: false,
      error: 'Token invalid or expired',
      detail: result.data,
    });
  }

  // 返回验证成功 + 新token
  const resp = buildResponse(200, { message: 'Token valid', listPreview: result.data }, result.newToken);
  res.status(resp.status);
  Object.entries(resp.headers).forEach(([k, v]) => res.setHeader(k, v));
  res.end(resp.body);
};
