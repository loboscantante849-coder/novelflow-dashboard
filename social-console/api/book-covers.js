const { getRedis } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');

async function parallel(items, limit, work) {
  const result = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      result.push(await work(item));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const books = Array.isArray(req.body?.books) ? req.body.books.slice(0, 50) : [];
  const normalized = books.map((book) => ({ sku: String(book?.sku || '').trim(), title: String(book?.title || '').trim() })).filter((book) => book.sku && book.title);
  if (!normalized.length) return res.status(400).json({ error: 'Provide up to 50 book SKU and title pairs' });
  const redis = getRedis();
  try {
    const resolved = await parallel(normalized, 8, async (book) => {
      const key = `nf_social:book_cover:${book.sku}`;
      const cached = redis ? await redis.get(key) : null;
      if (cached) return { sku: book.sku, cover: typeof cached === 'string' ? cached : String(cached) };
      try {
        const exact = await providers.findExactBook(book.title, book.sku);
        const cover = String(exact.cover || '');
        if (cover && redis) await redis.set(key, cover, { ex: 30 * 24 * 60 * 60 });
        return { sku: book.sku, cover };
      } catch {
        return { sku: book.sku, cover: '' };
      }
    });
    return res.status(200).json({ covers: Object.fromEntries(resolved.filter((item) => item.cover).map((item) => [item.sku, item.cover])) });
  } catch (error) {
    console.error('[social/book-covers]', error);
    return res.status(502).json({ error: 'Unable to resolve book covers' });
  }
};
