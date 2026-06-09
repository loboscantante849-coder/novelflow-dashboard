/**
 * GET /api/per-link-stats?username=xxx
 * 
 * Data sources (in priority order):
 * 1. putreport API by linkId (real-time, per-link)
 * 2. KV user data (CloudSync books)
 * 3. data.json + link-stats.json (cron pre-aggregated, campaign-level) — fallback
 * 
 * Admin users (xujt) see ALL KOC data aggregated.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getBookstoreToken } = require('./_lib/oidc-token');
const { Redis } = require('@upstash/redis');

const PUTREPORT_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport';
const ADMIN_USERNAMES = ['xujt', 'admin'];

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const username = req.query.username;
  if (!username) return res.status(400).json({ error: 'username is required' });

  const redis = getRedis();
  if (!redis) return res.status(500).json({ error: 'KV not configured' });

  try {
    const isAdmin = ADMIN_USERNAMES.includes(username.toLowerCase());

    // Step 1: Get user's submissions from KV
    let subKeys = [];
    if (isAdmin) {
      const allEntries = await redis.hgetall('nf_subs');
      if (allEntries && typeof allEntries === 'object') {
        subKeys = Object.keys(allEntries).filter(k => !k.startsWith('_pending_'));
      }
    } else {
      subKeys = await redis.smembers(`nf_user_subs:${username.toLowerCase()}`);
      if (!Array.isArray(subKeys)) subKeys = [];
    }

    let userSubs = [];
    const values = await Promise.all(subKeys.map(k => redis.hget('nf_subs', k)));
    for (const v of values) {
      if (v) {
        try {
          const sub = typeof v === 'string' ? JSON.parse(v) : v;
          if (sub.linkId) userSubs.push(sub);
        } catch (e) {}
      }
    }

    // Also check KV user data for CloudSync books
    const existingLinkIds = new Set(userSubs.map(s => s.linkId));
    const existingCodes = new Set(userSubs.map(s => String(s.code)).filter(c => c && c !== 'undefined'));
    try {
      const kvData = await redis.get(`nf_user_data:${username}`);
      if (kvData?.myBooks) {
        for (const book of kvData.myBooks) {
          const bookCode = book.code ? String(book.code) : null;
          const bookLinkId = book.linkId || null;
          const isDup = (bookLinkId && existingLinkIds.has(bookLinkId)) || (bookCode && existingCodes.has(bookCode));
          if (!isDup && (bookLinkId || bookCode)) {
            userSubs.push({
              discordUsername: username, status: 'completed',
              code: book.code || bookCode, linkId: bookLinkId,
              bookId: book.bookId || null, matchedBookName: book.title || book.bookName || 'Unknown',
              bookName: book.title || book.bookName || 'Unknown',
              link: book.link || null,
              submittedAt: book.createdAt ? new Date(book.createdAt).toISOString() : null
            });
            if (bookLinkId) existingLinkIds.add(bookLinkId);
            if (bookCode) existingCodes.add(bookCode);
          }
        }
      }
    } catch (e) {}

    // Step 2: Fallback — read data.json and link-stats.json from GitHub
    let dataJson = { users: {} };
    let linkStats = { links: {} };
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (GITHUB_TOKEN) {
      const ghHeaders = { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'NovelFlow-API' };
      const apiBase = 'https://api.github.com/repos/loboscantante849-coder/novelflow-dashboard/contents';
      try {
        const r = await fetch(`${apiBase}/data.json`, { headers: ghHeaders, signal: AbortSignal.timeout(5000) });
        if (r.ok) dataJson = JSON.parse(Buffer.from((await r.json()).content, 'base64').toString('utf-8'));
      } catch (e) {}
      try {
        const r = await fetch(`${apiBase}/link-stats.json`, { headers: ghHeaders, signal: AbortSignal.timeout(5000) });
        if (r.ok) linkStats = JSON.parse(Buffer.from((await r.json()).content, 'base64').toString('utf-8'));
      } catch (e) {}
    }

    // Step 3: Query putreport API
    const token = await getBookstoreToken();
    const now = new Date();
    const dateTo = now.toISOString().split('T')[0];
    const dateFrom = new Date(now.getTime() - 365*24*60*60*1000).toISOString().split('T')[0];
    let allRows = [];

    if (userSubs.length > 0 && token) {
      const linkIds = userSubs.map(s => s.linkId).filter(Boolean);
      for (let i = 0; i < linkIds.length; i += 50) {
        const batch = linkIds.slice(i, i+50);
        try {
          const resp = await fetch(PUTREPORT_API, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'X-OS': 'web', 'X-AppName': 'web-admin', 'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1', 'Content-Type': 'application/json;charset=UTF-8', 'Accept': 'application/json', 'Origin': 'https://admin.novelspa.app', 'Referer': 'https://admin.novelspa.app/' },
            body: JSON.stringify({ filters: { productline: ['NovelFlow'], mediasource: [], mediasource2: ['SocialMedia'], date: { from: dateFrom, to: dateTo, datesLabel: '' }, campaignid: [], adsetid: [], adid: batch, copywritingid: [] }, groupings: ['adid', 'date'] })
          });
          if (resp.status === 401) break;
          const data = await resp.json();
          if (data.data) allRows = allRows.concat(data.data);
        } catch (e) {}
      }
    }

    // Step 4: Aggregate putreport by adid
    const linkMap = {};
    for (const row of allRows) {
      const adid = row.adid || '';
      const date = row.date || row.dt || '';
      const visits = parseInt(row.h5landingpageclicks || row.h5landingpageclicknum || 0);
      const unique = parseInt(row.h5landingpageclickusernum || row.clickusernum || 0);
      const newUsers = parseInt(row.newusernum || 0);
      const income = parseFloat(row.d14income || 0);
      if (!linkMap[adid]) linkMap[adid] = { total_visits: 0, total_unique: 0, total_new: 0, total_income: 0, daily: {} };
      linkMap[adid].total_visits += visits;
      linkMap[adid].total_unique += unique;
      linkMap[adid].total_new += newUsers;
      linkMap[adid].total_income += income;
      if (date) linkMap[adid].daily[date] = { visits, unique_users: unique, new_users: newUsers, income };
    }

    // Step 5: Build links array
    const links = [];
    for (const sub of userSubs) {
      let ls = linkMap[sub.linkId] || null;
      let cronLinkData = sub.linkId && linkStats.links?.[sub.linkId] || null;

      const merged = {
        total_visits: ls?.total_visits || cronLinkData?.visits || 0,
        total_unique: ls?.total_unique || cronLinkData?.unique_users || 0,
        total_new: ls?.total_new || cronLinkData?.new_users || 0,
        total_income: ls?.total_income || cronLinkData?.d14_income || 0,
        daily: {}
      };
      if (ls?.daily) Object.assign(merged.daily, ls.daily);
      if (cronLinkData && !ls?.daily) {
        if (cronLinkData.unique_daily) for (const [d, v] of Object.entries(cronLinkData.unique_daily)) { if (!merged.daily[d]) merged.daily[d] = { visits:0, unique_users:v, new_users:0, income:0 }; }
        if (cronLinkData.d14_income_daily) for (const [d, v] of Object.entries(cronLinkData.d14_income_daily)) { if (!merged.daily[d]) merged.daily[d] = { visits:0, unique_users:0, new_users:0, income:v }; }
      }
      links.push({
        bookName: sub.matchedBookName || sub.bookName, bookId: sub.bookId,
        code: sub.code, link: sub.link, linkId: sub.linkId,
        submittedAt: sub.submittedAt, kocName: sub.discordUsername || '',
        visits: merged.total_visits, unique_users: merged.total_unique,
        new_users: merged.total_new, d14_income: Math.round(merged.total_income*100)/100,
        daily: merged.daily, isLegacy: sub.isLegacy || false
      });
    }

    if (links.length === 0) {
      return res.status(200).json({ username, total_visits: 0, total_unique: 0, total_new: 0, total_income: 0, daily: {}, links: [], message: 'No completed submissions with linkIds' });
    }

    // Step 6: Campaign-level fallback for 0-income users
    let totalVisits = links.reduce((s,l) => s+l.visits, 0);
    let totalUnique = links.reduce((s,l) => s+l.unique_users, 0);
    let totalNew = links.reduce((s,l) => s+l.new_users, 0);
    let totalIncome = links.reduce((s,l) => s+l.d14_income, 0);

    if (!isAdmin && totalIncome === 0 && totalUnique === 0) {
      const dataUsers = dataJson.users || {};
      let matchedUserData = null;
      for (const [key, udata] of Object.entries(dataUsers)) {
        if (key.toLowerCase() === username.toLowerCase() || (udata.name?.toLowerCase() === username.toLowerCase())) {
          if (!matchedUserData || (udata.d14income||0) > (matchedUserData.d14income||0)) matchedUserData = udata;
        }
      }
      if (matchedUserData) {
        totalVisits = matchedUserData.link_visits || matchedUserData.visits || totalVisits;
        totalUnique = matchedUserData.link_unique || matchedUserData.unique_visitors || matchedUserData.unique_users || totalUnique;
        totalNew = matchedUserData.new_users || totalNew;
        totalIncome = matchedUserData.d14income || matchedUserData.subscription_revenue || totalIncome;
        const dailyAgg = {};
        if (matchedUserData.link_unique_daily) for (const [d,v] of Object.entries(matchedUserData.link_unique_daily)) { if (!dailyAgg[d]) dailyAgg[d] = {visits:0,unique_users:0,new_users:0,income:0}; dailyAgg[d].unique_users = v; }
        if (matchedUserData.d14income_daily) for (const [d,v] of Object.entries(matchedUserData.d14income_daily)) { if (!dailyAgg[d]) dailyAgg[d] = {visits:0,unique_users:0,new_users:0,income:0}; dailyAgg[d].income = v; }
        if (links.length > 0) {
          const perLink = { visits: Math.floor(totalVisits/links.length), unique: Math.floor(totalUnique/links.length), new_users: Math.floor(totalNew/links.length), income: Math.round(totalIncome/links.length*100)/100 };
          let av=0,au=0,an=0,ai=0;
          for (let i=0; i<links.length; i++) {
            if (i < links.length-1) { links[i].visits=perLink.visits; links[i].unique_users=perLink.unique; links[i].new_users=perLink.new_users; links[i].d14_income=perLink.income; av+=perLink.visits; au+=perLink.unique; an+=perLink.new_users; ai+=perLink.income; }
            else { links[i].visits=totalVisits-av; links[i].unique_users=totalUnique-au; links[i].new_users=totalNew-an; links[i].d14_income=Math.round((totalIncome-ai)*100)/100; }
            links[i].daily = dailyAgg;
          }
        }
      }
    }

    const dailyAgg = {};
    for (const l of links) for (const [date,val] of Object.entries(l.daily||{})) { if (!dailyAgg[date]) dailyAgg[date]={visits:0,unique_users:0,new_users:0,income:0}; dailyAgg[date].visits+=val.visits||0; dailyAgg[date].unique_users+=val.unique_users||0; dailyAgg[date].new_users+=val.new_users||0; dailyAgg[date].income+=val.income||0; }

    totalVisits = links.reduce((s,l) => s+l.visits, 0);
    totalUnique = links.reduce((s,l) => s+l.unique_users, 0);
    totalNew = links.reduce((s,l) => s+l.new_users, 0);
    totalIncome = links.reduce((s,l) => s+l.d14_income, 0);

    return res.status(200).json({
      username, isAdmin,
      total_visits: totalVisits, total_unique: totalUnique,
      total_new: totalNew, total_income: Math.round(totalIncome*100)/100,
      daily: dailyAgg, links
    });

  } catch (error) {
    console.error('per-link-stats error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
};
