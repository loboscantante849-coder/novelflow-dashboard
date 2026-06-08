/**
 * GET /api/per-link-stats?username=xxx
 * 
 * Data sources (in priority order):
 * 1. putreport API by linkId (real-time, per-link)
 * 2. data.json + link-stats.json (cron pre-aggregated, campaign-level)
 * 
 * Admin users (xujt) see ALL KOC data aggregated.
 * Regular KOC users only see their own data.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getBookstoreToken } = require('./_lib/oidc-token');

const PUTREPORT_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport';

// Admin usernames that can see all KOC data
const ADMIN_USERNAMES = ['xujt', 'admin'];

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
    // Step 1: Fetch submissions.json
    const subResp = await fetch(`${apiBase}/submissions.json`, { headers: ghHeaders });
    if (!subResp.ok) return res.status(500).json({ error: 'Failed to fetch submissions' });
    const subData = await subResp.json();
    const submissions = JSON.parse(Buffer.from(subData.content, 'base64').toString('utf-8'));

    const isAdmin = ADMIN_USERNAMES.includes(username.toLowerCase());
    
    // Admin sees all completed submissions; regular user sees only their own
    const userSubs = isAdmin
      ? submissions.filter(s => s.status === 'completed' && s.linkId)
      : submissions.filter(s =>
          ((s.discordUsername || '').toLowerCase() === username.toLowerCase()) &&
          s.status === 'completed' &&
          s.linkId
        );

    // Step 2: Fetch data.json (pre-aggregated campaign stats from cron)
    let dataJson = { users: {} };
    try {
      const dataResp = await fetch(`${apiBase}/data.json`, { headers: ghHeaders });
      if (dataResp.ok) {
        const dataContent = await dataResp.json();
        dataJson = JSON.parse(Buffer.from(dataContent.content, 'base64').toString('utf-8'));
      }
    } catch (e) {
      console.error('data.json fetch error:', e.message);
    }

    // Step 3: Fetch link-stats.json (per-link aggregated stats from cron)
    let linkStats = { links: {} };
    try {
      const statsResp = await fetch(`${apiBase}/link-stats.json`, { headers: ghHeaders });
      if (statsResp.ok) {
        const statsContent = await statsResp.json();
        linkStats = JSON.parse(Buffer.from(statsContent.content, 'base64').toString('utf-8'));
      }
    } catch (e) {
      console.error('link-stats.json fetch error:', e.message);
    }

    // Step 4: Query putreport API for real-time data
    const token = await getBookstoreToken();
    const now = new Date();
    const dateTo = now.toISOString().split('T')[0];
    const dateFrom = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const BATCH_SIZE = 50;
    let allRows = [];

    if (userSubs.length > 0 && token) {
      const linkIds = userSubs.map(s => s.linkId);

      for (let i = 0; i < linkIds.length; i += BATCH_SIZE) {
        const batch = linkIds.slice(i, i + BATCH_SIZE);
        try {
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
          if (resp.status === 401) {
            console.error('putreport 401 - token expired');
            break;
          }
          const data = await resp.json();
          if (data.data) allRows = allRows.concat(data.data);
        } catch (e) {
          console.error('putreport batch error:', e.message);
        }
      }
    }

    // Step 5: Aggregate putreport data by adid
    const linkMap = {};
    for (const row of allRows) {
      const adid = row.adid || '';
      const date = row.date || row.dt || '';
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

    // Step 6: Build links array - merge data from all sources
    const links = [];
    for (const sub of userSubs) {
      let ls = linkMap[sub.linkId] || null;
      
      // Fallback: try shortUrl matching from putreport
      if (!ls && sub.link) {
        const shortUrlMatch = sub.link.match(/\/([^\/]+)\/?$/);
        if (shortUrlMatch) {
          ls = linkMap[shortUrlMatch[1]] || null;
        }
      }
      
      // Fallback: try link-stats.json (cron pre-aggregated per-link data)
      let cronLinkData = null;
      if (sub.linkId && linkStats.links && linkStats.links[sub.linkId]) {
        cronLinkData = linkStats.links[sub.linkId];
      }

      // Merge: putreport takes priority, then cron link-stats
      const merged = {
        total_visits: ls?.total_visits || cronLinkData?.visits || 0,
        total_unique: ls?.total_unique || cronLinkData?.unique_users || 0,
        total_new: ls?.total_new || cronLinkData?.new_users || 0,
        total_income: ls?.total_income || cronLinkData?.d14_income || 0,
        daily: {}
      };

      // Merge daily: putreport first, then fill gaps from cron
      if (ls?.daily) {
        Object.assign(merged.daily, ls.daily);
      }
      if (cronLinkData && !ls?.daily) {
        // Add cron daily data if no putreport daily
        if (cronLinkData.unique_daily) {
          for (const [d, v] of Object.entries(cronLinkData.unique_daily)) {
            if (!merged.daily[d]) merged.daily[d] = { visits: 0, unique_users: v, new_users: 0, income: 0 };
            else merged.daily[d].unique_users = merged.daily[d].unique_users || v;
          }
        }
        if (cronLinkData.d14_income_daily) {
          for (const [d, v] of Object.entries(cronLinkData.d14_income_daily)) {
            if (!merged.daily[d]) merged.daily[d] = { visits: 0, unique_users: 0, new_users: 0, income: v };
            else merged.daily[d].income = merged.daily[d].income || v;
          }
        }
      }
      
      links.push({
        bookName: sub.matchedBookName || sub.bookName,
        bookId: sub.bookId,
        code: sub.code,
        link: sub.link,
        linkId: sub.linkId,
        submittedAt: sub.submittedAt,
        kocName: sub.discordUsername || '',
        visits: merged.total_visits,
        unique_users: merged.total_unique,
        new_users: merged.total_new,
        d14_income: Math.round(merged.total_income * 100) / 100,
        daily: merged.daily,
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

    // Step 7: Calculate summary
    let totalVisits = links.reduce((s, l) => s + l.visits, 0);
    let totalUnique = links.reduce((s, l) => s + l.unique_users, 0);
    let totalNew = links.reduce((s, l) => s + l.new_users, 0);
    let totalIncome = links.reduce((s, l) => s + l.d14_income, 0);

    // Step 8: For non-admin users with 0 income, check data.json for campaign-level data
    if (!isAdmin && totalIncome === 0 && totalUnique === 0) {
      const dataUsers = dataJson.users || {};
      // Find matching user in data.json (by name or campaign)
      let matchedUserData = null;
      for (const [key, udata] of Object.entries(dataUsers)) {
        if (key.toLowerCase() === username.toLowerCase() || 
            (udata.name && udata.name.toLowerCase() === username.toLowerCase())) {
          if (!matchedUserData || (udata.d14income || 0) > (matchedUserData.d14income || 0)) {
            matchedUserData = udata;
          }
        }
      }
      
      // Also check: if user's submissions have a campaign_id, find campaign data
      if (!matchedUserData) {
        const campaignIds = new Set();
        for (const sub of userSubs) {
          // Check link-stats for campaign_id
          if (sub.linkId && linkStats.links && linkStats.links[sub.linkId]) {
            const cid = linkStats.links[sub.linkId].campaign_id;
            if (cid) campaignIds.add(cid);
          }
        }
        for (const cid of campaignIds) {
          if (dataUsers[cid] && (dataUsers[cid].d14income || 0) > 0) {
            matchedUserData = dataUsers[cid];
            break;
          }
        }
      }

      if (matchedUserData) {
        totalVisits = matchedUserData.link_visits || matchedUserData.visits || totalVisits;
        totalUnique = matchedUserData.link_unique || matchedUserData.unique_visitors || matchedUserData.unique_users || totalUnique;
        totalNew = matchedUserData.new_users || totalNew;
        totalIncome = matchedUserData.d14income || matchedUserData.subscription_revenue || totalIncome;

        // Add daily data from data.json
        const dailyAgg = {};
        if (matchedUserData.link_unique_daily) {
          for (const [d, v] of Object.entries(matchedUserData.link_unique_daily)) {
            if (!dailyAgg[d]) dailyAgg[d] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
            dailyAgg[d].unique_users = v;
          }
        }
        if (matchedUserData.d14income_daily) {
          for (const [d, v] of Object.entries(matchedUserData.d14income_daily)) {
            if (!dailyAgg[d]) dailyAgg[d] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
            dailyAgg[d].income = v;
          }
        }
        if (matchedUserData.link_visits_daily) {
          for (const [d, v] of Object.entries(matchedUserData.link_visits_daily)) {
            if (!dailyAgg[d]) dailyAgg[d] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
            dailyAgg[d].visits = v;
          }
        }
        if (matchedUserData.new_users_daily) {
          for (const [d, v] of Object.entries(matchedUserData.new_users_daily)) {
            if (!dailyAgg[d]) dailyAgg[d] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
            dailyAgg[d].new_users = v;
          }
        }

        // Distribute campaign-level data across the user's links proportionally
        if (links.length > 0) {
          const perLink = {
            visits: Math.floor(totalVisits / links.length),
            unique: Math.floor(totalUnique / links.length),
            new_users: Math.floor(totalNew / links.length),
            income: Math.round(totalIncome / links.length * 100) / 100
          };
          let assignedVisits = 0, assignedUnique = 0, assignedNew = 0, assignedIncome = 0;
          for (let i = 0; i < links.length; i++) {
            if (i < links.length - 1) {
              links[i].visits = perLink.visits;
              links[i].unique_users = perLink.unique;
              links[i].new_users = perLink.new_users;
              links[i].d14_income = perLink.income;
              assignedVisits += perLink.visits;
              assignedUnique += perLink.unique;
              assignedNew += perLink.new_users;
              assignedIncome += perLink.income;
            } else {
              // Last link gets remainder
              links[i].visits = totalVisits - assignedVisits;
              links[i].unique_users = totalUnique - assignedUnique;
              links[i].new_users = totalNew - assignedNew;
              links[i].d14_income = Math.round((totalIncome - assignedIncome) * 100) / 100;
            }
            links[i].daily = dailyAgg;
          }
        }
      }
    }

    // Aggregate daily across all links
    const dailyAgg = {};
    for (const l of links) {
      for (const [date, val] of Object.entries(l.daily)) {
        if (!dailyAgg[date]) dailyAgg[date] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
        dailyAgg[date].visits += val.visits || 0;
        dailyAgg[date].unique_users += val.unique_users || 0;
        dailyAgg[date].new_users += val.new_users || 0;
        dailyAgg[date].income += val.income || 0;
      }
    }

    // Recalculate totals from links (in case we distributed from data.json)
    totalVisits = links.reduce((s, l) => s + l.visits, 0);
    totalUnique = links.reduce((s, l) => s + l.unique_users, 0);
    totalNew = links.reduce((s, l) => s + l.new_users, 0);
    totalIncome = links.reduce((s, l) => s + l.d14_income, 0);

    return res.status(200).json({
      username,
      isAdmin,
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
