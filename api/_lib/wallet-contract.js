'use strict';

// Public composition boundary for wallet callers. Keeping identity resolution
// and balance calculation together prevents endpoints from choosing different
// aliases or income arithmetic.
const identity = require('./wallet-identity');
const finance = require('./commission-policy');

module.exports = {
  resolveUsernameAlias: identity.resolveUsernameAlias,
  resolveWalletStorageIdentity: identity.resolveWalletStorageIdentity,
  walletStorageCandidates: identity.walletStorageCandidates,
  computeWalletBalances: finance.computeWalletBalances,
  buildEarningsDetail: finance.buildEarningsDetail,
  isSafeMoneyValue: finance.isSafeMoneyValue,
};
