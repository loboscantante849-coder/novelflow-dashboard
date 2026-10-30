'use strict';

// Server-reviewed ownership, not amounts. Reapply it to each new report so a
// legacy Redis mapping cannot erase verified assets on the next pipeline run.
// Never infer ownership from client CloudSync or from a similar-looking name.
const reviews = require('./reviewed-attribution.json');
const { roundMoney } = require('./commission-policy');
const { applyRecoveredIncome } = require('./recovered-income');
const normalized = value => String(value || '').trim().toLowerCase();

function applyReviewedAttribution(snapshot) {
  if (!snapshot?.ad_ids || !snapshot?.by_promoter) return snapshot;
  const adIds = { ...snapshot.ad_ids };
  const promoters = { ...snapshot.by_promoter };
  const issues = {};
  for (const [owner, review] of Object.entries(reviews)) {
    const conflicts = [];
    for (const asset of review.assets) {
      for (const [id, channel] of [[asset.linkId, 'link'], [asset.code, 'code']]) {
        const row = adIds[id];
        if (!row) continue; // No activity in this report; never invent zero rows.
        const foreignIndex = Object.entries(snapshot.by_promoter).some(([key, p]) =>
          key !== owner && [...(p.links || []), ...(p.codes || [])].map(String).includes(id));
        if ((row.username_canon && normalized(row.username_canon) !== owner) ||
            (row.username && normalized(row.username) !== owner) || foreignIndex ||
            (row.book_id && row.book_id !== asset.bookId) ||
            (row.media_source && row.media_source !== channel) ||
            (row.channel && row.channel !== channel)) {
          conflicts.push(id);
          continue;
        }
        adIds[id] = { ...row, username: review.display_name, username_canon: owner,
          book_id: asset.bookId, book_name: asset.bookName };
      }
    }
    const owned = Object.entries(adIds).filter(([, row]) => row.username_canon === owner);
    const entry = { ...(promoters[owner] || {}), display_name: review.display_name,
      links: [], codes: [], invites: [], books: [], total_uv: 0, total_new: 0, total_dn: 0 };
    const books = new Map();
    for (const [id, row] of owned) {
      const channel = row.media_source || row.channel;
      const field = { link: 'links', code: 'codes', invite: 'invites' }[channel];
      if (!field) continue;
      entry[field].push(channel === 'invite' ? id.replace(/^invite:/, '') : id);
      const stats = row.stats || {};
      entry.total_uv += Number(stats.pull_uv) || 0;
      entry.total_new += Number(stats.new_uv) || 0;
      entry.total_dn += Number(stats.dn_income) || 0;
      const key = row.book_id || row.book_name || id;
      if (!books.has(key)) books.set(key, { name: row.book_name || 'Unknown', ad_ids: [], uv: 0, new: 0, dn: 0 });
      const book = books.get(key);
      book.ad_ids.push(id);
      book.uv += Number(stats.pull_uv) || 0;
      book.new += Number(stats.new_uv) || 0;
      book.dn += Number(stats.dn_income) || 0;
    }
    if (owned.length) {
      entry.total_dn = roundMoney(entry.total_dn);
      entry.books = [...books.values()].map(book => ({ ...book, dn: roundMoney(book.dn) }));
      entry.link_count = entry.links.length;
      entry.code_count = entry.codes.length;
      entry.invite_count = entry.invites.length;
      promoters[owner] = entry;
    }
    issues[owner] = conflicts;
  }
  const mapped = Object.values(adIds).filter(row => row.username_canon).length;
  return { ...snapshot, ad_ids: adIds, by_promoter: promoters,
    mapped_ad_ids: mapped, unmapped_ad_ids: Object.keys(adIds).length - mapped,
    reviewed_attribution_issues: issues };
}

// Use the same asset snapshot as My Stats. The old recovery is evidence of
// ownership, not another payment: when its assets are covered, do not add its
// stored amount again. Retain the previous calculation and block settlement
// when we cannot account for every recovered asset or the full daily history.
function reviewedIncomeProfile(base, recovered, snapshot, username) {
  const owner = normalized(username);
  const review = reviews[owner];
  if (!review) return applyRecoveredIncome(base, recovered);
  const fallback = reason => ({ ...applyRecoveredIncome(base, recovered),
    reconciliationReasons: ['reviewed_attribution_' + reason] });
  if (!snapshot?.ad_ids || !snapshot.reviewed_attribution_issues ||
      snapshot.reviewed_attribution_issues[owner]?.length) return fallback('unavailable_or_conflicting');
  if (!snapshot.date_range?.from || snapshot.date_range.from > review.history_from) return fallback('history_incomplete');

  const owned = Object.entries(snapshot.ad_ids).filter(([, row]) => row.username_canon === owner);
  const ids = new Set(owned.map(([id]) => id));
  if (recovered) {
    const assets = recovered.assets || [];
    const recoveredIds = new Set(assets.map(asset => String(asset.ad_id || '')));
    if (!assets.length || recoveredIds.size !== assets.length ||
        [...recoveredIds].some(id => !ids.has(id))) return fallback('recovery_assets_incomplete');
    if (assets.some(asset => !Number.isFinite(Number(asset.dn_income))) ||
        roundMoney(assets.reduce((sum, asset) => sum + Number(asset.dn_income), 0)) !== roundMoney(recovered.total) ||
        roundMoney(Object.values(recovered.daily || {}).reduce((sum, amount) => sum + Number(amount), 0)) !== roundMoney(recovered.total)) {
      return fallback('recovery_total_mismatch');
    }
  }
  const daily = {};
  let total = 0, d14 = 0;
  for (const [, row] of owned) {
    const amount = Number(row.stats?.dn_income);
    if (!Number.isFinite(amount)) return fallback('invalid_income');
    const days = Array.isArray(row.daily) ? row.daily
      : Object.entries(row.daily || {}).map(([dt, value]) => ({ ...value, dt }));
    let assetTotal = 0;
    for (const day of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.dt) || !Number.isFinite(Number(day.dn_income))) return fallback('invalid_daily');
      assetTotal += Number(day.dn_income);
      daily[day.dt] = roundMoney((daily[day.dt] || 0) + Number(day.dn_income));
    }
    if (roundMoney(assetTotal) !== roundMoney(amount)) return fallback('daily_total_mismatch');
    total += amount;
    d14 += Number(row.stats?.d14_income) || 0;
  }
  total = roundMoney(total);
  if (!owned.length || total < base.grossTotal) return fallback('base_income_missing');
  return { ...base, sourceKey: owner, found: true, daily,
    dailyTotal: roundMoney(Object.values(daily).reduce((sum, amount) => sum + amount, 0)),
    grossTotal: total, grossD14Total: roundMoney(d14), grossAfterD14Total: roundMoney(Math.max(0, total - d14)),
    recoveredIncome: roundMoney(total - base.grossTotal), recoveredAssets: recovered?.assets?.length || 0,
    recoveredComputedAt: snapshot.last_updated, attributionMode: 'reviewed_assets_live' };
}

module.exports = { applyReviewedAttribution, reviewedIncomeProfile };
