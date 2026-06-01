/**
 * POST /api/update-stats
 * Fetches latest stats from putreport API and updates data.json + link-stats.json
 * Called by Vercel cron every 2 hours
 * Requires NOVELSPA_TOKEN env var for API auth
 */

const { setCORSHeaders } = require('./_lib/cors')
const { getBookstoreToken } = require('./_lib/oidc-token');

const PUTREPORT_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport';
const BOOKSTORE_API = 'https://admin.novelspa.app/api/v1/novelmanage';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';

// Campaign config - KOC campaign IDs
const CAMPAIGNS = [
  { id: '69f42260362028a0ac10b770', username: 'Cons Espher' },
  { id: '69f94be3e71c030eb9032000', username: 'DRAS' },
  { id: '699ef7b8194eb218db3c2270', username: 'xujt' },
  { id: '690dc4d8f12f26c746c245b3', username: 'zhangth' },
  { id: '690afae3f12f26c746c24553', username: 'jiangjx' },
  { id: '694ca8495351adbc02818388', username: 'zhangshang' },
];

module.exports = async (req, res) => {
  setCORSHeaders(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth: require admin key or cron secret
  const adminKey = process.env.ADMIN_KEY;
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers['x-admin-key'] || req.headers['x-cron-secret'] || req.query.secret || '';
  if (adminKey && provided !== adminKey && provided !== cronSecret) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const BOOKSTORE_TOKEN = await getBookstoreToken();
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const ghHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'NovelFlow-API'
  };

  const logs = [];
  const now = new Date();
  const dateTo = now.toISOString().split('T')[0];
  const dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    // Step 1: Fetch current data.json
    const dataResp = await fetch(`${apiBase}/data.json`, { headers: ghHeaders });
    if (!dataResp.ok) throw new Error('Failed to fetch data.json');
    const dataJson = await dataResp.json();
    const dataSha = dataJson.sha;
    const currentData = JSON.parse(Buffer.from(dataJson.content, 'base64').toString('utf-8'));

    // Step 2: Fetch putreport data for each campaign
    if (BOOKSTORE_TOKEN) {
      for (const campaign of CAMPAIGNS) {
        try {
          const payload = {
            filters: {
              productline: ["NovelFlow"],
              mediasource: [],
              mediasource2: ["SocialMedia"],
              date: { from: dateFrom, to: dateTo, datesLabel: "" },
              campaignid: [campaign.id],
              adsetid: [],
              adid: [],
              copywritingid: []
            },
            groupings: ["date"]
          };

          const rResp = await fetch(PUTREPORT_API, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
              'X-OS': 'web', 'X-AppName': 'web-admin',
              'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1',
              'Content-Type': 'application/json;charset=UTF-8',
              'Accept': 'application/json'
            },
            body: JSON.stringify(payload)
          });

          if (rResp.status === 401) {
            logs.push(`${campaign.username}: API 401 - token expired`);
            continue;
          }

          const rData = await rResp.json();
          const rows = rData.data || [];

          if (rows.length === 0) {
            logs.push(`${campaign.username}: no data`);
            continue;
          }

          // Aggregate daily stats
          const visitsDaily = {};
          const uniqueDaily = {};
          const newUsersDaily = {};
          const incomeDaily = {};
          let totalVisits = 0, totalUnique = 0, totalNew = 0, totalIncome = 0;

          for (const row of rows) {
            const date = row.date || row.dt || '';
            const visits = parseInt(row.h5landingpageclicks || row.h5landingpageclicknum || row.clicknum || row.visits || 0);
            const unique = parseInt(row.h5landingpageclickusernum || row.clickusernum || row.unique_users || 0);
            const newUsers = parseInt(row.newusernum || row.new_users || 0);
            const income = parseFloat(row.d14income || row.income || 0);

            if (date) {
              visitsDaily[date] = (visitsDaily[date] || 0) + visits;
              uniqueDaily[date] = (uniqueDaily[date] || 0) + unique;
              newUsersDaily[date] = (newUsersDaily[date] || 0) + newUsers;
              incomeDaily[date] = parseFloat(((incomeDaily[date] || 0) + income).toFixed(2));
            }
            totalVisits += visits;
            totalUnique += unique;
            totalNew += newUsers;
            totalIncome += income;
          }

          // Update data.json for this user - use dashboard.html compatible field names
          const users = currentData.users || {};
          if (!users[campaign.username]) {
            users[campaign.username] = { name: campaign.username };
          }
          const userData = users[campaign.username];
          userData.campaign_id = campaign.id;
          userData.link_visits = totalVisits;                // was: visits
          userData.link_unique = totalUnique;                // was: unique_users  
          userData.unique_visitors = totalUnique;            // was: unique_users
          userData.new_users = totalNew;
          userData.subscription_revenue = parseFloat(totalIncome.toFixed(2)); // was: d14income
          userData.ad_revenue = 0.0;                         // was: missing
          userData.link_visits_daily = visitsDaily;
          userData.link_unique_daily = uniqueDaily;
          userData.new_users_daily = newUsersDaily;
          userData.subscription_revenue_daily = incomeDaily;  // was: d14income_daily
          userData.ad_revenue_daily = {};                     // was: missing
          userData.last_updated = now.toISOString();

          // Also set by campaign ID for my-stats.js compatibility
          users[campaign.id] = {
            name: campaign.username,
            campaign_id: campaign.id,
            link_visits: totalVisits,
            link_unique: totalUnique,
            unique_visitors: totalUnique,
            new_users: totalNew,
            subscription_revenue: parseFloat(totalIncome.toFixed(2)),
            ad_revenue: 0.0,
            last_updated: now.toISOString()
          };

          currentData.users = users;
          logs.push(`${campaign.username}: ${totalVisits} visits, ${totalUnique} unique, ${totalNew} new, $${totalIncome.toFixed(2)} income`);
        } catch (e) {
          logs.push(`${campaign.username}: error - ${e.message}`);
        }
      }
    } else {
      logs.push('NOVELSPA_TOKEN not set - skipping putreport fetch');
    }

    // Step 3: Save updated data.json
    const updatedContent = Buffer.from(JSON.stringify(currentData, null, 2)).toString('base64');
    const saveResp = await fetch(`${apiBase}/data.json`, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Auto-update stats: ${now.toISOString().split('T')[0]} ${now.toISOString().split('T')[1].substring(0,5)}`,
        content: updatedContent,
        sha: dataSha
      })
    });

    if (!saveResp.ok) {
      const errText = await saveResp.text().catch(() => '');
      logs.push(`Save failed: ${saveResp.status} ${errText.substring(0, 200)}`);
    } else {
      logs.push('data.json saved successfully');
    }

    return res.status(200).json({ success: true, updated: now.toISOString(), logs });

  } catch (error) {
    console.error('update-stats error:', error);
    return res.status(500).json({ success: false, error: error.message, logs });
  }
};
