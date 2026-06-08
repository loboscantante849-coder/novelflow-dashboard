/**
 * POST /api/claim-links
 * 
 * Auto-migration: When a KOC user logs in on the new site, their localStorage 
 * has myBooks with codes that may be stored as "Anonymous" in submissions.json.
 * This endpoint reassigns those codes to the correct user.
 * 
 * Body: { username: string, codes: string[] }
 * Auth: JWT token matching username
 */
const { setCORSHeaders } = require('./_lib/cors');
const { verifyJWT } = require('./_lib/jwt');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify auth
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/nf_token=([^;]+)/);
  const authHeader = req.headers.authorization;
  let username = null;
  
  if (cookieMatch) {
    const payload = verifyJWT(cookieMatch[1]);
    if (payload?.username) username = payload.username;
  }
  if (!username && authHeader?.startsWith('Bearer ')) {
    const payload = verifyJWT(authHeader.slice(7));
    if (payload?.username) username = payload.username;
  }
  
  if (!username) return res.status(401).json({ error: 'Not authenticated' });

  const { codes } = req.body || {};
  if (!codes || !Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: 'codes array required' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/submissions.json`;
  const ghHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'NovelFlow-API'
  };

  try {
    // Fetch current submissions
    const getResp = await fetch(apiBase, { headers: ghHeaders });
    if (!getResp.ok) return res.status(500).json({ error: 'Failed to fetch submissions' });
    const fileData = await getResp.json();
    const sha = fileData.sha;
    const submissions = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

    // Reassign Anonymous entries matching the provided codes
    let changed = 0;
    const claimed = [];
    for (const s of submissions) {
      if (s.discordUsername === 'Anonymous' && codes.includes(String(s.code))) {
        s.discordUsername = username;
        changed++;
        claimed.push(s.code);
      }
    }

    if (changed === 0) {
      return res.status(200).json({ success: true, changed: 0, message: 'No Anonymous entries to claim' });
    }

    // Push updated file
    const newContent = Buffer.from(JSON.stringify(submissions, null, 2)).toString('base64');
    const updateResp = await fetch(apiBase, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify({
        message: `claim-links: ${username} claimed ${changed} Anonymous entries (${claimed.join(',')})`,
        content: newContent,
        sha
      })
    });

    if (!updateResp.ok) {
      return res.status(500).json({ error: 'Failed to update submissions', details: updateResp.status });
    }

    return res.status(200).json({ success: true, changed, claimed, username });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
