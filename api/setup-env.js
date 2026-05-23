/**
 * POST /api/setup-env - Set Vercel env vars (one-time setup, admin only)
 */
const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin key required' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
  const PROJECT_ID = 'prj_jqVG4SiqA2FNAzvLdJCcGa0hFAdI';

  if (!VERCEL_TOKEN) {
    return res.status(500).json({ 
      error: 'VERCEL_TOKEN not set. Create a token at https://vercel.com/account/tokens, add as VERCEL_TOKEN env var, then retry.' 
    });
  }

  try {
    const envVars = req.body;
    if (!envVars || typeof envVars !== 'object') {
      return res.status(400).json({ error: 'Send JSON object with env var names as keys' });
    }

    const results = [];
    const baseUrl = `https://api.vercel.com/v10/projects/${PROJECT_ID}/env`;

    for (const [key, value] of Object.entries(envVars)) {
      try {
        const response = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${VERCEL_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            key,
            value: String(value),
            target: ['production', 'preview', 'development'],
            type: 'encrypted',
          }),
        });

        const result = await response.json();
        results.push({ key, status: response.status, ok: response.ok, error: result.error?.message });
      } catch(e) {
        results.push({ key, status: 'error', error: e.message });
      }
    }

    return res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('Setup env error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
