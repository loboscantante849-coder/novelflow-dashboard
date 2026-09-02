const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'wallet-alias-withdrawals-test-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

const { signAccessToken } = require('../api/_lib/auth');
const statsData = require('../api/_lib/stats-data');
const { resolveUsernameAlias, resolveWalletStorageIdentity, resolveReadOnlyWalletStorageIdentity } = require('../api/_lib/wallet-identity');
const { userDataLockKey } = require('../api/_lib/user-data-lock');
const { isAdminUser, isDisabledUser } = require('../api/_lib/security');

function withIncomeSource() {
  const originalLegacy = statsData.getLegacyDataJson;
  const originalAd = statsData.getAdIdDetails;
  statsData.getLegacyDataJson = async () => ({
    users: {
      eliza_stellar: {
        name: 'Eliza Stellar',
        subscription_revenue_dn: 60,
        subscription_revenue_dn_daily: { '2026-08-19': 60 },
      },
    },
  });
  statsData.getAdIdDetails = async () => ({
    by_promoter: { eliza_stellar: { display_name: 'Eliza Stellar', links: [] } },
    ad_ids: {},
  });
  delete require.cache[require.resolve('../api/withdrawals')];
  return {
    handler: require('../api/withdrawals'),
    restore() {
      statsData.getLegacyDataJson = originalLegacy;
      statsData.getAdIdDetails = originalAd;
      delete require.cache[require.resolve('../api/withdrawals')];
    },
  };
}

function withPunctuationIncomeSource({ approvedRaw = null } = {}) {
  const originalLegacy = statsData.getLegacyDataJson;
  const originalAd = statsData.getAdIdDetails;
  statsData.getLegacyDataJson = async () => ({
    users: {
      foo_bar: {
        name: 'Foo Bar',
        subscription_revenue_dn: 60,
        subscription_revenue_dn_daily: { '2026-08-19': 60 },
      },
    },
  });
  statsData.getAdIdDetails = async () => ({
    by_promoter: { foo_bar: { display_name: 'Foo Bar', links: [] } },
    ad_ids: approvedRaw ? {
      'trusted-ad': { username: approvedRaw, username_canon: 'foo_bar' },
    } : {},
  });
  delete require.cache[require.resolve('../api/withdrawals')];
  return {
    handler: require('../api/withdrawals'),
    restore() {
      statsData.getLegacyDataJson = originalLegacy;
      statsData.getAdIdDetails = originalAd;
      delete require.cache[require.resolve('../api/withdrawals')];
    },
  };
}

test('explicit historical aliases merge while ordinary punctuation remains intact', () => {
  assert.equal(resolveUsernameAlias('Eliza Stellar'), 'eliza_star');
  assert.equal(resolveUsernameAlias('@eliza.stellar'), 'eliza_star');
  assert.equal(resolveUsernameAlias('eliza--stellar'), 'eliza--stellar');
  assert.equal(resolveUsernameAlias('Cons Espher'), 'cons_espher');
  assert.equal(resolveUsernameAlias('@cons_espher'), 'cons_espher');
  assert.equal(resolveUsernameAlias('constance.espher'), 'constance.espher');
  assert.equal(resolveUsernameAlias('ordinary.name-tag'), 'ordinary.name-tag');
});

test('account status reads use the same explicit wallet alias identity', async () => {
  FakeRedis.reset({
    'nf_user_data:eliza_star': JSON.stringify({ accountType: 'admin', disabled: true }),
  });
  const redis = new FakeRedis();
  assert.equal(await isAdminUser(redis, 'eliza_stellar', { failClosed: true }), true);
  assert.equal(await isDisabledUser(redis, '@eliza.stellar', { failClosed: true }), true);
});

test('a sole protected case-variant legacy wallet remains usable under its canonical identity', async () => {
  const original = JSON.stringify({ bonus_balance: 0.5, points: 160, withdrawals: [] });
  FakeRedis.reset({ 'nf_user_data:Xenomorphette': original });

  const identity = await resolveWalletStorageIdentity(new FakeRedis(), 'xenomorphette');
  assert.equal(identity.primaryUsername, 'xenomorphette');
  assert.equal(identity.storageUsername, 'Xenomorphette');
  assert.equal(identity.conflict, false);
  assert.deepEqual(identity.matches, ['Xenomorphette']);
  assert.equal(FakeRedis.values.get('nf_user_data:Xenomorphette'), original);
  assert.equal(FakeRedis.values.has('nf_user_data:xenomorphette'), false);
});

