const crypto = require('crypto');
const { scopedToken, readScopedToken } = require('./auth');
const { ProviderError } = require('./providers');

const RECEIPT_SCOPE = 'p0_rank_v1';
const RECEIPT_VERSION = 1;
const RECEIPT_TTL_MS = 20 * 60 * 1000;
const WINDOW_DAYS = new Set([1, 7, 30, 90]);

function text(value, max = 200) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
}

function number(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : 0;
}

function normalizedTitle(value) {
  // Match the catalogue/provider title key: punctuation and apostrophe
  // presentation differences should not strand a freshly issued receipt,
  // while the signed SKU and route claims still provide the exact binding.
  return text(value, 300)
    .normalize('NFKD')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}

function targetSnapshot(delivery = {}) {
  const accountId = Number(delivery.accountId || 0);
  const applicationId = text(delivery.applicationId, 100);
  const appKey = text(delivery.appKey, 80);
  const platform = text(delivery.platform, 40).toLowerCase();
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !applicationId || !appKey || !['facebook', 'instagram', 'tiktok'].includes(platform)) {
    throw new ProviderError('A verified target account, application, and platform are required for P0 selection', { status: 400 });
  }
  return { accountId, applicationId, appKey, platform };
}

function sourceHealth(value) {
  return String(value || '').trim().toLowerCase();
}

function verifiedMetrics(book = {}, context = {}) {
  if (String(context.source || '') !== 'content_dashboard_performance'
    || String(context.dataQuality || '') !== 'verified_metrics'
    || sourceHealth(context.sourceHealth) !== 'healthy'
    || context.stale === true
    || book?.ownershipVerified !== true
    || book?.automationReady !== true) {
    throw new ProviderError('P0 receipt requires a fresh verified catalog row for the exact target application', { status: 409 });
  }
  const readerBase = number(book.baseReadUnt, 0, 1e12);
  if (readerBase <= 0) throw new ProviderError('P0 receipt cannot be issued for a zero-reader catalog row', { status: 422 });
  return readerBase;
}

function selectionFilters(filters = {}) {
  return {
    language: ['EN', 'PT', 'ES'].includes(String(filters.language || '')) ? String(filters.language) : '',
    complete: text(filters.complete, 20),
    length: ['all', 'short', 'long'].includes(String(filters.length || '')) ? String(filters.length) : 'all',
    genre: text(filters.genre, 40),
    readBaseMin: number(filters.readBaseMin, 0, 1e12),
    firstReadMin: number(filters.firstReadMin, 0, 1),
    longReadMin: number(filters.longReadMin, 0, 1)
  };
}

function issueP0Receipt(book = {}, context = {}) {
  const target = targetSnapshot(context.target || book.selectionTarget || {});
  const title = text(book.title, 300);
  const sku = text(book.bookSkuId || book.sku, 160);
  if (!title || !sku) throw new ProviderError('P0 receipt requires an exact title and SKU', { status: 422 });
  const windowDays = Number(context.windowDays || 0);
  if (!WINDOW_DAYS.has(windowDays)) throw new ProviderError('P0 receipt has an unsupported ranking window', { status: 422 });
  const readerBase = verifiedMetrics(book, context);
  const issuedAt = Date.now();
  const suppliedGeneratedAt = text(context.generatedAt, 80);
  const generatedAtMs = Date.parse(suppliedGeneratedAt);
  const snapshotGeneratedAt = Number.isFinite(generatedAtMs) ? generatedAtMs : issuedAt;
  if (snapshotGeneratedAt > issuedAt + 60 * 1000) {
    throw new ProviderError('P0 receipt cannot be issued for a future ranking snapshot', { status: 422 });
  }
  const expiresAt = Math.min(issuedAt + RECEIPT_TTL_MS, snapshotGeneratedAt + RECEIPT_TTL_MS);
  if (expiresAt <= issuedAt) {
    throw new ProviderError('P0 ranking snapshot expired; refresh it before starting production', { status: 409 });
  }
  const selectionRank = number(book.selectionRank ?? book.recommendationRank ?? book.rank, 0, 100000);
  const claims = {
    v: RECEIPT_VERSION,
    type: 'p0_rank',
    iat: issuedAt,
    exp: expiresAt,
    title,
    rankedTitle: title,
    sku,
    target,
    source: 'content_dashboard_performance',
    dataQuality: 'verified_metrics',
    sourceHealth: 'healthy',
    stale: false,
    generatedAt: new Date(snapshotGeneratedAt).toISOString(),
    snapshotVersion: text(context.snapshotVersion || book.snapshotVersion, 100) || 'p0_rank_v1',
    windowDays,
    sourceRank: number(book.rank, 0, 100000),
    recommendationRank: number(book.recommendationRank, 0, 100000),
    selectionRank,
    selectionScore: number(book.selectionScore ?? book.promotionScore, 0, 100),
    readerBase,
    firstReadRate: number(book.firstReadUntRate, 0, 100),
    longReadRate: number(Object.prototype.hasOwnProperty.call(book, 'read20wRate')
      && book.read20wRate !== null && book.read20wRate !== '' && book.read20wRate !== undefined
      ? book.read20wRate
      : book.read10wRate, 0, 100),
    trend7v30: book.trend7v30 === null || book.trend7v30 === undefined || book.trend7v30 === '' ? null : number(book.trend7v30, -10, 10),
    filters: selectionFilters(context.filters)
  };
  return scopedToken(RECEIPT_SCOPE, claims);
}

