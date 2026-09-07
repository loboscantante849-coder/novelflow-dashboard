const { getRedis } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');
const { normalizeDelivery } = require('./_lib/distribution');
const { consumeRateLimit, requestIdentity } = require('./_lib/rate-limit');

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

function thumbnail(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'oss.novelago.app' && !parsed.searchParams.has('x-oss-process')) {
      return `${url}${parsed.search ? '&' : '?'}x-oss-process=image/resize,w_320/quality,q_78/format,webp`;
    }
  } catch {}
  return url;
}

function coverErrorKind(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || '').toLowerCase();
  if ([401, 403].includes(status) || /invalid_grant|unauthori[sz]ed|token.*expired|authentication/.test(message)) return 'auth';
  if (/timed out|timeout/.test(message)) return 'timeout';
  if (status >= 500 || /gateway|upstream|http 5\d\d/.test(message)) return 'upstream_5xx';
  return 'unknown';
}

async function resolveCoverBooks(normalized, redis, findExactBook = providers.findExactBook, route = {}) {
  const appKey = String(route.appKey || 'novelflow').trim().toLowerCase().replace(/[^a-z0-9]/g, '') || 'novelflow';
  return parallel(normalized, 8, async (book) => {
    const key = `nf_social:book_cover:${appKey}:${book.sku}`;
    const cached = redis ? await redis.get(key) : null;
    if (cached) return { sku: book.sku, cover: thumbnail(typeof cached === 'string' ? cached : String(cached)), state: 'ready' };
    try {
      const exact = await findExactBook(book.title, book.sku, route.applicationId ? { applicationId: route.applicationId } : {});
      const cover = thumbnail(exact.cover);
      if (cover && redis) await redis.set(key, cover, { ex: 30 * 24 * 60 * 60 });
      return { sku: book.sku, cover, state: cover ? 'ready' : 'missing' };
    } catch (error) {
      return { sku: book.sku, cover: '', state: 'failed', kind: coverErrorKind(error) };
    }
  });
}

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const delivery = normalizeDelivery({ accountId: Number(req.body?.accountId || 0) });
  if (!delivery) return res.status(400).json({ error: 'A verified target account is required for cover lookup' });
  const books = Array.isArray(req.body?.books) ? req.body.books.slice(0, 50) : [];
  const normalized = books.map((book) => ({ sku: String(book?.sku || '').trim(), title: String(book?.title || '').trim() })).filter((book) => book.sku && book.title);
  if (!normalized.length) return res.status(400).json({ error: 'Provide up to 50 book SKU and title pairs' });
  const redis = getRedis();
  const rate = await consumeRateLimit(redis, 'book_covers', requestIdentity(req), 30, 60);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return res.status(429).json({ error: 'Cover lookup rate limit reached. Try again later.' });
  }
  try {
    const resolved = await resolveCoverBooks(normalized, redis, providers.findExactBook, delivery);
    return res.status(200).json({
      covers: Object.fromEntries(resolved.filter((item) => item.cover).map((item) => [item.sku, item.cover])),
      missing: resolved.filter((item) => item.state === 'missing').map((item) => item.sku),
      failed: resolved.filter((item) => item.state === 'failed').map((item) => ({ sku: item.sku, kind: item.kind }))
    });
  } catch (error) {
    console.error('[social/book-covers]', error);
    return res.status(502).json({ error: 'Unable to resolve book covers' });
  }
};

module.exports.coverErrorKind = coverErrorKind;
module.exports.resolveCoverBooks = resolveCoverBooks;