test('case-variant duplicate protected wallets remain fail-closed', async () => {
  FakeRedis.reset({
    'nf_user_data:xenomorphette': JSON.stringify({ bonus_balance: 0.5 }),
    'nf_user_data:Xenomorphette': JSON.stringify({ bonus_balance: 1 }),
  });

  const identity = await resolveWalletStorageIdentity(new FakeRedis(), 'xenomorphette');
  assert.equal(identity.conflict, true);
  assert.deepEqual(new Set(identity.matches), new Set(['xenomorphette', 'Xenomorphette']));
});

test('reviewed DRAS case-variant wallets resolve to the canonical account', async () => {
  FakeRedis.reset({
    'nf_user_data:dras': JSON.stringify({ bonus_balance: 0.5 }),
    'nf_user_data:DRAS': JSON.stringify({ bonus_balance: 0.5 }),
    'nf_identity_owner:dras': 'local:dras',
    'nf_identity_owner:DRAS': 'local:dras',
    'nf_user_pass_owner:dras': 'local:dras',
    'nf_user_pass_owner:DRAS': 'local:dras',
  });

  const identity = await resolveReadOnlyWalletStorageIdentity(new FakeRedis(), 'DRAS');
  assert.equal(identity.conflict, false);
  assert.equal(identity.storageUsername, 'dras');
  assert.equal(identity.readOnlyLegacyConflict, true);
});

test('a legacy Eliza alias principal cannot cross into a differently owned primary wallet', async () => {
  const original = JSON.stringify({ bonus_balance: 60, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_data:eliza_star': original,
    'nf_identity_owner:eliza_star': 'local:primary-owner',
    'nf_identity_owner:eliza_stellar': 'discord:legacy-discord',
  });
  const token = signAccessToken({
    type: 'discord',
    username: 'eliza_stellar',
    discordId: 'legacy-discord',
    principal: 'discord:legacy-discord',
  });
  const scoped = withIncomeSource();
  try {
    const response = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        amount: 20,
        payment_account: 'eliza@example.com',
        idempotency_key: 'eliza-split-principal-0001', // gitleaks:allow — deterministic test value
      },
    });
    assert.notEqual(response.statusCode, 200);
    assert.equal(response.body.code, 'ACCOUNT_IDENTITY_CONFLICT');
    assert.equal(FakeRedis.values.get('nf_user_data:eliza_star'), original);
  } finally {
    scoped.restore();
  }
});

test('admin reporting alias uses Eliza\'s established wallet and lock identity', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:eliza_star': JSON.stringify({ bonus_balance: 60, withdrawals: [] }),
  });
  const scoped = withIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const wallet = await invoke(scoped.handler, {
      method: 'GET',
      headers: { cookie: `nf_token=${token}` },
      query: { username: 'eliza_stellar' },
    });
    assert.equal(wallet.statusCode, 200);
    assert.equal(wallet.body.wallet_username, 'eliza_star');

    const result = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'eliza_stellar',
        amount: 20,
        payment_account: 'eliza@example.com',
        idempotency_key: 'eliza-alias-wallet-0001',
      },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.wallet_username, 'eliza_star');
    assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:eliza_star')).withdrawals.length, 1);
    assert.equal(FakeRedis.values.has('nf_user_data:eliza_stellar'), false);
    assert.equal(FakeRedis.values.has('nf_user_data_lock:v2:eliza_star'), false);
  } finally {
    scoped.restore();
  }
});

test('a sole legacy Eliza wallet remains the storage key under the primary lock', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:eliza_stellar': JSON.stringify({ bonus_balance: 60, withdrawals: [] }),
  });
  const scoped = withIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const result = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'eliza_stellar',
        amount: 20,
        payment_account: 'eliza@example.com',
        idempotency_key: 'eliza-legacy-wallet-0001',
      },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.wallet_username, 'eliza_stellar');
    assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:eliza_stellar')).withdrawals.length, 1);
    assert.equal(FakeRedis.values.has('nf_user_data:eliza_star'), false);
    assert.equal(FakeRedis.values.has(userDataLockKey('eliza_star')), false);
  } finally {
    scoped.restore();
  }
});

