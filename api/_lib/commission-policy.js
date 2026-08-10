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

function isPostCutoffOnlyProfile(profile) {
  const daily = profile && profile.daily || {};
  const entries = Object.entries(daily).filter(([, amount]) => Math.abs(Number(amount) || 0) > 0.0001);
  if (!entries.length || entries.some(([date]) => date < COMMISSION_EFFECTIVE_DATE)) return false;
  const dailyTotal = roundMoney(entries.reduce((sum, [, amount]) => sum + Number(amount || 0), 0));
  return dailyTotal === roundMoney(profile && profile.grossTotal);
}

function creditedIncome(profile, userData) {
  const migration = getCommissionMigration(userData);
  if (!migration) {
    if (isPostCutoffOnlyProfile(profile)) {
      const postCutoffGrossIncome = roundMoney(profile && profile.grossTotal);
      return {
        mode: `${COMMISSION_MIGRATION_ID}_new`,
        effectiveDate: COMMISSION_EFFECTIVE_DATE,
        commissionRate: COMMISSION_RATE,
        creditedIncome: roundMoney(Object.values(profile.daily)
          .reduce((sum, amount) => sum + roundMoney(Number(amount || 0) * COMMISSION_RATE), 0)),
        postCutoffGrossIncome,
      };
    }
    return {
      mode: 'legacy_100',
      effectiveDate: null,
      commissionRate: 1,
      creditedIncome: roundMoney(profile && profile.grossTotal),
      postCutoffGrossIncome: 0,
    };
  }

  const effectiveDate = /^\d{4}-\d{2}-\d{2}$/.test(String(migration.effective_date || ''))
    ? String(migration.effective_date)
    : COMMISSION_EFFECTIVE_DATE;
  const rate = Number.isFinite(Number(migration.commission_rate))
    ? Number(migration.commission_rate)
    : COMMISSION_RATE;
  const daily = profile && profile.daily || {};
  const postDates = Object.keys(daily).filter(date => date >= effectiveDate);
  let postCutoffGrossIncome;
  let netIncome;

  if (postDates.length) {
    postCutoffGrossIncome = roundMoney(postDates.reduce((sum, date) => sum + daily[date], 0));
    netIncome = roundMoney(postDates.reduce((sum, date) => sum + roundMoney(daily[date] * rate), 0));
  } else {
    const historicalGross = Number(migration.historical_gross_income);
    postCutoffGrossIncome = Number.isFinite(historicalGross)
      ? roundMoney(Math.max(0, (profile && profile.grossTotal || 0) - historicalGross))
      : 0;
    netIncome = roundMoney(postCutoffGrossIncome * rate);
  }

  return {
    mode: COMMISSION_MIGRATION_ID,
    effectiveDate,
    commissionRate: rate,
    creditedIncome: netIncome,
    postCutoffGrossIncome,
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
  const bonus = roundMoney(userData && userData.bonus_balance);
  const adjustment = roundMoney(incomeAdjustment);
  const income = creditedIncome(incomeProfile, userData);
  const totals = withdrawalTotals(userData);
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
    approved_total: totals.approved,
    pending_total: totals.pending,
    frozen_total: totals.pending,
    rejected_total: totals.rejected,
    available_balance: available,
    pending_settlement: totals.pending,
    wallet_anomaly_count: totals.unknown.length,
    withdrawals: totals.withdrawals.slice().sort((a, b) => String(b && b.created_at || '').localeCompare(String(a && a.created_at || ''))),
  };
}

function buildEarningsDetail(profile, userData, limit = 30) {
  const migration = getCommissionMigration(userData);
  const usesNewAccountPolicy = !migration && isPostCutoffOnlyProfile(profile);
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
      amount: roundMoney(gross * ((migration || usesNewAccountPolicy) && date >= effectiveDate ? rate : 1)),
      commission_rate: (migration || usesNewAccountPolicy) && date >= effectiveDate ? rate : 1,
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
  isPostCutoffOnlyProfile,
  roundMoney,
  withdrawalTotals,
};
