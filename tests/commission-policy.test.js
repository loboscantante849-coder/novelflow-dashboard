const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMMISSION_MIGRATION_ID,
  buildEarningsDetail,
  buildIncomeProfile,
  computeWalletBalances,
  historicalGrossBefore,
} = require('../api/_lib/commission-policy');

const source = {
  users: {
    promoter: {
      name: 'Promoter',
      subscription_revenue_dn: 130,
      subscription_revenue_dn_daily: {
        '2026-08-08': 100,
        '2026-08-10': 10,
        '2026-08-11': 20,
      },
    },
    _unmapped: {
      name: '_unmapped',
      subscription_revenue_dn: 9999,
      subscription_revenue_dn_daily: { '2026-08-08': 9999 },
    },
  },
};

test('system statistics buckets never resolve to user income', () => {
  const profile = buildIncomeProfile(source, '_unmapped');
  assert.equal(profile.found, false);
  assert.equal(profile.grossTotal, 0);
});

test('punctuation variants resolve to the same promoter income record', () => {
  const profile = buildIncomeProfile({ users: { promo_user: source.users.promoter } }, 'promo.user');
  assert.equal(profile.found, true);
  assert.equal(profile.sourceKey, 'promo_user');
});

test('unmigrated wallets apply 100 percent before Aug 21 and 80 percent from Aug 21', () => {
  const profile = buildIncomeProfile({
    users: {
      promoter: {
        subscription_revenue_dn: 160,
        subscription_revenue_dn_daily: {
          '2026-08-20': 100,
          '2026-08-21': 10,
          '2026-08-22': 50,
        },
      },
    },
  }, 'promoter');
  const balances = computeWalletBalances({
    bonus_balance: 5,
    withdrawals: [{ amount: 20, status: 'approved' }, { amount: 10, status: 'pending' }],
  }, profile, -2);

  assert.equal(balances.commission_mode, 'commission_80_v1_daily');
  assert.equal(balances.commission_effective_date, '2026-08-21');
  assert.equal(balances.commission_rate, 0.8);
  assert.equal(balances.historical_gross_income, 100);
  assert.equal(balances.post_cutoff_gross_income, 60);
  assert.equal(balances.post_cutoff_user_income, 48);
  assert.equal(balances.commission_income, 148);
  assert.equal(balances.total_earned, 151);
  assert.equal(balances.available_balance, 121);
  assert.equal(balances.withdrawable_balance, 121);
  assert.equal(balances.approved_total, 20);
  assert.equal(balances.withdrawn_total, 20);
  assert.equal(balances.pending_withdrawal_total, 10);
  assert.equal(balances.promotion_income_total, 148);
  assert.equal(balances.reward_income_total, 5);
  assert.equal(balances.legacy_earnings_carryover, 0);
  assert.equal(balances.reconciliation_required, false);
  assert.deepEqual(buildEarningsDetail(profile, {}), [
    { date: '2026-08-22', gross_amount: 50, amount: 40, commission_rate: 0.8 },
    { date: '2026-08-21', gross_amount: 10, amount: 8, commission_rate: 0.8 },
    { date: '2026-08-20', gross_amount: 100, amount: 100, commission_rate: 1 },
  ]);
});

test('complete post-cutoff-only income uses 80 percent without a migration marker', () => {
  const profile = buildIncomeProfile({
    users: {
      new_promoter: {
        subscription_revenue_dn: 30,
        subscription_revenue_dn_daily: { '2026-08-21': 10, '2026-08-22': 20 },
      },
    },
  }, 'new_promoter');
  const balances = computeWalletBalances({}, profile);

  assert.equal(balances.commission_mode, 'commission_80_v1_daily');
  assert.equal(balances.commission_income, 24);
  assert.equal(balances.available_balance, 24);
  assert.equal(balances.commission_effective_date, '2026-08-21');
  assert.deepEqual(buildEarningsDetail(profile, {}), [
    { date: '2026-08-22', gross_amount: 20, amount: 16, commission_rate: 0.8 },
    { date: '2026-08-21', gross_amount: 10, amount: 8, commission_rate: 0.8 },
  ]);
});

test('incomplete daily data preserves the displayed total but requires reconciliation', () => {
  const profile = buildIncomeProfile({
    users: {
      uncertain_promoter: {
        subscription_revenue_dn: 40,
        subscription_revenue_dn_daily: { '2026-08-21': 20 },
      },
    },
  }, 'uncertain_promoter');
  const balances = computeWalletBalances({}, profile);

  assert.equal(balances.commission_mode, 'commission_80_v1_reconciliation_required');
  assert.equal(balances.commission_income, 40);
  assert.equal(balances.reconciliation_required, true);
  assert.deepEqual(balances.reconciliation_reasons, ['income_daily_total_mismatch']);
  assert.deepEqual(buildEarningsDetail(profile, {}), [
    { date: '2026-08-21', gross_amount: 20, amount: 16, commission_rate: 0.8 },
  ]);
});

