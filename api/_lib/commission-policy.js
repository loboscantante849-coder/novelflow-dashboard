const { canonizePromoter, isSystemStatsBucket } = require('./promoter-access');

// New accounts use the global Aug 21 cutoff. Existing migrated accounts keep
// their audited Aug 10 or Aug 21 cutoff so historical wallet totals do not
// change retroactively. The payout rate itself is always enforced at 80%.
const COMMISSION_EFFECTIVE_DATE = '2026-08-21';
const COMMISSION_RATE = 0.8;
const COMMISSION_MIGRATION_ID = 'commission_80_v1';
const ALLOWED_COMMISSION_EFFECTIVE_DATES = new Set(['2026-08-10', COMMISSION_EFFECTIVE_DATE]);

function isSafeMoneyValue(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && Number.isSafeInteger(Math.round(numeric * 100));
}

function roundMoney(value) {
  const numeric = Number(value);
  return isSafeMoneyValue(numeric) ? Math.round(numeric * 100) / 100 : 0;
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
  const statedD14 = Number(record && record.subscription_revenue);
  const grossD14Total = Number.isFinite(statedD14) ? roundMoney(Math.max(0, statedD14)) : 0;
  return {
    username: String(username || '').trim().toLowerCase(),
    sourceKey: key,
    grossTotal,
    grossD14Total,
    grossAfterD14Total: roundMoney(Math.max(0, grossTotal - grossD14Total)),
    daily,
    dailyTotal,
    found: Boolean(record),
  };
}

function getCommissionMigration(userData) {
  const migrations = userData && userData.balance_migrations;
  const migration = migrations && typeof migrations === 'object' && !Array.isArray(migrations)
    ? migrations[COMMISSION_MIGRATION_ID]
    : null;
  if (!migration || typeof migration !== 'object' || Array.isArray(migration) || migration.status !== 'applied') return null;
  return migration;
}

function resolveCommissionPolicy(userData) {
  const migration = getCommissionMigration(userData);
  const storedEffectiveDate = migration && String(migration.effective_date || '');
  const storedCommissionRate = migration && Number.isFinite(Number(migration.commission_rate))
    ? Number(migration.commission_rate)
    : null;
  const reconciliationReasons = [];
  if (migration && !ALLOWED_COMMISSION_EFFECTIVE_DATES.has(storedEffectiveDate)) {
    reconciliationReasons.push('invalid_commission_effective_date');
  }
  if (migration && storedCommissionRate !== COMMISSION_RATE) {
    reconciliationReasons.push('invalid_commission_rate');
  }
  return {
    migration,
    effectiveDate: migration && ALLOWED_COMMISSION_EFFECTIVE_DATES.has(storedEffectiveDate)
      ? storedEffectiveDate
      : COMMISSION_EFFECTIVE_DATE,
    commissionRate: COMMISSION_RATE,
    storedEffectiveDate: migration ? storedEffectiveDate || null : null,
    storedCommissionRate,
    reconciliationReasons,
  };
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
  const policy = resolveCommissionPolicy(userData);
  const migration = policy.migration;
  const effectiveDate = policy.effectiveDate;
  const rate = policy.commissionRate;
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
      if (!policy.reconciliationReasons.length && Number.isFinite(historicalGross)) {
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
    historicalGrossIncome: dailyTotals.historicalGrossIncome,
    postCutoffGrossIncome,
    postCutoffNetIncome: dailyTotals.postCutoffNetIncome,
    storedEffectiveDate: policy.storedEffectiveDate,
    storedCommissionRate: policy.storedCommissionRate,
    markerPolicyNormalized: policy.reconciliationReasons.length > 0,
    reconciliationRequired: reconciliation.required || policy.reconciliationReasons.length > 0,
    reconciliationReasons: [...reconciliation.reasons, ...policy.reconciliationReasons],
  };
}

