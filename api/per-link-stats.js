/**
 * GET /api/per-link-stats?username=xxx
 * Single-phase query: all links (legacy + v1 + app-v2) are in submissions.json
 * Query putreport by user's linkIds, aggregate and return
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getBookstoreToken } = require('./_lib/oidc-token');

const PUTREPORT_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport';

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const username = req.query.username;
  if (!username) return res.status(400).json({ error: 'username is required' });

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const ghHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'NovelFlow-API'
  };

  try {
    // Step 1: Get user's completed submissions (includes legacy links)
    const subResp = await fetch(`${apiBase}/submissions.json`, { headers: ghHeaders });
    if (!subResp.ok) return res.status(500).json({ error: 'Failed to fetch submissions' });
    const subData = await subResp.json();
    const submissions = JSON.parse(Buffer.from(subData.content, 'base64').toString('utf-8'));

    const userSubs = submissions.filter(s =>
      (s.discordUsername || '').toLowerCase() === username.toLowerCase() &&
      s.status === 'completed' &&
      s.linkId
    );

    // Step 2: Get putreport token
    const token = await getBookstoreToken();
    if (!token) return res.status(500).json({ error: 'Failed to get API token' });

    const now = new Date();
    const dateTo = now.toISOString().split('T')[0];
    // 365 days to cover all historical data including legacy links
    const dateFrom = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const BATCH_SIZE = 50;
    let allRows = [];

    // Query putreport by user's linkIds
    if (userSubs.length > 0) {
      const linkIds = userSubs.map(s => s.linkId);

      for (let i = 0; i < linkIds.length; i += BATCH_SIZE) {
        const batch = linkIds.slice(i, i + BATCH_SIZE);
        const resp = await fetch(PUTREPORT_API, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-OS': 'web', 'X-AppName': 'web-admin',
            'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1',
            'Content-Type': 'application/json;charset=UTF-8',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            filters: {
              productline: ['NovelFlow'], mediasource: [], mediasource2: ['SocialMedia'],
              date: { from: dateFrom, to: dateTo, datesLabel: '' },
              campaignid: [], adsetid: [], adid: batch, copywritingid: []
            },
            groupings: ['adid', 'date']
          })
        });
        if (resp.status === 401) return res.status(500).json({ error: 'API token expired' });
        const data = await resp.json();
        if (data.data) allRows = allRows.concat(data.data);
      }
    }

    // Step 3: Aggregate by adid — use correct putreport field names
    const linkMap = {};
    for (const row of allRows) {
      const adid = row.adid || '';
      const date = row.date || row.dt || '';
      // FIX: use h5landingpageclicks (correct field) not h5landingpageclicknum
      const visits = parseInt(row.h5landingpageclicks || row.h5landingpageclicknum || row.clicknum || row.visits || 0);
      const unique = parseInt(row.h5landingpageclickusernum || row.clickusernum || row.unique_users || 0);
      const newUsers = parseInt(row.newusernum || row.new_users || 0);
      const income = parseFloat(row.d14income || row.income || 0);

      if (!linkMap[adid]) {
        linkMap[adid] = { linkId: adid, total_visits: 0, total_unique: 0, total_new: 0, total_income: 0, daily: {} };
      }
      const lm = linkMap[adid];
      lm.total_visits += visits;
      lm.total_unique += unique;
      lm.total_new += newUsers;
      lm.total_income += income;
      if (date) {
        lm.daily[date] = { visits, unique_users: unique, new_users: newUsers, income };
      }
    }

    // Step 4: Build links array - merge submission metadata with putreport data
    // FIX: Also try matching by shortUrl extracted from link field for Anonymous data recovery
    const links = [];
    for (const sub of userSubs) {
      let ls = linkMap[sub.linkId] || null;
      
      // If no data found by linkId, try matching by shortUrl from the link field
      if (!ls && sub.link) {
        // Extract shortUrl from link: "https://social.novelplatform.vip/XXXXX" → "XXXXX"
        const shortUrlMatch = sub.link.match(/\/([^\/]+)\/?$/);
        if (shortUrlMatch) {
          const shortUrl = shortUrlMatch[1];
          // Exact match by shortUrl
          ls = linkMap[shortUrl] || null;
        }
      }
      
      if (!ls) {
        ls = { total_visits: 0, total_unique: 0, total_new: 0, total_income: 0, daily: {} };
      }
      
      links.push({
        bookName: sub.matchedBookName || sub.bookName,
        bookId: sub.bookId,
        code: sub.code,
        link: sub.link,
        linkId: sub.linkId,
        submittedAt: sub.submittedAt,
        visits: ls.total_visits,
        unique_users: ls.total_unique,
        new_users: ls.total_new,
        d14_income: Math.round(ls.total_income * 100) / 100,
        daily: ls.daily,
        isLegacy: sub.isLegacy || false
      });
    }

    if (links.length === 0) {
      return res.status(200).json({
        username,
        total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
        daily: {}, links: [],
        message: 'No completed submissions with linkIds'
      });
    }

    // Summary
    const totalVisits = links.reduce((s, l) => s + l.visits, 0);
    const totalUnique = links.reduce((s, l) => s + l.unique_users, 0);
    const totalNew = links.reduce((s, l) => s + l.new_users, 0);
    const totalIncome = links.reduce((s, l) => s + l.d14_income, 0);

    // Aggregate daily across all links
    const dailyAgg = {};
    for (const l of links) {
      for (const [date, val] of Object.entries(l.daily)) {
        if (!dailyAgg[date]) dailyAgg[date] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
        dailyAgg[date].visits += val.visits;
        dailyAgg[date].unique_users += val.unique_users;
        dailyAgg[date].new_users += val.new_users;
        dailyAgg[date].income += val.income;
      }
    }

    return res.status(200).json({
      username,
      total_visits: totalVisits,
      total_unique: totalUnique,
      total_new: totalNew,
      total_income: Math.round(totalIncome * 100) / 100,
      daily: dailyAgg,
      links
    });

  } catch (error) {
    console.error('per-link-stats error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
};
