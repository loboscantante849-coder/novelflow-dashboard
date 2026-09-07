'use strict';
const { taskAction } = require('./_lib/ac-proxy');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try { return await taskAction(req, res, 'retry'); } catch (error) {
    const status = Number(error?.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 502;
    return res.status(status).json({ error: String(error?.message || 'Video service unavailable').slice(0, 500), code: error?.code || 'AC_PROXY_ERROR' });
  }
};
