const assert = require('node:assert/strict');
const test = require('node:test');
const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();
process.env.JWT_SECRET = 'reviewed-assets-test-only';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-only';

const { applyReviewedAttribution, reviewedIncomeProfile } = require('../api/_lib/reviewed-attribution');
const { computeWalletBalances } = require('../api/_lib/commission-policy');
const { signAccessToken } = require('../api/_lib/auth');
const owner = 'estefanyb_05';
const link = '6ac4ba498a3435ab4da8c31f';
const base = { sourceKey: owner, grossTotal: 0.5, dailyTotal: 0.5,
  daily: { '2026-10-20': 0.5 }, found: true };
const recovered = { total: 9, daily: { '2026-08-05': 7, '2026-10-20': 2 },
  assets: [{ ad_id: '6174', dn_income: 7 }, { ad_id: link, dn_income: 2 }] };
function fixture() {
  const row = (id, amount, date, channel, username = null) => ({
    ad_id: id, media_source: channel, channel, username_canon: username,
    stats: { dn_income: amount, pull_uv: 10, new_uv: 1, d14_income: amount },
    daily: [{ dt: date, dn_income: amount, pull_uv: 10, new_uv: 1 }],
  });
  return { last_updated: '2026-10-30T00:27:39Z', date_range: { from: '2026-02-01', to: '2026-10-28' },
    by_promoter: { [owner]: { display_name: 'Estefanyb_05', codes: ['9217'], links: [] } },
    ad_ids: { '6174': row('6174', 8, '2026-08-05', 'code'), [link]: row(link, 2, '2026-10-20', 'link'),
      '9217': row('9217', 0.5, '2026-10-20', 'code', owner) } };
}

test('reviewed assets survive repeated pipeline refreshes without mutating or duplicating the source', () => {
  const source = fixture();
  const fixed = applyReviewedAttribution(source);
  assert.equal(source.ad_ids['6174'].username_canon, null);
  assert.equal(fixed.by_promoter[owner].total_dn, 10.5);
  assert.equal(fixed.by_promoter[owner].total_uv, 30);
  assert.equal(fixed.ad_ids['6174'].book_name, 'Fake Dating the Basketball Star I Hate');
  assert.deepEqual(applyReviewedAttribution(fixed), fixed);
  const next = fixture();
  next.ad_ids['6174'].stats.dn_income += 1;
  next.ad_ids['6174'].daily.push({ dt: '2026-10-28', dn_income: 1 });
  const profile = reviewedIncomeProfile(base, recovered, applyReviewedAttribution(next), owner);
  assert.equal(profile.grossTotal, 11.5);
  assert.equal(profile.daily['2026-10-28'], 1);
});

test('wallet replaces the recovery snapshot with current assets once, preserving commission dates', () => {
  const fixed = applyReviewedAttribution(fixture());
  const profile = reviewedIncomeProfile(base, recovered, fixed, owner);
  assert.equal(profile.grossTotal, 10.5); // Not 19.5 with the old $9 counted twice.
  const balances = computeWalletBalances({ bonus_balance: 0, withdrawals: [] }, profile);
  assert.equal(balances.reconciliation_required, false);
  assert.equal(balances.total_earned, 10); // $8 historical + $2.5 * 80%.
  // When the producer eventually repairs ownership too, there is no second credit.
  assert.equal(reviewedIncomeProfile(profile, recovered, applyReviewedAttribution(fixed), owner).grossTotal, 10.5);
});

test('ownership conflicts never overwrite another promoter or become withdrawable', () => {
  const source = fixture();
  source.ad_ids['6174'].username_canon = 'someone_else';
  const fixed = applyReviewedAttribution(source);
  assert.equal(fixed.ad_ids['6174'].username_canon, 'someone_else');
  assert.deepEqual(fixed.reviewed_attribution_issues[owner], ['6174']);
  const profile = reviewedIncomeProfile(base, recovered, fixed, owner);
  assert.equal(profile.grossTotal, 9.5); // Preserve previous display pending review.
  assert.equal(computeWalletBalances({ bonus_balance: 0 }, profile).reconciliation_required, true);
});

