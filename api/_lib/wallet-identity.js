const { acquireUserDataLock, releaseUserDataLock } = require('./user-data-lock');
const { isProtectedPromoterUsername } = require('./promoter-access');

const CASE_VARIANT_SCAN_PAGE_LIMIT = 16;
const CONS_READ_ONLY_CANONICAL = 'cons_espher';
const CONS_READ_ONLY_LEGACY = '@cons espher';

// Reporting usernames and wallet/login usernames are different namespaces.
// Keep this map deliberately small and exact: only verified historical
// spellings belong here. Ordinary usernames keep their punctuation so
// unrelated login identities cannot be silently merged into the same wallet.
const WALLET_PRIMARY_BY_EXPLICIT_ALIAS = new Map([
  ['eliza_star', 'eliza_star'],
  ['eliza_stellar', 'eliza_star'],
  ['eliza-stellar', 'eliza_star'],
  ['eliza.stellar', 'eliza_star'],
  ['eliza stellar', 'eliza_star'],
  ['@eliza.stellar', 'eliza_star'],
  // The active promoter is Ndidi2000; their mobile login screenshot and
  // historical support messages contain this one extra-i spelling.
  ['ndidii2000', 'ndidi2000'],
  // Cons Espher has an established account with historical Redis keys using
  // both the Discord display spelling and the canonical reporting spelling.
  // Keep `constance.espher` out of this map: it is a separate credential.
  ['cons_espher', 'cons_espher'],
  ['@cons_espher', 'cons_espher'],
  ['cons espher', 'cons_espher'],
  ['@cons espher', 'cons_espher'],
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
  // Reads may preserve one sole historical Cons key. If more than one of
  // these records exists, resolveWalletStorageIdentity deliberately reports
  // a conflict so balances cannot be merged implicitly.
  if (primaryUsername === 'cons_espher') {
    return ['cons_espher', '@cons espher', 'cons espher', '@cons_espher'];
  }
  return [primaryUsername];
}

function caseVariantWalletPattern(username) {
  // Redis glob matching is case-sensitive. Usernames have already passed the
  // authentication character policy, so replacing ASCII letters is safe; all
  // returned keys are still compared by exact case-folded username below.
  return `nf_user_data:${String(username).replace(/[a-z]/gi, '?')}`;
}

async function findCaseVariantWallets(redis, candidates) {
  if (!redis || typeof redis.scan !== 'function') return [];
  const expected = new Set(candidates.map(username => String(username).trim().toLowerCase()));
  const matches = new Set();
  let pages = 0;
  for (const pattern of new Set(candidates.map(caseVariantWalletPattern))) {
    let cursor = '0';
    do {
      if (++pages > CASE_VARIANT_SCAN_PAGE_LIMIT) {
        const error = new Error('Wallet identity lookup exceeded its bounded scan');
        error.code = 'WALLET_IDENTITY_UNAVAILABLE';
        throw error;
      }
      const result = await redis.scan(cursor, { match: pattern, count: 200 });
      if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
        const error = new Error('Wallet identity lookup returned an invalid response');
        error.code = 'WALLET_IDENTITY_UNAVAILABLE';
        throw error;
      }
      cursor = String(result[0] || '0');
      for (const key of result[1]) {
        const value = String(key);
        if (!value.startsWith('nf_user_data:')) continue;
        const storageUsername = value.slice('nf_user_data:'.length);
        if (expected.has(storageUsername.toLowerCase())) matches.add(storageUsername);
      }
    } while (cursor !== '0');
  }
  return Array.from(matches);
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
  const directMatches = candidates.filter((_, index) => values[index] !== null && values[index] !== undefined);
  // Case scans are allowed only for a known existing wallet or a protected
  // promoter identity. Unknown public usernames remain constant-time and can
  // never enumerate Redis keys through an authentication request.
  const caseVariantMatches = directMatches.length || isProtectedPromoterUsername(primaryUsername)
    ? await findCaseVariantWallets(redis, candidates)
    : [];
  const matches = Array.from(new Set([
    ...directMatches,
    ...caseVariantMatches,
  ]));
  return {
    primaryUsername,
    storageUsername: matches.length === 1 ? matches[0] : primaryUsername,
    conflict: matches.length > 1,
    matches,
  };
}

