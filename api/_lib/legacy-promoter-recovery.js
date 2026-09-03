const { canonizePromoter } = require('./promoter-access');

// This module is retained only for parsing/auditing historical reporting
// rows. Promotion codes and links are public and are never authentication
// credentials; password recovery is handled manually by support.

// Historical reporting rows predate account passwords. A username alone is
// public information, so it must never be sufficient to claim one of these
// accounts. The account owner has both assets they created: a promotion code
// and a promotion link. We compare the submitted pair to the trusted live
// reporting snapshot without returning any matching values to the client.
const CODE_RE = /^[A-Za-z0-9_-]{3,128}$/;
const LINK_RE = /^[A-Za-z0-9_-]{8,160}$/;
const SHORT_LINK_HOST = 'social.novelplatform.vip';
const ID_LINK_HOSTS = new Set([
  'novelflow.top',
  'www.novelflow.top',
  'novelflow.app',
  'www.novelflow.app',
  SHORT_LINK_HOST,
]);

// `submissions.json` is shipped with the same trusted reporting snapshot as
// this function. It contains the historical short URL alongside the internal
// linkId, allowing a user to prove ownership with the URL they actually saw.
// Loading it once keeps recovery bounded and avoids a request-time fetch of
// mutable/unauthenticated data.
function loadBundledSubmissions() {
  try {
    const rows = require('../../submissions.json');
    return Array.isArray(rows) ? rows : Object.values(rows || {});
  } catch (_error) {
    return [];
  }
}

const TRUSTED_SUBMISSIONS = loadBundledSubmissions();

/**
 * Compatibility shim for older internal callers. Public promotion codes and
 * links are intentionally not authentication credentials, so this function
 * can never change a password or touch Redis. Endpoints should return the
 * same support-required response before calling it.
 */
async function recoverLegacyPromoterPassword() {
  return { ok: false, status: 409, code: 'SUPPORT_RECOVERY_REQUIRED' };
}

function normalizeCode(value) {
  const code = String(value || '').trim();
  return CODE_RE.test(code) ? code.toLowerCase() : '';
}

function normalizeShortLinkToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let candidate = raw;
  // Accept the copied form without a scheme, but only for the one trusted
  // short-link host. This does not turn arbitrary hostnames into proof.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== SHORT_LINK_HOST ||
        url.port || url.username || url.password || url.search || url.hash) return '';
    const match = url.pathname.match(/^\/s\/([A-Za-z0-9]{6})\/?$/);
    // Short-link tokens are base62 and therefore case-sensitive.
    return match ? match[1] : '';
  } catch (_error) {
    return '';
  }
}

function parseLinkProof(value) {
  const raw = String(value || '').trim();
  if (LINK_RE.test(raw)) return { id: raw.toLowerCase() };
  const shortToken = normalizeShortLinkToken(raw);
  if (shortToken) return { shortToken };

  // Historical support messages sometimes contain a dashboard URL ending in
  // the internal linkId. Keep accepting that exact trusted identifier, but
  // reject arbitrary hosts and URLs with query/fragment components.
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !ID_LINK_HOSTS.has(url.hostname.toLowerCase()) ||
        url.port || url.username || url.password || url.search || url.hash) return null;
    const lastSegment = url.pathname.split('/').filter(Boolean).pop() || '';
    return LINK_RE.test(lastSegment) ? { id: lastSegment.toLowerCase() } : null;
  } catch (_error) {
    return null;
  }
}

function normalizeLink(value) {
  const parsed = parseLinkProof(value);
  if (!parsed) return '';
  return parsed.id || `short:${parsed.shortToken}`;
}

function recoveryProofFromRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const promotionCode = normalizeCode(value.promotion_code);
  const parsedLink = parseLinkProof(value.promotion_link);
  const promotionLink = parsedLink ? (parsedLink.id || `short:${parsedLink.shortToken}`) : '';
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

function trustedSubmissionLinks(username, promotionCode) {
  const expectedUsername = canonizePromoter(username);
  if (!expectedUsername || !promotionCode) return [];
  return TRUSTED_SUBMISSIONS.filter(row => {
    if (!row || typeof row !== 'object' || String(row.status || '').toLowerCase() !== 'completed' ||
        normalizeCode(row.code) !== promotionCode) return false;
    const owner = row.discordUsername || row.username || row.koc_username || row.display_name;
    return canonizePromoter(owner) === expectedUsername;
  }).map(row => ({
    linkId: String(row.linkId || '').trim().toLowerCase(),
    shortTokens: [row.link, row.shortUrl].map(normalizeShortLinkToken).filter(Boolean),
  })).filter(row => row.linkId || row.shortTokens.length);
}

function verifiesLegacyPromoterProof(snapshot, username, proofValue) {
  const proof = recoveryProofFromRequest(proofValue);
  const entry = promoterEntry(snapshot, username);
  if (!proof || !entry) return false;
  const codes = new Set((Array.isArray(entry.codes) ? entry.codes : []).map(normalizeCode).filter(Boolean));
  const links = new Set((Array.isArray(entry.links) ? entry.links : []).map(normalizeLink).filter(Boolean));
  const mapped = trustedSubmissionLinks(username, proof.promotionCode).filter(row => row.linkId);
  // The bundled submission index may contain a valid historical asset that
  // has already aged out of the latest reporting snapshot. Treat that trusted
  // row as sufficient code evidence, while still requiring the owner and the
  // paired link to match it.
  if (!codes.has(proof.promotionCode) && !mapped.length) return false;

  if (proof.promotionLink.startsWith('short:')) {
    const token = proof.promotionLink.slice('short:'.length);
    return trustedSubmissionLinks(username, proof.promotionCode).some(row =>
      row.shortTokens.includes(token)
    );
  }

  // When the bundled submission index has this code, require the submitted
  // linkId to be the one paired with that code. Older pipeline-only rows do
  // not have a submission row, so retain the snapshot-set fallback for them.
  if (mapped.length) return mapped.some(row => row.linkId === proof.promotionLink);
  return links.has(proof.promotionLink);
}

module.exports = {
  normalizeCode,
  normalizeLink,
  normalizeShortLinkToken,
  parseLinkProof,
  recoverLegacyPromoterPassword,
  recoveryProofFromRequest,
  trustedSubmissionLinks,
  verifiesLegacyPromoterProof,
};
