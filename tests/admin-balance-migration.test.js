const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'migration-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.ADMIN_KEY = 'migration-test-admin-key';

const incomeData = {
  last_updated: '2026-08-12T01:00:00.000Z',
  date_range: { from: '2026-08-08', to: '2026-08-12' },
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
  },
};

const adData = {
  by_promoter: {
    promoter: { display_name: 'Promoter', links: ['link-1'] },
  },
  ad_ids: {},
};

const statsData = require('../api/_lib/stats-data');
statsData.getLegacyDataJson = async () => incomeData;
statsData.getAdIdDetails = async () => adData;
delete require.cache[require.resolve('../api/admin-balance-migration')];

const migration = require('../api/admin-balance-migration');
const { signAccessToken } = require('../api/_lib/auth');
const { computeWalletBalances, buildIncomeProfile } = require('../api/_lib/commission-policy');
const { userDataLockKey } = require('../api/_lib/user-data-lock');

function authHeaders(username = 'rootadmin') {
  return {
    authorization: `Bearer ${signAccessToken({ type: 'local', username, principal: `local:${username}` })}`,
    'x-forwarded-for': '192.0.2.80',
  };
}

function seed(extra = {}) {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:promoter': JSON.stringify({
      bonus_balance: 5,
      withdrawals: [
        { amount: 20, status: 'approved' },
        { amount: 10, status: 'pending' },
      ],
    }),
    ...extra,
  });
}

function applyRequest(overrides = {}) {
  return {
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'apply', confirm: migration.APPLY_CONFIRMATION },
    ...overrides,
  };
}

test.beforeEach(() => seed());

test('migration requires an authenticated active admin', async () => {
  const unauthenticated = await invoke(migration, { method: 'GET' });
  assert.equal(unauthenticated.statusCode, 401);

  FakeRedis.values.set('nf_user_data:member', JSON.stringify({ accountType: 'local' }));
  const member = await invoke(migration, { method: 'GET', headers: authHeaders('member') });
  assert.equal(member.statusCode, 403);
  assert.equal(member.body.code, 'ADMIN_ONLY');

  FakeRedis.values.set('nf_user_data:rootadmin', JSON.stringify({ accountType: 'admin', disabled: true }));
  const disabled = await invoke(migration, { method: 'GET', headers: authHeaders() });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.body.code, 'ACCOUNT_DISABLED');
});

test('the server-managed admin key can run dry-run without a user session', async () => {
  const response = await invoke(migration, {
    method: 'GET',
    headers: { 'x-admin-key': 'migration-test-admin-key', 'x-forwarded-for': '192.0.2.81' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.dry_run, true);
  assert.equal(response.body.can_apply_after_review, true);
});

test('POST requires the exact action and confirmation phrase', async () => {
  const missing = await invoke(migration, applyRequest({ body: {} }));
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.code, 'CONFIRMATION_REQUIRED');

  const wrong = await invoke(migration, applyRequest({
    body: { action: 'apply', confirm: 'APPLY_COMMISSION_80' },
  }));
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.body.code, 'CONFIRMATION_REQUIRED');
});

test('GET remains a read-only dry-run and reports cutoff preservation', async () => {
  const before = FakeRedis.values.get('nf_user_data:promoter');
  const response = await invoke(migration, {
    method: 'GET',
    headers: authHeaders(),
    query: { include_users: '1' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.dry_run, true);
  assert.equal(response.body.apply_supported, true);
  assert.equal(response.body.can_apply_after_review, true);
  assert.equal(response.body.summary.migration_candidates, 1);
  assert.equal(response.body.summary.historical_gross_income, 100);
  assert.equal(response.body.summary.cutoff_balance_change, 0);
  assert.equal(response.body.users[0].current_balance_change, 0);
  assert.equal(FakeRedis.values.get('nf_user_data:promoter'), before);
});

test('successful migration credits historical income once and records its source', async () => {
  const profile = buildIncomeProfile(incomeData, 'promoter');
  const beforeData = JSON.parse(FakeRedis.values.get('nf_user_data:promoter'));
  const beforeWallet = computeWalletBalances(beforeData, profile);

  const response = await invoke(migration, applyRequest());
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.deepEqual(response.body.result, {
    applied: 1,
    skipped: 0,
    busy: 0,
    errors: 0,
    historical_gross_income_added: 100,
    error_codes: [],
  });

  const afterData = JSON.parse(FakeRedis.values.get('nf_user_data:promoter'));
  const marker = afterData.balance_migrations.commission_80_v1;
  assert.equal(afterData.bonus_balance, 105);
  assert.equal(marker.status, 'applied');
  assert.equal(marker.effective_date, '2026-08-10');
  assert.equal(marker.commission_rate, 0.8);
  assert.equal(marker.historical_gross_income, 100);
  assert.equal(marker.source_key, 'promoter');
  assert.equal(marker.source_last_updated, incomeData.last_updated);
  assert.match(marker.applied_at, /^\d{4}-\d{2}-\d{2}T/);

  const afterWallet = computeWalletBalances(afterData, profile);
  assert.equal(beforeWallet.available_balance, 99);
  assert.equal(afterWallet.available_balance, 99);
  assert.equal(afterWallet.commission_income, 24);
});

test('a second POST is idempotent and the next dry-run has no candidates', async () => {
  await invoke(migration, applyRequest());
  const afterFirst = FakeRedis.values.get('nf_user_data:promoter');

  const second = await invoke(migration, applyRequest());
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.result.applied, 0);
  assert.equal(second.body.result.skipped, 1);
  assert.equal(second.body.result.historical_gross_income_added, 0);
  assert.equal(FakeRedis.values.get('nf_user_data:promoter'), afterFirst);

  const dryRun = await invoke(migration, { method: 'GET', headers: authHeaders() });
  assert.equal(dryRun.body.can_apply_after_review, true);
  assert.equal(dryRun.body.summary.migration_candidates, 0);
  assert.equal(dryRun.body.summary.already_migrated, 1);
});

test('an occupied shared user-data lock leaves the wallet untouched', async () => {
  const before = FakeRedis.values.get('nf_user_data:promoter');
  FakeRedis.values.set(userDataLockKey('promoter'), 'another-writer');

  const response = await invoke(migration, applyRequest());
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.success, false);
  assert.equal(response.body.applied, false);
  assert.equal(response.body.complete, false);
  assert.equal(response.body.retry_required, true);
  assert.equal(response.body.result.applied, 0);
  assert.equal(response.body.result.busy, 1);
  assert.equal(FakeRedis.values.get('nf_user_data:promoter'), before);
});

