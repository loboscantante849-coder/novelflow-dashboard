const { setCORSHeaders } = require('../_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const username = req.query.username || (req.body && req.body.username);
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  }

  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'NovelFlow-API'
  };

  try {
    // Step 1: Fetch submissions.json
    const submissionsResp = await fetch(`${apiBase}/submissions.json`, { headers });
    if (!submissionsResp.ok) {
      return res.status(500).json({ error: 'Failed to fetch submissions' });
    }
    const submissionsData = await submissionsResp.json();
    const submissions = JSON.parse(Buffer.from(submissionsData.content, 'base64').toString('utf-8'));

    // Step 2: Fetch data.json (per-user aggregated stats)
    let userData = null;
    const dataResp = await fetch(`${apiBase}/data.json`, { headers });
    if (dataResp.ok) {
      const dataContent = await dataResp.json();
      const allData = JSON.parse(Buffer.from(dataContent.content, 'base64').toString('utf-8'));
      const users = allData.users || {};
      // Match by username (case-insensitive)
      // Strategy: find all matches, prefer direct key match, then prefer richer data
      const allMatches = Object.entries(users).filter(([k, v]) => 
        k.toLowerCase() === username.toLowerCase() || 
        (v.name && v.name.toLowerCase() === username.toLowerCase())
      );
      if (allMatches.length > 0) {
        // Prefer direct key match, then prefer entry with daily breakdown, then highest income
        allMatches.sort((a, b) => {
          const aDirectKey = a[0].toLowerCase() === username.toLowerCase() ? 1 : 0;
          const bDirectKey = b[0].toLowerCase() === username.toLowerCase() ? 1 : 0;
          if (aDirectKey !== bDirectKey) return bDirectKey - aDirectKey;
          const aHasDaily = a[1].d14income_daily ? 1 : 0;
          const bHasDaily = b[1].d14income_daily ? 1 : 0;
          if (aHasDaily !== bHasDaily) return bHasDaily - aHasDaily;
          return (b[1].d14income || 0) - (a[1].d14income || 0);
        });
        userData = allMatches[0][1];
      }
    }

    // Step 3: Fetch link-stats.json for per-link detail
    let linkStats = {};
    const statsResp = await fetch(`${apiBase}/link-stats.json`, { headers });
    if (statsResp.ok) {
      const statsData = await statsResp.json();
      linkStats = JSON.parse(Buffer.from(statsData.content, 'base64').toString('utf-8'));
    }

    // Step 4: Filter user's completed submissions
    const userSubmissions = submissions.filter(sub =>
      (sub.discordUsername || '').toLowerCase() === username.toLowerCase() && sub.status === 'completed'
    );

    if (userSubmissions.length === 0 && !userData) {
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

    // Step 5: Calculate totals from data.json (primary source)
    const totalVisits = userData?.visits || userData?.link_visits || 0;
    const totalUnique = userData?.unique_users || userData?.link_unique || userData?.unique_visitors || 0;
    const totalNew = userData?.new_users || 0;
    const totalIncome = userData?.d14income || 0;

    // Step 6: Build books list - distribute stats across books
    const numBooks = userSubmissions.length || 1;
    const books = userSubmissions.map((sub, idx) => {
      const linkId = sub.linkId;
      const linkStat = linkId ? (linkStats?.links?.[linkId] || {}) : {};

      // Per-link stats from link-stats.json if available, otherwise distribute evenly
      let bookVisits, bookUnique, bookNew, bookIncome;

      if (linkStat.visits > 0 || linkStat.unique_users > 0) {
        // Has per-link data
        bookVisits = linkStat.visits || 0;
        bookUnique = linkStat.unique_users || 0;
        bookNew = linkStat.new_users || 0;
        bookIncome = linkStat.d14_income || 0;
      } else if (numBooks === 1) {
        // Single book - give all stats
        bookVisits = totalVisits;
        bookUnique = totalUnique;
        bookNew = totalNew;
        bookIncome = totalIncome;
      } else {
        // Multiple books - distribute evenly, last book gets remainder
        bookVisits = Math.floor(totalVisits / numBooks);
        bookUnique = Math.floor(totalUnique / numBooks);
        bookNew = Math.floor(totalNew / numBooks);
        bookIncome = Math.floor(totalIncome / numBooks * 100) / 100;

        // Last book gets the remainder
        if (idx === userSubmissions.length - 1) {
          bookVisits = totalVisits - bookVisits * (numBooks - 1);
          bookUnique = totalUnique - bookUnique * (numBooks - 1);
          bookNew = totalNew - bookNew * (numBooks - 1);
          bookIncome = Math.round((totalIncome - bookIncome * (numBooks - 1)) * 100) / 100;
        }
      }

      return {
        bookName: sub.matchedBookName || sub.bookName,
        code: sub.code || 'N/A',
        link: sub.link || null,
        bookId: sub.bookId || null,
        submittedAt: sub.submittedAt,
        visits: bookVisits,
        unique_users: bookUnique,
        new_users: bookNew,
        d14_income: Math.max(0, bookIncome)
      };
    });

    // Include daily breakdown for charts
    const visits_daily = userData?.link_visits_daily || {};
    const unique_daily = userData?.link_unique_daily || {};
    const new_users_daily = userData?.new_users_daily || {};
    const income_daily = userData?.d14income_daily || {};

    return res.status(200).json({
      username,
      total_visits: totalVisits,
      total_unique: totalUnique,
      total_new: totalNew,
      total_income: Math.round(totalIncome * 100) / 100,
      last_updated: userData?.last_updated || null,
      visits_daily,
      unique_daily,
      new_users_daily,
      income_daily,
      books
    });

  } catch (error) {
    console.error('my-stats error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
};
