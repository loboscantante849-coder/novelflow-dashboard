const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_BOOKS = 500;
const MAX_TOMBSTONES = 1000;

function bookSyncKey(book) {
  if (!book || typeof book !== 'object') return null;
  if (book.code !== undefined && book.code !== null && String(book.code).trim()) {
    return `code:${String(book.code).trim()}`;
  }
  if (book.bookId !== undefined && book.bookId !== null && String(book.bookId).trim()) {
    return `book:${String(book.bookId).trim()}`;
  }
  if (book.id !== undefined && book.id !== null && String(book.id).trim()) {
    return `id:${String(book.id).trim()}`;
  }
  if (typeof book.title === 'string' && book.title.trim()) {
    return `title:${book.title.trim().toLowerCase()}`;
  }
  return null;
}

function normalizeDeletedBooks(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  const entries = Object.entries(value).slice(0, MAX_TOMBSTONES);
  for (const [key, rawTimestamp] of entries) {
    const timestamp = Number(rawTimestamp);
    if (!key || key.length > 256 || !Number.isFinite(timestamp) || timestamp <= 0) continue;
    if (timestamp <= now + 5 * 60 * 1000 && now - timestamp <= TOMBSTONE_TTL_MS) {
      result[key] = timestamp;
    }
  }
  return result;
}

function mergeDeletedBooks(existing, incoming, restoreBookKeys = [], now = Date.now()) {
  const merged = {
    ...normalizeDeletedBooks(existing, now),
  };
  for (const [key, timestamp] of Object.entries(normalizeDeletedBooks(incoming, now))) {
    merged[key] = Math.max(merged[key] || 0, timestamp);
  }
  if (Array.isArray(restoreBookKeys)) {
    for (const key of restoreBookKeys.slice(0, MAX_TOMBSTONES)) {
      if (typeof key === 'string' && key.length <= 256) delete merged[key];
    }
  }
  return merged;
}

function mergeBooks(existingBooks, incomingBooks, deletedBooks) {
  const books = new Map();
  for (const source of [existingBooks, incomingBooks]) {
    if (!Array.isArray(source)) continue;
    for (const book of source.slice(0, MAX_BOOKS)) {
      const key = bookSyncKey(book);
      if (!key || deletedBooks[key]) continue;
      books.set(key, books.has(key) ? { ...books.get(key), ...book } : book);
    }
  }
  return Array.from(books.values()).slice(0, MAX_BOOKS);
}

function mergeBookState(existing, incoming, now = Date.now()) {
  const deletedBooks = mergeDeletedBooks(
    existing && existing.deletedBooks,
    incoming && incoming.deletedBooks,
    incoming && incoming.restoreBookKeys,
    now,
  );
  return {
    deletedBooks,
    myBooks: mergeBooks(
      existing && existing.myBooks,
      incoming && incoming.myBooks,
      deletedBooks,
    ),
  };
}

module.exports = {
  bookSyncKey,
  mergeBookState,
  mergeBooks,
  mergeDeletedBooks,
  normalizeDeletedBooks,
};
