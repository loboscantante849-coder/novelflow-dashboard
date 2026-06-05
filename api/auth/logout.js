/**
 * Logout Endpoint
 * 
 * GET /api/auth/logout
 * 
 * Clears all auth cookies (access + refresh + user info).
 */

const { clearAuthCookies } = require('../_lib/auth');
const { setCORSHeaders } = require('../_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  clearAuthCookies(res);
  return res.redirect('/app-v2');
};
