const test = require('node:test');
const assert = require('node:assert/strict');
const { issueP0Receipt, p0SelectionFromReceipt, rebindP0ReceiptBook, requiresP0Receipt } = require('../api/_lib/p0-receipts');

const previousSecret = process.env.SOCIAL_CONSOLE_SESSION_SECRET;
process.env.SOCIAL_CONSOLE_SESSION_SECRET = 'p0-receipt-test-secret-at-least-thirty-two-characters-long';

const target = { accountId: 13751295, applicationId: '642fc1ace309494378a774a6', appKey: 'novelflow', platform: 'facebook' };
const book = { title: 'Receipt Bound Luna', bookSkuId: 'receipt-sku-1', rank: 1, recommendationRank: 2, selectionRank: 3, selectionScore: 87.25, baseReadUnt: 120, firstReadUntRate: 0.4, read10wRate: 0.2, read20wRate: 0.15, ownershipVerified: true, automationReady: true };
const context = { target, source: 'content_dashboard_performance', dataQuality: 'verified_metrics', sourceHealth: 'healthy', stale: false, generatedAt: new Date(Date.now() - 1000).toISOString(), snapshotVersion: 'p0_multi_axis_v1', windowDays: 1, filters: { language: 'EN', length: 'long' } };

test('P0 receipt is bound to the exact target, SKU, and fresh verified metrics', () => {
  const receipt = issueP0Receipt(book, context);
  const selection = p0SelectionFromReceipt(receipt, { delivery: target, title: book.title, sku: book.bookSkuId });
  assert.equal(selection.windowDays, 1);
  assert.equal(selection.readerBase, 120);
  assert.equal(selection.target.applicationId, target.applicationId);
  assert.equal(selection.dataQuality, 'verified_metrics');
  assert.equal(selection.selectionRank, 3);
  assert.equal(selection.selectionScore, 87.25);
  assert.equal(selection.snapshotVersion, 'p0_multi_axis_v1');
  assert.ok(Date.parse(selection.receiptExpiresAt) <= Date.parse(context.generatedAt) + 20 * 60 * 1000);
});

test('P0 receipt lifetime is capped by snapshot age rather than response time', () => {
  const generatedAt = new Date(Date.now() - 19 * 60 * 1000).toISOString();
  const receipt = issueP0Receipt(book, { ...context, generatedAt });
  const selection = p0SelectionFromReceipt(receipt, { delivery: target, title: book.title, sku: book.bookSkuId });
  assert.ok(Date.parse(selection.receiptExpiresAt) <= Date.parse(generatedAt) + 20 * 60 * 1000);
  assert.ok(Date.parse(selection.receiptExpiresAt) > Date.now());
  assert.throws(() => issueP0Receipt(book, { ...context, generatedAt: new Date(Date.now() - 20 * 60 * 1000 - 1).toISOString() }), /snapshot expired/);
});

test('a real zero read20w metric never falls back to read10w in a receipt', () => {
  const receipt = issueP0Receipt({ ...book, read20wRate: 0, read10wRate: 28 }, context);
  const selection = p0SelectionFromReceipt(receipt, { delivery: target, title: book.title, sku: book.bookSkuId });
  assert.equal(selection.longReadRate, 0);
});

test('legacy callers may omit the new audit fields', () => {
  const legacyBook = { ...book };
  delete legacyBook.selectionRank;
  delete legacyBook.selectionScore;
  const legacyContext = { ...context };
  delete legacyContext.generatedAt;
  delete legacyContext.snapshotVersion;
  const receipt = issueP0Receipt(legacyBook, legacyContext);
  const selection = p0SelectionFromReceipt(receipt, { delivery: target, title: book.title, sku: book.bookSkuId });
  assert.equal(selection.selectionRank, book.recommendationRank);
  assert.equal(selection.selectionScore, 0);
  assert.equal(selection.snapshotVersion, 'p0_rank_v1');
});

test('P0 receipt cannot be replayed to another account or SKU', () => {
  const receipt = issueP0Receipt(book, context);
  assert.throws(() => p0SelectionFromReceipt(receipt, { delivery: { ...target, accountId: 13943450 }, title: book.title, sku: book.bookSkuId }), /does not belong to the requested SocialEcho route/);
  assert.throws(() => p0SelectionFromReceipt(receipt, { delivery: target, title: book.title, sku: 'other-sku' }), /does not belong to the exact title and SKU/);
});

test('P0 receipt tolerates catalogue apostrophe and punctuation presentation', () => {
  const receipt = issueP0Receipt({ ...book, title: "The Lycan King\u2019s Treasured Luna" }, context);
  const selection = p0SelectionFromReceipt(receipt, {
    delivery: target,
    title: "The Lycan King's Treasured Luna",
    sku: book.bookSkuId
  });
  assert.equal(selection.readerBase, book.baseReadUnt);
});

test('an exact bookstore result may rebind only the canonical title for the same signed SKU and route', () => {
  const receipt = issueP0Receipt(book, context);
  const before = p0SelectionFromReceipt(receipt, { delivery: target, title: book.title, sku: book.bookSkuId });
  const rebound = rebindP0ReceiptBook(receipt, {
    delivery: target,
    title: book.title,
    sku: book.bookSkuId
  }, {
    title: 'The Canonical Book Title',
    bookSkuId: book.bookSkuId,
    cityBookId: 'city-canonical-1'
  });
  const selection = p0SelectionFromReceipt(rebound, {
    delivery: target,
    title: 'The Canonical Book Title',
    sku: book.bookSkuId
  });
  assert.equal(selection.readerBase, 120);
  assert.equal(selection.receiptIssuedAt, before.receiptIssuedAt);
  assert.equal(selection.receiptExpiresAt, before.receiptExpiresAt);
  assert.deepEqual(selection.target, before.target);
  assert.equal(selection.snapshotVersion, before.snapshotVersion);
  assert.equal(selection.rankedTitle, book.title);
  assert.equal(selection.canonicalTitle, 'The Canonical Book Title');
  assert.equal(selection.canonicalCityBookId, 'city-canonical-1');
  assert.ok(Number.isFinite(Date.parse(selection.canonicalVerifiedAt)));
  assert.throws(() => rebindP0ReceiptBook(receipt, {
    delivery: target,
    title: book.title,
    sku: book.bookSkuId
  }, { title: 'Wrong SKU', bookSkuId: 'other-sku' }), /different SKU/);
});

test('P0 receipt signature is purpose-separated from a session signature', () => {
  const receipt = issueP0Receipt(book, context);
  const tampered = `${receipt.slice(0, -1)}${receipt.endsWith('a') ? 'b' : 'a'}`;
  assert.throws(() => p0SelectionFromReceipt(tampered, { delivery: target, title: book.title, sku: book.bookSkuId }), /receipt is invalid/);
});

test('verified-catalog production sources require a P0 receipt', () => {
  assert.equal(requiresP0Receipt({ source: 'catalog_novelflow_facebook_1d' }), true);
  assert.equal(requiresP0Receipt({ source: 'p0_v20_daily_best' }), true);
  assert.equal(requiresP0Receipt({ source: 'manual' }), false);
});

test.after(() => {
  if (previousSecret === undefined) delete process.env.SOCIAL_CONSOLE_SESSION_SECRET;
  else process.env.SOCIAL_CONSOLE_SESSION_SECRET = previousSecret;
});