test('migrated wallets count only post-cutoff income at 80 percent', () => {
  const profile = buildIncomeProfile(source, 'promoter');
  const migrated = {
    bonus_balance: 105,
    balance_migrations: {
      [COMMISSION_MIGRATION_ID]: {
        status: 'applied',
        effective_date: '2026-08-10',
        commission_rate: 0.8,
        historical_gross_income: 100,
      },
    },
    withdrawals: [{ amount: 20, status: 'APPROVED' }, { amount: 10, status: 'Pending' }],
  };
  const balances = computeWalletBalances(migrated, profile, -2);

  assert.equal(balances.commission_mode, COMMISSION_MIGRATION_ID);
  assert.equal(balances.commission_effective_date, '2026-08-10');
  assert.equal(balances.post_cutoff_gross_income, 30);
  assert.equal(balances.commission_income, 24);
  assert.equal(balances.total_earned, 127);
  assert.equal(balances.available_balance, 97);
  assert.equal(balances.bonus_balance, 105);
  assert.equal(balances.legacy_earnings_carryover, 100);
  assert.equal(balances.reward_income_total, 5);
  assert.equal(balances.reconciliation_required, false);
  assert.equal(historicalGrossBefore(profile, balances.commission_effective_date), 100);
});

test('a migrated Aug 10 wallet cannot override the enforced 80 percent rate', () => {
  const profile = buildIncomeProfile(source, 'promoter');
  const balances = computeWalletBalances({
    bonus_balance: 100,
    balance_migrations: {
      [COMMISSION_MIGRATION_ID]: {
        status: 'applied',
        effective_date: '2026-08-10',
        commission_rate: 1,
        historical_gross_income: 100,
      },
    },
  }, profile);

  assert.equal(balances.commission_effective_date, '2026-08-10');
  assert.equal(balances.stored_commission_rate, 1);
  assert.equal(balances.commission_rate, 0.8);
  assert.equal(balances.commission_income, 24);
  assert.equal(balances.reconciliation_required, true);
  assert.deepEqual(balances.reconciliation_reasons, ['invalid_commission_rate']);
});

test('production-shaped migration keeps the wallet total while exposing only the true reward', () => {
  const profile = buildIncomeProfile({
    users: {
      promoter: {
        subscription_revenue_dn: 3498.56,
        subscription_revenue_dn_daily: {
          '2026-08-09': 3479.94,
          '2026-08-10': 18.33,
          '2026-08-11': 0.29,
        },
      },
    },
  }, 'promoter');
  const balances = computeWalletBalances({
    bonus_balance: 3480.44,
    balance_migrations: {
      [COMMISSION_MIGRATION_ID]: {
        status: 'applied', effective_date: '2026-08-10', commission_rate: 0.8,
        historical_gross_income: 3479.94,
      },
    },
  }, profile);

  assert.equal(balances.total_earned, 3495.33);
  assert.equal(balances.withdrawable_balance, 3495.33);
  assert.equal(balances.legacy_earnings_carryover, 3479.94);
  assert.equal(balances.reward_income_total, 0.5);
  assert.equal(balances.commission_income, 14.89);
  assert.equal(balances.reconciliation_required, false);
});

test('a migrated partial post-cutoff source keeps the old displayed amount but blocks settlement', () => {
  const profile = buildIncomeProfile({
    users: {
      promoter: {
        subscription_revenue_dn: 130,
        subscription_revenue_dn_daily: { '2026-08-08': 100, '2026-08-11': 20 },
      },
    },
  }, 'promoter');
  const balances = computeWalletBalances({
    bonus_balance: 105,
    balance_migrations: {
      [COMMISSION_MIGRATION_ID]: {
        status: 'applied', effective_date: '2026-08-10', commission_rate: 0.8,
        historical_gross_income: 100,
      },
    },
  }, profile);

  assert.equal(balances.total_earned, 121);
  assert.equal(balances.commission_income, 16);
  assert.equal(balances.commission_rate, 0.8);
  assert.equal(balances.reconciliation_required, true);
  assert.deepEqual(balances.reconciliation_reasons, ['income_daily_total_mismatch']);
});

test('a malformed carryover classification never exposes a negative activity reward', () => {
  const profile = buildIncomeProfile(source, 'promoter');
  const balances = computeWalletBalances({
    bonus_balance: 50,
    balance_migrations: {
      [COMMISSION_MIGRATION_ID]: {
        status: 'applied', effective_date: '2026-08-10', commission_rate: 0.8,
        historical_gross_income: 100,
      },
    },
  }, profile);

  assert.equal(balances.bonus_balance, 50);
  assert.equal(balances.legacy_earnings_carryover, 100);
  assert.equal(balances.reward_income_total, 0);
  assert.equal(balances.reconciliation_required, true);
  assert.deepEqual(balances.reconciliation_reasons, ['legacy_carryover_exceeds_stored_bonus']);
});

test('daily earnings show historical 100 percent and new 80 percent amounts', () => {
  const profile = buildIncomeProfile(source, 'promoter');
  const details = buildEarningsDetail(profile, {
    balance_migrations: {
      [COMMISSION_MIGRATION_ID]: {
        status: 'applied', effective_date: '2026-08-10', commission_rate: 0.8,
      },
    },
  });

  assert.deepEqual(details, [
    { date: '2026-08-11', gross_amount: 20, amount: 16, commission_rate: 0.8 },
    { date: '2026-08-10', gross_amount: 10, amount: 8, commission_rate: 0.8 },
    { date: '2026-08-08', gross_amount: 100, amount: 100, commission_rate: 1 },
  ]);
});
