'use strict';
const { isSystemStatsBucket } = require('./promoter-access');

const ALIAS_VARIANTS = {
  eliza_star: 'eliza_stellar',
  eliza_stellar: 'eliza_stellar',
  'eliza stellar': 'eliza_stellar',
  cons_espher: 'cons_espher',
  'cons espher': 'cons_espher',
  '@cons espher': 'cons_espher',
};

function canonize(name) {
  // Normalize a promoter display name for lookup in by_promoter.
  // Keep CJK / accented Latin / alphanumerics; collapse runs of whitespace / punctuation
  // to a single underscore and trim leading/trailing underscores. This ensures Chinese
  // handles like "英语" survive (the old regex [^a-z0-9] would strip them to '').
  const raw = String(name || '').toLowerCase().trim();
  if (!raw) return '';
  return raw
    .replace(/[\s\-–—.·@#$%^&*()+=[\]{};:'"<>/\|!?~`]+/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Resolve an incoming username string to the pipeline's by_promoter key.
 *
 * Resolution order:
 *   1. Exact canonical match in by_promoter.
 *   2. Known alias map (handles "Eliza_Star" → eliza_stellar, etc.).
 *   3. Last-resort: scan ad_ids for any record whose username canon-matches and return that
 *      record's username_canon (covers new/one-off mappings not in the hardcoded table).
 */
function resolvePromoterKey(rawName, adData) {
  if (isSystemStatsBucket(rawName)) return null;
  const canon = canonize(rawName);
  if (!canon) return null;
  if (adData?.by_promoter?.[canon]) return canon;
  if (ALIAS_VARIANTS[canon]) {
    const target = ALIAS_VARIANTS[canon];
    if (adData?.by_promoter?.[target]) return target;
  }
  // Scan ad_ids for any username that canonizes to the same key
  if (adData?.ad_ids) {
    for (const entry of Object.values(adData.ad_ids)) {
      if (entry.username_canon && canonize(entry.username) === canon) {
        if (adData.by_promoter[entry.username_canon]) return entry.username_canon;
      }
    }
  }
  return canon; // fallback: return canon even if no by_promoter entry exists
}

// Build the expensive ad-id fallback once for bulk callers. `resolvePromoterKey`
// intentionally keeps its standalone behavior for request paths that only resolve
// one username, while migrations can resolve every Redis wallet in O(A + U)
// instead of scanning all A ad ids for each of U users.
function createPromoterKeyResolver(adData) {
  const byPromoter = adData?.by_promoter && typeof adData.by_promoter === 'object'
    ? adData.by_promoter
    : {};
  const adIdFallbacks = new Map();
  if (adData?.ad_ids && typeof adData.ad_ids === 'object') {
    for (const entry of Object.values(adData.ad_ids)) {
      const sourceKey = String(entry && entry.username_canon || '').trim();
      const usernameCanon = canonize(entry && entry.username);
      if (!usernameCanon || !sourceKey || !byPromoter[sourceKey] || adIdFallbacks.has(usernameCanon)) continue;
      // Preserve resolvePromoterKey's first-match behavior for ambiguous legacy rows.
      adIdFallbacks.set(usernameCanon, sourceKey);
    }
  }

  return rawName => {
    if (isSystemStatsBucket(rawName)) return null;
    const canon = canonize(rawName);
    if (!canon) return null;
    if (byPromoter[canon]) return canon;
    const aliasTarget = ALIAS_VARIANTS[canon];
    if (aliasTarget && byPromoter[aliasTarget]) return aliasTarget;
    return adIdFallbacks.get(canon) || canon;
  };
}

module.exports = { ALIAS_VARIANTS, canonize, resolvePromoterKey, createPromoterKeyResolver };
