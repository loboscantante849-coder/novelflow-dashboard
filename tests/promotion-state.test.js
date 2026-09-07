'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { STATES, canTransition, transition } = require('../api/_lib/promotion-state');

test('promotion state follows the code and link lifecycle', () => {
  let record = { state: STATES.REQUESTED };
  for (const state of [STATES.CODE_ALLOCATED, STATES.LINK_CREATED, STATES.PERSISTED, STATES.COMPLETED]) {
    assert.equal(canTransition(record.state, state), true);
    record = transition(record, state, { updatedAt: '2026-09-07T00:00:00.000Z' });
  }
  assert.equal(record.state, STATES.COMPLETED);
  assert.equal(canTransition(STATES.COMPLETED, STATES.REQUESTED), false);
});

test('pending and failed promotion records have explicit recovery paths', () => {
  assert.equal(canTransition(STATES.REQUESTED, STATES.PENDING), true);
  assert.equal(canTransition(STATES.PENDING, STATES.CODE_ALLOCATED), true);
  assert.equal(canTransition(STATES.CODE_ALLOCATED, STATES.PENDING), true);
  assert.equal(canTransition(STATES.FAILED, STATES.REQUESTED), true);
  assert.throws(() => transition({ state: STATES.COMPLETED }, STATES.PENDING), /Invalid promotion transition/);
});