test('duplicate wallet identities fail closed before a withdrawal can be created', async () => {
  const star = JSON.stringify({ bonus_balance: 60, withdrawals: [] });
  const stellar = JSON.stringify({ bonus_balance: 60, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:eliza_star': star,
    'nf_user_data:eliza_stellar': stellar,
  });
  const scoped = withIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const read = await invoke(scoped.handler, {
      method: 'GET',
      headers: { cookie: `nf_token=${token}` },
      query: { username: 'eliza_stellar' },
    });
    assert.equal(read.statusCode, 409);
    assert.equal(read.body.code, 'WALLET_IDENTITY_CONFLICT');

    const submit = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'eliza_stellar',
        amount: 20,
        payment_account: 'eliza@example.com',
        idempotency_key: 'eliza-alias-wallet-0002',
      },
    });
    assert.equal(submit.statusCode, 409);
    assert.equal(submit.body.code, 'WALLET_IDENTITY_CONFLICT');

    const approve = await invoke(scoped.handler, {
      method: 'PATCH',
      headers: { cookie: `nf_token=${token}` },
      body: { username: 'eliza_stellar', request_id: 'wd_existing', action: 'approve' },
    });
    assert.equal(approve.statusCode, 409);
    assert.equal(approve.body.code, 'WALLET_IDENTITY_CONFLICT');
    assert.equal(FakeRedis.values.get('nf_user_data:eliza_star'), star);
    assert.equal(FakeRedis.values.get('nf_user_data:eliza_stellar'), stellar);
  } finally {
    scoped.restore();
  }
});

test('POST and PATCH recheck duplicate aliases after the primary lock is acquired', async () => {
  const operations = [
    {
      method: 'POST',
      wallet: { bonus_balance: 60, withdrawals: [] },
      body: {
        username: 'eliza_stellar',
        amount: 20,
        payment_account: 'eliza@example.com',
        idempotency_key: 'eliza-alias-lock-race-0001',
      },
    },
    {
      method: 'PATCH',
      wallet: {
        bonus_balance: 60,
        withdrawals: [{ id: 'wd_existing', amount: 20, status: 'pending' }],
      },
      body: { username: 'eliza_stellar', request_id: 'wd_existing', action: 'approve' },
    },
  ];

  for (const operation of operations) {
    const primary = JSON.stringify(operation.wallet);
    FakeRedis.reset({
      'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
      'nf_user_data:eliza_star': primary,
    });
    const scoped = withIncomeSource();
    const token = signAccessToken({ type: 'local', username: 'rootadmin' });
    const originalSet = FakeRedis.prototype.set;
    let inserted = false;
    FakeRedis.prototype.set = async function insertAliasAfterLock(key, value, options) {
      const result = await originalSet.call(this, key, value, options);
      if (!inserted && key === 'nf_user_data_lock:v2:eliza_star' && result === 'OK') {
        inserted = true;
        FakeRedis.values.set(
          'nf_user_data:eliza_stellar',
          JSON.stringify({ bonus_balance: 60, withdrawals: [] }),
        );
      }
      return result;
    };

    try {
      const result = await invoke(scoped.handler, {
        method: operation.method,
        headers: { cookie: `nf_token=${token}` },
        body: operation.body,
      });
      assert.equal(inserted, true);
      assert.equal(result.statusCode, 409);
      assert.equal(result.body.code, 'WALLET_IDENTITY_CONFLICT');
      assert.equal(FakeRedis.values.get('nf_user_data:eliza_star'), primary);
      assert.equal(FakeRedis.values.has('nf_user_data_lock:v2:eliza_star'), false);
    } finally {
      FakeRedis.prototype.set = originalSet;
      scoped.restore();
    }
  }
});

