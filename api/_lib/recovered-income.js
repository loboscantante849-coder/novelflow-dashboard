'use strict';

// Recovered CPS income for a member.
//
// Some legacy promotion codes were created before the reporting pipeline
// recorded an owner, so the ad platform reports their revenue with no
// username. The member's own submission rows still identify those assets.
// An operator runs the recovery tool once; it stores the per-day net income
// here so the wallet is computed from the recovered data instead of a
// hand-entered correction. Nothing in this module can grant an amount that the
// recovery tool did not already reconcile against a real asset.
const RECOVERED_INCOME_PREFIX = 'nf_recovered_income:';

function roundMoney(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

function normalizeDaily(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const daily = {};
  for (const [date, amount] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const numeric = Number(amount);
    if (Number.isFinite(numeric) && numeric !== 0) daily[date] = roundMoney(numeric);
  }
  return daily;
}

function parseRecoveredRecord(raw) {
  if (raw === null || raw === undefined) return null;
  let record = raw;
  if (typeof raw === 'string') {
    try { record = JSON.parse(raw); } catch (_error) { return null; }
  }
  if (!record || typeof record !== 'object') return null;
  const daily = normalizeDaily(record.daily);
  const total = roundMoney(record.total !== undefined
    ? record.total
    : Object.values(daily).reduce((sum, amount) => sum + amount, 0));
  if (!total && !Object.keys(daily).length) return null;
  return {
    daily,
    total,
    assets: Array.isArray(record.assets) ? record.assets : [],
    source: record.source || 'recovered_submission_evidence',
    computed_at: record.computed_at || null,
    adjusted_at: record.adjusted_at || null,
  };
}

/**
 * Load recovered income for the first candidate spelling that has one.
 * Candidates should include the login spelling and the reporting key.
 */
async function loadRecoveredIncome(redis, usernames) {
  if (!redis || typeof redis.get !== 'function') return null;
  const candidates = Array.from(new Set((Array.isArray(usernames) ? usernames : [usernames])
    .map(name => String(name || '').trim().toLowerCase())
    .filter(Boolean)));
  for (const name of candidates) {
    let raw;
    try {
      raw = await redis.get(`${RECOVERED_INCOME_PREFIX}${name}`);
    } catch (_error) {
      continue;
    }
    const record = parseRecoveredRecord(raw);
    if (record) return { ...record, key: `${RECOVERED_INCOME_PREFIX}${name}`, username: name };
  }
  return null;
}

/**
 * Fold recovered income into an income profile. Recovered days keep their real
 * dates, so the commission policy still treats pre-cutoff income as carryover
 * and post-cutoff income at the current rate.
 */
function applyRecoveredIncome(profile, recovered) {
  if (!profile || !recovered) return profile;
  const daily = { ...(profile.daily || {}) };
  let added = 0;
  for (const [date, amount] of Object.entries(recovered.daily)) {
    daily[date] = roundMoney((Number(daily[date]) || 0) + amount);
    added = roundMoney(added + amount);
  }
  if (!added) return profile;
  return {
    ...profile,
    daily,
    dailyTotal: roundMoney((Number(profile.dailyTotal) || 0) + added),
    grossTotal: roundMoney((Number(profile.grossTotal) || 0) + added),
    found: true,
    recoveredIncome: added,
    recoveredAssets: recovered.assets.length,
    recoveredComputedAt: recovered.computed_at,
  };
}

module.exports = {
  RECOVERED_INCOME_PREFIX,
  applyRecoveredIncome,
  loadRecoveredIncome,
  normalizeDaily,
  parseRecoveredRecord,
};
