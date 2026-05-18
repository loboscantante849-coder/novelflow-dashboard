module.exports = async (req, res) => {
  // Support both GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get username from query params or body
  const username = req.query.username || (req.body && req.body.username);
  
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const submissionsPath = 'submissions.json';
  const linkStatsPath = 'link-stats.json';
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  }

  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`;

  try {
    // Step 1: Fetch submissions.json
    const submissionsResp = await fetch(`${apiBase}/${submissionsPath}`, {
      headers: { 
        'Authorization': `token ${GITHUB_TOKEN}`, 
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'NovelFlow-API'
      }
    });

    if (!submissionsResp.ok) {
      console.error('Failed to fetch submissions:', submissionsResp.status);
      return res.status(500).json({ error: 'Failed to fetch submissions' });
    }

    const submissionsData = await submissionsResp.json();
    const submissions = JSON.parse(Buffer.from(submissionsData.content, 'base64').toString('utf-8'));

    // Step 2: Fetch link-stats.json (if exists)
    let linkStats = {};
    const statsResp = await fetch(`${apiBase}/${linkStatsPath}`, {
      headers: { 
        'Authorization': `token ${GITHUB_TOKEN}`, 
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'NovelFlow-API'
      }
    });

    if (statsResp.ok) {
      const statsData = await statsResp.json();
      linkStats = JSON.parse(Buffer.from(statsData.content, 'base64').toString('utf-8'));
    }

    // Step 3: Filter user's completed submissions
    const userSubmissions = submissions.filter(sub => 
      sub.discordUsername === username && sub.status === 'completed'
    );

    if (userSubmissions.length === 0) {
      return res.status(200).json({
        username,
        total_visits: 0,
        total_unique: 0,
        total_new: 0,
        total_income: 0,
        last_updated: null,
        books: [],
        message: 'No submissions found for this user'
      });
    }

    // Step 4: Build response with stats for each book
    const books = userSubmissions.map(sub => {
      const linkId = sub.linkId;
      const stats = linkStats?.links?.[linkId] || {};

      return {
        bookName: sub.matchedBookName || sub.bookName,
        code: sub.code || 'N/A',
        link: sub.link || null,
        linkId: linkId || null,
        bookId: sub.bookId || null,
        submittedAt: sub.submittedAt,
        visits: stats.visits || 0,
        unique_users: stats.unique_users || 0,
        new_users: stats.new_users || 0,
        d14_income: stats.d14_income || 0
      };
    });

    // Step 5: Calculate totals
    const total_visits = books.reduce((sum, b) => sum + (b.visits || 0), 0);
    const total_unique = books.reduce((sum, b) => sum + (b.unique_users || 0), 0);
    const total_new = books.reduce((sum, b) => sum + (b.new_users || 0), 0);
    const total_income = books.reduce((sum, b) => sum + (b.d14_income || 0), 0);

    return res.status(200).json({
      username,
      total_visits,
      total_unique,
      total_new,
      total_income: Math.round(total_income * 100) / 100,
      last_updated: linkStats?.last_updated || null,
      books
    });

  } catch (error) {
    console.error('my-stats error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
};
