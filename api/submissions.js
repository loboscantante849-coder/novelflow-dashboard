/**
 * GET /api/submissions
 * Returns submission list - requires admin key for full data
 * Without auth: returns only public-safe fields (book names + links, no internal IDs)
 */

const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const path = 'submissions.json';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  try {
    const response = await fetch(apiBase + '?ref=main', {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'NovelFlow-API'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        const masterResponse = await fetch(apiBase + '?ref=master', {
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'NovelFlow-API'
          }
        });
        
        if (!masterResponse.ok) return res.status(200).json([]);
        
        const data = await masterResponse.json();
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const submissions = JSON.parse(content);
        return res.status(200).json(Array.isArray(submissions) ? submissions : []);
      }
      
      return res.status(response.status).json({ error: 'Failed to fetch data' });
    }

    const data = await response.json();
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const submissions = JSON.parse(content);
    
    // Check if request has admin key - if so, return full data
    const adminKey = process.env.ADMIN_KEY;
    const providedKey = req.headers['x-admin-key'] || req.query.adminKey;
    const isAdmin = adminKey && providedKey === adminKey;

    if (isAdmin) {
      return res.status(200).json(Array.isArray(submissions) ? submissions : []);
    }

    // Public: return only safe fields
    const safe = (Array.isArray(submissions) ? submissions : []).map(s => ({
      bookName: s.bookName,
      matchedBookName: s.matchedBookName,
      status: s.status,
      submittedAt: s.submittedAt,
      link: s.link,
      lang: s.lang
    }));
    return res.status(200).json(safe);

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