test('wallet aliases use the reporting identity for admin income adjustments', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:eliza_star': JSON.stringify({ bonus_balance: 0, withdrawals: [] }),
    'nf_admin_income_adjustment:eliza_stellar': JSON.stringify({ amount: -60 }),
  });
  const scoped = withIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const result = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'eliza_stellar',
        amount: 20,
        payment_account: 'eliza@example.com',
        idempotency_key: 'eliza-alias-wallet-0003',
      },
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.available, 0);
    assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:eliza_star')).withdrawals.length, 0);
  } finally {
    scoped.restore();
  }
});

test('punctuation variants cannot create a second Eliza wallet', async () => {
  const variants = ['eliza-stellar', '@eliza.stellar', 'Eliza Stellar'];
  for (const [index, variant] of variants.entries()) {
    FakeRedis.reset({
      'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
      'nf_user_data:eliza_star': JSON.stringify({ bonus_balance: 60, withdrawals: [] }),
    });
    const scoped = withIncomeSource();
    const token = signAccessToken({ type: 'local', username: 'rootadmin' });
    try {
      const result = await invoke(scoped.handler, {
        method: 'POST',
        headers: { cookie: `nf_token=${token}` },
        body: {
          username: variant,
          amount: 20,
          payment_account: 'eliza@example.com',
          idempotency_key: `eliza-alias-variant-000${index + 1}`,
        },
      });
      assert.equal(result.statusCode, 200);
      assert.equal(result.body.wallet_username, 'eliza_star');
      assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:eliza_star')).withdrawals.length, 1);
      assert.equal(FakeRedis.values.has(`nf_user_data:${variant.toLowerCase()}`), false);
    } finally {
      scoped.restore();
    }
  }
});

test('non-finite alias adjustment records fail closed before wallet mutation', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:eliza_star': JSON.stringify({ bonus_balance: 0, withdrawals: [] }),
    'nf_admin_income_adjustment:eliza_stellar': JSON.stringify({ amount: 'Infinity' }),
  });
  const scoped = withIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const result = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'eliza_stellar',
        amount: 10000,
        payment_account: 'eliza@example.com',
        idempotency_key: 'eliza-invalid-adjustment-0001',
      },
    });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, 'INCOME_ADJUSTMENT_UNAVAILABLE');
    assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:eliza_star')).withdrawals.length, 0);
  } finally {
    scoped.restore();
  }
});

test('invalid wallet identity lookup shapes fail closed', async () => {
  const original = JSON.stringify({ bonus_balance: 60, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:eliza_star': original,
  });
  const scoped = withIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  const originalMget = FakeRedis.prototype.mget;
  FakeRedis.prototype.mget = async function invalidAliasLookup(...keys) {
    if (keys.some(key => key === 'nf_user_data:eliza_star')) return { invalid: true };
    return originalMget.apply(this, keys);
  };
  try {
    const result = await invoke(scoped.handler, {
      method: 'GET',
      headers: { cookie: `nf_token=${token}` },
      query: { username: 'eliza_stellar' },
    });
    assert.equal(result.statusCode, 503);
    assert.equal(FakeRedis.values.get('nf_user_data:eliza_star'), original);
  } finally {
    FakeRedis.prototype.mget = originalMget;
    scoped.restore();
  }
});

test('ordinary punctuation wallets sharing one reporting source fail closed', async () => {
  const first = JSON.stringify({ bonus_balance: 60, withdrawals: [] });
  const second = JSON.stringify({ bonus_balance: 60, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo.bar': first,
    'nf_user_data:foo_bar': second,
  });
  const scoped = withPunctuationIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const read = await invoke(scoped.handler, {
      method: 'GET',
      headers: { cookie: `nf_token=${token}` },
      query: { username: 'foo.bar' },
    });
    assert.equal(read.statusCode, 409);
    assert.equal(read.body.code, 'INCOME_SOURCE_OWNER_CONFLICT');

    const write = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo.bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'punctuation-owner-0001', // gitleaks:allow — deterministic test value
      },
    });
    assert.equal(write.statusCode, 409);
    assert.equal(write.body.code, 'INCOME_SOURCE_OWNER_CONFLICT');
    assert.equal(FakeRedis.values.get('nf_user_data:foo.bar'), first);
    assert.equal(FakeRedis.values.get('nf_user_data:foo_bar'), second);
  } finally {
    scoped.restore();
  }
});