function parseReadOnlyWalletRecord(raw) {
  if (!raw) return null;
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_error) { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function healthyReadOnlyWalletRecord(record) {
  return Boolean(record && !record.disabled && !record.wallet_merged_into);
}

// Identity-owner records were written by older clients before the explicit
// login alias registry existed.  In particular, Cons may still be stored as
// `local:@cons espher`.  Normalize that value before applying the strict
// read-only duplicate check.  This import must stay lazy: identity.js itself
// lazily imports this module while canonicalizing local principals.
function canonicalReadOnlyOwner(value) {
  const raw = String(value || '').trim();
  if (!/^local:[^\r\n]{1,128}$/.test(raw)) return '';
  let normalized = raw;
  try {
    const { canonicalizeLocalPrincipal } = require('./identity');
    if (typeof canonicalizeLocalPrincipal === 'function') {
      normalized = canonicalizeLocalPrincipal(raw, CONS_READ_ONLY_CANONICAL);
    }
  } catch (_error) {
    // Keep the raw value; the validation below still fails closed if it is
    // not a single-token local principal.
  }
  return /^local:[^\s]{1,128}$/.test(normalized) ? normalized : '';
}

/**
 * The Cons account has one reviewed production-only exception: two historical
 * wallet records may coexist under the canonical and old credential spelling.
 * Read-only session/stat flows can select the canonical record only when both
 * records are valid and healthy and every relevant owner is the same canonical
 * local principal. This never merges data. The dedicated check-in lock below
 * may reuse this proof solely to append points/streak to the canonical record;
 * cash, VIP, withdrawals, and all other mutations remain fail-closed.
 */
async function resolveReadOnlyWalletStorageIdentity(redis, requestedUsername, { expectedPrincipal = null } = {}) {
  const identity = await resolveWalletStorageIdentity(redis, requestedUsername);
  if (!identity.conflict) return identity;

  const matches = new Set(identity.matches || []);
  if (identity.primaryUsername !== CONS_READ_ONLY_CANONICAL ||
      matches.size !== 2 ||
      !matches.has(CONS_READ_ONLY_CANONICAL) ||
      !matches.has(CONS_READ_ONLY_LEGACY)) {
    return identity;
  }

  const keys = [
    `nf_user_data:${CONS_READ_ONLY_CANONICAL}`,
    `nf_user_data:${CONS_READ_ONLY_LEGACY}`,
    `nf_identity_owner:${CONS_READ_ONLY_CANONICAL}`,
    `nf_identity_owner:${CONS_READ_ONLY_LEGACY}`,
    `nf_user_pass_owner:${CONS_READ_ONLY_CANONICAL}`,
    `nf_user_pass_owner:${CONS_READ_ONLY_LEGACY}`,
  ];
  const values = typeof redis.mget === 'function'
    ? await redis.mget(...keys)
    : await Promise.all(keys.map(key => redis.get(key)));
  if (!Array.isArray(values) || values.length !== keys.length) {
    const error = new Error('Read-only wallet identity lookup returned an invalid response');
    error.code = 'WALLET_IDENTITY_UNAVAILABLE';
    throw error;
  }

  const [canonicalRaw, legacyRaw, canonicalOwner, legacyOwner, canonicalPasswordOwner, legacyPasswordOwner] = values;
  const canonicalRecord = parseReadOnlyWalletRecord(canonicalRaw);
  const legacyRecord = parseReadOnlyWalletRecord(legacyRaw);
  if (!healthyReadOnlyWalletRecord(canonicalRecord) || !healthyReadOnlyWalletRecord(legacyRecord)) {
    return identity;
  }
  const identityOwners = [canonicalOwner, legacyOwner].map(canonicalReadOnlyOwner);
  const expectedOwner = `local:${CONS_READ_ONLY_CANONICAL}`;
  if (identityOwners.some(owner => owner !== expectedOwner) ||
      new Set(identityOwners).size !== 1) {
    return identity;
  }
  const owner = identityOwners[0];
  if (expectedPrincipal && canonicalReadOnlyOwner(expectedPrincipal) !== owner) {
    return identity;
  }
  const passwordOwners = [canonicalPasswordOwner, legacyPasswordOwner]
    .filter(Boolean)
    .map(canonicalReadOnlyOwner);
  if (passwordOwners.some(passwordOwner => passwordOwner !== owner)) {
    return identity;
  }

  return {
    ...identity,
    storageUsername: CONS_READ_ONLY_CANONICAL,
    conflict: false,
    readOnlyLegacyConflict: true,
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

/**
 * Daily check-in has one narrow reviewed legacy exception. It may update the
 * canonical Cons points/streak record when the read-only resolver has proved
 * that the two known historical records are healthy and owned by the active
 * local principal. No other mutator may use this path.
 */
async function acquireCheckinWalletDataLock(redis, requestedUsername, options = {}) {
  const { expectedPrincipal = null, ...lockOptions } = options;
  if (!expectedPrincipal) {
    const error = new Error('Check-in wallet identity requires an authenticated principal');
    error.code = 'INVALID_WALLET_IDENTITY';
    throw error;
  }

  const initial = await resolveReadOnlyWalletStorageIdentity(redis, requestedUsername, { expectedPrincipal });
  if (!initial.primaryUsername) {
    const error = new Error('Invalid wallet identity');
    error.code = 'INVALID_WALLET_IDENTITY';
    throw error;
  }
  if (initial.conflict) throw walletIdentityConflict(initial);

  const lock = await acquireUserDataLock(redis, initial.primaryUsername, lockOptions);
  if (!lock) return { lock: null, identity: initial };

  try {
    const locked = await resolveReadOnlyWalletStorageIdentity(redis, requestedUsername, { expectedPrincipal });
    if (locked.conflict ||
        locked.storageUsername !== initial.storageUsername ||
        Boolean(locked.readOnlyLegacyConflict) !== Boolean(initial.readOnlyLegacyConflict)) {
      throw walletIdentityConflict(locked, 'Wallet identity changed while the check-in operation was starting');
    }
    return {
      lock,
      identity: {
        ...locked,
        reviewedLegacyCheckinWallet: Boolean(locked.readOnlyLegacyConflict),
      },
    };
  } catch (error) {
    await releaseUserDataLock(redis, lock);
    throw error;
  }
}

module.exports = {
  acquireCheckinWalletDataLock,
  acquireWalletDataLock,
  caseVariantWalletPattern,
  findCaseVariantWallets,
  resolveUsernameAlias,
  resolveReadOnlyWalletStorageIdentity,
  resolveWalletStorageIdentity,
  walletIdentityConflict,
  walletStorageCandidates,
};
