const { createPromoterKeyResolver, getAdIdDetails } = require('./stats-data');
const { acquireUserDataLock, releaseUserDataLock } = require('./user-data-lock');
const { VERIFIED_SOURCE_OWNER_ALIASES } = require('./income-source-aliases');

function normalizeOwner(value) {
  return String(value || '').trim().toLowerCase();
}

function buildApprovedSourceOwnerRegistry(adData, requestedSourceKey = '') {
  const trustedMappings = new Map();
  const dynamicMappings = new Map();
  const addMapping = (target, ownerValue, sourceValue) => {
    const owner = normalizeOwner(ownerValue);
    const source = normalizeOwner(sourceValue);
    if (!owner || !source) return;
    if (!target.has(owner)) target.set(owner, new Set());
    target.get(owner).add(source);
  };

  const byPromoter = adData && adData.by_promoter && typeof adData.by_promoter === 'object'
    ? adData.by_promoter
    : {};
  for (const source of Object.keys(byPromoter)) addMapping(trustedMappings, source, source);
  addMapping(trustedMappings, requestedSourceKey, requestedSourceKey);
  for (const [source, aliases] of VERIFIED_SOURCE_OWNER_ALIASES.entries()) {
    for (const alias of aliases) addMapping(trustedMappings, alias, source);
  }

  const adIds = adData && adData.ad_ids && typeof adData.ad_ids === 'object'
    ? adData.ad_ids
    : {};
  for (const entry of Object.values(adIds)) {
    const source = normalizeOwner(entry && entry.username_canon);
    const rawOwner = normalizeOwner(entry && entry.username);
    if (!source || !rawOwner || !byPromoter[source]) continue;
    addMapping(dynamicMappings, rawOwner, source);
  }

  const ownersBySource = new Map();
  const sourcesByOwner = new Map();
  const ambiguousOwners = new Set();
  const allOwners = new Set([...trustedMappings.keys(), ...dynamicMappings.keys()]);
  for (const owner of allOwners) {
    // Exact source names and the explicit Eliza aliases are reviewed mappings.
    // Dynamic rows may extend that registry but cannot revoke a reviewed owner.
    const trustedSources = trustedMappings.get(owner) || new Set();
    const sources = trustedSources.size ? trustedSources : (dynamicMappings.get(owner) || new Set());
    sourcesByOwner.set(owner, new Set(sources));
    if (sources.size !== 1) {
      ambiguousOwners.add(owner);
      continue;
    }
    const [source] = sources;
    if (!ownersBySource.has(source)) ownersBySource.set(source, new Set());
    ownersBySource.get(source).add(owner);
  }
  return { ownersBySource, sourcesByOwner, ambiguousOwners };
}

function approvedWalletOwnersForSource(adData, sourceKey) {
  const source = normalizeOwner(sourceKey);
  if (!source) return new Set();
  return buildApprovedSourceOwnerRegistry(adData, source).ownersBySource.get(source) || new Set();
}

function isApprovedSourceOwner(adData, sourceKey, walletUsername) {
  return approvedWalletOwnersForSource(adData, sourceKey)
    .has(normalizeOwner(walletUsername));
}

async function scanWalletKeys(redis) {
  const keys = new Set();
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, { match: 'nf_user_data:*', count: 200 });
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
      const error = new Error('Wallet owner lookup returned an invalid response');
      error.code = 'WALLET_OWNER_LOOKUP_UNAVAILABLE';
      throw error;
    }
    cursor = String(result[0] || '0');
    for (const key of result[1]) keys.add(String(key));
  } while (cursor !== '0');
  return Array.from(keys);
}

function buildSourceOwnerIndex(walletKeys, resolveSourceKey) {
  const ownersBySource = new Map();
  for (const key of walletKeys) {
    const username = String(key).replace(/^nf_user_data:/, '');
    const sourceKey = resolveSourceKey(username);
    if (!sourceKey) continue;
    const owners = ownersBySource.get(sourceKey) || [];
    owners.push(username);
    ownersBySource.set(sourceKey, owners);
  }
  return ownersBySource;
}

