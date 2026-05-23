/**
 * GET /api/diag - Diagnostic endpoint
 */
const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const diag = {
    timestamp: new Date().toISOString(),
    env: {
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      NOVELSPA_TOKEN: !!process.env.NOVELSPA_TOKEN,
      NOVELSPA_TOKEN_LENGTH: process.env.NOVELSPA_TOKEN?.length || 0,
      AC_TOKEN: !!process.env.AC_TOKEN,
      ADMIN_KEY: !!process.env.ADMIN_KEY,
      JWT_SECRET: !!process.env.JWT_SECRET,
      KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    },
    token_check: {},
    api_tests: {},
  };

  // Decode JWT to check expiration (NOVELSPA_TOKEN)
  const token = process.env.NOVELSPA_TOKEN || '';
  if (token) {
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        diag.token_check.novelspa_sub = payload.sub;
        diag.token_check.novelspa_name = payload.name;
        diag.token_check.novelspa_exp = payload.exp;
        diag.token_check.novelspa_exp_date = new Date(payload.exp * 1000).toISOString();
        diag.token_check.novelspa_expired = Date.now() / 1000 > payload.exp;
      } else {
        diag.token_check.novelspa_format = 'not JWT (length=' + token.length + ', starts=' + token.substring(0, 20) + ')';
      }
    } catch(e) {
      diag.token_check.novelspa_decode_error = e.message;
    }
  }

  // Test Bookstore API - savebookpromotionkeywords (GET to check auth)
  if (token) {
    try {
      const r = await fetch('https://admin.novelspa.app/api/v1/novelmanage/SocialMediaLinkConfig?pageSize=1', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-OS': 'web', 'X-AppName': 'web-admin', 'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
        }
      });
      diag.api_tests.bookstore_linkconfig = r.status;
      if (r.status !== 200) {
        const text = await r.text().catch(() => '');
        diag.api_tests.bookstore_linkconfig_body = text.substring(0, 200);
      }
    } catch(e) {
      diag.api_tests.bookstore_linkconfig = 'error: ' + e.message;
    }
  }

  // Test GitHub API
  if (process.env.GITHUB_TOKEN) {
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'NovelFlow-Diag' }
      });
      diag.api_tests.github = r.status;
    } catch(e) {
      diag.api_tests.github = 'error: ' + e.message;
    }
  }

  // Test confirm flow - dry run (just check if the function would work)
  diag.confirm_flow = {
    step1_github_token: !!process.env.GITHUB_TOKEN,
    step2_novelspa_token: !!process.env.NOVELSPA_TOKEN,
    would_return_500: !process.env.GITHUB_TOKEN,
  };

  res.status(200).json(diag);
};
