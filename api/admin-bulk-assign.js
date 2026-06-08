/**
 * POST /api/admin-bulk-assign — Bulk assign Anonymous entries to users
 * Body: { assignments: [{ username: "xxx", codes: ["1234","5678"] }] }
 * Admin only (xujt or admin)
 */
const { setCORSHeaders } = require('./_lib/cors');
const { verifyJWT } = require('./_lib/jwt');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/nf_token=([^;]+)/);
  const authHeader = req.headers.authorization;
  let username = null;
  if (cookieMatch) { const p = verifyJWT(cookieMatch[1]); if (p?.username) username = p.username; }
  if (!username && authHeader?.startsWith('Bearer ')) { const p = verifyJWT(authHeader.slice(7)); if (p?.username) username = p.username; }
  if (!username || !['admin', 'xujt'].includes(username.toLowerCase())) {
    return res.status(403).json({ error: 'Admin only' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { assignments } = req.body;
  if (!assignments || !Array.isArray(assignments)) {
    return res.status(400).json({ error: 'Missing assignments array' });
  }

  try {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) return res.status(503).json({ error: 'GITHUB_TOKEN not configured' });

    // Get current submissions.json from GitHub
    const getResp = await fetch(`https://api.github.com/repos/loboscantante849-coder/novelflow-dashboard/contents/submissions.json`, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    const fileData = await getResp.json();
    const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
    const submissions = JSON.parse(content);

    let totalAssigned = 0;
    const results = [];

    for (const { username: targetUser, codes } of assignments) {
      let assigned = 0;
      for (const code of codes) {
        const entry = submissions.find(s => s.code === String(code) && s.discordUsername === 'Anonymous');
        if (entry) {
          entry.discordUsername = targetUser;
          assigned++;
          totalAssigned++;
        }
      }
      results.push({ username: targetUser, assigned, total: codes.length });
    }

    if (totalAssigned === 0) {
      return res.status(200).json({ success: true, assigned: 0, message: 'No new assignments needed', results });
    }

    // Push updated submissions.json to GitHub
    const newContent = JSON.stringify(submissions, indent=2).replace(/"indent=2"/g, '');
    const newContentStr = JSON.stringify(submissions, null, 2);
    
    const pushResp = await fetch(`https://api.github.com/repos/loboscantante849-coder/novelflow-dashboard/contents/submissions.json`, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `data: bulk assign ${totalAssigned} Anonymous entries`,
        content: Buffer.from(newContentStr, 'utf-8').toString('base64'),
        sha: fileData.sha
      })
    });

    if (!pushResp.ok) {
      const errData = await pushResp.json();
      return res.status(500).json({ error: 'GitHub push failed', details: errData });
    }

    return res.status(200).json({ success: true, assigned: totalAssigned, results });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
