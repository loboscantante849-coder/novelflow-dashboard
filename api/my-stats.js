/**
 * GET /api/my-stats?username=xxx
 * 
 * Data source: Upstash KV (no GitHub API).
 * Flow: user's code set → HMGET submissions → putreport API → aggregate
 * Admin users (xujt) see ALL KOC data.
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

  const username = req.query.username || (req.body && req.body.username);
  if (!username) return res.status(400).json({ error: 'username is required' });

  const redis = getRedis();
  if (!redis) return res.status(500).json({ error: 'KV not configured' });

  const debugLog = [];

  try {
    const isAdmin = ADMIN_USERNAMES.includes(username.toLowerCase());

    // Step 1: Get user's submission keys from KV set
    let subKeys = [];
    if (isAdmin) {
      // Admin: get all hash fields from nf_subs
      const allFields = await redis.hkeys('nf_subs');
      subKeys = allFields.filter(k => !k.startsWith('_pending_'));
      debugLog.push(`admin: ${subKeys.length} non-pending keys from nf_subs`);
    } else {
      subKeys = await redis.smembers(`nf_user_subs:${username.toLowerCase()}`);
      debugLog.push(`user ${username}: ${subKeys.length} keys from set`);
    }

    if (subKeys.length === 0) {
      return res.status(200).json({
        username, isAdmin,
        total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
        last_updated: null,
        visits_daily: {}, unique_daily: {}, new_users_daily: {}, income_daily: {},
        books: [], debug: debugLog, version: 'v4-kv'
      });
    }

    // Step 2: Batch-get submissions from KV hash
    // HMGET returns values in same order as fields; null for missing
    const BATCH = 50;
    let userSubmissions = [];
    for (let i = 0; i < subKeys.length; i += BATCH) {
      const batchKeys = subKeys.slice(i, i + BATCH);
      const values = await redis.hmget('nf_subs', ...batchKeys);
      for (const v of values) {
        if (v) {
          try {
            const sub = typeof v === 'string' ? JSON.parse(v) : v;
            // Only include completed entries with linkId (needed for putreport)
            if (sub.linkId) {
              userSubmissions.push(sub);
            }
          } catch (e) { /* skip corrupt */ }
        }
      }
    }
    debugLog.push(`submissions with linkId: ${userSubmissions.length}`);

    // Step 3: Also check KV user data for CloudSync books not yet in submissions
    const existingLinkIds = new Set(userSubmissions.map(s => s.linkId).filter(Boolean));
    const existingCodes = new Set(userSubmissions.map(s => String(s.code)).filter(c => c && c !== 'undefined'));

    try {
      const kvData = await redis.get(`nf_user_data:${username}`);
      if (kvData && kvData.myBooks && Array.isArray(kvData.myBooks)) {
        for (const book of kvData.myBooks) {
          const bookCode = book.code ? String(book.code) : null;
          const bookLinkId = book.linkId || null;
          const isDuplicate = (bookLinkId && existingLinkIds.has(bookLinkId)) ||
                              (bookCode && existingCodes.has(bookCode));
          if (!isDuplicate && (bookLinkId || bookCode)) {
            userSubmissions.push({
              discordUsername: username,
              status: 'completed',
              code: book.code || bookCode,
              linkId: bookLinkId,
              bookId: book.bookId || null,
              matchedBookName: book.title || book.bookName || 'Unknown',
              bookName: book.title || book.bookName || 'Unknown',
              link: book.link || null,
              submittedAt: book.createdAt ? new Date(book.createdAt).toISOString() : null
            });
            if (bookLinkId) existingLinkIds.add(bookLinkId);
            if (bookCode) existingCodes.add(bookCode);
          }
        }
        debugLog.push(`after KV user-data merge: ${userSubmissions.length}`);
      }
    } catch (e) {
      debugLog.push(`KV user-data merge skipped: ${e.message}`);
    }

    if (userSubmissions.length === 0) {
      return res.status(200).json({
        username, isAdmin,
        total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
        last_updated: null,
        visits_daily: {}, unique_daily: {}, new_users_daily: {}, income_daily: {},
        books: [], debug: debugLog, version: 'v4-kv'
      });
    }

    // Step 4: Get OIDC token for putreport
    let putreportToken = null;
    try {
      putreportToken = await getBookstoreToken();
      debugLog.push(putreportToken ? 'got OIDC token' : 'OIDC token is null');
    } catch (e) {
      debugLog.push(`OIDC error: ${e.message}`);
    }

    // Step 5: Query putreport API
    const linkIds = userSubmissions.map(s => s.linkId).filter(Boolean);
    const now = new Date();
    const dateTo = now.toISOString().split('T')[0];
    const dateFrom = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let allRows = [];
    if (putreportToken && linkIds.length > 0) {
      debugLog.push(`putreport: ${linkIds.length} linkIds in ${Math.ceil(linkIds.length / 50)} batches`);
      for (let i = 0; i < linkIds.length; i += 50) {
        const batch = linkIds.slice(i, i + 50);
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
          if (resp.status === 401) { debugLog.push('putreport 401'); break; }
          const data = await resp.json();
          if (data.data) allRows = allRows.concat(data.data);
          debugLog.push(`batch ${i}: ${data.data?.length || 0} rows`);
        } catch (e) {
          debugLog.push(`putreport batch ${i} error: ${e.message}`);
        }
      }
    } else {
      debugLog.push('skipping putreport: no token or no linkIds');
    }

    // Step 6: Aggregate by linkId
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
      if (date) {
        if (!linkMap[adid].daily[date]) linkMap[adid].daily[date] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
        linkMap[adid].daily[date].visits += visits;
        linkMap[adid].daily[date].unique_users += unique;
        linkMap[adid].daily[date].new_users += newUsers;
        linkMap[adid].daily[date].income += income;
      }
    }

    // Step 7: Build books array
    const books = [];
    const aggDaily = {};
    for (const sub of userSubmissions) {
      const lm = linkMap[sub.linkId] || null;
      if (lm?.daily) {
        for (const [date, val] of Object.entries(lm.daily)) {
          if (!aggDaily[date]) aggDaily[date] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
          aggDaily[date].visits += val.visits || 0;
          aggDaily[date].unique_users += val.unique_users || 0;
          aggDaily[date].new_users += val.new_users || 0;
          aggDaily[date].income += val.income || 0;
        }
      }
      books.push({
        bookName: sub.matchedBookName || sub.bookName,
        code: sub.code || 'N/A',
        link: sub.link || null,
        bookId: sub.bookId || null,
        linkId: sub.linkId,
        submittedAt: sub.submittedAt,
        kocName: sub.discordUsername || '',
        visits: lm?.total_visits || 0,
        unique_users: lm?.total_unique || 0,
        new_users: lm?.total_new || 0,
        d14_income: Math.round((lm?.total_income || 0) * 100) / 100
      });
    }

    const totalVisits = books.reduce((s, b) => s + b.visits, 0);
    const totalUnique = books.reduce((s, b) => s + b.unique_users, 0);
    const totalNew = books.reduce((s, b) => s + b.new_users, 0);
    const totalIncome = books.reduce((s, b) => s + b.d14_income, 0);

    const visits_daily = {}, unique_daily = {}, new_users_daily = {}, income_daily = {};
    for (const [date, val] of Object.entries(aggDaily)) {
      if (val.visits) visits_daily[date] = val.visits;
      if (val.unique_users) unique_daily[date] = val.unique_users;
      if (val.new_users) new_users_daily[date] = val.new_users;
      if (val.income) income_daily[date] = val.income;
    }

    debugLog.push(`final: income=$${totalIncome.toFixed(2)}, books=${books.length}`);

    return res.status(200).json({
      username, isAdmin,
      total_visits: totalVisits,
      total_unique: totalUnique,
      total_new: totalNew,
      total_income: Math.round(totalIncome * 100) / 100,
      last_updated: new Date().toISOString(),
      visits_daily, unique_daily, new_users_daily, income_daily,
      books, debug: debugLog, version: 'v4-kv'
    });

  } catch (error) {
    console.error('[my-stats] Error:', error);
    return res.status(200).json({
      username,
      total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
      books: [],
      debug: [`FATAL: ${error.message}`],
      version: 'v4-kv',
      error: error.message
    });
  }
};
