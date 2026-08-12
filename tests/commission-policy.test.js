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

test('unmigrated wallets retain the legacy 100 percent calculation', () => {
  const profile = buildIncomeProfile(source, 'promoter');
  const balances = computeWalletBalances({
    bonus_balance: 5,
    withdrawals: [{ amount: 20, status: 'approved' }, { amount: 10, status: 'pending' }],
  }, profile, -2);

  assert.equal(balances.commission_mode, 'legacy_100');
  assert.equal(balances.commission_income, 130);
  assert.equal(balances.total_earned, 133);
  assert.equal(balances.available_balance, 103);
  assert.equal(balances.withdrawable_balance, 103);
  assert.equal(balances.approved_total, 20);
  assert.equal(balances.withdrawn_total, 20);
  assert.equal(balances.pending_withdrawal_total, 10);
  assert.equal(balances.promotion_income_total, 130);
  assert.equal(balances.reward_income_total, 5);
});

test('complete post-cutoff-only income uses 80 percent without a migration marker', () => {
  const profile = buildIncomeProfile({
    users: {
      new_promoter: {
        subscription_revenue_dn: 30,
        subscription_revenue_dn_daily: { '2026-08-10': 10, '2026-08-11': 20 },
      },
    },
  }, 'new_promoter');
  const balances = computeWalletBalances({}, profile);

  assert.equal(balances.commission_mode, 'commission_80_v1_new');
  assert.equal(balances.commission_income, 24);
  assert.equal(balances.available_balance, 24);
  assert.deepEqual(buildEarningsDetail(profile, {}), [
    { date: '2026-08-11', gross_amount: 20, amount: 16, commission_rate: 0.8 },
    { date: '2026-08-10', gross_amount: 10, amount: 8, commission_rate: 0.8 },
  ]);
});

test('incomplete post-cutoff data remains on the safe legacy calculation', () => {
  const profile = buildIncomeProfile({
    users: {
      uncertain_promoter: {
        subscription_revenue_dn: 40,
        subscription_revenue_dn_daily: { '2026-08-11': 20 },
      },
    },
  }, 'uncertain_promoter');
  const balances = computeWalletBalances({}, profile);

  assert.equal(balances.commission_mode, 'legacy_100');
  assert.equal(balances.commission_income, 40);
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
  assert.equal(balances.post_cutoff_gross_income, 30);
  assert.equal(balances.commission_income, 24);
  assert.equal(balances.total_earned, 127);
  assert.equal(balances.available_balance, 97);
  assert.equal(historicalGrossBefore(profile), 100);
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
