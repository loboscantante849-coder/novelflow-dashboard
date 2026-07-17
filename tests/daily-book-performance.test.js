const assert = require('node:assert/strict');
const test = require('node:test');

const dailyBooks = require('../daily-book-performance');

const links = [
  {
    bookId: 'book-1',
    bookName: 'First Book',
    code: '1001',
    daily: {
      '2026-07-15': { visits: 3, unique_users: 3, new_users: 1, income: 0.25 },
      '2026-07-16': { visits: 8, unique_users: 8, new_users: 2, income: 1.15 },
    },
  },
  {
    bookId: 'book-1',
    bookName: 'First Book',
    code: '1002',
    daily: {
      '2026-07-16': { visits: 4, unique_users: 4, new_users: 1, income: 0.35 },
    },
  },
  {
    bookId: 'book-2',
    bookName: 'Second Book',
    code: '1003',
    daily: {
      '2026-07-16': { visits: 7, unique_users: 7, new_users: 4, income: 2.1 },
    },
  },
];

test('lists available reporting dates in order', () => {
  assert.deepEqual(dailyBooks.availableDates(links), ['2026-07-15', '2026-07-16']);
});

test('omits empty dates and books with no activity on the selected date', () => {
  const rows = dailyBooks.aggregateForDate([
    { bookId: 'active', bookName: 'Active', daily: { '2026-07-16': { visits: 2 } } },
    { bookId: 'empty', bookName: 'Empty', daily: { '2026-07-16': { visits: 0, new_users: 0, income: 0 } } },
    { bookId: 'refund', bookName: 'Refund', daily: { '2026-07-17': { income: -0.5 } } },
    { bookId: 'missing', bookName: 'Missing', daily: {} },
  ], '2026-07-16');

  assert.deepEqual(rows.map(row => row.bookId), ['active']);
  assert.deepEqual(dailyBooks.availableDates([
    { daily: { '2026-07-15': { visits: 0 }, '2026-07-16': { new_users: 1 }, '2026-07-17': { income: -0.5 } } },
  ]), ['2026-07-16', '2026-07-17']);
  assert.equal(dailyBooks.hasActivity({ visits: 0, new_users: 0, income: 0 }), false);
  assert.equal(dailyBooks.hasActivity({ income: -0.5 }), true);
});

test('groups multiple promotion assets for the same book', () => {
  const rows = dailyBooks.aggregateForDate(links, '2026-07-16');
  const firstBook = rows.find(row => row.bookId === 'book-1');

  assert.equal(rows.length, 2);
  assert.deepEqual(firstBook, {
    key: 'id:book-1',
    bookId: 'book-1',
    bookName: 'First Book',
    assets: 2,
    visits: 12,
    unique_users: 12,
    new_users: 3,
    income: 1.5,
  });
  assert.equal(dailyBooks.countBooks(links), 2);
});

test('uses normalized titles only when a stable book id is unavailable', () => {
  const rows = dailyBooks.aggregateForDate([
    { bookName: '  Same   Title ', daily: { '2026-07-16': { visits: 2 } } },
    { bookName: 'same title', daily: { '2026-07-16': { visits: 3 } } },
    { bookId: 'different-id', bookName: 'Different Title', daily: { '2026-07-16': { visits: 4 } } },
  ], '2026-07-16');

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.visits).sort((a, b) => a - b), [4, 5]);
});

test('merges a legacy title-only row when the title has one stable book id', () => {
  const rows = dailyBooks.aggregateForDate([
    { bookId: 'book-1', bookName: 'First Book', daily: { '2026-07-16': { visits: 2 } } },
    { bookName: ' first  book ', daily: { '2026-07-16': { visits: 3 } } },
  ], '2026-07-16');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].bookId, 'book-1');
  assert.equal(rows[0].assets, 2);
  assert.equal(rows[0].visits, 5);
});

test('sorts rows by the selected metric and calculates daily totals', () => {
  const rows = dailyBooks.aggregateForDate(links, '2026-07-16');
  assert.equal(dailyBooks.sortRows(rows, 'income')[0].bookId, 'book-2');
  assert.deepEqual(dailyBooks.totals(rows), {
    visits: 19,
    unique_users: 19,
    new_users: 7,
    income: 3.6,
  });
});

test('uses the API asset count for a combined code and link row', () => {
  const rows = dailyBooks.aggregateForDate([
    {
      bookId: 'book-1',
      bookName: 'First Book',
      assetCount: 2,
      daily: { '2026-07-16': { visits: 5 } },
    },
  ], '2026-07-16');

  assert.equal(rows[0].assets, 2);
  assert.equal(dailyBooks.countAssets([{ assetCount: 2 }, {}]), 3);
});
