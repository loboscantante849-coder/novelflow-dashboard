const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeHttpsCoverUrl,
  extractBookCover,
} = require('../api/_lib/book-covers');

test('cover URLs are normalized to HTTPS and unsafe schemes are rejected', () => {
  assert.equal(normalizeHttpsCoverUrl('http://cdn.example/cover.jpg'), 'https://cdn.example/cover.jpg');
  assert.equal(normalizeHttpsCoverUrl('//cdn.example/cover.jpg'), 'https://cdn.example/cover.jpg');
  assert.equal(normalizeHttpsCoverUrl('javascript:alert(1)'), '');
  assert.equal(normalizeHttpsCoverUrl('data:image/svg+xml,<svg/>'), '');
});

test('book cover extraction requires the exact selected book id', () => {
  const payload = {
    data: { data: [
      { bookId: 'other', cover: 'https://cdn.example/wrong.jpg' },
      { bookId: 'selected', coverImageUrl: 'http://cdn.example/right.jpg' },
    ] },
  };
  assert.equal(extractBookCover(payload, 'selected'), 'https://cdn.example/right.jpg');
  assert.equal(extractBookCover(payload, 'missing'), '');
});

test('Profile uses an explicit placeholder and lets trusted API covers repair stale local metadata', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  assert.match(source, /safeClientUrl\(book\.cover \|\| book\.coverImage[^\n]+\|\| '\/book-cover-placeholder\.svg'/);
  assert.match(source, /if \(local && local\.cover !== apiBook\.cover\)/);
  assert.match(source, /onerror="this\.onerror=null;this\.src='\/book-cover-placeholder\.svg'"/);
});

test('a wrong-typed cover cache key is repaired instead of failing every write', async () => {
  const { cacheBookCover, writeCoverHash } = require('../api/_lib/book-covers');
  const calls = [];
  let failFirst = true;
  const redis = {
    async hset(key, values) {
      calls.push(['hset', key, values]);
      if (failFirst) {
        failFirst = false;
        const error = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        throw error;
      }
      return 'OK';
    },
    async del(key) {
      calls.push(['del', key]);
      return 1;
    },
  };

  const stored = await cacheBookCover(redis, 'book-1', 'https://cdn.example/book-1.jpg');

  assert.equal(stored, true);
  assert.deepEqual(calls, [
    ['hset', 'nf_book_covers', { 'book-1': 'https://cdn.example/book-1.jpg' }],
    ['del', 'nf_book_covers'],
    ['hset', 'nf_book_covers', { 'book-1': 'https://cdn.example/book-1.jpg' }],
  ]);
  assert.equal(typeof writeCoverHash, 'function');
});