test('a record removed after analysis is not recreated by the migration', async () => {
  const originalSet = FakeRedis.prototype.set;
  FakeRedis.prototype.set = async function setWithRemoval(key, value, options) {
    const result = await originalSet.call(this, key, value, options);
    if (key === userDataLockKey('promoter') && result === 'OK') {
      FakeRedis.values.delete('nf_user_data:promoter');
    }
    return result;
  };
  try {
    const response = await invoke(migration, applyRequest());
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.success, false);
    assert.equal(response.body.applied, false);
    assert.equal(response.body.complete, false);
    assert.equal(response.body.result.applied, 0);
    assert.equal(response.body.result.errors, 1);
    assert.deepEqual(response.body.result.error_codes, ['USER_RECORD_MISSING']);
    assert.equal(FakeRedis.values.has('nf_user_data:promoter'), false);
  } finally {
    FakeRedis.prototype.set = originalSet;
  }
});

test('corrupt or anomalous records abort all writes', async () => {
  const cases = [
    { 'nf_user_data:broken': '{not-json' },
    { 'nf_user_data:promoter': JSON.stringify({ withdrawals: [{ amount: -1, status: 'approved' }] }) },
    { 'nf_user_data:promoter': JSON.stringify({ bonus_balance: 'not-money' }) },
  ];

  for (const extra of cases) {
    seed(extra);
    const before = FakeRedis.values.get('nf_user_data:promoter');
    const response = await invoke(migration, applyRequest());
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'MIGRATION_SAFETY_CHECK_FAILED');
    assert.equal(response.body.applied, false);
    assert.equal(FakeRedis.values.get('nf_user_data:promoter'), before);
  }
});

test('legacy case aliases are excluded while the canonical login record migrates once', async () => {
  seed({ 'nf_user_data:Promoter': JSON.stringify({ bonus_balance: 2 }) });
  const duplicate = await invoke(migration, applyRequest());
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.summary.duplicate_source_mappings, 0);
  assert.equal(duplicate.body.summary.excluded_legacy_aliases, 1);
  assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:promoter')).bonus_balance, 105);
  assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:Promoter')).bonus_balance, 2);
});

test('ambiguous lowercase aliases and invalid migration markers abort all writes', async () => {
  const originalPromoter = adData.by_promoter.promoter;
  delete adData.by_promoter.promoter;
  adData.by_promoter.promoter_canon = originalPromoter;
  incomeData.users.promoter_canon = incomeData.users.promoter;
  delete incomeData.users.promoter;
  try {
    seed({
      'nf_user_data:promoter canon': JSON.stringify({ bonus_balance: 5 }),
      'nf_user_data:promoter-canon': JSON.stringify({ bonus_balance: 2 }),
    });
    const ambiguous = await invoke(migration, applyRequest());
    assert.equal(ambiguous.statusCode, 409);
    assert.equal(ambiguous.body.summary.duplicate_source_mappings, 1);
    assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:promoter canon')).bonus_balance, 5);
  } finally {
    adData.by_promoter.promoter = originalPromoter;
    delete adData.by_promoter.promoter_canon;
    incomeData.users.promoter = incomeData.users.promoter_canon;
    delete incomeData.users.promoter_canon;
  }

  seed({
    'nf_user_data:promoter': JSON.stringify({
      bonus_balance: 5,
      balance_migrations: { commission_80_v1: { status: 'pending' } },
    }),
  });
  const marker = await invoke(migration, applyRequest());
  assert.equal(marker.statusCode, 409);
  assert.equal(marker.body.summary.anomalous_records, 1);
  assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:promoter')).bonus_balance, 5);
});
