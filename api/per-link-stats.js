/**
 * GET /api/per-link-stats?username=xxx
 *
 * v6-unified-funnel
 *
 * Per-link granularity view. Same data strategy as my-stats.js:
 *   - Primary: ad_id_details.json (covers link + code channels, dn_income, no putreport).
 *   - Redis: nf_subs / nf_user_subs / nf_user_data / nf_book_covers for metadata.
 *   - Fallback: legacy link-stats.json + data.json from GitHub.
 *
 * Backward-compatible response shape:
 *   { username, isAdmin, total_visits, total_unique, total_new, total_income,
 *     daily: { dt: {visits, unique_users, new_users, income} },
 *     links:  [ { bookName, bookId, code, link, linkId, submittedAt, kocName,
 *                 visits, unique_users, new_users, d14_income, dn_income, channel,
 *                 daily: { dt: {visits, unique_users, new_users, income} } } ] }
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser } = require('./_lib/security');
const {
  getRedis, canonize, resolvePromoterKey,
  getAdIdDetails, getLegacyLinkStats,
  loadSubmissions, loadCovers,
  buildAdIdLookup, zeroStats, r2,
} = require('./_lib/stats-data');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- AUTH: must be logged in ----
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const jwtUsername = payload.username;

  // Client-requested username (for self or admin cross-view)
  const requestedUsername = req.query.username || (req.body && req.body.username);
  const redis = getRedis();

  // Admin check via Redis (no static whitelist)
  let admin = false;
  if (redis) {
    try { admin = await isAdminUser(redis, jwtUsername); } catch(e) { admin = false; }
  }

  // Non-admin can only view their own stats
  let username;
  if (admin) {
    username = requestedUsername || jwtUsername;
  } else {
    username = jwtUsername;
  }
  if (!username) return res.status(400).json({ error: 'username is required' });

  const debugLog = [];

  const empty = () => res.status(200).json({
    username, isAdmin: admin,
    total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
    last_updated: null,
    daily: {}, links: [], debug: debugLog, version: 'v6-unified-funnel',
  });

  try {
    // admin determined above via isAdminUser(redis, jwtUsername)
    let usernameCanon = null;

    const adData = await getAdIdDetails(debugLog);
    if (!admin) {
      usernameCanon = resolvePromoterKey(username, adData);
      debugLog.push(`username "${username}" → canon="${usernameCanon}"`);
    }
    const submissions = redis ? await loadSubmissions(redis, username, admin, debugLog) : [];
    const bookIds = submissions.map(s => s.bookId).filter(Boolean);
    const covers = redis ? await loadCovers(redis, bookIds, debugLog) : {};

    // =================== PRIMARY PATH ===================
    if (adData) {
      const { byAdId, promoterEntries } = buildAdIdLookup(adData, usernameCanon, admin);

      const links = [];
      const aggDaily = {};

      if (admin) {
        // Admin: build one record per ad_id across all promoters, joined with nf_subs metadata.
        const nfSubsByAdId = new Map();
        for (const sub of submissions) {
          if (sub.linkId) nfSubsByAdId.set(String(sub.linkId), sub);
          if (sub.code) nfSubsByAdId.set(String(sub.code), sub);
        }
        for (const [pCanon, pEntry] of Object.entries(promoterEntries || {})) {
          const adIds = [...(pEntry.links || []), ...(pEntry.codes || [])];
          for (const adIdRaw of adIds) {
            const adId = String(adIdRaw);
            const st = byAdId[adId] || zeroStats();
            const sub = nfSubsByAdId.get(adId) || {};
            const channel = st.channel || (pEntry.links?.includes(adIdRaw) ? 'link' : 'code');
            const bookName = sub.matchedBookName || sub.bookName || st.book_name ||
              (pEntry.books || []).find(b => (b.ad_ids || []).map(String).includes(adId))?.name ||
              'Unknown';
            const bookId = sub.bookId || null;

            const daily = {};
            for (const [dt, dv] of Object.entries(st.daily || {})) {
              daily[dt] = {
                visits: dv.pull_uv || 0,
                unique_users: dv.pull_uv || 0,
                new_users: dv.new_uv || 0,
                income: r2(dv.dn_income || 0),
              };
              if (!aggDaily[dt]) aggDaily[dt] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
              aggDaily[dt].visits += daily[dt].visits;
              aggDaily[dt].unique_users += daily[dt].unique_users;
              aggDaily[dt].new_users += daily[dt].new_users;
              aggDaily[dt].income += daily[dt].income;
            }
            const dn = r2(st.dn_income);
            links.push({
              bookName,
              bookId,
              code: sub.code || (channel === 'code' ? adId : 'N/A'),
              link: sub.link || null,
              linkId: sub.linkId || (channel === 'link' ? adId : null),
              submittedAt: sub.submittedAt || null,
              kocName: pEntry.display_name || pCanon,
              cover: bookId ? (covers[bookId] || '') : '',
              visits: st.pull_uv || 0,
              unique_users: st.pull_uv || 0,
              new_users: st.new_uv || 0,
              d14_income: dn,
              dn_income: dn,
              channel,
              daily,
            });
          }
        }
      } else {
        // Normal user: iterate submissions, lookup per-ad_id stats.
        for (const sub of submissions) {
          const linkId = sub.linkId ? String(sub.linkId) : null;
          const code = sub.code ? String(sub.code) : null;

          let adIdKey = null;
          let st = null;
          if (linkId && byAdId[linkId]) { adIdKey = linkId; st = byAdId[linkId]; }
          else if (code && byAdId[code]) { adIdKey = code; st = byAdId[code]; }

          if (!st) st = zeroStats();
          const channel = st.channel || (adIdKey && code === adIdKey ? 'code' : 'link');
          const bookName = sub.matchedBookName || sub.bookName || st.book_name || 'Unknown';
          const bookId = sub.bookId || null;

          const daily = {};
          for (const [dt, dv] of Object.entries(st.daily || {})) {
            daily[dt] = {
              visits: dv.pull_uv || 0,
              unique_users: dv.pull_uv || 0,
              new_users: dv.new_uv || 0,
              income: r2(dv.dn_income || 0),
            };
            if (!aggDaily[dt]) aggDaily[dt] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
            aggDaily[dt].visits += daily[dt].visits;
            aggDaily[dt].unique_users += daily[dt].unique_users;
            aggDaily[dt].new_users += daily[dt].new_users;
            aggDaily[dt].income += daily[dt].income;
          }
          const dn = r2(st.dn_income);
          links.push({
            bookName, bookId,
            code: sub.code || code || 'N/A',
            link: sub.link || null,
            linkId: sub.linkId || linkId || null,
            submittedAt: sub.submittedAt || null,
            kocName: sub.discordUsername || username,
            cover: bookId ? (covers[bookId] || '') : '',
            visits: st.pull_uv || 0,
            unique_users: st.pull_uv || 0,
            new_users: st.new_uv || 0,
            d14_income: dn,
            dn_income: dn,
            channel,
            daily,
          });
        }
      }

      // ---------- ORPHAN AD_ID SYNC (same reasoning as my-stats.js) ----------
      const promoterEntry = (() => {
        if (!adData || !adData.by_promoter || admin) return null;
        return adData.by_promoter[usernameCanon] || null;
      })();
      if (promoterEntry) {
        const knownAdIds = new Set();
        for (const l of links) {
          if (l.linkId) knownAdIds.add(String(l.linkId));
          if (l.code && l.code !== 'N/A') knownAdIds.add(String(l.code));
        }
        const promoAdIds = [
          ...(promoterEntry.links || []).map(String),
          ...(promoterEntry.codes || []).map(String),
        ];
        let orphanCount = 0;
        for (const adId of promoAdIds) {
          if (knownAdIds.has(adId)) continue;
          const st = byAdId[adId];
          if (!st) continue;
          const isCode = (promoterEntry.codes || []).map(String).includes(adId);
          const channel = (isCode ? 'code' : 'link') + ' (synced)';
          let bookName = st.book_name || 'Unknown';
          for (const pb of (promoterEntry.books || [])) {
            if ((pb.ad_ids || []).map(String).includes(adId)) { bookName = pb.name; break; }
          }
          const dn = r2(st.dn_income);
          const dailyRow = {};
          for (const [dt, dv] of Object.entries(st.daily || {})) {
            if (!aggDaily[dt]) aggDaily[dt] = { visits:0, unique_users:0, new_users:0, income:0 };
            aggDaily[dt].visits += dv.pull_uv || 0;
            aggDaily[dt].unique_users += dv.pull_uv || 0;
            aggDaily[dt].new_users += dv.new_uv || 0;
            aggDaily[dt].income += dv.dn_income || 0;
            dailyRow[dt] = {
              visits: dv.pull_uv || 0,
              unique_users: dv.pull_uv || 0,
              new_users: dv.new_uv || 0,
              income: r2(dv.dn_income || 0),
            };
          }
          links.push({
            bookName, bookId: null,
            code: isCode ? adId : 'N/A',
            link: null,
            linkId: isCode ? null : adId,
            submittedAt: null,
            kocName: username,
            cover: '',
            visits: st.pull_uv || 0,
            unique_users: st.pull_uv || 0,
            new_users: st.new_uv || 0,
            d14_income: dn, dn_income: dn,
            channel,
            daily: dailyRow,
          });
          orphanCount++;
        }
        if (orphanCount) debugLog.push(`synced ${orphanCount} orphan ad_id(s) from pipeline mapping`);
      }

      const totalVisits = links.reduce((s, l) => s + l.visits, 0);
      const totalNew = links.reduce((s, l) => s + l.new_users, 0);
      const totalIncome = r2(links.reduce((s, l) => s + l.dn_income, 0));

      // Round aggregated daily income
      const daily = {};
      for (const [dt, v] of Object.entries(aggDaily)) {
        daily[dt] = {
          visits: v.visits,
          unique_users: v.unique_users,
          new_users: v.new_users,
          income: r2(v.income),
        };
      }

      debugLog.push(`primary path: ${links.length} link rows, income=$${totalIncome.toFixed(2)}`);

      return res.status(200).json({
        username, isAdmin: admin,
        total_visits: totalVisits,
        total_unique: totalVisits,
        total_new: totalNew,
        total_income: totalIncome,
        last_updated: adData.last_updated || new Date().toISOString(),
        daily, links,
        debug: debugLog, version: 'v6-unified-funnel',
      });
    }

    // =================== FALLBACK: link-stats.json ===================
    debugLog.push('primary ad_id_details unavailable — using legacy link-stats.json fallback');
    const linkStats = await getLegacyLinkStats(debugLog);
    const linkStatsLinks = (linkStats && linkStats.links) || {};

    const links = [];
    const aggDaily = {};
    for (const sub of submissions) {
      const linkId = sub.linkId ? String(sub.linkId) : null;
      const code = sub.code ? String(sub.code) : null;
      const cron = (linkId && linkStatsLinks[linkId]) || (code && linkStatsLinks[code]) || null;

      const daily = {};
      let visits = 0, unique = 0, newUsers = 0, income = 0;
      if (cron) {
        visits = +cron.total_visits || +cron.visits || +cron.unique_visitors || 0;
        unique = +cron.unique_visitors || +cron.unique_users || visits;
        newUsers = +cron.new_users || 0;
        income = r2(+cron.dn || +cron.dn_income || +cron.d14_income || +cron.revenue || 0);
        if (cron.daily && typeof cron.daily === 'object') {
          for (const [dt, v] of Object.entries(cron.daily)) {
            daily[dt] = {
              visits: +v.pull_uv || +v.visits || 0,
              unique_users: +v.pull_uv || +v.unique_users || +v.visits || 0,
              new_users: +v.new_uv || +v.new_users || 0,
              income: r2(+v.dn_income || +v.dn || 0),
            };
          }
        }
      }
      for (const [dt, v] of Object.entries(daily)) {
        if (!aggDaily[dt]) aggDaily[dt] = { visits:0, unique_users:0, new_users:0, income:0 };
        aggDaily[dt].visits += v.visits;
        aggDaily[dt].unique_users += v.unique_users;
        aggDaily[dt].new_users += v.new_users;
        aggDaily[dt].income += v.income;
      }
      links.push({
        bookName: sub.matchedBookName || sub.bookName || cron?.book_name || 'Unknown',
        bookId: sub.bookId || null,
        code: sub.code || code || 'N/A',
        link: sub.link || null,
        linkId: sub.linkId || linkId || null,
        submittedAt: sub.submittedAt || null,
        kocName: sub.discordUsername || username,
        cover: sub.bookId ? (covers[sub.bookId] || '') : '',
        visits, unique_users: unique, new_users: newUsers,
        d14_income: income, dn_income: income,
        channel: cron?.channel || 'link',
        daily,
      });
    }

    const totalVisits = links.reduce((s,l)=>s+l.visits,0);
    const totalNew = links.reduce((s,l)=>s+l.new_users,0);
    const totalIncome = r2(links.reduce((s,l)=>s+l.dn_income,0));
    const daily = {};
    for (const [dt,v] of Object.entries(aggDaily)) {
      daily[dt] = { visits: v.visits, unique_users: v.unique_users, new_users: v.new_users, income: r2(v.income) };
    }

    return res.status(200).json({
      username, isAdmin: admin,
      total_visits: totalVisits, total_unique: totalVisits,
      total_new: totalNew, total_income: totalIncome,
      last_updated: linkStats.last_updated || new Date().toISOString(),
      daily, links,
      debug: debugLog, version: 'v6-unified-funnel',
    });

  } catch (error) {
    console.error('[per-link-stats] Error:', error);
    debugLog.push(`FATAL: ${error.message}`);
    return res.status(200).json({
      username, isAdmin: admin,
      total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
      daily: {}, links: [],
      debug: debugLog, version: 'v6-unified-funnel',
      error: error.message,
    });
  }
};
