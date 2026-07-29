const test = require('node:test');
const assert = require('node:assert/strict');

const { statusRunLimit } = require('../api/status');

test('status run limit keeps startup bounded and supports one explicit history expansion', () => {
  assert.equal(statusRunLimit(undefined), 24);
  assert.equal(statusRunLimit('4'), 12);
  assert.equal(statusRunLimit('50'), 50);
  assert.equal(statusRunLimit('500'), 50);
});
