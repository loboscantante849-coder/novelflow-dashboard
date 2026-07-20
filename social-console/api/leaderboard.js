const { getRedis } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');

function shanghaiDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function enrichBooks(books) {
  const enriched = [];
  for (let index = 0; index < books.length; index += 4) {
    const group = books.slice(index, index + 4);
    const results = await Promise.all(group.map(async (book) => {
      try {
        const exact = await providers.findExactBook(book.title, book.bookSkuId);
        return { ...book, title: exact.title, bookSkuId: exact.bookSkuId, cover: exact.cover, category: exact.category || book.category, automationReady: true };
      } catch {
        // Historical data may include retired books; retain its performance but
        // do not pretend it can be launched as a current automation task.
        return { ...book, automationReady: false };
      }
    }));
    enriched.push(...results);
  }
  return enriched;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (!isCron && !requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const days = [3, 7, 30].includes(Number(req.query?.days)) ? Number(req.query.days) : 7;
  const day = shanghaiDay();
  const key = `nf_social:leaderboard:performance:v2:${day}:${days}`;
  const refresh = isCron || req.query?.refresh === '1';
  try {
    if (!refresh) {
      const cached = await redis.get(key);
      if (cached) return res.status(200).json(typeof cached === 'string' ? JSON.parse(cached) : cached);
    }
    const result = await providers.performanceBooks(days);
    const books = await enrichBooks(result.books);
    if (!books.length) throw new providers.ProviderError('Top-book source returned no usable books');
    const payload = { books, generatedAt: new Date().toISOString(), day, source: 'unified_funnel_performance', window: result.window, metrics: result.metrics };
    await redis.set(key, JSON.stringify(payload), { ex: 36 * 60 * 60 });
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[social/leaderboard]', error);
    return res.status(502).json({ error: 'Unable to load today\'s Top 50' });
  }
};
