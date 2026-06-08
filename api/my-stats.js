/**
 * GET /api/my-stats?username=xxx
 * 
 * Data flow:
 * 1. Get user's linkIds from submissions.json
 * 2. Use linkId as adid → query putreport API → real per-link data  
 * 3. Aggregate per-link data into summary
 * 
 * Always returns valid JSON even if putreport fails.
 * Admin users (xujt) see ALL KOC data aggregated.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getBookstoreToken } = require('./_lib/oidc-token');
const { Redis } = require('@upstash/redis');

const PUTREPORT_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport';
const ADMIN_USERNAMES = ['xujt', 'admin'];

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const username = req.query.username || (req.body && req.body.username);
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const ghHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'NovelFlow-API'
  };

  const debugLog = [];

  try {
    // Step 1: Fetch submissions.json
    debugLog.push('fetching submissions');
    const submissionsResp = await fetch(`${apiBase}/submissions.json`, { headers: ghHeaders });
    if (!submissionsResp.ok) {
      debugLog.push(`submissions fetch failed: ${submissionsResp.status}`);
      return res.status(200).json({
        username, total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
        books: [], debug: debugLog, version: 'v3-putreport+kv'
      });
    }
    const submissionsData = await submissionsResp.json();
    const submissions = JSON.parse(Buffer.from(submissionsData.content, 'base64').toString('utf-8'));
    debugLog.push(`submissions: ${submissions.length} total`);

    const isAdmin = ADMIN_USERNAMES.includes(username.toLowerCase());

    // Filter user's completed submissions with linkId
    const userSubmissions = isAdmin
      ? submissions.filter(s => s.status === 'completed' && s.linkId)
      : submissions.filter(s =>
          ((s.discordUsername || '').toLowerCase() === username.toLowerCase()) &&
          s.status === 'completed' &&
          s.linkId
        );

    debugLog.push(`user subs: ${userSubmissions.length} for ${username}`);

    // Also check KV for additional books not in submissions.json
    // (e.g., from CloudSync before submissions.json was updated)
    const existingLinkIds = new Set(userSubmissions.map(s => s.linkId).filter(Boolean));
    const existingCodes = new Set(userSubmissions.map(s => String(s.code)).filter(c => c && c !== 'undefined'));
    
    try {
      const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const kvData = await redis.get(`nf_user_data:${username}`);
      if (kvData && kvData.myBooks && Array.isArray(kvData.myBooks)) {
        for (const book of kvData.myBooks) {
          const bookCode = book.code ? String(book.code) : null;
          const bookLinkId = book.linkId || null;
          // Add if not already in userSubmissions (by code or linkId)
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
        debugLog.push(`after KV merge: ${userSubmissions.length} total subs`);
      }
    } catch (e) {
      debugLog.push(`KV lookup skipped: ${e.message}`);
    }

    if (userSubmissions.length === 0) {
      return res.status(200).json({
        username, isAdmin,
        total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
        last_updated: null,
        visits_daily: {}, unique_daily: {}, new_users_daily: {}, income_daily: {},
        books: [], debug: debugLog, version: 'v3-putreport+kv'
      });
    }

    // Step 2: Get OIDC token for putreport API
    let putreportToken = null;
    try {
      putreportToken = await getBookstoreToken();
      debugLog.push(putreportToken ? 'got OIDC token' : 'OIDC token is null');
    } catch (e) {
      debugLog.push(`OIDC error: ${e.message}`);
    }

    // Step 3: Query putreport API using linkId as adid
    const linkIds = userSubmissions.map(s => s.linkId);
    const now = new Date();
    const dateTo = now.toISOString().split('T')[0];
    const dateFrom = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const BATCH_SIZE = 50;
    let allRows = [];

    if (putreportToken && linkIds.length > 0) {
      debugLog.push(`querying putreport: ${linkIds.length} linkIds in ${Math.ceil(linkIds.length / BATCH_SIZE)} batches`);
      for (let i = 0; i < linkIds.length; i += BATCH_SIZE) {
        const batch = linkIds.slice(i, i + BATCH_SIZE);
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
                mediasource: [],
                mediasource2: ['SocialMedia'],
                date: { from: dateFrom, to: dateTo, datesLabel: '' },
                campaignid: [], adsetid: [], adid: batch, copywritingid: []
              },
              groupings: ['adid', 'date']
            })
          });
          if (resp.status === 401) {
            debugLog.push(`putreport 401 at batch ${i}`);
            break;
          }
          const data = await resp.json();
          if (data.data) {
            allRows = allRows.concat(data.data);
          }
          debugLog.push(`batch ${i}: got ${data.data ? data.data.length : 0} rows`);
        } catch (e) {
          debugLog.push(`putreport batch ${i} error: ${e.message}`);
        }
      }
    } else {
      debugLog.push('skipping putreport: no token or no linkIds');
    }

    debugLog.push(`total putreport rows: ${allRows.length}`);

    // Step 4: Aggregate putreport data by adid (linkId)
    const linkMap = {};
    for (const row of allRows) {
      const adid = row.adid || '';
      const date = row.date || row.dt || '';
      const visits = parseInt(row.h5landingpageclicks || row.h5landingpageclicknum || 0);
      const unique = parseInt(row.h5landingpageclickusernum || row.clickusernum || 0);
      const newUsers = parseInt(row.newusernum || 0);
      const income = parseFloat(row.d14income || 0);

      if (!linkMap[adid]) {
        linkMap[adid] = { total_visits: 0, total_unique: 0, total_new: 0, total_income: 0, daily: {} };
      }
      linkMap[adid].total_visits += visits;
      linkMap[adid].total_unique += unique;
      linkMap[adid].total_new += newUsers;
      linkMap[adid].total_income += income;
      if (date) {
        if (!linkMap[adid].daily[date]) {
          linkMap[adid].daily[date] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
        }
        linkMap[adid].daily[date].visits += visits;
        linkMap[adid].daily[date].unique_users += unique;
        linkMap[adid].daily[date].new_users += newUsers;
        linkMap[adid].daily[date].income += income;
      }
    }

    // Step 5: Build books array
    const books = [];
    const aggDaily = {};

    for (const sub of userSubmissions) {
      const lm = linkMap[sub.linkId] || null;

      const bookVisits = lm?.total_visits || 0;
      const bookUnique = lm?.total_unique || 0;
      const bookNew = lm?.total_new || 0;
      const bookIncome = lm?.total_income || 0;

      // Aggregate daily
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
        visits: bookVisits,
        unique_users: bookUnique,
        new_users: bookNew,
        d14_income: Math.round(bookIncome * 100) / 100
      });
    }

    // Step 6: Calculate totals
    const totalVisits = books.reduce((s, b) => s + b.visits, 0);
    const totalUnique = books.reduce((s, b) => s + b.unique_users, 0);
    const totalNew = books.reduce((s, b) => s + b.new_users, 0);
    const totalIncome = books.reduce((s, b) => s + b.d14_income, 0);

    // Split daily into separate fields for chart compatibility
    const visits_daily = {};
    const unique_daily = {};
    const new_users_daily = {};
    const income_daily = {};
    for (const [date, val] of Object.entries(aggDaily)) {
      if (val.visits) visits_daily[date] = val.visits;
      if (val.unique_users) unique_daily[date] = val.unique_users;
      if (val.new_users) new_users_daily[date] = val.new_users;
      if (val.income) income_daily[date] = val.income;
    }

    debugLog.push(`final: income=$${totalIncome.toFixed(2)}, unique=${totalUnique}, books=${books.length}`);

    return res.status(200).json({
      username,
      isAdmin,
      total_visits: totalVisits,
      total_unique: totalUnique,
      total_new: totalNew,
      total_income: Math.round(totalIncome * 100) / 100,
      last_updated: new Date().toISOString(),
      visits_daily,
      unique_daily,
      new_users_daily,
      income_daily,
      books,
      debug: debugLog,
      version: 'v3-putreport+kv'
    });

  } catch (error) {
    console.error('my-stats error:', error);
    // Always return valid JSON, never let the API crash
    return res.status(200).json({
      username,
      total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
      books: [],
      debug: [...debugLog, `FATAL: ${error.message}`],
      version: 'v3-putreport+kv',
      error: error.message
    });
  }
};