test('admin can reject a pending request even when source owners conflict', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo.bar': JSON.stringify({
      bonus_balance: 60,
      withdrawals: [{ id: 'wd_conflicted', amount: 20, status: 'pending' }],
    }),
    'nf_user_data:foo_bar': JSON.stringify({ bonus_balance: 60, withdrawals: [] }),
  });
  const scoped = withPunctuationIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const result = await invoke(scoped.handler, {
      method: 'PATCH',
      headers: { cookie: `nf_token=${token}` },
      body: { username: 'foo.bar', request_id: 'wd_conflicted', action: 'reject' },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.request.status, 'rejected');
    assert.equal(
      JSON.parse(FakeRedis.values.get('nf_user_data:foo.bar')).withdrawals[0].status,
      'rejected',
    );
  } finally {
    scoped.restore();
  }
});

test('admin approval is blocked for a disabled target wallet while rejection remains available', async () => {
  const original = JSON.stringify({
    disabled: true,
    bonus_balance: 60,
    withdrawals: [{ id: 'wd_disabled', amount: 20, status: 'pending' }],
  });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:eliza_star': original,
  });
  const scoped = withIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const approve = await invoke(scoped.handler, {
      method: 'PATCH',
      headers: { cookie: `nf_token=${token}` },
      body: { username: 'eliza_stellar', request_id: 'wd_disabled', action: 'approve' },
    });
    assert.equal(approve.statusCode, 403);
    assert.equal(approve.body.code, 'ACCOUNT_DISABLED');
    assert.equal(FakeRedis.values.get('nf_user_data:eliza_star'), original);

    const reject = await invoke(scoped.handler, {
      method: 'PATCH',
      headers: { cookie: `nf_token=${token}` },
      body: { username: 'eliza_stellar', request_id: 'wd_disabled', action: 'reject' },
    });
    assert.equal(reject.statusCode, 200);
    assert.equal(reject.body.request.status, 'rejected');
  } finally {
    scoped.restore();
  }
});

test('admin rejection commits even when income sources are unavailable for the response refresh', async () => {
  const original = JSON.stringify({
    bonus_balance: 60,
    withdrawals: [{ id: 'wd_source_outage', amount: 20, status: 'pending' }],
  });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo_bar': original,
  });
  const originalLegacy = statsData.getLegacyDataJson;
  const originalAd = statsData.getAdIdDetails;
  statsData.getLegacyDataJson = async () => { throw new Error('source unavailable'); };
  statsData.getAdIdDetails = async () => { throw new Error('source unavailable'); };
  delete require.cache[require.resolve('../api/withdrawals')];
  const handler = require('../api/withdrawals');
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const result = await invoke(handler, {
      method: 'PATCH',
      headers: { cookie: `nf_token=${token}` },
      body: { username: 'foo_bar', request_id: 'wd_source_outage', action: 'reject' },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.request.status, 'rejected');
    assert.equal(result.body.balances, null);
    assert.equal(result.body.balance_refresh_required, true);
    assert.equal(
      JSON.parse(FakeRedis.values.get('nf_user_data:foo_bar')).withdrawals[0].status,
      'rejected',
    );
  } finally {
    statsData.getLegacyDataJson = originalLegacy;
    statsData.getAdIdDetails = originalAd;
    delete require.cache[require.resolve('../api/withdrawals')];
  }
});

test('wallet mutations fail closed when withdrawals is not an array', async () => {
  const original = JSON.stringify({ bonus_balance: 60, withdrawals: { corrupted: true } });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo_bar': original,
  });
  const scoped = withPunctuationIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const submitted = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo_bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'corrupt-withdrawals-array-0001',
      },
    });
    assert.equal(submitted.statusCode, 503);
    assert.equal(submitted.body.code, 'WALLET_DATA_CORRUPT');
    assert.equal(FakeRedis.values.get('nf_user_data:foo_bar'), original);

    const reviewed = await invoke(scoped.handler, {
      method: 'PATCH',
      headers: { cookie: `nf_token=${token}` },
      body: { username: 'foo_bar', request_id: 'missing', action: 'reject' },
    });
    assert.equal(reviewed.statusCode, 503);
    assert.equal(reviewed.body.code, 'WALLET_DATA_CORRUPT');
    assert.equal(FakeRedis.values.get('nf_user_data:foo_bar'), original);
  } finally {
    scoped.restore();
  }
});

