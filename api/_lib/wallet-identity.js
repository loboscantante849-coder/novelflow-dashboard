const { acquireUserDataLock, releaseUserDataLock } = require('./user-data-lock');

// Reporting usernames and wallet/login usernames are different namespaces.
// Keep this map deliberately small and exact: only verified Eliza spellings
// belong here. Ordinary usernames keep their punctuation so unrelated login
// identities cannot be silently merged into the same Redis wallet.
const WALLET_PRIMARY_BY_EXPLICIT_ALIAS = new Map([
  ['eliza_star', 'eliza_star'],
  ['eliza_stellar', 'eliza_star'],
  ['eliza-stellar', 'eliza_star'],
  ['eliza.stellar', 'eliza_star'],
  ['eliza stellar', 'eliza_star'],
  ['@eliza.stellar', 'eliza_star'],
]);

function resolveUsernameAlias(rawName) {
  const raw = String(rawName || '').trim().toLowerCase();
  if (!raw) return '';
  return WALLET_PRIMARY_BY_EXPLICIT_ALIAS.get(raw) || raw;
}

function walletStorageCandidates(rawName) {
  const primaryUsername = resolveUsernameAlias(rawName);
  if (!primaryUsername) return [];
  // `eliza_stellar` is the only verified legacy reporting-key wallet. Reads
  // may preserve it when it is the sole record, but every writer locks star.
  if (primaryUsername === 'eliza_star') return ['eliza_star', 'eliza_stellar'];
  return [primaryUsername];
}

async function resolveWalletStorageIdentity(redis, requestedUsername) {
  const primaryUsername = resolveUsernameAlias(requestedUsername);
  if (!primaryUsername) {
    return { primaryUsername: null, storageUsername: null, conflict: false, matches: [] };
  }
  const candidates = walletStorageCandidates(requestedUsername);
  if (!redis) {
    return { primaryUsername, storageUsername: primaryUsername, conflict: false, matches: [] };
  }
  const keys = candidates.map(username => `nf_user_data:${username}`);
  const values = !keys.length
    ? []
    : (typeof redis.mget === 'function'
      ? await redis.mget(...keys)
      : await Promise.all(keys.map(key => redis.get(key))));
  if (!Array.isArray(values) || values.length !== keys.length) {
    const error = new Error('Wallet identity lookup returned an invalid response');
    error.code = 'WALLET_IDENTITY_UNAVAILABLE';
    throw error;
  }
  const matches = candidates.filter((_, index) => values[index] !== null && values[index] !== undefined);
  return {
    primaryUsername,
    storageUsername: matches.length === 1 ? matches[0] : primaryUsername,
    conflict: matches.length > 1,
    matches,
  };
}

function walletIdentityConflict(identity, message = 'Multiple wallet records resolve to the same user') {
  const error = new Error(message);
  error.code = 'WALLET_IDENTITY_CONFLICT';
  error.identity = identity;
  return error;
}

async function acquireWalletDataLock(redis, requestedUsername, options = {}) {
  const initial = await resolveWalletStorageIdentity(redis, requestedUsername);
  if (!initial.primaryUsername) {
    const error = new Error('Invalid wallet identity');
    error.code = 'INVALID_WALLET_IDENTITY';
    throw error;
  }
  if (initial.conflict) throw walletIdentityConflict(initial);

  // Stable contract shared with admin services:
  //   key = nf_user_data_lock:v2:<preferred primary alias>
  // The actual storage key may remain a sole legacy alias during recovery.
  const lock = await acquireUserDataLock(redis, initial.primaryUsername, options);
  if (!lock) return { lock: null, identity: initial };

  try {
    const locked = await resolveWalletStorageIdentity(redis, requestedUsername);
    if (locked.conflict || locked.storageUsername !== initial.storageUsername) {
      throw walletIdentityConflict(locked, 'Wallet identity changed while the operation was starting');
    }
    return { lock, identity: locked };
  } catch (error) {
    await releaseUserDataLock(redis, lock);
    throw error;
  }
}

module.exports = {
  acquireWalletDataLock,
  resolveUsernameAlias,
  resolveWalletStorageIdentity,
  walletIdentityConflict,
  walletStorageCandidates,
};
