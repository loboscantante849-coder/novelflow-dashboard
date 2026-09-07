'use strict';
const { list } = require('./_lib/ac-proxy');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try { return await list(req, res); } catch (error) {
    const status = Number(error?.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 502;
    return res.status(status).json({ error: String(error?.message || 'Video service unavailable').slice(0, 500), code: error?.code || 'AC_PROXY_ERROR' });
  }
};
