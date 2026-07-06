/**
 * GET /api/my-stats?username=xxx
 *
 * v6.1 - Security P0 fixes 2026-07-06
 *   - C-01: JWT auth required. Unauthenticated → 401.
 *           Non-admin can only query own username → 403 if mismatch.
 *           Admin (static list xujt/admin OR nf_user_data:<u>.accountType === 'admin') can view anyone.
 *   - debug field stripped in production (NODE_ENV === 'production').
 *
 * Primary data source: GitHub ad_id_details.json (pipeline pre-aggregated every 2h).
 * Redis used for submission metadata / covers.
 */
const { handlePreflight } = require('./_lib/cors');
const {
  getRedis, canonize, resolvePromoterKey, isAdmin: legacyIsAdmin,
  getAdIdDetails, getLegacyDataJson,
  loadSubmissions, loadCovers,
  buildAdIdLookup, zeroStats, r2,
} = require('./_lib/stats-data');
const { getAuthPayload, isAdminUser } = require('./_lib/security');

const IS_PROD = process.env.NODE_ENV === 'production';

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;

  // ---------- AUTH (C-01) ----------
  const payload = getAuthPayload(req);
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  const jwtUsername = payload.username;

  // Check if the JWT user has been disabled (dirty account lockout)
  const redis = getRedis();
  if (redis) {
    try {
      const selfData = await redis.get('nf_user_data:' + String(jwtUsername).toLowerCase());
      if (selfData) {
        const parsed = typeof selfData === 'string' ? JSON.parse(selfData) : selfData;
        if (parsed && parsed.disabled) {
          return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        }
      }
    } catch (_e) { /* ignore */ }
  }

  const isAdmin = await isAdminUser(redis, jwtUsername);

  // Determine target username: ?username= wins if admin, otherwise forced to JWT user
  let requested = req.query.username || (req.body && req.body.username);
  if (requested && String(requested).trim()) {
    requested = String(requested).trim();
    if (!isAdmin && requested.toLowerCase() !== String(jwtUsername).toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden: can only view your own stats', code: 'FORBIDDEN' });
    }
  } else {
    requested = jwtUsername;
  }
  const username = requested;

  const debugLog = [];
  if (!IS_PROD) debugLog.push(`auth: jwt_user=${jwtUsername}, target=${username}, isAdmin=${isAdmin}`);

  // Empty shape helper
  const empty = (extra = {}) => {
    const base = {
      username, isAdmin,
      total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
      last_updated: null,
      visits_daily: {}, unique_daily: {}, new_users_daily: {}, income_daily: {},
      books: [], version: 'v6.1-security',
    };
    if (!IS_PROD) base.debug = debugLog;
    return res.status(200).json({ ...base, ...extra });
  };

  try {
    // 1. Fetch primary data
    const adData = await getAdIdDetails(IS_PROD ? [] : debugLog);

    // 2. Load submissions from Redis
    const submissions = redis ? await loadSubmissions(redis, username, isAdmin, IS_PROD ? [] : debugLog) : [];

    // 3. Load covers
    const bookIds = submissions.map(s => s.bookId).filter(Boolean);
    const covers = redis ? await loadCovers(redis, bookIds, IS_PROD ? [] : debugLog) : {};

    // Helper to strip debug from response body
    const finalize = (obj) => {
      if (IS_PROD) {
        const { debug, ...rest } = obj;
        return rest;
      }
      return obj;
    };

    if (adData) {
      let usernameCanon = null;
      if (!isAdmin) {
        const k = resolvePromoterKey(username, adData);
        if (!IS_PROD) debugLog.push(`username "${username}" → canon="${k}"`);
        usernameCanon = k;
      }
      const { byAdId, promoterEntry, promoterEntries } =
        buildAdIdLookup(adData, usernameCanon, isAdmin);

      if (isAdmin) {
        const books = [];
        const aggDaily = {};
        let totalVisits = 0, totalNew = 0, totalIncome = 0;

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
              kocName: pEntry.display_name || pCanon,
              cover: bookId ? (covers[bookId] || '') : '',
              visits: st.pull_uv || 0,
              unique_users: st.pull_uv || 0,
              new_users: st.new_uv || 0,
              d14_income: dn,
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

        if (!IS_PROD) debugLog.push(`admin primary path: ${books.length} book rows, income=$${r2(totalIncome).toFixed(2)}`);

        return res.status(200).json(finalize({
          username, isAdmin: true,
          total_visits: totalVisits,
          total_unique: totalVisits,
          total_new: totalNew,
          total_income: r2(totalIncome),
          last_updated: adData.last_updated || new Date().toISOString(),
          visits_daily, unique_daily, new_users_daily, income_daily,
          books, debug: debugLog, version: 'v6.1-security',
        }));
      }

      // NORMAL USER
      const books = [];
      const aggDaily = {};
      let missingFromPipeline = 0;
      let linkAdIds = 0, codeAdIds = 0;

      for (const sub of submissions) {
        const linkId = sub.linkId ? String(sub.linkId) : null;
        const code = sub.code ? String(sub.code) : null;

        let adIdKey = null, st = null;
        if (linkId && byAdId[linkId]) { adIdKey = linkId; st = byAdId[linkId]; }
        else if (code && byAdId[code]) { adIdKey = code; st = byAdId[code]; }
        if (!st) { st = zeroStats(); missingFromPipeline++; }

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
        if (orphanCount && !IS_PROD) debugLog.push(`synced ${orphanCount} orphan ad_id(s)`);
      }

      if (!promoterEntry) {
        if (!IS_PROD) debugLog.push(`note: no by_promoter entry for canon="${usernameCanon}"`);
      } else if (!IS_PROD) {
        debugLog.push(`promoter "${usernameCanon}": ${promoterEntry.link_count||0} links, ${promoterEntry.code_count||0} codes`);
      }
      if (missingFromPipeline && !IS_PROD) debugLog.push(`${missingFromPipeline}/${books.length} submissions not yet in pipeline`);
      if (!IS_PROD) debugLog.push(`channel breakdown: ${linkAdIds} link / ${codeAdIds} code`);

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

      return res.status(200).json(finalize({
        username, isAdmin: false,
        total_visits: totalVisits,
        total_unique: totalVisits,
        total_new: totalNew,
        total_income: totalIncome,
        last_updated: adData.last_updated || new Date().toISOString(),
        visits_daily, unique_daily, new_users_daily, income_daily,
        books, debug: debugLog, version: 'v6.1-security',
      }));
    }

    // FALLBACK: legacy data.json
    if (!IS_PROD) debugLog.push('primary ad_id_details unavailable — using legacy data.json fallback');
    const dataJson = await getLegacyDataJson(IS_PROD ? [] : debugLog);
    if (!isAdmin && !usernameCanon) usernameCanon = resolvePromoterKey(username, null);
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
      const fallbackCovers = redis && covIds.length ? await loadCovers(redis, covIds, IS_PROD ? [] : debugLog) : {};
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
      return res.status(200).json(finalize({
        username, isAdmin,
        total_visits: tv, total_unique: tv, total_new: tn, total_income: ti,
        last_updated: dataJson.last_updated || new Date().toISOString(),
        visits_daily: vd, unique_daily: ud, new_users_daily: nd, income_daily: id,
        books, debug: debugLog, version: 'v6.1-security',
      }));
    }

    return empty();

  } catch (error) {
    console.error('[my-stats] Error:', error);
    const errBody = {
      username, isAdmin,
      total_visits: 0, total_unique: 0, total_new: 0, total_income: 0,
      last_updated: null,
      visits_daily: {}, unique_daily: {}, new_users_daily: {}, income_daily: {},
      books: [], version: 'v6.1-security',
      error: IS_PROD ? 'Internal error' : error.message,
    };
    if (!IS_PROD) errBody.debug = debugLog;
    return res.status(200).json(errBody);
  }
};