function splitStoredBonus(userData, incomeProfile) {
  const rawBonusBalance = userData && userData.bonus_balance;
  const bonusMissing = rawBonusBalance === undefined;
  const bonusNumber = bonusMissing ? 0 : Number(rawBonusBalance);
  const invalidBonusBalance = !bonusMissing && (!isSafeMoneyValue(rawBonusBalance) || bonusNumber < 0);
  const bonusBalance = invalidBonusBalance ? 0 : roundMoney(bonusNumber);
  const migration = getCommissionMigration(userData);
  const historical = Number(migration && migration.historical_gross_income);
  const storedLegacyCarryover = Number.isFinite(historical) ? roundMoney(Math.max(0, historical)) : 0;
  const policy = resolveCommissionPolicy(userData);
  const hasIncomeProfile = Boolean(incomeProfile && typeof incomeProfile === 'object' && incomeProfile.found);
  const sourceReconciliation = incomeProfileReconciliation(incomeProfile);
  const legacyCarryover = migration && hasIncomeProfile && !sourceReconciliation.required && !policy.reconciliationReasons.length
    ? policyDailyTotals(incomeProfile, policy.effectiveDate, policy.commissionRate).historicalGrossIncome
    : storedLegacyCarryover;
  const classificationRequired = storedLegacyCarryover > bonusBalance;
  return {
    bonus_balance: bonusBalance,
    legacy_earnings_carryover: legacyCarryover,
    stored_legacy_earnings_carryover: storedLegacyCarryover,
    historical_earnings_delta: roundMoney(legacyCarryover - storedLegacyCarryover),
    reward_income_total: roundMoney(Math.max(0, bonusBalance - storedLegacyCarryover)),
    classification_reconciliation_required: classificationRequired,
    invalid_bonus_balance: invalidBonusBalance,
  };
}

function withdrawalTotals(userData) {
  const rawWithdrawals = userData && userData.withdrawals;
  const withdrawals = Array.isArray(rawWithdrawals) ? rawWithdrawals : [];
  const totals = { approved: 0, pending: 0, rejected: 0, external: 0, unknown: [] };
  if (rawWithdrawals !== undefined && !Array.isArray(rawWithdrawals)) {
    totals.unknown.push(rawWithdrawals);
  }
  for (const withdrawal of withdrawals) {
    if (!withdrawal || typeof withdrawal !== 'object') {
      totals.unknown.push(withdrawal);
      continue;
    }
    const status = String(withdrawal.status || 'pending').trim().toLowerCase();
    const amount = Number(withdrawal.amount);
    if (!isSafeMoneyValue(withdrawal.amount) || amount <= 0 || !['approved', 'pending', 'rejected'].includes(status)) {
      totals.unknown.push(withdrawal);
      continue;
    }
    if (withdrawal.wallet_excluded === true || withdrawal.source === 'external_settlement') {
      if (status !== 'approved') totals.unknown.push(withdrawal);
      else if (isSafeMoneyValue(totals.external + amount)) totals.external += amount;
      else totals.unknown.push(withdrawal);
      continue;
    }
    if (isSafeMoneyValue(totals[status] + amount)) totals[status] += amount;
    else totals.unknown.push(withdrawal);
  }
  totals.approved = roundMoney(totals.approved);
  totals.pending = roundMoney(totals.pending);
  totals.rejected = roundMoney(totals.rejected);
  totals.external = roundMoney(totals.external);
  return { withdrawals, ...totals };
}

