const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'recovered-income-test-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

const { signAccessToken } = require('../api/_lib/auth');
const statsData = require('../api/_lib/stats-data');
const { applyRecoveredIncome, normalizeDaily, parseRecoveredRecord } = require('../api/_lib/recovered-income');

function withIncomeSources(users, byPromoter) {
  const originalLegacy = statsData.getLegacyDataJson;
  const originalAd = statsData.getAdIdDetails;
  statsData.getLegacyDataJson = async () => ({ users });
  statsData.getAdIdDetails = async () => ({ by_promoter: byPromoter, ad_ids: {} });
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

test('recovered income keeps its own dates so the commission policy still applies', () => {
  const profile = { daily: { '2026-08-05': 5 }, dailyTotal: 5, grossTotal: 5, found: true };
  const merged = applyRecoveredIncome(profile, {
    daily: { '2026-08-05': 2.5, '2026-08-25': 4 },
    total: 6.5,
    assets: [{ ad_id: '4712' }],
  });
  assert.equal(merged.daily['2026-08-05'], 7.5);
  assert.equal(merged.daily['2026-08-25'], 4);
  assert.equal(merged.total === undefined, true);
  assert.equal(merged.grossTotal, 11.5);
  assert.equal(merged.dailyTotal, 11.5);
  assert.equal(merged.recoveredIncome, 6.5);
  assert.equal(merged.found, true);
});

test('recovered income records ignore unusable payloads', () => {
  assert.deepEqual(normalizeDaily({ '2026-08-25': 4, bad: 9, '2026-08-26': 'x' }), { '2026-08-25': 4 });
  assert.equal(parseRecoveredRecord(null), null);
  assert.equal(parseRecoveredRecord('{"daily":{"2026-08-25":0}}'), null);
  assert.equal(parseRecoveredRecord('not json'), null);
  const record = parseRecoveredRecord({ daily: { '2026-08-25': 4 }, assets: [{ ad_id: '1' }] });
  assert.equal(record.total, 4);
  assert.equal(record.assets.length, 1);
});

test('several wallet spellings of one member still show their recovered income', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:eliza stellar': JSON.stringify({
      bonus_balance: 34.84,
      withdrawals: [],
      balance_migrations: {
        commission_80_v1: {
          status: 'applied',
          effective_date: '2026-08-10',
          commission_rate: 0.8,
          historical_gross_income: 33.34,
        },
      },
    }),
    'nf_user_data:Eliza Stellar': JSON.stringify({ bonus_balance: 0, withdrawals: [] }),
    'nf_recovered_income:eliza_stellar': JSON.stringify({
      daily: { '2026-08-19': 10 },
      total: 10,
      assets: [{ ad_id: '4712', dn_income: 10 }],
      computed_at: '2026-09-14T00:00:00.000Z',
    }),
  });
  const scoped = withIncomeSources({
    eliza_stellar: {
      name: 'Eliza Stellar',
      subscription_revenue_dn: 60,
      subscription_revenue_dn_daily: { '2026-08-19': 60 },
    },
  }, { eliza_stellar: { display_name: 'Eliza Stellar', links: [] } });
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const response = await invoke(scoped.handler, {
      method: 'GET',
      headers: { cookie: `nf_token=${token}` },
      query: { username: 'eliza stellar' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.review_required, true);
    assert.ok(response.body.review_reasons.includes('wallet_identity_conflict'));
    // 60 from the reporting record plus the 10 recovered from her own rows.
    assert.equal(response.body.source_total_dn_income, 70);
    assert.ok(response.body.total_earned > 40);
  } finally {
    scoped.restore();
  }
});

test('recovered income never reaches a source shared with another login', async () => {
  FakeRedis.reset({
    'nf_user_data:rootadmin': JSON.stringify({ accountType: 'admin' }),
    'nf_user_data:foo.bar': JSON.stringify({ bonus_balance: 0, withdrawals: [] }),
    'nf_user_data:foo_bar': JSON.stringify({ bonus_balance: 0, withdrawals: [] }),
    'nf_recovered_income:foo_bar': JSON.stringify({ daily: { '2026-08-19': 10 }, total: 10, assets: [] }),
  });
  const scoped = withIncomeSources({
    foo_bar: {
      name: 'Foo Bar',
      subscription_revenue_dn: 60,
      subscription_revenue_dn_daily: { '2026-08-19': 60 },
    },
  }, { foo_bar: { display_name: 'Foo Bar', links: [] } });
  const token = signAccessToken({ type: 'local', username: 'rootadmin' });
  try {
    const response = await invoke(scoped.handler, {
      method: 'GET',
      headers: { cookie: `nf_token=${token}` },
      query: { username: 'foo.bar' },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.review_reasons.includes('income_source_owner_conflict'));
    assert.equal(response.body.source_total_dn_income, 0);
  } finally {
    scoped.restore();
  }
});
