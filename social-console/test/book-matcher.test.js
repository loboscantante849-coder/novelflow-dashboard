const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { mergeBooks, lexicalScore, recommendationScore, matchBooks, visibleTitleFromQuery } = require('../api/_lib/book-matcher');

test('merges the same SKU across bookstore and ranking sources', () => {
  const books = mergeBooks([
    { name: 'bookstore_uv', metric: 'uv', books: [{ bookSkuId: 'sku-1', title: 'The Crown', uv: 100, rank: 4, tags: ['royal'] }] },
    { name: 'content_30d_firstReadUntRate', metric: 'firstReadUntRate', books: [{ bookSkuId: 'sku-1', title: 'The Crown', firstReadUntRate: 32, rank: 9, category: 'Romance' }] }
  ]);
  assert.equal(books.length, 1);
  assert.deepEqual(books[0].sources.sort(), ['bookstore_uv', 'content_30d_firstReadUntRate'].sort());
  assert.equal(books[0].uv, 100);
  assert.equal(books[0].firstReadUntRate, 32);
});

test('title evidence scores higher than an unrelated excerpt', () => {
  const book = { title: 'The Last Crown', author: 'Mira', tags: ['royal marriage'], category: 'Romance', description: 'A hidden heir returns.' };
  assert.ok(lexicalScore('The Last Crown', book) > lexicalScore('spaceship repair manual', book));
});

test('recommendation score rewards shared category and tags', () => {
  const reference = { category: 'Romance', tags: ['contract marriage'] };
  assert.ok(recommendationScore({ category: 'Romance', tags: ['contract marriage'], rankings: { uv: { rank: 1 } } }, reference) > recommendationScore({ category: 'Mystery', tags: ['detective'], rankings: {} }, reference));
});

test('extracts a visible screenshot title without story text', () => {
  assert.equal(visibleTitleFromQuery('Visible title: My Husband Sent His Twin to My Bed, and I Made Him King\nChapter 1'), 'My Husband Sent His Twin to My Bed, and I Made Him King');
});

test('resolves a visible screenshot title against the bookstore before building rankings', async () => {
  const original = providers.findExactBook;
  providers.findExactBook = async (title) => ({ bookSkuId: 'sku-exact', title, description: 'An exact bookstore introduction.' });
  try {
    const redis = { get: async () => { throw new Error('ranking catalog should not be read'); } };
    const result = await matchBooks(redis, 'Visible title: My Husband Sent His Twin to My Bed, and I Made Him King\nChapter 1 text');
    assert.equal(result.matches[0].bookSkuId, 'sku-exact');
    assert.equal(result.matches[0].confidence, 99);
    assert.equal(result.matches[0].description, 'An exact bookstore introduction.');
    assert.equal(result.model, 'bookstore-exact-title');
  } finally {
    providers.findExactBook = original;
  }
});
