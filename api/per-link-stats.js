/**
 * GET /api/per-link-stats?username=xxx
 * Three data sources:
 * 1. Legacy links (old KOC links created manually in bookstore, in campaigns but not in submissions.json)
 * 2. V1 submission system (self-service links, in submissions.json with linkId)
 * 3. App-v2 aggregation site (new links, also in submissions.json)
 *
 * Two-phase query:
 * Phase 1: Query putreport by user's linkIds (from submissions.json) — covers sources 2 & 3
 * Phase 2: Query by dedicated campaign (fallback for legacy links) — covers source 1
 * Merge & deduplicate by adid
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getBookstoreToken } = require('./_lib/oidc-token');

const PUTREPORT_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport';

// Campaign → username mapping for fallback queries
// Only dedicated KOC campaigns (one user, one campaign, all links belong to that user)
// Shared channels like xujt/zhangth/jiangjx/zhangshang contain links from MANY users — MUST NOT map here
const CAMPAIGN_USER_MAP = {
  '69f42260362028a0ac10b770': 'Cons Espher',
  '69f94be3e71c030eb9032000': 'DRAS',
};

// Known legacy links with bookName metadata (created manually before submission system)
const KNOWN_LEGACY_LINKS = {
  // Cons Espher legacy links (campaign 69f42260362028a0ac10b770)
  '69f42401e255ff29f2ff1708': { bookName: 'Legacy - Cons Espher Link 1' },
  '69f4242e362028a0ac10b773': { bookName: 'Legacy - Cons Espher Link 2' },
  '69f42482e255ff29f2ff170a': { bookName: 'Legacy - Cons Espher Link 3' },
  '69f42364e255ff29f2ff1707': { bookName: 'Legacy - Cons Espher Link 4' },
  '69f422db1e1476c5e25b1650': { bookName: 'Legacy - Cons Espher Link 5' },
  // DRAS legacy links (campaign 69f94be3e71c030eb9032000)
  '69f95cea362028a0ac10b7b2': { bookName: 'Legacy - DRAS Link 1' },
  '69f95c9c362028a0ac10b7ae': { bookName: 'Legacy - DRAS Link 2' },
  '69f963191e1476c5e25b16a3': { bookName: 'Legacy - DRAS Link 3' },
};

// Reverse map: username (lowercase) → campaign IDs
const USER_CAMPAIGNS = {};
for (const [cid, uname] of Object.entries(CAMPAIGN_USER_MAP)) {
  const key = uname.toLowerCase();
  if (!USER_CAMPAIGNS[key]) USER_CAMPAIGNS[key] = [];
  USER_CAMPAIGNS[key].push(cid);
}

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
    // Step 1: Get user's completed submissions
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
    // Use 365 days to cover all historical data including legacy links
    const dateFrom = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const BATCH_SIZE = 50;
    let allRows = [];
    const phase1Adids = new Set(); // Track adids from Phase 1 for dedup

    // Phase 1: Query by user's linkIds (covers v1 submission system + app-v2)
    if (userSubs.length > 0) {
      const linkIds = userSubs.map(s => s.linkId);
      linkIds.forEach(id => phase1Adids.add(id));
      
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

    // Phase 2: Campaign fallback - query by campaignid with adid grouping (legacy links)
    // This covers old links that are in the campaign but NOT in submissions.json
    const userCampaigns = USER_CAMPAIGNS[username.toLowerCase()] || [];
    for (const campaignId of userCampaigns) {
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
            campaignid: [campaignId], adsetid: [], adid: [], copywritingid: []
          },
          groupings: ['adid', 'date']
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.data) {
          // Dedup: only add rows whose adid was NOT already covered in Phase 1
          const dedupedRows = data.data.filter(row => !phase1Adids.has(row.adid));
          allRows = allRows.concat(dedupedRows);
        }
      }
    }

    // Step 3: Structure the response - aggregate by adid
    const linkMap = {};
    for (const row of allRows) {
      const adid = row.adid || '';
      const date = row.date || row.dt || '';
      const visits = parseInt(row.h5landingpageclicknum || row.clicknum || row.visits || 0);
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
    const seenAdids = new Set();
    const links = [];

    // First: user's app/v1 submissions (have full metadata)
    for (const sub of userSubs) {
      const ls = linkMap[sub.linkId] || { total_visits: 0, total_unique: 0, total_new: 0, total_income: 0, daily: {} };
      seenAdids.add(sub.linkId);
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
        daily: ls.daily
      });
    }

    // Then: campaign legacy adids not in submissions (old links)
    for (const [adid, ls] of Object.entries(linkMap)) {
      if (seenAdids.has(adid)) continue;
      // Only include if there's actual data
      if (ls.total_unique > 0 || ls.total_income > 0 || ls.total_visits > 0) {
        const legacyMeta = KNOWN_LEGACY_LINKS[adid] || {};
        links.push({
          bookName: legacyMeta.bookName || 'Legacy Link',
          bookId: legacyMeta.bookId || null,
          code: legacyMeta.code || null,
          link: legacyMeta.link || null,
          linkId: adid,
          submittedAt: null,
          visits: ls.total_visits,
          unique_users: ls.total_unique,
          new_users: ls.total_new,
          d14_income: Math.round(ls.total_income * 100) / 100,
          daily: ls.daily,
          isLegacy: true
        });
      }
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