function invalidReceipt(message, status = 409) {
  throw new ProviderError(message, { status });
}

function p0SelectionFromReceipt(receipt, expected = {}) {
  const claims = readScopedToken(RECEIPT_SCOPE, receipt);
  if (!claims || claims.v !== RECEIPT_VERSION || claims.type !== 'p0_rank') invalidReceipt('P0 selection receipt is invalid; refresh the verified ranking before starting production');
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= Date.now()) invalidReceipt('P0 selection receipt expired; refresh the verified ranking before starting production');
  const generatedAtMs = Date.parse(text(claims.generatedAt, 80));
  if (!Number.isFinite(generatedAtMs)
    || Number(claims.exp) > generatedAtMs + RECEIPT_TTL_MS) {
    invalidReceipt('P0 selection receipt is not bound to its verified ranking snapshot');
  }
  const target = targetSnapshot(expected.delivery || {});
  const claimTarget = targetSnapshot(claims.target || {});
  if (target.accountId !== claimTarget.accountId
    || target.applicationId !== claimTarget.applicationId
    || target.appKey !== claimTarget.appKey
    || target.platform !== claimTarget.platform) {
    invalidReceipt('P0 selection receipt does not belong to the requested SocialEcho route');
  }
  if (text(expected.sku, 160) !== text(claims.sku, 160)
    || normalizedTitle(expected.title) !== normalizedTitle(claims.title)) {
    invalidReceipt('P0 selection receipt does not belong to the exact title and SKU');
  }
  if (claims.source !== 'content_dashboard_performance'
    || claims.dataQuality !== 'verified_metrics'
    || claims.sourceHealth !== 'healthy'
    || claims.stale === true
    || !WINDOW_DAYS.has(Number(claims.windowDays))
    || number(claims.readerBase, 0, 1e12) <= 0) {
    invalidReceipt('P0 selection receipt is not backed by fresh verified ranking metrics');
  }
  return {
    source: claims.source,
    windowDays: Number(claims.windowDays),
    sourceRank: number(claims.sourceRank, 0, 100000),
    recommendationRank: number(claims.recommendationRank, 0, 100000),
    selectionRank: number(claims.selectionRank ?? claims.recommendationRank ?? claims.sourceRank, 0, 100000),
    selectionScore: number(claims.selectionScore, 0, 100),
    readerBase: number(claims.readerBase, 0, 1e12),
    firstReadRate: number(claims.firstReadRate, 0, 100),
    longReadRate: number(claims.longReadRate, 0, 100),
    trend7v30: claims.trend7v30 === null ? null : number(claims.trend7v30, -10, 10),
    filters: selectionFilters(claims.filters),
    target: { ...target },
    dataQuality: claims.dataQuality,
    sourceHealth: claims.sourceHealth,
    generatedAt: text(claims.generatedAt, 80),
    snapshotVersion: text(claims.snapshotVersion, 100) || 'legacy_v1',
    rankedTitle: text(claims.rankedTitle || claims.title, 300),
    canonicalTitle: text(claims.canonicalTitle, 300),
    canonicalVerifiedAt: text(claims.canonicalVerifiedAt, 80),
    canonicalCityBookId: text(claims.canonicalCityBookId, 160),
    receiptVersion: RECEIPT_VERSION,
    receiptIssuedAt: new Date(Number(claims.iat || 0)).toISOString(),
    receiptExpiresAt: new Date(Number(claims.exp || 0)).toISOString(),
    receiptFingerprint: crypto.createHash('sha256').update(String(receipt || '')).digest('hex')
  };
}

// A live performance row may retain an older display title even though its
// SKU still resolves to an active canonical bookstore record.  Campaign
// preview verifies that record before paid state exists, then uses this helper
// to bind the already-signed ranking metrics to the authoritative title.  The
// SKU, route, snapshot, metrics, and original expiry cannot be changed here.
function rebindP0ReceiptBook(receipt, expected = {}, canonicalBook = {}) {
  p0SelectionFromReceipt(receipt, expected);
  const claims = readScopedToken(RECEIPT_SCOPE, receipt);
  const canonicalTitle = text(canonicalBook.title, 300);
  const canonicalSku = text(canonicalBook.bookSkuId || canonicalBook.sku, 160);
  if (!canonicalTitle || !canonicalSku) invalidReceipt('Canonical P0 book identity is incomplete', 422);
  if (canonicalSku !== text(claims?.sku, 160)
    || canonicalSku !== text(expected.sku, 160)) {
    invalidReceipt('Canonical bookstore lookup returned a different SKU');
  }
  return scopedToken(RECEIPT_SCOPE, {
    ...claims,
    rankedTitle: text(claims.rankedTitle || claims.title, 300),
    title: canonicalTitle,
    sku: canonicalSku,
    canonicalTitle,
    canonicalVerifiedAt: new Date().toISOString(),
    canonicalCityBookId: text(canonicalBook.cityBookId, 160)
  });
}

function requiresP0Receipt(body = {}) {
  const source = text(body.source, 100).toLowerCase();
  const selectionSource = text(body?.p0Selection?.source, 80);
  return source.startsWith('catalog_') || source.startsWith('p0_') || selectionSource === 'content_dashboard_performance';
}

module.exports = {
  RECEIPT_SCOPE,
  RECEIPT_VERSION,
  RECEIPT_TTL_MS,
  issueP0Receipt,
  p0SelectionFromReceipt,
  rebindP0ReceiptBook,
  requiresP0Receipt
};
