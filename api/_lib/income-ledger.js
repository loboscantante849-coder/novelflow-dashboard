'use strict';

const { roundMoney, applyDisplayCommission } = require('./commission-policy');
const { isSystemStatsBucket } = require('./promoter-access');
const { RECOVERED_INCOME_PREFIX } = require('./recovered-income');

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const money = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value)) && Number.isSafeInteger(Math.round(Number(value) * 100));
function record(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid attribution record');
  return parsed;
}
function assetKey(id, channel) {
  const value = String(id || '').trim();
  if (!value || value === 'undefined' || value === 'null') return '';
  return channel === 'invite' && !value.startsWith('invite:') ? `invite:${value}` : value;
}

/** Pure reconciliation. Every source+asset ID is credited to at most one source. */
function buildIncomeLedger(snapshot, submissions = {}, recoveryRecords = {}, equityRecords = {}) {
  if (!snapshot?.ad_ids || !snapshot?.by_promoter) throw new Error('Income snapshot unavailable');
  const { createPromoterKeyResolver } = require('./promoter-resolution');
  const resolveSource = createPromoterKeyResolver(snapshot);
  const claims = new Map(), metadata = new Map(), issues = new Map(), recoveries = new Map();
  const rawOwners = new Map();
  const sourceOf = name => isSystemStatsBucket(name) ? null : resolveSource(name);
  function issue(owner, reason) {
    if (!owner || isSystemStatsBucket(owner)) return;
    if (!issues.has(owner)) issues.set(owner, new Set());
    issues.get(owner).add(reason);
  }
  function claim(id, owner, meta = {}, rawOwner = owner) {
    if (!id || !owner) return;
    if (!claims.has(id)) claims.set(id, new Set());
    claims.get(id).add(owner);
    const previous = metadata.get(id) || {};
    if (previous.book_id && meta.book_id && previous.book_id !== meta.book_id) issue(owner, `asset_book_mismatch:${id}`);
    metadata.set(id, { ...Object.fromEntries(Object.entries(meta).filter(([, value]) => value)), ...previous });
    if (!rawOwners.has(owner)) rawOwners.set(owner, String(rawOwner || owner));
  }
  for (const [owner, entry] of Object.entries(snapshot.by_promoter)) {
    if (isSystemStatsBucket(owner)) continue;
    rawOwners.set(owner, owner);
    for (const id of entry.links || []) claim(String(id), owner);
    for (const id of entry.codes || []) claim(String(id), owner);
    for (const id of entry.invites || []) claim(assetKey(id, 'invite'), owner);
  }
  for (const [id, row] of Object.entries(snapshot.ad_ids)) {
    if (row.username_canon && !isSystemStatsBucket(row.username_canon)) {
      claim(id, row.username_canon, {}, row.username || row.username_canon);
      if (row.username) rawOwners.set(row.username_canon, row.username);
    }
  }
  for (const [key, raw] of Object.entries(submissions || {})) {
    if (key.startsWith('_pending_')) continue;
    let sub;
    try { sub = record(raw); } catch (_) { continue; }
    const rawOwner = sub.discordUsername || sub.username;
    if (!rawOwner || String(rawOwner).toLowerCase() === 'anonymous' ||
        ['pending', 'awaiting_confirmation', 'failed', 'rejected', 'error'].includes(String(sub.status || '').toLowerCase())) continue;
    const owner = sourceOf(rawOwner);
    const meta = { raw_owner: rawOwner, book_id: sub.bookId || null, book_name: sub.matchedBookName || sub.bookName || null };
    for (const id of [assetKey(sub.linkId, 'link'), sub.inviteCode
      ? assetKey(sub.inviteCode, 'invite') : assetKey(sub.code, 'code')]) claim(id, owner, meta, rawOwner);
  }
  for (const [key, raw] of Object.entries(equityRecords)) {
    const rawOwner = key.replace(/^nf_equity_code:/, '');
    const owner = sourceOf(rawOwner);
    let equity;
    try { equity = record(raw); } catch (_) { issue(owner, 'equity_record_invalid'); continue; }
    if (equity.code && equity.bookId && equity.status !== 'unbound') {
      claim(assetKey(equity.code, 'invite'), owner,
        { raw_owner: rawOwner, book_id: equity.bookId, book_name: equity.bookTitle || null }, rawOwner);
    }
  }
  for (const [key, raw] of Object.entries(recoveryRecords)) {
    const rawOwner = key.replace(RECOVERED_INCOME_PREFIX, '');
    const owner = sourceOf(rawOwner);
    if (!owner) continue;
    let recovery;
    try { recovery = record(raw); } catch (_) { issue(owner, 'recovery_record_invalid'); continue; }
    const assets = Array.isArray(recovery.assets) ? recovery.assets : [];
    const daily = recovery.daily;
    const total = recovery.total;
    if (!daily || typeof daily !== 'object' || Array.isArray(daily) || !money(total) ||
        Object.entries(daily).some(([date, amount]) => !datePattern.test(date) || !money(amount)) ||
        roundMoney(Object.values(daily).reduce((sum, amount) => sum + Number(amount), 0)) !== roundMoney(total)) {
      issue(owner, 'recovery_record_invalid'); continue;
    }
    if (!assets.length && Number(total) === 0) continue;
    const ids = assets.map(asset => assetKey(asset?.ad_id, asset?.channel));
    if (!assets.length || ids.some(id => !id) || new Set(ids).size !== ids.length ||
        assets.some(asset => !asset || !money(asset.dn_income)) ||
        roundMoney(assets.reduce((sum, asset) => sum + Number(asset.dn_income), 0)) !== roundMoney(total)) {
      issue(owner, 'recovery_assets_invalid'); continue;
    }
    if (!recoveries.has(owner)) recoveries.set(owner, []);
    recoveries.get(owner).push(recovery);
    for (const id of ids) {
      claim(id, owner, { raw_owner: rawOwner }, rawOwner);
      if (!snapshot.ad_ids[id]) issue(owner, 'recovered_asset_missing');
    }
    const dates = Object.keys(daily).sort();
    if (dates.length && (!snapshot.date_range?.from || !snapshot.date_range?.to ||
        snapshot.date_range.from > dates[0] || snapshot.date_range.to < dates.at(-1))) issue(owner, 'recovery_history_incomplete');
  }
  for (const [owner, entry] of Object.entries(snapshot.by_promoter)) {
    for (const id of [...(entry.links || []), ...(entry.codes || []), ...(entry.invites || []).map(id => assetKey(id, 'invite'))]) {
      if (!snapshot.ad_ids[String(id)]) issue(owner, `reported_asset_missing:${id}`);
    }
  }
  for (const [owner, conflicts] of Object.entries(snapshot.reviewed_attribution_issues || {})) {
    for (const id of conflicts) issue(owner, `asset_conflict:${id}`);
  }

  for (const [owner, from] of Object.entries(snapshot.attribution_history_from || {})) {
    if (!snapshot.date_range?.from || snapshot.date_range.from > from) issue(owner, 'attribution_history_incomplete');
  }

  const adIds = Object.create(null), promoters = Object.create(null), profiles = Object.create(null), conflicts = Object.create(null);
  function ensure(owner) {
    if (!profiles[owner]) {
      profiles[owner] = { username: owner, sourceKey: owner, found: true, daily: {}, dailyTotal: 0,
        grossTotal: 0, grossD14Total: 0, grossAfterD14Total: 0, assetIds: [], attributionMode: 'verified_asset_ledger' };
      promoters[owner] = { display_name: snapshot.by_promoter[owner]?.display_name || rawOwners.get(owner) || owner,
        links: [], codes: [], invites: [], books: [], total_uv: 0, total_new: 0, total_dn: 0 };
    }
    return profiles[owner];
  }
  for (const owner of Object.keys(snapshot.by_promoter)) if (!isSystemStatsBucket(owner)) ensure(owner);
  for (const [id, row] of Object.entries(snapshot.ad_ids)) {
    const owners = claims.get(id) || new Set();
    if (owners.size > 1) {
      conflicts[id] = [...owners];
      for (const owner of owners) issue(owner, `asset_conflict:${id}`);
      adIds[id] = { ...row, username: null, username_canon: null };
      continue;
    }
    if (!owners.size) { adIds[id] = row; continue; }
    const [owner] = owners;
    const meta = metadata.get(id) || {};
    if (meta.book_id && row.book_id && meta.book_id !== row.book_id) issue(owner, `asset_book_mismatch:${id}`);
    const channel = id.startsWith('invite:') ? 'invite' : (row.media_source || row.channel || (/^\d+$/.test(id) ? 'code' : 'link'));
    if ((row.media_source && row.media_source !== channel) || (row.channel && row.channel !== channel)) issue(owner, `asset_channel_mismatch:${id}`);
    adIds[id] = { ...row, username_canon: owner, username: row.username || meta.raw_owner || rawOwners.get(owner) || owner,
      book_id: row.book_id || meta.book_id || null, book_name: row.book_name || meta.book_name || null };
    const profile = ensure(owner), entry = promoters[owner];
    profile.assetIds.push(id);
    const field = { link: 'links', code: 'codes', invite: 'invites' }[channel];
    if (!field) { issue(owner, `asset_channel_invalid:${id}`); continue; }
    entry[field].push(channel === 'invite' ? id.slice(7) : id);
    entry.total_uv += Number(row.stats?.pull_uv) || 0;
    entry.total_new += Number(row.stats?.new_uv) || 0;
    const amount = row.stats?.dn_income;
    if (!money(amount)) { issue(owner, `asset_income_invalid:${id}`); continue; }
    profile.grossTotal += Number(amount);
    profile.grossD14Total += Number(row.stats?.d14_income) || 0;
    const days = Array.isArray(row.daily) ? row.daily : Object.entries(row.daily || {}).map(([dt, value]) => ({ ...value, dt }));
    let dailyTotal = 0;
    const seenDates = new Set();
    for (const day of days) {
      if (!day || !datePattern.test(day.dt) || !money(day.dn_income) || seenDates.has(day.dt)) {
        issue(owner, `asset_daily_invalid:${id}`); continue;
      }
      seenDates.add(day.dt);
      const amount = Number(day.dn_income);
      dailyTotal += amount;
      profile.daily[day.dt] = roundMoney((profile.daily[day.dt] || 0) + amount);
    }
    if (roundMoney(dailyTotal) !== roundMoney(amount)) issue(owner, `asset_daily_mismatch:${id}`);
  }
  for (const [owner, entry] of Object.entries(snapshot.by_promoter)) {
    if (isSystemStatsBucket(owner) || entry.total_dn === undefined) continue;
    const ids = new Set([...(entry.links || []), ...(entry.codes || []), ...(entry.invites || []).map(id => assetKey(id, 'invite'))].map(String));
    for (const [id, row] of Object.entries(snapshot.ad_ids)) if (row.username_canon === owner) ids.add(id);
    const expected = [...ids].reduce((sum, id) => sum + (Number(snapshot.ad_ids[id]?.stats?.dn_income) || 0), 0);
    if (!money(entry.total_dn) || roundMoney(expected) !== roundMoney(entry.total_dn)) issue(owner, 'reported_income_total_mismatch');
  }
  for (const owner of issues.keys()) ensure(owner);
  for (const owner of recoveries.keys()) ensure(owner);
  for (const [owner, profile] of Object.entries(profiles)) {
    if (!money(profile.grossTotal) || !money(Object.values(profile.daily).reduce((sum, value) => sum + value, 0))) issue(owner, 'income_total_invalid');
    profile.grossTotal = roundMoney(profile.grossTotal);
    profile.grossD14Total = roundMoney(profile.grossD14Total);
    profile.grossAfterD14Total = roundMoney(Math.max(0, profile.grossTotal - profile.grossD14Total));
    profile.dailyTotal = roundMoney(Object.values(profile.daily).reduce((sum, value) => sum + value, 0));
    profile.displayIncome = roundMoney(Object.values(profile.daily).reduce((sum, value) => sum + applyDisplayCommission(value), 0));
    profile.reconciliationReasons = [...(issues.get(owner) || [])];
    const entry = promoters[owner];
    entry.total_dn = profile.grossTotal;
    entry.link_count = entry.links.length; entry.code_count = entry.codes.length; entry.invite_count = entry.invites.length;
    const books = new Map();
    for (const id of profile.assetIds) {
      const row = adIds[id], key = row.book_id || row.book_name || id;
      if (!books.has(key)) books.set(key, { name: row.book_name || 'Unknown', ad_ids: [], uv: 0, new: 0, dn: 0 });
      const book = books.get(key);
      book.ad_ids.push(id); book.uv += Number(row.stats?.pull_uv) || 0;
      book.new += Number(row.stats?.new_uv) || 0; book.dn = roundMoney(book.dn + (Number(row.stats?.dn_income) || 0));
    }
    entry.books = [...books.values()];
  }
  const mapped = Object.values(adIds).filter(row => row.username_canon && !isSystemStatsBucket(row.username_canon)).length;
  return { adData: { ...snapshot, ad_ids: adIds, by_promoter: promoters, income_ledger: true, attribution_conflicts: conflicts,
    mapped_ad_ids: mapped, unmapped_ad_ids: Object.keys(adIds).length - mapped }, profiles,
  profileFor(username) {
    const source = sourceOf(username);
    return profiles[source] || { username: source, sourceKey: source, found: false, daily: {}, dailyTotal: 0,
      grossTotal: 0, grossD14Total: 0, grossAfterD14Total: 0, displayIncome: 0, assetIds: [], reconciliationReasons: [] };
  } };
}

