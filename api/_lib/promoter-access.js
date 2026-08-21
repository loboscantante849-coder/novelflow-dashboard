const SYSTEM_STATS_BUCKETS = new Set(['_unmapped']);
const { verifiedSourceOwnerAliasValues } = require('./income-source-aliases');

function canonizePromoter(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/[\s\-\u2013\u2014.\u00b7@#$%^&*()+=[\]{};:'"<>/\\|!?~`]+/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_|_$/g, '');
}

function isSystemStatsBucket(value) {
  return SYSTEM_STATS_BUCKETS.has(String(value || '').trim().toLowerCase());
}

let protectedPromoters = null;

function buildProtectedPromoters(snapshot) {
  const result = new Set();
  if (snapshot && typeof snapshot === 'object') {
    for (const [key, entry] of Object.entries(snapshot.by_promoter || {})) {
      const canonicalKey = canonizePromoter(key);
      const displayName = canonizePromoter(entry && entry.display_name);
      if (canonicalKey && !isSystemStatsBucket(canonicalKey)) result.add(canonicalKey);
      if (displayName && !isSystemStatsBucket(displayName)) result.add(displayName);
    }
    // Pipeline raw usernames are authentication-sensitive identities as well
    // as reporting aliases. Reserve every spelling present in the trusted
    // snapshot (including ambiguous legacy rows) so an empty wallet/password
    // slot cannot be claimed before ownership reconciliation.
    for (const entry of Object.values(snapshot.ad_ids || {})) {
      const rawUsername = canonizePromoter(entry && entry.username);
      if (rawUsername && !isSystemStatsBucket(rawUsername)) result.add(rawUsername);
    }
  }
  for (const alias of verifiedSourceOwnerAliasValues()) {
    const canonicalAlias = canonizePromoter(alias);
    if (canonicalAlias && !isSystemStatsBucket(canonicalAlias)) result.add(canonicalAlias);
  }
  return result;
}

function getProtectedPromoters() {
  if (protectedPromoters) return protectedPromoters;
  let snapshot = null;
  try {
    snapshot = require('../../ad_id_details.json');
  } catch (_error) {
    // Explicit verified aliases and system buckets remain protected even when
    // the bundled reporting snapshot is missing.
  }
  const result = buildProtectedPromoters(snapshot);
  protectedPromoters = result;
  return result;
}

function isProtectedPromoterUsername(value, runtimeSnapshot = null) {
  if (isSystemStatsBucket(value)) return true;
  const canonical = canonizePromoter(value);
  if (!canonical) return false;
  if (getProtectedPromoters().has(canonical)) return true;
  return Boolean(runtimeSnapshot && buildProtectedPromoters(runtimeSnapshot).has(canonical));
}

module.exports = {
  SYSTEM_STATS_BUCKETS,
  buildProtectedPromoters,
  canonizePromoter,
  isProtectedPromoterUsername,
  isSystemStatsBucket,
};
