const { bookstoreFetch } = require('./bookstore-fetch');

const BOOK_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage/book';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
const COVER_HASH_KEY = 'nf_book_covers';
const MISS_KEY_PREFIX = 'nf_book_cover_miss:';
const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_MAX_LOOKUPS = 12;
const DEFAULT_CONCURRENCY = 3;
const MISSING_COVER_TTL_SECONDS = 6 * 60 * 60;
const FAILED_LOOKUP_TTL_SECONDS = 10 * 60;

function normalizeHttpsCoverUrl(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const raw = String(value).trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return '';
    return url.href;
  } catch (_error) {
    return '';
  }
}

function extractRows(payload) {
  const candidates = [
    payload && payload.data && payload.data.data,
    payload && payload.data && payload.data.records,
    payload && payload.data && payload.data.list,
    payload && payload.data,
    payload && payload.records,
    payload && payload.list,
    payload && payload.items,
    payload,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function extractBookCover(payload, bookId) {
  const exactBook = extractRows(payload).find(book => (
    String(book && (book.bookId || book.id || book.skuId) || '') === String(bookId)
  ));
  if (!exactBook) return '';
  return normalizeHttpsCoverUrl(
    exactBook.cover ||
    exactBook.coverImage ||
    exactBook.coverImageUrl ||
    exactBook.coverUrl ||
    exactBook.bookCover ||
    exactBook.picUrl ||
    exactBook.imgUrl ||
    exactBook.pic ||
    '',
  );
}

async function fetchTrustedBookCover(bookId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalizedBookId = String(bookId || '').trim();
  if (!normalizedBookId) return '';
  const query = new URLSearchParams({
    current: '1',
    pageIndex: '1',
    pageSize: '5',
    applicationId: BOOKSTORE_APP_ID,
    bookStatus: '1',
    bookIds: normalizedBookId,
  });
  const { response } = await bookstoreFetch(`${BOOK_API_BASE}/booklist?${query}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }, { timeoutMs });
  if (!response || !response.ok) return '';
  return extractBookCover(await response.json(), normalizedBookId);
}

async function cacheBookCover(redis, bookId, cover) {
  const normalizedBookId = String(bookId || '').trim();
  const normalizedCover = normalizeHttpsCoverUrl(cover);
  if (!redis || !normalizedBookId || !normalizedCover) return false;
  await redis.hset(COVER_HASH_KEY, { [normalizedBookId]: normalizedCover });
  return true;
}

function coverMissKey(bookId) {
  return `${MISS_KEY_PREFIX}${encodeURIComponent(String(bookId))}`;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, run));
  return results;
}

async function batchKeyGet(redis, keys) {
  if (!keys.length) return [];
  if (typeof redis.mget === 'function') return redis.mget(...keys);
  if (typeof redis.pipeline === 'function') {
    const pipeline = redis.pipeline();
    keys.forEach(key => pipeline.get(key));
    return pipeline.exec();
  }
  return Promise.all(keys.map(key => redis.get(key)));
}

async function backfillBookCovers(redis, bookIds, debugLog, options = {}) {
  const maxLookups = Math.max(0, Number(options.maxLookups) || DEFAULT_MAX_LOOKUPS);
  const concurrency = Math.max(1, Number(options.concurrency) || DEFAULT_CONCURRENCY);
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const fetchCover = options.fetchCover || fetchTrustedBookCover;
  const unique = [...new Set((bookIds || []).map(value => String(value || '').trim()).filter(Boolean))];
  if (!redis || !unique.length || maxLookups === 0) return {};

  let candidates = unique.slice(0, maxLookups);
  try {
    const missValues = await batchKeyGet(redis, unique.map(coverMissKey));
    candidates = unique.filter((_bookId, index) => !missValues[index]).slice(0, maxLookups);
  } catch (error) {
    debugLog?.push(`cover miss cache unavailable; continuing with bounded lookups: ${error.message}`);
  }

  const resolved = {};
  await mapWithConcurrency(candidates, concurrency, async bookId => {
    try {
      const cover = normalizeHttpsCoverUrl(await fetchCover(bookId, { timeoutMs }));
      if (cover) {
        resolved[bookId] = cover;
        return;
      }
      await redis.set(coverMissKey(bookId), 'not-found', { ex: MISSING_COVER_TTL_SECONDS });
    } catch (error) {
      debugLog?.push(`cover lookup failed for ${bookId}: ${error.message}`);
      try {
        await redis.set(coverMissKey(bookId), 'failed', { ex: FAILED_LOOKUP_TTL_SECONDS });
      } catch (_cacheError) {}
    }
  });

  if (Object.keys(resolved).length) {
    try {
      await redis.hset(COVER_HASH_KEY, resolved);
    } catch (error) {
      debugLog?.push(`cover cache write failed; continuing with fetched covers: ${error.message}`);
    }
  }
  if (unique.length > candidates.length) {
    debugLog?.push(`cover backfill limited to ${candidates.length}/${unique.length} missing books`);
  }
  debugLog?.push(`cover backfill: ${Object.keys(resolved).length}/${candidates.length} resolved`);
  return resolved;
}

module.exports = {
  COVER_HASH_KEY,
  normalizeHttpsCoverUrl,
  extractBookCover,
  fetchTrustedBookCover,
  cacheBookCover,
  backfillBookCovers,
};
