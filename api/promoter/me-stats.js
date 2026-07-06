/**
 * GET /api/promoter/me-stats
 *
 * JWT-authenticated endpoint for promoters.
 * Extracts username from JWT cookie, returns their stats.
 * Cannot be used to query other users.
 */
const { setCORSHeaders } = require('../_lib/cors');
const { verifyJWT, parseCookies } = require('../_lib/auth');
const { getBookstoreToken } = require('../_lib/oidc-token');
const { Redis } = require('@upstash/redis');

const PUTREPORT_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport';
const ADMIN_USERNAMES = ['xujt', 'admin'];

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 1. Extract JWT from cookies
  const cookies = parseCookies(req);
  const token = cookies.nf_access_token || cookies.access_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const payload = verifyJWT(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  // Support both payload shapes: {username} or {sub} or {user:{username}}
  let username = payload.username || payload.sub;
  if (!username && payload.user && payload.user.username) username = payload.user.username;
  if (!username) return res.status(401).json({ error: 'Token missing username' });
  username = String(username).toLowerCase();

  // 2. Load stats - reusing logic from my-stats.js
  const redis = getRedis();
  if (!redis) return res.status(500).json({ error: 'KV not configured' });

  try {
    const isAdmin = ADMIN_USERNAMES.includes(username);

    let subKeys = [];
    if (isAdmin) {
      const allEntries = await redis.hgetall('nf_subs');
      if (allEntries && typeof allEntries === 'object') {
        subKeys = Object.keys(allEntries).filter(k => !k.startsWith('_pending_'));
      }
    } else {
      subKeys = await redis.smembers(`nf_user_subs:${username}`);
      if (!Array.isArray(subKeys)) subKeys = [];
    }

    if (subKeys.length === 0) {
      return res.status(200).json({
        username, isAdmin,
        total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
        last_updated: new Date().toISOString(), books: []
      });
    }

    // Batch get submissions
    const BATCH = 50;
    let userSubmissions = [];
    for (let i = 0; i < subKeys.length; i += BATCH) {
      const batchKeys = subKeys.slice(i, i+BATCH);
      const values = await Promise.all(batchKeys.map(k => redis.hget('nf_subs', k)));
      for (const v of values) {
        if (v) {
          try {
            const sub = typeof v === 'string' ? JSON.parse(v) : v;
            if (sub.linkId) userSubmissions.push(sub);
          } catch(e) {}
        }
      }
    }

    // Also merge myBooks from user_data
    const existingLinkIds = new Set(userSubmissions.map(s => s.linkId).filter(Boolean));
    try {
      const kvData = await redis.get(`nf_user_data:${username}`);
      if (kvData && kvData.myBooks && Array.isArray(kvData.myBooks)) {
        for (const book of kvData.myBooks) {
          const bookLinkId = book.linkId || null;
          if (bookLinkId && !existingLinkIds.has(bookLinkId)) {
            userSubmissions.push({
              discordUsername: username, status: 'completed',
              code: book.code, linkId: bookLinkId, bookId: book.bookId || null,
              matchedBookName: book.title || book.bookName || 'Unknown',
              bookName: book.title || book.bookName || 'Unknown',
              link: book.link || null,
              submittedAt: book.createdAt ? new Date(book.createdAt).toISOString() : null,
              lang: book.lang || 'en'
            });
            existingLinkIds.add(bookLinkId);
          }
        }
      }
    } catch(e) {}

    if (userSubmissions.length === 0) {
      return res.status(200).json({
        username, isAdmin,
        total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
        last_updated: new Date().toISOString(), books: []
      });
    }

    // Get putreport token
    let putreportToken = null;
    try { putreportToken = await getBookstoreToken(); } catch(e) {}

    const linkIds = userSubmissions.map(s => s.linkId).filter(Boolean);
    const now = new Date();
    const dateTo = now.toISOString().split('T')[0];
    const dateFrom = new Date(now.getTime() - 365*24*60*60*1000).toISOString().split('T')[0];

    let allRows = [];
    if (putreportToken && linkIds.length > 0) {
      for (let i = 0; i < linkIds.length; i += 50) {
        const batch = linkIds.slice(i, i+50);
        try {
          const resp = await fetch(PUTREPORT_API, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${putreportToken}`,
              'X-OS': 'web', 'X-AppName': 'web-admin',
              'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1',
              'Content-Type': 'application/json;charset=UTF-8',
              'Accept': 'application/json',
              'Origin': 'https://admin.novelspa.app',
              'Referer': 'https://admin.novelspa.app/'
            },
            body: JSON.stringify({
              filters: {
                productline: ['NovelFlow'],
                mediasource: [], mediasource2: ['SocialMedia'],
                date: { from: dateFrom, to: dateTo, datesLabel: '' },
                campaignid: [], adsetid: [], adid: batch, copywritingid: []
              },
              groupings: ['adid', 'date']
            })
          });
          if (resp.status === 401) break;
          const data = await resp.json();
          if (data.data) allRows = allRows.concat(data.data);
        } catch(e) {}
      }
    }

    // Aggregate
    const linkMap = {};
    for (const row of allRows) {
      const adid = row.adid || '';
      const visits = parseInt(row.h5landingpageclicks || row.h5landingpageclicknum || 0);
      const unique = parseInt(row.h5landingpageclickusernum || row.clickusernum || 0);
      const newUsers = parseInt(row.newusernum || 0);
      const income = parseFloat(row.d14income || 0);
      if (!linkMap[adid]) linkMap[adid] = { total_visits: 0, total_unique: 0, total_new: 0, total_income: 0 };
      linkMap[adid].total_visits += visits;
      linkMap[adid].total_unique += unique;
      linkMap[adid].total_new += newUsers;
      linkMap[adid].total_income += income;
    }

    const books = [];
    for (const sub of userSubmissions) {
      const lm = linkMap[sub.linkId] || { total_visits: 0, total_unique: 0, total_new: 0, total_income: 0 };
      books.push({
        bookName: sub.matchedBookName || sub.bookName,
        matchedBookName: sub.matchedBookName || sub.bookName,
        code: sub.code || 'N/A',
        link: sub.link || null,
        shortUrl: sub.shortUrl || null,
        bookId: sub.bookId || null,
        linkId: sub.linkId,
        lang: sub.lang || 'en',
        submittedAt: sub.submittedAt,
        visits: lm.total_visits || 0,
        unique_users: lm.total_unique || 0,
        new_users: lm.total_new || 0,
        d14_income: Math.round((lm.total_income || 0) * 100) / 100
      });
    }

    const totalVisits = books.reduce((s,b) => s+b.visits, 0);
    const totalUnique = books.reduce((s,b) => s+b.unique_users, 0);
    const totalNew = books.reduce((s,b) => s+b.new_users, 0);
    const totalIncome = books.reduce((s,b) => s+b.d14_income, 0);

    return res.status(200).json({
      username, isAdmin,
      total_visits: totalVisits,
      total_unique: totalUnique,
      total_new: totalNew,
      total_income: Math.round(totalIncome*100)/100,
      last_updated: new Date().toISOString(),
      books
    });
  } catch (error) {
    console.error('[promoter/me-stats] Error:', error);
    return res.status(500).json({ error: error.message, books: [] });
  }
};