// One bounded load per request. Bulk wallet callers reuse the returned ledger;
// no persistent cache is used when validating a withdrawal or its approval.
async function loadIncomeLedger(redis, snapshot) {
  if (!redis) throw new Error('Attribution storage unavailable');
  const submissions = await redis.hgetall('nf_subs') || {};
  if (typeof submissions !== 'object' || Array.isArray(submissions)) throw new Error('Invalid submission index');
  async function loadRecords(prefix) {
    let cursor = '0'; const keys = new Set(); let pages = 0;
    do {
      if (++pages > 1000) throw new Error('Attribution index exceeded bounded scan');
      const result = await redis.scan(cursor, { match: `${prefix}*`, count: 1000 });
      if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) throw new Error('Invalid attribution index');
      cursor = String(result[0]);
      for (const key of result[1]) if (String(key).startsWith(prefix)) keys.add(String(key));
    } while (cursor !== '0');
    const records = {}, list = [...keys];
    for (let i = 0; i < list.length; i += 200) {
      const batch = list.slice(i, i + 200);
      const values = await redis.mget(...batch);
      if (!Array.isArray(values) || values.length !== batch.length) throw new Error('Invalid attribution records');
      batch.forEach((key, index) => { if (values[index] != null) records[key] = values[index]; });
    }
    return records;
  }
  const [recoveries, equities] = await Promise.all([
    loadRecords(RECOVERED_INCOME_PREFIX), loadRecords('nf_equity_code:'),
  ]);
  return buildIncomeLedger(snapshot, submissions, recoveries, equities);
}

module.exports = { buildIncomeLedger, loadIncomeLedger };
