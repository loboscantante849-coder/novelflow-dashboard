const { canonizePromoter, isSystemStatsBucket } = require('./promoter-access');

const COMMISSION_EFFECTIVE_DATE = '2026-08-10';
const COMMISSION_RATE = 0.8;
const COMMISSION_MIGRATION_ID = 'commission_80_v1';

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeDaily(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const daily = {};
  for (const [date, amount] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const numeric = Number(amount);
    if (Number.isFinite(numeric)) daily[date] = roundMoney(numeric);
  }
  return daily;
}

function findIncomeRecord(data, rawUsername) {
  if (isSystemStatsBucket(rawUsername)) return { key: null, record: null };
  const users = data && data.users && typeof data.users === 'object' ? data.users : {};
  const requested = String(rawUsername || '').trim();
  const requestedLower = requested.toLowerCase();
  const requestedCanon = canonizePromoter(requested);
  for (const [key, record] of Object.entries(users)) {
    if (isSystemStatsBucket(key)) continue;
    const displayName = String(record && record.name || '').trim();
    if (key === requested || key.toLowerCase() === requestedLower ||
        displayName.toLowerCase() === requestedLower ||
        canonizePromoter(key) === requestedCanon ||
        canonizePromoter(displayName) === requestedCanon) {
      return { key, record: record && typeof record === 'object' ? record : null };
    }
  }
  return { key: null, record: null };
}

function buildIncomeProfile(data, username) {
  const { key, record } = findIncomeRecord(data, username);
  const daily = normalizeDaily(record && record.subscription_revenue_dn_daily);
  const dailyTotal = roundMoney(Object.values(daily).reduce((sum, amount) => sum + amount, 0));
  const statedTotal = Number(record && record.subscription_revenue_dn);
  const grossTotal = Number.isFinite(statedTotal) ? roundMoney(statedTotal) : dailyTotal;
  return {
    username: String(username || '').trim().toLowerCase(),
    sourceKey: key,
    grossTotal,
    daily,
    dailyTotal,
    found: Boolean(record),
  };
}

function getCommissionMigration(userData) {
  const migrations = userData && userData.balance_migrations;
  const migration = migrations && typeof migrations === 'object'
    ? migrations[COMMISSION_MIGRATION_ID]
    : null;
  if (!migration || typeof migration !== 'object' || migration.status !== 'applied') return null;
  return migration;
}

function incomeProfileReconciliation(profile) {
  if (!profile || !profile.found) return { required: false, reasons: [] };
  const grossTotal = roundMoney(profile.grossTotal);
  const dailyTotal = roundMoney(profile.dailyTotal !== undefined
    ? profile.dailyTotal
    : Object.values(profile.daily || {}).reduce((sum, amount) => sum + Number(amount || 0), 0));
  const reasons = [];
  const dailyMissing = grossTotal > 0 && Object.keys(profile.daily || {}).length === 0;
  if (dailyMissing) reasons.push('income_daily_detail_missing');
  if (dailyTotal !== grossTotal) reasons.push('income_daily_total_mismatch');
  return { required: reasons.length > 0, reasons: Array.from(new Set(reasons)) };
}

function policyDailyTotals(profile, effectiveDate, rate) {
  const entries = Object.entries(profile && profile.daily || {});
  const historicalGrossIncome = roundMoney(entries
    .filter(([date]) => date < effectiveDate)
    .reduce((sum, [, amount]) => sum + Number(amount || 0), 0));
  const postCutoffGrossIncome = roundMoney(entries
    .filter(([date]) => date >= effectiveDate)
    .reduce((sum, [, amount]) => sum + Number(amount || 0), 0));
  const postCutoffNetIncome = roundMoney(entries
    .filter(([date]) => date >= effectiveDate)
    .reduce((sum, [, amount]) => sum + roundMoney(Number(amount || 0) * rate), 0));
  return { historicalGrossIncome, postCutoffGrossIncome, postCutoffNetIncome };
}

function creditedIncome(profile, userData) {
  const migration = getCommissionMigration(userData);
  const effectiveDate = migration && /^\d{4}-\d{2}-\d{2}$/.test(String(migration.effective_date || ''))
    ? String(migration.effective_date)
    : COMMISSION_EFFECTIVE_DATE;
  const rate = migration && Number.isFinite(Number(migration.commission_rate))
    ? Number(migration.commission_rate)
    : COMMISSION_RATE;
  const reconciliation = incomeProfileReconciliation(profile);
  const dailyTotals = policyDailyTotals(profile, effectiveDate, rate);
  let postCutoffGrossIncome = dailyTotals.postCutoffGrossIncome;
  let credited = migration
    ? dailyTotals.postCutoffNetIncome
    : roundMoney(dailyTotals.historicalGrossIncome + dailyTotals.postCutoffNetIncome);

  if (reconciliation.required && migration) {
    if (Object.keys(profile && profile.daily || {}).some(date => date >= effectiveDate)) {
      // Match the pre-repair wallet value without treating missing income as
      // settled. The reconciliation flag prevents this amount being withdrawn.
      credited = dailyTotals.postCutoffNetIncome;
    } else {
      const historicalGross = Number(migration.historical_gross_income);
      if (Number.isFinite(historicalGross)) {
        postCutoffGrossIncome = roundMoney(Math.max(0, (profile && profile.grossTotal || 0) - historicalGross));
        credited = roundMoney(postCutoffGrossIncome * rate);
      }
    }
  } else if (reconciliation.required) {
    // Preserve the previously displayed wallet total while the source is under
    // review. This amount is explicitly unsettled and cannot be withdrawn.
    credited = roundMoney(profile && profile.grossTotal);
  }

  return {
    mode: reconciliation.required
      ? `${COMMISSION_MIGRATION_ID}_reconciliation_required`
      : (migration ? COMMISSION_MIGRATION_ID : `${COMMISSION_MIGRATION_ID}_daily`),
    effectiveDate,
    commissionRate: rate,
    creditedIncome: credited,
    postCutoffGrossIncome,
    reconciliationRequired: reconciliation.required,
    reconciliationReasons: reconciliation.reasons,
  };
}

