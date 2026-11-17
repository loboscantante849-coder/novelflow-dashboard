const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWalletAliasTargets } = require('../api/_lib/wallet-identity');

test('large ownership scans batch alias markers and retain case mapping and chains', async () => {
  let batches = 0;
  const names = Array.from({ length: 250 }, (_, i) => 'user' + i);
  const records = { 'nf_wallet_alias:user0': 'user1', 'nf_wallet_alias:user1': 'primary' };
  const redis = {
    get() { throw Error('Individual reads are unnecessary'); },
    async mget(...keys) { batches++; assert.ok(keys.length <= 128); return keys.map(k => records[k] || null); },
  };
  const aliases = await loadWalletAliasTargets(redis, [...names, 'User0']);
  assert.equal(batches, 2);
  assert.equal(aliases.get('user0'), 'primary');
  assert.equal(aliases.get('User0'), 'primary');
  assert.equal(aliases.get('user200'), undefined);
});

for (const broken of ['throws', 'short', 'object']) {
  test(`malformed or failed batch (${broken}) keeps partial results using bounded fallback`, async () => {
    let active = 0, max = 0;
    const redis = {
      async mget() { if (broken === 'throws') throw Error('outage'); return broken === 'short' ? [] : {}; },
      async get(key) {
        active++; max = Math.max(max, active);
        await new Promise(resolve => setImmediate(resolve)); active--;
        if (key.endsWith(':user1')) throw Error('one unavailable marker');
        return key.endsWith(':user0') ? 'primary' : null;
      },
    };
    const aliases = await loadWalletAliasTargets(redis, Array.from({length:20}, (_,i) => 'user'+i));
    assert.ok(max <= 8); assert.equal(aliases.get('user0'), 'primary'); assert.equal(aliases.has('user1'), false);
  });
}
