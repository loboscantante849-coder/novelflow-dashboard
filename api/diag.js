/**
 * GET /api/diag - Diagnostic endpoint (temporary)
 * Checks env vars and API connectivity
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
    bookstore_api: 'unknown',
    github_api: 'unknown',
  };

  // Test Bookstore API with token
  if (process.env.NOVELSPA_TOKEN) {
    try {
      const r = await fetch('https://admin.novelspa.app/api/v1/novelmanage/book/search?pageSize=1', {
        headers: {
          'Authorization': `Bearer ${process.env.NOVELSPA_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      diag.bookstore_api = r.status;
    } catch(e) {
      diag.bookstore_api = 'error: ' + e.message;
    }
  }

  // Test GitHub API
  if (process.env.GITHUB_TOKEN) {
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'NovelFlow-Diag' }
      });
      diag.github_api = r.status;
    } catch(e) {
      diag.github_api = 'error: ' + e.message;
    }
  }

  res.status(200).json(diag);
};
