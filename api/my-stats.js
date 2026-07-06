/**
 * GET /api/my-stats?username=xxx
 *
 * v6-unified-funnel
 *
 * Primary data source: GitHub ad_id_details.json (pipeline pre-aggregated every 2h).
 *   - Covers BOTH short links (channel=link) AND search codes (channel=code) from 2026-02 onward.
 *   - Uses dn_income (full-lifetime revenue) instead of d14_income.
 *   - No per-request putreport batching — single 1.5 MB JSON fetch with 5-min in-memory cache.
 *
 * Redis is still used for:
 *   - nf_subs (submission metadata: linkId/code/bookId/cover link/submittedAt/kocName)
 *   - nf_user_subs:<username> set (user's submission id list)
 *   - nf_user_data:<username>.myBooks (CloudSync books not yet in nf_subs)
 *   - nf_book_covers (cover URLs)
 *
 * Admin users (xujt/admin) see ALL KOC data aggregated.
 */
const { setCORSHeaders } = require('./_lib/cors');
const {
  getRedis, canonize, resolvePromoterKey, isAdmin,
  getAdIdDetails, getLegacyDataJson,
  loadSubmissions, loadCovers,
  buildAdIdLookup, zeroStats, r2,
} = require('./_lib/stats-data');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const username = req.query.username || (req.body && req.body.username);
  if (!username) return res.status(400).json({ error: 'username is required' });

  const debugLog = [];
  const redis = getRedis();

  // Empty-shape helper used in early-return / error paths
  const empty = (extra = {}) => res.status(200).json({
    username, isAdmin: isAdmin(username),
    total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
    last_updated: null,
    visits_daily: {}, unique_daily: {}, new_users_daily: {}, income_daily: {},
    books: [], debug: debugLog, version: 'v6-unified-funnel',
    ...extra,
  });

  try {
    const admin = isAdmin(username);
    // Resolve canonical promoter key (handles aliases like "Eliza_Star" → eliza_stellar)
    // We do this AFTER fetching adData so alias-table + ad_ids scan can backstop.
    let usernameCanon = null;
    const resolveCanon = (adDataRef) => {
      if (admin) return null;
      const k = resolvePromoterKey(username, adDataRef);
      debugLog.push(`username "${username}" → canon="${k}"`);
      return k;
    };

    // 1. Fetch primary data (ad_id_details.json) with cache+retry
    const adData = await getAdIdDetails(debugLog);

    // 2. Load submissions from Redis
    const submissions = redis ? await loadSubmissions(redis, username, admin, debugLog) : [];

    // 3. Load covers for bookIds in submissions
    const bookIds = submissions.map(s => s.bookId).filter(Boolean);
    const covers = redis ? await loadCovers(redis, bookIds, debugLog) : {};

    // ============ PRIMARY PATH: ad_id_details.json ============
    if (adData) {
      if (!admin) usernameCanon = resolveCanon(adData);
      const { byAdId, promoterEntry, promoterEntries } =
        buildAdIdLookup(adData, usernameCanon, admin);

      // ---------- ADMIN: aggregate across all promoters ----------
      if (admin) {
        const books = [];
        const aggDaily = {};
        let totalVisits = 0, totalNew = 0, totalIncome = 0;

        // Walk all promoters in by_promoter; for each promoter walk their links+codes and
        // match against nf_subs to surface submission metadata. Fallback: create a synthetic
        // record per ad_id with what's in the pipeline.
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
            const channel = st.channel || (pEntry.links?.includes(adIdRaw) ? 'link' : (pEntry.codes?.includes(adIdRaw) ? 'code' : 'link'));
            const bookName = sub.matchedBookName || sub.bookName || st.book_name ||
              (pEntry.books || []).find(b => (b.ad_ids || []).map(String).includes(adId))?.name ||
              'Unknown';
            const bookId = sub.bookId || null;
            const dn = r2(st.dn_income);

            for (const [dt, dv] of Object.entries(st.daily || {})) {
              if (!aggDaily[dt]) aggDaily[dt] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
              aggDaily[dt].visits += dv.pull_uv || 0;
              aggDaily[dt].unique_users += dv.pull_uv || 0;
              aggDaily[dt].new_users += dv.new_uv || 0;
              aggDaily[dt].income += dv.dn_income || 0;
            }
            totalVisits += st.pull_uv || 0;
            totalNew += st.new_uv || 0;
            totalIncome += st.dn_income || 0;

            books.push({
              bookName,
              code: sub.code || (channel === 'code' ? adId : 'N/A'),
              link: sub.link || (channel === 'link' ? `https://s.novelflow.top/${adId}` : null),
              bookId,
              linkId: sub.linkId || (channel === 'link' ? adId : null),
              submittedAt: sub.submittedAt || null,
              kocName: sub.discordUsername || pEntry.display_name || pCanon,
              cover: bookId ? (covers[bookId] || '') : '',
              visits: st.pull_uv || 0,
              unique_users: st.pull_uv || 0,
              new_users: st.new_uv || 0,
              d14_income: dn,   // back-compat: fill with dn
              dn_income: dn,
              channel,
            });
          }
        }

        const visits_daily = {}, unique_daily = {}, new_users_daily = {}, income_daily = {};
        for (const [dt, v] of Object.entries(aggDaily)) {
          if (v.visits) visits_daily[dt] = v.visits;
          if (v.unique_users) unique_daily[dt] = v.unique_users;
          if (v.new_users) new_users_daily[dt] = v.new_users;
          if (v.income) income_daily[dt] = r2(v.income);
        }

        debugLog.push(`admin primary path: ${books.length} book rows, income=$${r2(totalIncome).toFixed(2)}`);

        return res.status(200).json({
          username, isAdmin: true,
          total_visits: totalVisits,
          total_unique: totalVisits,
          total_new: totalNew,
          total_income: r2(totalIncome),
          last_updated: adData.last_updated || new Date().toISOString(),
          visits_daily, unique_daily, new_users_daily, income_daily,
          books, debug: debugLog, version: 'v6-unified-funnel'
        });
      }

      // ---------- NORMAL USER ----------
      // A submission's ad_id can be either the linkId (channel=link) or the code (channel=code).
      // We check both against byAdId to cover cases where nf_subs only has one.
      const books = [];
      const aggDaily = {};
      let missingFromPipeline = 0;
      let linkAdIds = 0, codeAdIds = 0;

      for (const sub of submissions) {
        const linkId = sub.linkId ? String(sub.linkId) : null;
        const code = sub.code ? String(sub.code) : null;

        // Try linkId first, then code
        let adIdKey = null;
        let st = null;
        if (linkId && byAdId[linkId]) { adIdKey = linkId; st = byAdId[linkId]; }
        else if (code && byAdId[code]) { adIdKey = code; st = byAdId[code]; }

        if (!st) {
          // Not in pipeline yet — emit zero placeholder so the row still shows up
          st = zeroStats();
          missingFromPipeline++;
        }

        const channel = st.channel || (adIdKey && code === adIdKey ? 'code' : 'link');
        if (channel === 'link') linkAdIds++; else if (channel === 'code') codeAdIds++;

        const bookName = sub.matchedBookName || sub.bookName || st.book_name || 'Unknown';
        const bookId = sub.bookId || null;
        const dn = r2(st.dn_income);

        for (const [dt, dv] of Object.entries(st.daily || {})) {
          if (!aggDaily[dt]) aggDaily[dt] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
          aggDaily[dt].visits += dv.pull_uv || 0;
          aggDaily[dt].unique_users += dv.pull_uv || 0;
          aggDaily[dt].new_users += dv.new_uv || 0;
          aggDaily[dt].income += dv.dn_income || 0;
        }

        books.push({
          bookName,
          code: sub.code || code || 'N/A',
          link: sub.link || (linkId ? `https://s.novelflow.top/${linkId}` : null),
          bookId,
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
        });
      }

      // ---------- ORPHAN AD_ID SYNC: surface pipeline-mapped ad_ids missing from Redis subs ----------
      // Older nf_subs entries sometimes don't have corresponding nf_user_subs:<user> set membership
      // (legacy bug), so by_promoter may contain ad_ids that belong to this user but aren't in
      // Redis submissions. Emit synthetic rows for them so the user sees their full earnings.
      if (promoterEntry) {
        const knownAdIds = new Set();
        for (const b of books) {
          if (b.linkId) knownAdIds.add(String(b.linkId));
          if (b.code && b.code !== 'N/A') knownAdIds.add(String(b.code));
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
          const channel = isCode ? 'code' : 'link';
          // Try to recover a display book name from promoterEntry.books
          let bookName = st.book_name || 'Unknown';
          for (const pb of (promoterEntry.books || [])) {
            if ((pb.ad_ids || []).map(String).includes(adId)) { bookName = pb.name; break; }
          }
          const dn = r2(st.dn_income);
          for (const [dt, dv] of Object.entries(st.daily || {})) {
            if (!aggDaily[dt]) aggDaily[dt] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
            aggDaily[dt].visits += dv.pull_uv || 0;
            aggDaily[dt].unique_users += dv.pull_uv || 0;
            aggDaily[dt].new_users += dv.new_uv || 0;
            aggDaily[dt].income += dv.dn_income || 0;
          }
          books.push({
            bookName,
            code: isCode ? adId : 'N/A',
            link: isCode ? null : `https://s.novelflow.top/${adId}`,
            bookId: null,
            linkId: isCode ? null : adId,
            submittedAt: null,
            kocName: username,
            cover: '',
            visits: st.pull_uv || 0,
            unique_users: st.pull_uv || 0,
            new_users: st.new_uv || 0,
            d14_income: dn,
            dn_income: dn,
            channel: channel + ' (synced)',
          });
          orphanCount++;
        }
        if (orphanCount) debugLog.push(`synced ${orphanCount} orphan ad_id(s) from pipeline mapping not present in Redis subs`);
      }

      // If user has submissions but promoter entry wasn't found, log it. It can mean the
      // username is new or not yet mapped; per-row stats will already be 0 where appropriate.
      if (!promoterEntry) {
        debugLog.push(`note: no by_promoter entry for canon="${usernameCanon}" — relying on per-ad_id matches`);
      } else {
        debugLog.push(`promoter "${usernameCanon}" (${promoterEntry.display_name || ''}): ${promoterEntry.link_count || 0} links, ${promoterEntry.code_count || 0} codes, dn=$${r2(promoterEntry.total_dn).toFixed(2)}`);
      }
      if (missingFromPipeline) debugLog.push(`${missingFromPipeline}/${books.length} submissions not yet in pipeline (zeros)`);
      debugLog.push(`channel breakdown: ${linkAdIds} link / ${codeAdIds} code`);

      const totalVisits = books.reduce((s, b) => s + b.visits, 0);
      const totalNew = books.reduce((s, b) => s + b.new_users, 0);
      const totalIncome = r2(books.reduce((s, b) => s + b.dn_income, 0));

      const visits_daily = {}, unique_daily = {}, new_users_daily = {}, income_daily = {};
      for (const [dt, v] of Object.entries(aggDaily)) {
        if (v.visits) visits_daily[dt] = v.visits;
        if (v.unique_users) unique_daily[dt] = v.unique_users;
        if (v.new_users) new_users_daily[dt] = v.new_users;
        if (v.income) income_daily[dt] = r2(v.income);
      }

      return res.status(200).json({
        username, isAdmin: false,
        total_visits: totalVisits,
        total_unique: totalVisits,
        total_new: totalNew,
        total_income: totalIncome,
        last_updated: adData.last_updated || new Date().toISOString(),
        visits_daily, unique_daily, new_users_daily, income_daily,
        books, debug: debugLog, version: 'v6-unified-funnel'
      });
    }

    // ============ FALLBACK: legacy data.json (GitHub down / cold fetch failure) ============
    debugLog.push('primary ad_id_details unavailable — using legacy data.json fallback');
    const dataJson = await getLegacyDataJson(debugLog);
    // If we haven't resolved canon yet (primary fetch failed before resolution), resolve without adData
    if (!admin && !usernameCanon) usernameCanon = resolvePromoterKey(username, null);
    const userKey = usernameCanon;
    let matched = null;
    const users = (dataJson && dataJson.users) || {};
    if (users[userKey]) matched = users[userKey];
    else {
      for (const [k, u] of Object.entries(users)) {
        if (k.toLowerCase() === username.toLowerCase() ||
            (u.username && String(u.username).toLowerCase() === username.toLowerCase())) {
          if (!matched || (u.dn || 0) > (matched.dn || 0)) matched = u;
        }
      }
    }

    if (matched && Array.isArray(matched.links) && matched.links.length > 0) {
      const books = [];
      const aggDaily = {};
      const covIds = matched.links.map(l => l.bookId).filter(Boolean);
      const fallbackCovers = redis && covIds.length ? await loadCovers(redis, covIds, debugLog) : {};
      for (const l of matched.links) {
        const dn = r2(l.dn || l.d14_income || l.subscription_revenue || 0);
        if (l.unique_daily) for (const [dt, v] of Object.entries(l.unique_daily)) {
          if (!aggDaily[dt]) aggDaily[dt] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
          aggDaily[dt].visits += v; aggDaily[dt].unique_users += v;
        }
        if (l.dn_daily || l.d14_income_daily || l.income_daily) {
          const src = l.dn_daily || l.d14_income_daily || l.income_daily;
          for (const [dt, v] of Object.entries(src)) {
            if (!aggDaily[dt]) aggDaily[dt] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
            aggDaily[dt].income += +v || 0;
          }
        }
        if (l.new_users_daily) for (const [dt, v] of Object.entries(l.new_users_daily)) {
          if (!aggDaily[dt]) aggDaily[dt] = { visits: 0, unique_users: 0, new_users: 0, income: 0 };
          aggDaily[dt].new_users += v;
        }
        books.push({
          bookName: l.book_name || l.bookName || 'Unknown',
          code: l.code || l.ad_id || 'N/A',
          link: l.link || null,
          bookId: l.bookId || null,
          linkId: l.linkId || l.ad_id || null,
          submittedAt: l.submittedAt || null,
          kocName: l.username || username,
          cover: l.bookId ? (fallbackCovers[l.bookId] || '') : '',
          visits: l.visits || l.total_visits || l.unique_visitors || 0,
          unique_users: l.unique_visitors || l.unique_users || l.visits || 0,
          new_users: l.new_users || 0,
          d14_income: dn,
          dn_income: dn,
          channel: l.channel || 'link',
        });
      }
      const tv = books.reduce((s,b)=>s+b.visits,0);
      const tn = books.reduce((s,b)=>s+b.new_users,0);
      const ti = r2(books.reduce((s,b)=>s+b.dn_income,0));
      const vd={},ud={},nd={},id={};
      for (const [dt,v] of Object.entries(aggDaily)) {
        if (v.visits) vd[dt]=v.visits;
        if (v.unique_users) ud[dt]=v.unique_users;
        if (v.new_users) nd[dt]=v.new_users;
        if (v.income) id[dt]=r2(v.income);
      }
      return res.status(200).json({
        username, isAdmin: admin,
        total_visits: tv, total_unique: tv, total_new: tn, total_income: ti,
        last_updated: dataJson.last_updated || new Date().toISOString(),
        visits_daily: vd, unique_daily: ud, new_users_daily: nd, income_daily: id,
        books, debug: debugLog, version: 'v6-unified-funnel'
      });
    }

    // Absolute last resort: empty but valid
    debugLog.push('fallback: no data — returning empty shape');
    return empty({ debug: debugLog });

  } catch (error) {
    console.error('[my-stats] Error:', error);
    debugLog.push(`FATAL: ${error.message}`);
    return res.status(200).json({
      username, isAdmin: isAdmin(username),
      total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
      last_updated: null,
      visits_daily: {}, unique_daily: {}, new_users_daily: {}, income_daily: {},
      books: [], debug: debugLog, version: 'v6-unified-funnel',
      error: error.message,
    });
  }
};
