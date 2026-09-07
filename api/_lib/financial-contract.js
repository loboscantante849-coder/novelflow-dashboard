'use strict';

// Single source of truth for user-facing wallet boundaries. Keep all values in
// dollars at the API boundary; commission-policy owns income classification and
// cents conversion for rewards.
const MIN_WITHDRAWAL = 10;
const MAX_WITHDRAWAL = 10000;
const PAYMENT_METHODS = Object.freeze(['paypal']);

function isFiniteMoney(value) {
  if (value === null || value === undefined || value === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && Number.isSafeInteger(Math.round(numeric * 100));
}

function roundMoney(value) {
  return isFiniteMoney(value) ? Math.round(Number(value) * 100) / 100 : 0;
}

function validateWithdrawalAmount(value) {
  if (!isFiniteMoney(value)) return { ok: false, code: 'INVALID_AMOUNT', message: 'Withdrawal amount is invalid' };
  const amount = roundMoney(value);
  if (amount < MIN_WITHDRAWAL) return { ok: false, code: 'MIN_WITHDRAWAL', message: `Minimum withdrawal amount is $${MIN_WITHDRAWAL}` };
  if (amount > MAX_WITHDRAWAL) return { ok: false, code: 'MAX_WITHDRAWAL', message: `Single withdrawal cannot exceed $${MAX_WITHDRAWAL.toLocaleString('en-US')}` };
  return { ok: true, amount };
}

module.exports = {
  MIN_WITHDRAWAL,
  MAX_WITHDRAWAL,
  PAYMENT_METHODS,
  isFiniteMoney,
  roundMoney,
  validateWithdrawalAmount,
};
