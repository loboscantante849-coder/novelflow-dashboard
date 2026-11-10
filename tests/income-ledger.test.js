const assert = require('node:assert/strict');
const test = require('node:test');
const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();
process.env.JWT_SECRET = 'unified-income-test-secret';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-only';
const { buildIncomeLedger, loadIncomeLedger } = require('../api/_lib/income-ledger');
const { computeWalletBalances } = require('../api/_lib/commission-policy');
const { signAccessToken } = require('../api/_lib/auth');
const day = '2026-11-08';
const row = (amount, owner = null, channel = 'link', date = day) => ({
  username: owner, username_canon: owner, channel, media_source: channel,
  stats: { dn_income: amount, pull_uv: 7, new_uv: 3 },
  daily: [{ dt: date, dn_income: amount, pull_uv: 7, new_uv: 3 }],
});
const snapshot = () => ({ last_updated: '2026-11-09T19:13:04Z',
  date_range: { from: '2026-02-01', to: day },
  by_promoter: { dras: { links: ['old'] } },
  ad_ids: { old: row(1, 'dras'), '6065': row(0, null, 'code'), link6065: row(89.59), another: row(50) },
});
const submissions = () => ({
  '6065': { discordUsername: 'dras', code: '6065', linkId: 'link6065', bookId: 'book-dr', status: 'completed' },
  duplicate: { discordUsername: 'DRAS', linkId: 'link6065', status: 'completed' },
  second: { discordUsername: 'new_member', linkId: 'another', status: 'completed' },
});
const recovery = () => ({ total: 32.26, daily: { '2026-10-22': 32.26 },
  assets: [{ ad_id: 'link6065', channel: 'link', dn_income: 32.26 }] });

test('all accounts gain current server-owned assets, with recovery and pipeline overlaps counted once', () => {
  const raw = snapshot(), before = structuredClone(raw);
  const ledger = buildIncomeLedger(raw, submissions(), { 'nf_recovered_income:dras': recovery(), 'nf_recovered_income:DRAS': recovery() });
  assert.equal(ledger.profileFor('DRAS').grossTotal, 90.59);
  assert.equal(ledger.profileFor('new_member').grossTotal, 50);
  assert.equal(ledger.profileFor('dras').displayIncome, 72.47);
  assert.equal(ledger.profileFor('dras').assetIds.length, 3);
  assert.deepEqual(ledger.profileFor('dras').reconciliationReasons, []);
  assert.deepEqual(raw, before);
  raw.ad_ids.link6065.username_canon = 'dras';
  raw.by_promoter.dras.links.push('link6065');
  assert.equal(buildIncomeLedger(raw, submissions(), { 'nf_recovered_income:dras': recovery() }).profileFor('dras').grossTotal, 90.59);
  raw.ad_ids.another = row(65);
  assert.equal(buildIncomeLedger(raw, submissions()).profileFor('new_member').grossTotal, 65);
});

test('refunds replace historical recovery amounts instead of keeping the larger old number', () => {
  const raw = snapshot(); raw.ad_ids.link6065 = row(-5);
  const profile = buildIncomeLedger(raw, submissions(), { 'nf_recovered_income:dras': recovery() }).profileFor('dras');
  assert.equal(profile.grossTotal, -4);
  assert.equal(profile.displayIncome, -3.2);
  assert.deepEqual(profile.reconciliationReasons, []);
});

test('two accounts claiming one asset cannot receive that asset in either wallet or stats', () => {
  const subs = submissions(); subs.rival = { discordUsername: 'rival', linkId: 'link6065' };
  const ledger = buildIncomeLedger(snapshot(), subs);
  assert.equal(ledger.profileFor('dras').grossTotal, 1);
  assert.equal(ledger.profileFor('rival').grossTotal, 0);
  assert.equal(ledger.adData.ad_ids.link6065.username_canon, null);
  for (const owner of ['dras', 'rival']) assert.equal(computeWalletBalances({}, ledger.profileFor(owner)).reconciliation_required, true);
});

test('invite and CPS code with the same text remain separate namespaces', () => {
  const raw = snapshot(); raw.ad_ids['6065'] = row(4, null, 'code'); raw.ad_ids['invite:6065'] = row(9, null, 'invite');
  const ledger = buildIncomeLedger(raw, submissions(), {}, {
    'nf_equity_code:inviter': { code: '6065', bookId: 'invite-book', status: 'completed' },
  });
  assert.equal(ledger.profileFor('inviter').grossTotal, 9);
  assert.equal(ledger.profileFor('dras').grossTotal, 94.59);
  assert.equal(Object.keys(ledger.adData.attribution_conflicts).length, 0);
});

