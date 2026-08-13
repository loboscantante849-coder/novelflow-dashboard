const { isSystemStatsBucket } = require('./promoter-access');
const { resolvePromoterKey } = require('./stats-data');

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function grossIncomeSince(adData, promoterKey, effectiveDate) {
  if (!adData || !promoterKey || isSystemStatsBucket(promoterKey)) return { gross: 0, days: 0 };
  let gross = 0;
  const days = new Set();
  const promoterEntry = adData.by_promoter && adData.by_promoter[promoterKey];
  const inviteAssets = ((promoterEntry && promoterEntry.invites) || [])
    .map(value => `invite:${String(value).replace(/^invite:/, '')}`);
  const allowedAssets = new Set([
    ...((promoterEntry && promoterEntry.links) || []).map(String),
    ...((promoterEntry && promoterEntry.codes) || []).map(String),
    ...inviteAssets,
  ]);
  for (const [assetKey, entry] of Object.entries(adData.ad_ids || {})) {
    const taggedOwner = String(entry && entry.username_canon || '').toLowerCase();
    const assetId = String(entry && (entry.ad_id || entry.id || assetKey) || '');
    const channel = String(entry && (entry.channel || entry.media_source) || '').toLowerCase();
    const qualifiedAsset = channel === 'invite' || String(assetKey).startsWith('invite:')
      ? `invite:${assetId.replace(/^invite:/, '')}`
      : assetId;
    if (allowedAssets.size && !allowedAssets.has(qualifiedAsset) && taggedOwner !== promoterKey) continue;
    if (!allowedAssets.size && taggedOwner !== promoterKey) continue;
    const dailyRows = Array.isArray(entry.daily)
      ? entry.daily
      : Object.entries(entry.daily || {}).map(([dt, values]) => ({ dt, ...(values || {}) }));
    for (const row of dailyRows) {
      const date = String(row && row.dt || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < effectiveDate) continue;
      gross += Number(row.dn_income) || 0;
      days.add(date);
    }
  }
  return { gross: roundMoney(gross), days: days.size };
}

function referralCommissionStatement(adData, relationship, application, commissionRate = 0.05) {
  if (!relationship || !application || application.status !== 'active') return null;
  const parent = String(relationship.parent || '').trim().toLowerCase();
  const child = String(relationship.child || '').trim().toLowerCase();
  if (!parent || !child || parent === child) return null;
  const effectiveAt = [relationship.bound_at, application.created_at].filter(Boolean).sort().at(-1);
  if (!effectiveAt) return null;
  const effectiveDate = String(effectiveAt).slice(0, 10);
  const promoterKey = resolvePromoterKey(child, adData);
  const income = grossIncomeSince(adData, promoterKey, effectiveDate);
  return {
    parent,
    child,
    effective_at: effectiveAt,
    effective_date: effectiveDate,
    child_promoter_key: promoterKey && !isSystemStatsBucket(promoterKey) ? promoterKey : '',
    gross_dn_income: income.gross,
    commission_rate: commissionRate,
    commission_accrued_cumulative: roundMoney(income.gross * commissionRate),
    covered_days: income.days,
  };
}

module.exports = { grossIncomeSince, referralCommissionStatement, roundMoney };