function splitStoredBonus(userData) {
  const bonusBalance = roundMoney(userData && userData.bonus_balance);
  const migration = getCommissionMigration(userData);
  const historical = Number(migration && migration.historical_gross_income);
  const legacyCarryover = Number.isFinite(historical) ? roundMoney(Math.max(0, historical)) : 0;
  const classificationRequired = legacyCarryover > bonusBalance;
  return {
    bonus_balance: bonusBalance,
    legacy_earnings_carryover: legacyCarryover,
    reward_income_total: roundMoney(Math.max(0, bonusBalance - legacyCarryover)),
    classification_reconciliation_required: classificationRequired,
  };
}

function withdrawalTotals(userData) {
  const withdrawals = Array.isArray(userData && userData.withdrawals) ? userData.withdrawals : [];
  const totals = { approved: 0, pending: 0, rejected: 0, unknown: [] };
  for (const withdrawal of withdrawals) {
    if (!withdrawal || typeof withdrawal !== 'object') {
      totals.unknown.push(withdrawal);
      continue;
    }
    const status = String(withdrawal.status || 'pending').trim().toLowerCase();
    const amount = Number(withdrawal.amount);
    if (!Number.isFinite(amount) || amount < 0 || !['approved', 'pending', 'rejected'].includes(status)) {
      totals.unknown.push(withdrawal);
      continue;
    }
    totals[status] += amount;
  }
  totals.approved = roundMoney(totals.approved);
  totals.pending = roundMoney(totals.pending);
  totals.rejected = roundMoney(totals.rejected);
  return { withdrawals, ...totals };
}

function computeWalletBalances(userData, incomeProfile, incomeAdjustment = 0) {
  const stored = splitStoredBonus(userData);
  const bonus = stored.bonus_balance;
  const adjustment = roundMoney(incomeAdjustment);
  const income = creditedIncome(incomeProfile, userData);
  const totals = withdrawalTotals(userData);
  const reconciliationReasons = [
    ...(income.reconciliationReasons || []),
    ...(stored.classification_reconciliation_required ? ['legacy_carryover_exceeds_stored_bonus'] : []),
  ];
  const reconciliationRequired = Boolean(income.reconciliationRequired || stored.classification_reconciliation_required);
  const totalEarned = roundMoney(bonus + income.creditedIncome + adjustment);
  const available = roundMoney(Math.max(0, totalEarned - totals.approved - totals.pending));
  return {
    bonus_balance: bonus,
    total_earned: totalEarned,
    source_total_dn_income: roundMoney(incomeProfile && incomeProfile.grossTotal),
    gross_dn_income: roundMoney(incomeProfile && incomeProfile.grossTotal),
    income_adjustment: adjustment,
    total_dn_income: income.creditedIncome,
    commission_income: income.creditedIncome,
    commission_rate: income.commissionRate,
    commission_effective_date: income.effectiveDate,
    commission_mode: income.mode,
    post_cutoff_gross_income: income.postCutoffGrossIncome,
    reconciliation_required: reconciliationRequired,
    reconciliation_status: reconciliationRequired ? 'required' : 'ok',
    reconciliation_reasons: reconciliationReasons,
    approved_total: totals.approved,
    withdrawn_total: totals.approved,
    pending_total: totals.pending,
    pending_withdrawal_total: totals.pending,
    frozen_total: totals.pending,
    rejected_total: totals.rejected,
    available_balance: available,
    withdrawable_balance: available,
    promotion_income_total: income.creditedIncome,
    legacy_earnings_carryover: stored.legacy_earnings_carryover,
    reward_income_total: stored.reward_income_total,
    pending_settlement: totals.pending,
    wallet_anomaly_count: totals.unknown.length,
    withdrawals: totals.withdrawals.slice().sort((a, b) => String(b && b.created_at || '').localeCompare(String(a && a.created_at || ''))),
  };
}

function buildEarningsDetail(profile, userData, limit = 30) {
  const migration = getCommissionMigration(userData);
  const effectiveDate = migration && /^\d{4}-\d{2}-\d{2}$/.test(String(migration.effective_date || ''))
    ? String(migration.effective_date)
    : COMMISSION_EFFECTIVE_DATE;
  const rate = migration && Number.isFinite(Number(migration.commission_rate))
    ? Number(migration.commission_rate)
    : COMMISSION_RATE;
  return Object.entries(profile && profile.daily || {})
    .map(([date, gross]) => ({
      date,
      gross_amount: roundMoney(gross),
      amount: roundMoney(gross * (date >= effectiveDate ? rate : 1)),
      commission_rate: date >= effectiveDate ? rate : 1,
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

function historicalGrossBefore(profile, effectiveDate = COMMISSION_EFFECTIVE_DATE) {
  return roundMoney(Object.entries(profile && profile.daily || {})
    .filter(([date]) => date < effectiveDate)
    .reduce((sum, [, amount]) => sum + amount, 0));
}

module.exports = {
  COMMISSION_EFFECTIVE_DATE,
  COMMISSION_MIGRATION_ID,
  COMMISSION_RATE,
  buildEarningsDetail,
  buildIncomeProfile,
  computeWalletBalances,
  creditedIncome,
  findIncomeRecord,
  getCommissionMigration,
  historicalGrossBefore,
  incomeProfileReconciliation,
  roundMoney,
  splitStoredBonus,
  withdrawalTotals,
};