test('wallet mutations preserve an explicit null withdrawals field', async () => {
  const original = JSON.stringify({ bonus_balance: 60, withdrawals: null });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo_bar': original,
  });
  const scoped = withPunctuationIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const submitted = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo_bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'null-withdrawals-array-0001',
      },
    });
    assert.equal(submitted.statusCode, 503);
    assert.equal(submitted.body.code, 'WALLET_DATA_CORRUPT');
    assert.equal(FakeRedis.values.get('nf_user_data:foo_bar'), original);

    const reviewed = await invoke(scoped.handler, {
      method: 'PATCH',
      headers: { cookie: `nf_token=${token}` },
      body: { username: 'foo_bar', request_id: 'missing', action: 'reject' },
    });
    assert.equal(reviewed.statusCode, 503);
    assert.equal(reviewed.body.code, 'WALLET_DATA_CORRUPT');
    assert.equal(FakeRedis.values.get('nf_user_data:foo_bar'), original);
  } finally {
    scoped.restore();
  }
});

test('a sole unverified punctuation wallet cannot consume canonical source income', async () => {
  const original = JSON.stringify({ bonus_balance: 60, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo.bar': original,
  });
  const scoped = withPunctuationIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const result = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo.bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'unverified-existing-owner-0001', // gitleaks:allow — deterministic test value
      },
    });
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, 'INCOME_SOURCE_OWNER_UNVERIFIED');
    assert.equal(FakeRedis.values.get('nf_user_data:foo.bar'), original);
  } finally {
    scoped.restore();
  }
});

test('a raw wallet alias explicitly present in trusted pipeline data is approved', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo.bar': JSON.stringify({ bonus_balance: 60, withdrawals: [] }),
  });
  const scoped = withPunctuationIncomeSource({ approvedRaw: 'Foo.Bar' });
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const result = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo.bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'approved-raw-owner-0001',
      },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:foo.bar')).withdrawals.length, 1);
  } finally {
    scoped.restore();
  }
});

test('a source owner inserted after the source lock prevents wallet creation', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
  });
  const scoped = withPunctuationIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  const originalSet = FakeRedis.prototype.set;
  let inserted = false;
  FakeRedis.prototype.set = async function insertOwnerAfterSourceLock(key, value, options) {
    const result = await originalSet.call(this, key, value, options);
    if (!inserted && key === userDataLockKey('income-source-owner:foo_bar') && result === 'OK') {
      inserted = true;
      FakeRedis.values.set('nf_user_data:foo_bar', JSON.stringify({ bonus_balance: 60, withdrawals: [] }));
    }
    return result;
  };
  try {
    const result = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo.bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'punctuation-owner-race-0001', // gitleaks:allow — deterministic test value
      },
    });
    assert.equal(inserted, true);
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, 'INCOME_SOURCE_OWNER_CONFLICT');
    assert.equal(FakeRedis.values.has('nf_user_data:foo.bar'), false);
  } finally {
    FakeRedis.prototype.set = originalSet;
    scoped.restore();
  }
});

test('an empty owner index cannot be claimed by an unverified punctuation variant', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
  });
  const scoped = withPunctuationIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const denied = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo.bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'unverified-first-owner-0001',
      },
    });
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.body.code, 'INCOME_SOURCE_OWNER_UNVERIFIED');
    assert.equal(FakeRedis.values.has('nf_user_data:foo.bar'), false);

    const verified = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo_bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'verified-first-owner-0001',
      },
    });
    assert.equal(verified.statusCode, 200);
    assert.equal(JSON.parse(FakeRedis.values.get('nf_user_data:foo_bar')).withdrawals.length, 1);
  } finally {
    scoped.restore();
  }
});