test('foreign index, book mismatch and channel collision are rejected', () => {
  for (const change of [
    source => { source.by_promoter.other = { codes: ['6174'] }; },
    source => { source.ad_ids['6174'].book_id = 'different-book'; },
    source => { source.ad_ids['6174'].media_source = 'invite'; },
  ]) {
    const source = fixture(); change(source);
    const fixed = applyReviewedAttribution(source);
    assert.equal(fixed.ad_ids['6174'].username_canon, null);
    assert.ok(fixed.reviewed_attribution_issues[owner].includes('6174'));
  }
});

test('missing recovered assets, truncated daily history and inconsistent totals fail closed', () => {
  for (const change of [
    source => { delete source.ad_ids['6174']; },
    source => { source.date_range.from = '2026-10-01'; },
    source => { source.ad_ids['6174'].daily = []; },
    source => { source.ad_ids['6174'].daily[0].dn_income = 'invalid'; },
  ]) {
    const source = fixture(); change(source);
    const profile = reviewedIncomeProfile(base, recovered, applyReviewedAttribution(source), owner);
    assert.equal(computeWalletBalances({ bonus_balance: 0 }, profile).reconciliation_required, true);
  }
  for (const invalid of [{ ...recovered, assets: [] }, { ...recovered, total: 12 }]) {
    const profile = reviewedIncomeProfile(base, invalid, applyReviewedAttribution(fixture()), owner);
    assert.equal(computeWalletBalances({ bonus_balance: 0 }, profile).reconciliation_required, true);
  }
});

test('unreviewed users retain their existing recovery behavior', () => {
  const profile = reviewedIncomeProfile(base, recovered, applyReviewedAttribution(fixture()), 'other');
  assert.equal(profile.grossTotal, 9.5);
  assert.equal(profile.reconciliationReasons, undefined);
});

test('authenticated stats and wallet agree even with an empty Redis submission index', async () => {
  const stats = require('../api/_lib/stats-data');
  const originals = { getAdIdDetails: stats.getAdIdDetails, getLegacyDataJson: stats.getLegacyDataJson, loadCovers: stats.loadCovers };
  stats.getAdIdDetails = async () => applyReviewedAttribution(fixture());
  stats.getLegacyDataJson = async () => ({ users: { [owner]: {
    name: 'Estefanyb_05', subscription_revenue_dn: 0.5, subscription_revenue_dn_daily: base.daily,
  } } });
  stats.loadCovers = async () => ({});
  FakeRedis.reset({ [`nf_user_data:${owner}`]: JSON.stringify({ bonus_balance: 0, withdrawals: [] }),
    [`nf_recovered_income:${owner}`]: recovered });
  const headers = { authorization: `Bearer ${signAccessToken({ type: 'local', username: owner })}` };
  const files = ['../api/my-stats', '../api/per-link-stats', '../api/withdrawals'];
  for (const file of files) delete require.cache[require.resolve(file)];
  try {
    const summary = await invoke(require(files[0]), { method: 'GET', headers, query: {} });
    const links = await invoke(require(files[1]), { method: 'GET', headers, query: {} });
    const wallet = await invoke(require(files[2]), { method: 'GET', headers, query: {} });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.body.total_visits, 30);
    assert.equal(summary.body.total_income, 8.4); // Statistics display the 80% share.
    assert.equal(links.statusCode, 200);
    assert.equal(links.body.total_visits, 30);
    assert.equal(wallet.statusCode, 200);
    assert.equal(wallet.body.source_total_dn_income, 10.5);
    assert.equal(wallet.body.total_earned, 10);
    assert.equal(wallet.body.reconciliation_required, false);
    const denied = await invoke(require(files[0]), { method: 'GET', headers, query: { username: 'someone_else' } });
    assert.equal(denied.statusCode, 403);
  } finally {
    Object.assign(stats, originals);
    for (const file of files) delete require.cache[require.resolve(file)];
  }
});