test('pending submissions never grant ownership and new zero-activity assets do not block payouts', () => {
  const subs = { a: { discordUsername: 'member', linkId: 'not-yet-in-report' },
    _pending_x: { discordUsername: 'member', linkId: 'link6065' },
    failed: { discordUsername: 'member', status: 'failed', linkId: 'another' } };
  const ledger = buildIncomeLedger(snapshot(), subs);
  assert.equal(ledger.profileFor('member').grossTotal, 0);
  assert.equal(ledger.profileFor('member').found, false);
});

test('missing recovery evidence, truncated history, malformed amounts and duplicate dates block settlement', () => {
  for (const mutate of [
    (raw, recovered) => { recovered.assets = []; },
    (raw, recovered) => { recovered.total = 99; },
    raw => { delete raw.ad_ids.link6065; },
    raw => { raw.date_range.from = '2026-11-01'; },
    raw => { raw.ad_ids.link6065.daily = []; },
    raw => { raw.ad_ids.link6065.daily.push(null); },
    raw => { raw.by_promoter.dras.total_dn = 100; },
    raw => { raw.attribution_history_from = { dras: '2026-01-01' }; },
    raw => { raw.ad_ids.link6065.daily.push({ ...raw.ad_ids.link6065.daily[0] }); },
    raw => { raw.ad_ids.link6065.stats.dn_income = null; },
    raw => { raw.ad_ids.link6065.daily[0].dn_income = 'invalid'; },
  ]) {
    const raw = snapshot(), recovered = recovery(); mutate(raw, recovered);
    const profile = buildIncomeLedger(raw, submissions(), { 'nf_recovered_income:dras': recovered }).profileFor('dras');
    assert.equal(computeWalletBalances({ bonus_balance: 1000 }, profile).reconciliation_required, true);
  }
});

test('daily commission rounding is shared, and withdrawn/pending funds are deducted only once', () => {
  const raw = snapshot(); raw.ad_ids.link6065 = row(1.02);
  raw.ad_ids.link6065.daily = [{ dt: '2026-11-07', dn_income: 0.51 }, { dt: day, dn_income: 0.51 }];
  const profile = buildIncomeLedger(raw, submissions()).profileFor('dras');
  const wallet = computeWalletBalances({ bonus_balance: 0, withdrawals: [
    { amount: 0.5, status: 'approved' }, { amount: 0.3, status: 'pending' }, { amount: 1, status: 'rejected' },
  ] }, profile);
  assert.equal(profile.displayIncome, 1.62);
  assert.equal(wallet.total_earned, 1.62);
  assert.equal(wallet.available_balance, 0.82);
});

test('Redis scans are paginated and missing secondary user indexes do not drop server-owned assets', async () => {
  FakeRedis.reset({ nf_subs: submissions(), 'nf_recovered_income:dras': recovery(),
    'nf_user_data:attacker': { myBooks: [{ linkId: 'link6065' }] } });
  const redis = new FakeRedis();
  redis.scan = async (cursor, options) => options.match === 'nf_recovered_income:*'
    ? [String(cursor) === '0' ? '7' : '0', ['nf_recovered_income:dras']] : ['0', []];
  const ledger = await loadIncomeLedger(redis, snapshot());
  assert.equal(ledger.profileFor('dras').grossTotal, 90.59);
  assert.equal(ledger.profileFor('attacker').grossTotal, 0);
  FakeRedis.errorsByKey.set('nf_recovered_income:dras', new Error('Redis unavailable'));
  await assert.rejects(loadIncomeLedger(redis, snapshot()), /unavailable/);
  FakeRedis.errorsByKey.clear();
  redis.scan = async () => ['1', []];
  await assert.rejects(loadIncomeLedger(redis, snapshot()), /bounded scan/);
});