function computeWalletBalances(userData, incomeProfile, incomeAdjustment = 0) {
  const migrations = userData && userData.balance_migrations;
  const markerValue = migrations && typeof migrations === 'object' && !Array.isArray(migrations)
    ? migrations[COMMISSION_MIGRATION_ID]
    : undefined;
  const migration = getCommissionMigration(userData);
  const rawHistoricalGross = migration && migration.historical_gross_income;
  const numericHistoricalGross = Number(rawHistoricalGross);
  const stored = splitStoredBonus(userData, incomeProfile);
  const bonus = stored.bonus_balance;
  const adjustmentNumber = incomeAdjustment === undefined || incomeAdjustment === null || incomeAdjustment === '' ? 0 : Number(incomeAdjustment);
  const invalidIncomeAdjustment = !isSafeMoneyValue(adjustmentNumber);
  const adjustment = invalidIncomeAdjustment ? 0 : roundMoney(adjustmentNumber);
  const income = creditedIncome(incomeProfile, userData);
  const totals = withdrawalTotals(userData);
  const reconciliationReasons = [
    ...(income.reconciliationReasons || []),
    ...(migrations !== undefined && (!migrations || typeof migrations !== 'object' || Array.isArray(migrations))
      ? ['invalid_balance_migrations_record']
      : []),
    ...(markerValue !== undefined && !migration ? ['invalid_commission_migration_record'] : []),
    ...(migration && (!isSafeMoneyValue(rawHistoricalGross) || numericHistoricalGross < 0)
      ? ['invalid_migration_historical_gross_income']
      : []),
    ...(stored.classification_reconciliation_required ? ['legacy_carryover_exceeds_stored_bonus'] : []),
    ...(stored.invalid_bonus_balance ? ['invalid_bonus_balance'] : []),
    ...(invalidIncomeAdjustment ? ['invalid_income_adjustment'] : []),
    ...(totals.unknown.length ? ['invalid_withdrawal_record'] : []),
    ...(userData && userData.wallet_merged_into ? ['wallet_merged_into_primary'] : []),
  ];
  const userPromotionIncomeBeforeAdjustment = roundMoney(stored.legacy_earnings_carryover + income.creditedIncome);
  const userPromotionIncomeTotal = roundMoney(userPromotionIncomeBeforeAdjustment + adjustment);
  // External settlements were paid outside this wallet and are intentionally
  // excluded from the spendable wallet balance. They still belong in the
  // user's lifetime earned/settled total so the ledger cannot show withdrawn
  // funds greater than earnings.
  const walletTotalEarned = roundMoney(stored.reward_income_total + userPromotionIncomeTotal);
  const settledWithdrawals = roundMoney(totals.approved + totals.external);
  const totalEarned = roundMoney(walletTotalEarned + totals.external);
  if (roundMoney(totals.approved + totals.pending) > walletTotalEarned) {
    reconciliationReasons.push('withdrawal_commitments_exceed_total_earned');
  }
  const reconciliationRequired = reconciliationReasons.length > 0;
  const available = roundMoney(Math.max(0, walletTotalEarned - totals.approved - totals.pending));
  return {
    bonus_balance: bonus,
    total_earned: totalEarned,
    source_total_dn_income: roundMoney(incomeProfile && incomeProfile.grossTotal),
    gross_dn_income: roundMoney(incomeProfile && incomeProfile.grossTotal),
    gross_d14_income: roundMoney(incomeProfile && incomeProfile.grossD14Total),
    gross_after_d14_income: roundMoney(incomeProfile && incomeProfile.grossAfterD14Total),
    income_adjustment: adjustment,
    total_dn_income: income.creditedIncome,
    commission_income: income.creditedIncome,
    commission_rate: income.commissionRate,
    commission_effective_date: income.effectiveDate,
    commission_mode: income.mode,
    commission_policy_enforced: true,
    stored_commission_effective_date: income.storedEffectiveDate,
    stored_commission_rate: income.storedCommissionRate,
    marker_policy_normalized: income.markerPolicyNormalized,
    historical_gross_income: income.historicalGrossIncome,
    post_cutoff_gross_income: income.postCutoffGrossIncome,
    post_cutoff_user_income: income.postCutoffNetIncome,
    reconciliation_required: reconciliationRequired,
    reconciliation_status: reconciliationRequired ? 'required' : 'ok',
    reconciliation_reasons: reconciliationReasons,
    approved_total: totals.approved,
    withdrawn_total: settledWithdrawals,
    pending_total: totals.pending,
    pending_withdrawal_total: totals.pending,
    frozen_total: totals.pending,
    rejected_total: totals.rejected,
    external_settlement_total: totals.external,
    available_balance: available,
    withdrawable_balance: available,
    promotion_income_total: income.creditedIncome,
    user_promotion_income_before_adjustment: userPromotionIncomeBeforeAdjustment,
    user_promotion_income_total: userPromotionIncomeTotal,
    legacy_earnings_carryover: stored.legacy_earnings_carryover,
    stored_legacy_earnings_carryover: stored.stored_legacy_earnings_carryover,
    historical_earnings_delta: stored.historical_earnings_delta,
    reward_income_total: stored.reward_income_total,
    pending_settlement: totals.pending,
    wallet_anomaly_count: totals.unknown.length,
    withdrawals: totals.withdrawals.slice().sort((a, b) => String(b && b.created_at || '').localeCompare(String(a && a.created_at || ''))),
  };
}

function buildEarningsDetail(profile, userData, limit = 30) {
  const policy = resolveCommissionPolicy(userData);
  const effectiveDate = policy.effectiveDate;
  const rate = policy.commissionRate;
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
  resolveCommissionPolicy,
  historicalGrossBefore,
  incomeProfileReconciliation,
  isSafeMoneyValue,
  roundMoney,
  splitStoredBonus,
  withdrawalTotals,
};