async function loadSourceOwnerIndex(redis, adData) {
  const resolveSourceKey = createPromoterKeyResolver(adData || {});
  const walletKeys = await scanWalletKeys(redis);
  return {
    walletKeys,
    resolveSourceKey,
    ownersBySource: buildSourceOwnerIndex(walletKeys, resolveSourceKey),
  };
}

async function inspectApprovedSourceWalletOwner(
  redis,
  adData,
  requestedUsername,
  walletUsername,
  ownerIndex = null,
) {
  if (!redis || !adData || !adData.by_promoter || typeof adData.by_promoter !== 'object') {
    throw sourceOwnerError('INCOME_SOURCE_UNAVAILABLE', 'Income source identity is unavailable');
  }
  const index = ownerIndex || await loadSourceOwnerIndex(redis, adData);
  const sourceKey = index.resolveSourceKey(requestedUsername);
  const found = Boolean(sourceKey && adData.by_promoter[sourceKey]);
  if (!found) {
    return {
      sourceKey,
      found: false,
      owners: [],
      approved: false,
      unique: false,
      authorized: false,
      index,
    };
  }
  const owners = index.ownersBySource.get(sourceKey) || [];
  const normalizedWallet = normalizeOwner(walletUsername);
  const approved = isApprovedSourceOwner(adData, sourceKey, normalizedWallet);
  const unique = owners.length === 1 && normalizeOwner(owners[0]) === normalizedWallet;
  return {
    sourceKey,
    found: true,
    owners,
    approved,
    unique,
    authorized: approved && unique,
    index,
  };
}

function sourceOwnerError(code, message, owners = []) {
  const error = new Error(message);
  error.code = code;
  error.owners = owners;
  return error;
}

async function acquireWalletCreationSourceGuard(redis, requestedUsername, identity, adData = null) {
  if (!identity) return null;
  const sources = adData || await getAdIdDetails();
  if (!sources || !sources.by_promoter || typeof sources.by_promoter !== 'object') {
    throw sourceOwnerError('INCOME_SOURCE_UNAVAILABLE', 'Income source identity is unavailable');
  }
  const resolveSourceKey = createPromoterKeyResolver(sources);
  const sourceKey = resolveSourceKey(requestedUsername);
  if (!sourceKey || !sources.by_promoter[sourceKey]) return null;
  if (!isApprovedSourceOwner(sources, sourceKey, identity.storageUsername)) {
    throw sourceOwnerError(
      'INCOME_SOURCE_OWNER_UNVERIFIED',
      'Wallet identity is not the verified owner of this income source',
    );
  }

  const lock = await acquireUserDataLock(redis, `income-source-owner:${sourceKey}`);
  if (!lock) throw sourceOwnerError('INCOME_SOURCE_BUSY', 'Income source is being updated');
  try {
    const index = await loadSourceOwnerIndex(redis, sources);
    const owners = index.ownersBySource.get(sourceKey) || [];
    const validOwners = identity.matches.length === 0
      ? owners.length === 0
      : owners.length === 1 && owners[0] === identity.storageUsername;
    if (!validOwners) {
      throw sourceOwnerError(
        'INCOME_SOURCE_OWNER_CONFLICT',
        'Another wallet already owns this income source',
        owners,
      );
    }
    return lock;
  } catch (error) {
    await releaseUserDataLock(redis, lock);
    throw error;
  }
}

module.exports = {
  VERIFIED_SOURCE_OWNER_ALIASES,
  acquireWalletCreationSourceGuard,
  approvedWalletOwnersForSource,
  buildApprovedSourceOwnerRegistry,
  buildSourceOwnerIndex,
  isApprovedSourceOwner,
  inspectApprovedSourceWalletOwner,
  loadSourceOwnerIndex,
  scanWalletKeys,
};
