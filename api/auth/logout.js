/**
 * Logout Endpoint
 * 
 * POST /api/auth/logout
 * 
 * Clears all auth cookies (access + refresh + user info).
 */

const { clearAuthCookies } = require('../_lib/auth');
const { handlePreflight } = require('../_lib/cors');

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { methods: 'POST, OPTIONS', credentials: true })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  clearAuthCookies(res);
  return res.status(204).end();
};
