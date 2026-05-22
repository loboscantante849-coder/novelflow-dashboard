/**
 * GET /api/ac-health
 * AC代理健康检查 - 纯GET，无需token，验证路由是否通
 */
const { setCORSHeaders } = require('../_lib/cors');

module.exports = (req, res) => {
  setCORSHeaders(req, res);
  // CORS handled by setCORSHeaders;
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    status: 'ok',
    service: 'ac-video-proxy',
    endpoints: [
      'POST /api/ac-refresh',
      'POST /api/ac-create',
      'GET  /api/ac-list',
      'GET  /api/ac-result',
      'POST /api/ac-interrupt',
      'POST /api/ac-retry'
    ],
    timestamp: new Date().toISOString()
  });
};
