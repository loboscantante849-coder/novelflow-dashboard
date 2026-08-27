const { canonizePromoter } = require('./promoter-access');

// Historical reporting rows predate account passwords. A username alone is
// public information, so it must never be sufficient to claim one of these
// accounts. The account owner has both assets they created: a promotion code
// and a promotion link. We compare the submitted pair to the trusted live
// reporting snapshot without returning any matching values to the client.
const CODE_RE = /^[A-Za-z0-9_-]{3,128}$/;
const LINK_RE = /^[A-Za-z0-9_-]{8,160}$/;

function normalizeCode(value) {
  const code = String(value || '').trim();
  return CODE_RE.test(code) ? code.toLowerCase() : '';
}

function normalizeLink(value) {
  const raw = String(value || '').trim();
  if (LINK_RE.test(raw)) return raw.toLowerCase();
  try {
    const url = new URL(raw);
    const lastSegment = url.pathname.split('/').filter(Boolean).pop() || '';
    return LINK_RE.test(lastSegment) ? lastSegment.toLowerCase() : '';
  } catch (_error) {
    return '';
  }
}

function recoveryProofFromRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const promotionCode = normalizeCode(value.promotion_code);
  const promotionLink = normalizeLink(value.promotion_link);
  if (!promotionCode || !promotionLink) return null;
  return { promotionCode, promotionLink };
}

function promoterEntry(snapshot, username) {
  const expected = canonizePromoter(username);
  if (!expected || !snapshot || typeof snapshot !== 'object') return null;
  for (const [key, entry] of Object.entries(snapshot.by_promoter || {})) {
    if (canonizePromoter(key) === expected || canonizePromoter(entry && entry.display_name) === expected) {
      return entry && typeof entry === 'object' ? entry : null;
    }
  }
  return null;
}

function verifiesLegacyPromoterProof(snapshot, username, proofValue) {
  const proof = recoveryProofFromRequest(proofValue);
  const entry = promoterEntry(snapshot, username);
  if (!proof || !entry) return false;
  const codes = new Set((Array.isArray(entry.codes) ? entry.codes : []).map(normalizeCode).filter(Boolean));
  const links = new Set((Array.isArray(entry.links) ? entry.links : []).map(normalizeLink).filter(Boolean));
  return codes.has(proof.promotionCode) && links.has(proof.promotionLink);
}

module.exports = {
  normalizeCode,
  normalizeLink,
  recoveryProofFromRequest,
  verifiesLegacyPromoterProof,
};
