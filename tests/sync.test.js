const assert = require('node:assert/strict');
const test = require('node:test');

const { bookSyncKey, mergeBookState } = require('../api/_lib/sync');

test('uses stable keys for promotion links', () => {
  assert.equal(bookSyncKey({ code: 1234, bookId: 'book-1' }), 'code:1234');
  assert.equal(bookSyncKey({ bookId: 'book-1' }), 'book:book-1');
});

test('a deletion tombstone removes stale books from both devices', () => {
  const now = Date.now();
  const state = mergeBookState(
    { myBooks: [{ code: '1001', title: 'Old' }, { code: '1002', title: 'Keep' }] },
    { myBooks: [{ code: '1001', title: 'Stale copy' }], deletedBooks: { 'code:1001': now } },
    now,
  );
  assert.deepEqual(state.myBooks, [{ code: '1002', title: 'Keep' }]);
  assert.equal(state.deletedBooks['code:1001'], now);
});

test('an explicit restore clears the tombstone and permits re-adding', () => {
  const now = Date.now();
  const state = mergeBookState(
    { myBooks: [], deletedBooks: { 'code:1001': now - 1000 } },
    { myBooks: [{ code: '1001', title: 'Restored' }], restoreBookKeys: ['code:1001'] },
    now,
  );
  assert.deepEqual(state.deletedBooks, {});
  assert.deepEqual(state.myBooks, [{ code: '1001', title: 'Restored' }]);
});
