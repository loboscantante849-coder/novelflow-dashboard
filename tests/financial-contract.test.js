'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MIN_WITHDRAWAL,
  MAX_WITHDRAWAL,
  validateWithdrawalAmount,
} = require('../api/_lib/financial-contract');

test('withdrawal contract accepts cents and rounds once', () => {
  assert.deepEqual(validateWithdrawalAmount('10.005'), { ok: true, amount: 10.01 });
  assert.equal(validateWithdrawalAmount(MIN_WITHDRAWAL).ok, true);
  assert.equal(validateWithdrawalAmount(MAX_WITHDRAWAL).ok, true);
});

test('withdrawal contract rejects invalid and out-of-range amounts', () => {
  assert.equal(validateWithdrawalAmount('').code, 'INVALID_AMOUNT');
  assert.equal(validateWithdrawalAmount('NaN').code, 'INVALID_AMOUNT');
  assert.equal(validateWithdrawalAmount(9.99).code, 'MIN_WITHDRAWAL');
  assert.equal(validateWithdrawalAmount(10000.01).code, 'MAX_WITHDRAWAL');
});
