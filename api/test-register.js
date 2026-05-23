/**
 * GET /api/test-register - Test the register function directly
 */
const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const results = {
    step1_secret_check: null,
    step2_jwt_generation: null,
    step3_cookie_setting: null,
    errors: [],
  };

  // Step 1: Check JWT_SECRET
  const CLIENT_SECRET = process.env.JWT_SECRET || 'nf-default-secret-2026-change-me-in-prod';
  results.step1_secret_check = {
    has_env_var: !!process.env.JWT_SECRET,
    using_fallback: !process.env.JWT_SECRET,
    secret_length: CLIENT_SECRET.length,
  };

  // Step 2: Try generating a JWT
  try {
    const crypto = require('crypto');
    const payload = { type: 'local', username: 'test_user', iat: Math.floor(Date.now() / 1000) };
    const header = { alg: 'HS256', typ: 'JWT' };
    const encH = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encP = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', CLIENT_SECRET).update(`${encH}.${encP}`).digest('base64url');
    const token = `${encH}.${encP}.${sig}`;
    results.step2_jwt_generation = { success: true, token_length: token.length };
    
    // Step 3: Try setting a cookie
    results.step3_cookie_setting = { can_set: true };
    
    // Actually do a full register test
    res.setHeader('Set-Cookie', [
      `nf_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      `nf_user=${encodeURIComponent(JSON.stringify({ username: 'test_user' }))}; Path=/; Max-Age=2592000`
    ]);
    
  } catch(e) {
    results.step2_jwt_generation = { success: false, error: e.message };
    results.errors.push('JWT generation failed: ' + e.message);
  }

  res.status(200).json({ 
    message: 'Register function test complete',
    results,
    version: '2026-05-23-v3'
  });
};
