/**
 * GET /api/diag - Diagnostic endpoint
 */
const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const diag = {
    timestamp: new Date().toISOString(),
    deploy_check: '2026-05-23-v2',  // version marker
    env: {
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      NOVELSPA_TOKEN: !!process.env.NOVELSPA_TOKEN,
      NOVELSPA_TOKEN_LENGTH: process.env.NOVELSPA_TOKEN?.length || 0,
      AC_TOKEN: !!process.env.AC_TOKEN,
      ADMIN_KEY: !!process.env.ADMIN_KEY,
      JWT_SECRET: !!process.env.JWT_SECRET,
      JWT_SECRET_SOURCE: process.env.JWT_SECRET ? 'env_var' : 'fallback',
      KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    },
    token_check: {},
    api_tests: {},
  };

  // Decode JWT
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

  // Test register function
  try {
    const crypto = require('crypto');
    const secret = process.env.JWT_SECRET || 'nf-default-secret-2026-change-me-in-prod';
    const testPayload = { type: 'test', iat: Math.floor(Date.now() / 1000) };
    const header = { alg: 'HS256', typ: 'JWT' };
    const encH = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encP = Buffer.from(JSON.stringify(testPayload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(`${encH}.${encP}`).digest('base64url');
    diag.api_tests.jwt_generation = 'ok';
    diag.api_tests.jwt_token_sample = `${encH}.${encP}.${sig}`.substring(0, 30) + '...';
  } catch(e) {
    diag.api_tests.jwt_generation = 'failed: ' + e.message;
  }

  res.status(200).json(diag);
};