test('a writer that loses its wallet lock cannot commit stale withdrawal data', async () => {
  const original = JSON.stringify({ bonus_balance: 60, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo_bar': original,
  });
  const scoped = withPunctuationIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  const originalEval = FakeRedis.prototype.eval;
  let replaced = false;
  FakeRedis.prototype.eval = async function replaceLockBeforeCommit(script, keys, args) {
    if (!replaced && String(script).includes('NF_USER_DATA_LOCKED_COMMIT_V1') && keys[0] === 'nf_user_data:foo_bar') {
      replaced = true;
      FakeRedis.values.set(keys[1], 'new-writer-token');
    }
    return originalEval.call(this, script, keys, args);
  };
  try {
    const result = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo_bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'lost-wallet-lock-0001',
      },
    });
    assert.equal(replaced, true);
    assert.equal(result.statusCode, 503);
    assert.equal(FakeRedis.values.get('nf_user_data:foo_bar'), original);
  } finally {
    FakeRedis.prototype.eval = originalEval;
    scoped.restore();
  }
});

test('a writer that loses its income-source lock cannot commit wallet data', async () => {
  const original = JSON.stringify({ bonus_balance: 60, withdrawals: [] });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo_bar': original,
  });
  const scoped = withPunctuationIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  const originalEval = FakeRedis.prototype.eval;
  let replaced = false;
  FakeRedis.prototype.eval = async function replaceSourceLockBeforeCommit(script, keys, args) {
    if (!replaced && String(script).includes('NF_USER_DATA_LOCKED_COMMIT_V1') && keys[0] === 'nf_user_data:foo_bar') {
      replaced = true;
      assert.equal(keys[2], userDataLockKey('income-source-owner:foo_bar'));
      FakeRedis.values.set(keys[2], 'new-source-owner-token');
    }
    return originalEval.call(this, script, keys, args);
  };
  try {
    const result = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'foo_bar',
        amount: 20,
        payment_account: 'foo@example.com',
        idempotency_key: 'lost-source-lock-0001',
      },
    });
    assert.equal(replaced, true);
    assert.equal(result.statusCode, 503);
    assert.equal(FakeRedis.values.get('nf_user_data:foo_bar'), original);
  } finally {
    FakeRedis.prototype.eval = originalEval;
    scoped.restore();
  }
});

test('system income buckets are never addressable as wallets', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:_unmapped': JSON.stringify({ bonus_balance: 9999, withdrawals: [] }),
  });
  const scoped = withIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const read = await invoke(scoped.handler, {
      method: 'GET',
      headers: { cookie: `nf_token=${token}` },
      query: { username: '_unmapped' },
    });
    assert.equal(read.statusCode, 400);
    assert.equal(read.body.code, 'INVALID_WALLET_USERNAME');

    const write = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: '_unmapped',
        amount: 20,
        payment_account: 'system@example.com',
        idempotency_key: 'system-wallet-block-0001',
      },
    });
    assert.equal(write.statusCode, 400);
    assert.equal(FakeRedis.values.get('nf_user_data:_unmapped'), JSON.stringify({ bonus_balance: 9999, withdrawals: [] }));
  } finally {
    scoped.restore();
  }
});

test('non-finite stored wallet money is reconciled instead of withdrawable', async () => {
  const original = JSON.stringify({ bonus_balance: 'Infinity', withdrawals: [] });
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:eliza_star': original,
  });
  const scoped = withIncomeSource();
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const read = await invoke(scoped.handler, {
      method: 'GET',
      headers: { cookie: `nf_token=${token}` },
      query: { username: 'eliza_stellar' },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(Number.isFinite(read.body.available_balance), true);
    assert.equal(read.body.reconciliation_required, true);
    assert.ok(read.body.reconciliation_reasons.includes('invalid_bonus_balance'));

    const write = await invoke(scoped.handler, {
      method: 'POST',
      headers: { cookie: `nf_token=${token}` },
      body: {
        username: 'eliza_stellar',
        amount: 20,
        payment_account: 'eliza@example.com',
        idempotency_key: 'invalid-wallet-money-0001',
      },
    });
    assert.equal(write.statusCode, 409);
    assert.equal(write.body.code, 'INCOME_RECONCILIATION_REQUIRED');
    assert.equal(FakeRedis.values.get('nf_user_data:eliza_star'), original);
  } finally {
    scoped.restore();
  }
});
