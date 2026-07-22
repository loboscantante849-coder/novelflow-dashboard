const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeRedisKey, normalizeRedisKeys } = require('../api/_lib/redis-values');

test('normalizes Redis set members returned as primitives or objects', () => {
  assert.equal(normalizeRedisKey('5251'), '5251');
  assert.equal(normalizeRedisKey(5251), '5251');
  assert.equal(normalizeRedisKey({ value: '5252' }), '5252');
  assert.equal(normalizeRedisKey({ code: 5253 }), '5253');
  assert.equal(normalizeRedisKey({ unexpected: true }), null);
  assert.deepEqual(normalizeRedisKeys(['5251', { member: 5252 }, null]), ['5251', '5252']);
});
