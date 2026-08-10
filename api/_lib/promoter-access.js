const SYSTEM_STATS_BUCKETS = new Set(['_unmapped']);

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

function getProtectedPromoters() {
  if (protectedPromoters) return protectedPromoters;
  const result = new Set();
  try {
    const snapshot = require('../../ad_id_details.json');
    for (const [key, entry] of Object.entries(snapshot.by_promoter || {})) {
      const canonicalKey = canonizePromoter(key);
      const displayName = canonizePromoter(entry && entry.display_name);
      if (canonicalKey && !isSystemStatsBucket(canonicalKey)) result.add(canonicalKey);
      if (displayName && !isSystemStatsBucket(displayName)) result.add(displayName);
    }
  } catch (_error) {
    // A missing snapshot must not make system buckets available.
  }
  protectedPromoters = result;
  return result;
}

function isProtectedPromoterUsername(value) {
  if (isSystemStatsBucket(value)) return true;
  const canonical = canonizePromoter(value);
  return Boolean(canonical && getProtectedPromoters().has(canonical));
}

module.exports = {
  SYSTEM_STATS_BUCKETS,
  canonizePromoter,
  isProtectedPromoterUsername,
  isSystemStatsBucket,
};
