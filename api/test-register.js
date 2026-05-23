/**
 * GET /api/test-register - Diagnostic (admin only)
 * Requires x-admin-key header matching ADMIN_KEY env var
 */
const { setCORSHeaders } = require('./_lib/cors');
const { createJWT } = require('./_lib/jwt');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  // Require admin key
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin key required' });
  }

  const results = {
    step1_secret_check: null,
    step2_jwt_generation: null,
    errors: [],
  };

  try {
    const payload = { type: 'local', username: 'diag_test', novelFlowId: 'NF_DIAG', iat: Math.floor(Date.now() / 1000) };
    const token = createJWT(payload);
    results.step1_secret_check = { using_env: !!process.env.JWT_SECRET };
    results.step2_jwt_generation = { success: true, token_length: token.length };
  } catch(e) {
    results.step2_jwt_generation = { success: false, error: e.message };
    results.errors.push('JWT generation failed: ' + e.message);
  }

  res.status(200).json({ 
    message: 'Register function test complete',
    results,
    version: '2026-05-23-v4'
  });
};