test('all user endpoints use the same ledger; retries and approval cannot create or spend duplicated earnings', async () => {
  const stats = require('../api/_lib/stats-data');
  const originals = { getAdIdDetails: stats.getAdIdDetails, getLegacyDataJson: stats.getLegacyDataJson, loadCovers: stats.loadCovers };
  const raw = snapshot();
  stats.getAdIdDetails = async () => structuredClone(raw);
  stats.getLegacyDataJson = async () => { throw new Error('Legacy wallet source must not be consulted'); };
  stats.loadCovers = async () => ({});
  const files = ['../api/my-stats', '../api/per-link-stats', '../api/withdrawals'];
  files.forEach(file => { delete require.cache[require.resolve(file)]; });
  const endpoints = files.map(file => require(file));
  const headers = username => ({ authorization: `Bearer ${signAccessToken({ type: 'local', username })}` });
  FakeRedis.reset({ nf_subs: submissions(), 'nf_recovered_income:dras': recovery(),
    'nf_user_data:dras': { bonus_balance: 0, withdrawals: [{ id: 'previous', amount: 35, status: 'approved' }] },
    'nf_user_data:new_member': { bonus_balance: 0, withdrawals: [] },
    'nf_user_data:operator': { accountType: 'admin' },
  });
  try {
    for (const [owner, expected] of [['dras', 72.47], ['new_member', 40]]) {
      const responses = await Promise.all(endpoints.map(endpoint => invoke(endpoint, { method: 'GET', headers: headers(owner), query: {} })));
      responses.forEach(response => assert.equal(response.statusCode, 200));
      assert.equal(responses[0].body.total_income, expected);
      assert.equal(responses[1].body.total_income, expected);
      assert.equal(responses[2].body.total_earned, expected);
      assert.equal(responses[2].body.reconciliation_required, false);
    }
    const request = { method: 'POST', headers: headers('dras'), body: {
      amount: 20, payment_account: 'dras@example.com', idempotency_key: 'unified-income-withdrawal-001',
    } };
    const first = await invoke(endpoints[2], request);
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    const again = await invoke(endpoints[2], request);
    assert.equal(again.statusCode, 200);
    const walletRaw = FakeRedis.values.get('nf_user_data:dras');
    const saved = typeof walletRaw === 'string' ? JSON.parse(walletRaw) : walletRaw;
    assert.equal(saved.withdrawals.length, 2);
    const pending = saved.withdrawals.find(w => w.status === 'pending');
    const wallet = await invoke(endpoints[2], { method: 'GET', headers: headers('dras'), query: {} });
    assert.equal(wallet.body.available_balance, 17.47);
    // A second claimant appears after the original request. Approval must
    // recompute ownership from Redis, not trust the request-time balance.
    FakeRedis.values.get('nf_subs').rival = { discordUsername: 'rival', linkId: 'link6065' };
    const approve = { method: 'PATCH', headers: headers('operator'), body: { username: 'dras', request_id: pending.id, action: 'approve' } };
    const blocked = await invoke(endpoints[2], approve);
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.code, 'INCOME_RECONCILIATION_REQUIRED');
    delete FakeRedis.values.get('nf_subs').rival;
    assert.equal((await invoke(endpoints[2], approve)).statusCode, 200);
    const after = await invoke(endpoints[2], { method: 'GET', headers: headers('dras'), query: {} });
    assert.equal(after.body.total_earned, 72.47);
    assert.equal(after.body.available_balance, 17.47);
  } finally {
    Object.assign(stats, originals);
    files.forEach(file => { delete require.cache[require.resolve(file)]; });
  }
});

test('migrated historical carryover, rewards and adjustments remain distinct from live asset revenue', () => {
  const raw = snapshot(); raw.ad_ids.link6065 = row(32, null, 'link', '2026-08-05');
  const profile = buildIncomeLedger(raw, submissions(), { 'nf_recovered_income:dras': recovery() }).profileFor('dras');
  const stored = { bonus_balance: 35, balance_migrations: { commission_80_v1: {
    status: 'applied', effective_date: '2026-08-21', commission_rate: 0.8, historical_gross_income: 30,
  } }, withdrawals: [{ amount: 35, status: 'approved' }, { amount: 1, status: 'pending' }] };
  const before = structuredClone(stored);
  const wallet = computeWalletBalances(stored, profile, 2);
  assert.equal(wallet.total_earned, 39.8); // 32 historical + 5 reward + 0.80 commission + 2 adjustment.
  assert.equal(wallet.available_balance, 3.8);
  assert.equal(wallet.reconciliation_required, false);
  assert.deepEqual(computeWalletBalances(stored, profile, 2), wallet);
  assert.deepEqual(stored, before);
});

test('new trusted raw handles can use their canonical reporting source without inferring a display-name alias', () => {
  const { isApprovedSourceOwner } = require('../api/_lib/income-source-owners');
  const raw = snapshot(); raw.by_promoter.new_member = { display_name: 'Untrusted Display Name', links: [] };
  const subs = submissions(); subs.second.discordUsername = 'new.member';
  const ledger = buildIncomeLedger(raw, subs);
  assert.equal(isApprovedSourceOwner(ledger.adData, 'new_member', 'new.member'), true);
  assert.equal(isApprovedSourceOwner(ledger.adData, 'new_member', 'Untrusted Display Name'), false);
});

test('complete bundled report preserves every assigned promoter total without any recovery addition', () => {
  const raw = require('../ad_id_details.json');
  const ledger = buildIncomeLedger(raw);
  for (const [owner, entry] of Object.entries(raw.by_promoter)) {
    const profile = ledger.profileFor(owner);
    if (!profile.found) continue; // System buckets never become payable accounts.
    assert.equal(profile.grossTotal, Math.round(entry.total_dn * 100) / 100, owner);
    assert.deepEqual(profile.reconciliationReasons, [], owner);
    assert.equal(new Set(profile.assetIds).size, profile.assetIds.length, owner);
  }
  assert.equal(Object.keys(ledger.adData.attribution_conflicts).length, 0);
});
