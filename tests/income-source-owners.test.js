const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApprovedSourceOwnerRegistry,
  isApprovedSourceOwner,
} = require('../api/_lib/income-source-owners');

function sourceData() {
  return {
    by_promoter: {
      cons_espher: {},
      other_creator: {},
    },
    ad_ids: {
      one: { username: 'Cons Espher', username_canon: 'cons_espher' },
      two: { username: '@Cons Espher', username_canon: 'cons_espher' },
    },
  };
}

test('approved source owners include exact sources, verified Eliza aliases, and unique dynamic raw names', () => {
  const data = sourceData();
  assert.equal(isApprovedSourceOwner(data, 'cons_espher', 'cons_espher'), true);
  assert.equal(isApprovedSourceOwner(data, 'cons_espher', 'cons espher'), true);
  assert.equal(isApprovedSourceOwner(data, 'cons_espher', '@cons espher'), true);
  assert.equal(isApprovedSourceOwner(data, 'cons_espher', 'cons-espher'), false);
  assert.equal(isApprovedSourceOwner(data, 'eliza_stellar', 'eliza_star'), true);
  assert.equal(isApprovedSourceOwner(data, 'eliza_stellar', '@eliza.stellar'), true);
});

test('a raw owner mapped to multiple sources is excluded from every source', () => {
  const data = sourceData();
  data.ad_ids.three = { username: 'Cons Espher', username_canon: 'other_creator' };
  const registry = buildApprovedSourceOwnerRegistry(data);
  assert.equal(registry.ambiguousOwners.has('cons espher'), true);
  assert.equal(isApprovedSourceOwner(data, 'cons_espher', 'cons espher'), false);
  assert.equal(isApprovedSourceOwner(data, 'other_creator', 'cons espher'), false);
});
