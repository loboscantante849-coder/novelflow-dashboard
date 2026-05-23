/**
 * GET /api/diag - Diagnostic endpoint (admin only)
 * Requires x-admin-key header matching ADMIN_KEY env var
 */
const { setCORSHeaders } = require('./_lib/cors');
const { verifyJWT } = require('./_lib/jwt');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  // Require admin key for full diagnostics
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;
  
  if (!isAdmin) {
    return res.status(200).json({ 
      status: 'ok', 
      version: '2026-05-23-v4',
      hint: 'Add x-admin-key header or admin_key param for full diagnostics'
    });
  }
  
  const diag = {
    timestamp: new Date().toISOString(),
    deploy_check: '2026-05-23-v4',
    env: {
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      NOVELSPA_TOKEN: !!process.env.NOVELSPA_TOKEN,
      NOVELSPA_TOKEN_LENGTH: process.env.NOVELSPA_TOKEN?.length || 0,
      AC_TOKEN: !!process.env.AC_TOKEN,
      ADMIN_KEY: !!process.env.ADMIN_KEY,
      JWT_SECRET: !!process.env.JWT_SECRET,
      DISCORD_CLIENT_ID: !!process.env.DISCORD_CLIENT_ID,
      DISCORD_CLIENT_SECRET: !!process.env.DISCORD_CLIENT_SECRET,
      KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    },
    token_check: {},
    api_tests: {},
  };

  // Decode novelspa JWT
  const token = process.env.NOVELSPA_TOKEN || '';
  if (token) {
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        diag.token_check.novelspa_exp_date = new Date(payload.exp * 1000).toISOString();
        diag.token_check.novelspa_expired = Date.now() / 1000 > payload.exp;
      }
    } catch(e) {}
  }

  // Test JWT generation
  try {
    const { createJWT } = require('./_lib/jwt');
    const testToken = createJWT({ type: 'test', iat: Math.floor(Date.now() / 1000) });
    diag.api_tests.jwt_generation = 'ok';
    diag.api_tests.jwt_verify = verifyJWT(testToken) ? 'ok' : 'failed';
  } catch(e) {
    diag.api_tests.jwt_generation = 'failed: ' + e.message;
  }

  res.status(200).json(diag);
};
