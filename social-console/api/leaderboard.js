const { getRedis } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');

function shanghaiDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function enrichBooks(books, catalogSource = false) {
  if (catalogSource) {
    try {
      const catalog = await providers.topBooks(200);
      const bySku = new Map(catalog.map((book) => [String(book.bookSkuId), book]));
      const byTitle = new Map(catalog.map((book) => [providers.titleKey(book.title), book]));
      return books.map((book) => {
        const exact = bySku.get(String(book.bookSkuId)) || byTitle.get(providers.titleKey(book.title));
        return exact
          ? { ...book, title: exact.title, bookSkuId: exact.bookSkuId, cover: exact.cover || book.cover || '', category: exact.category || book.category, tags: exact.tags || [], words: Number(exact.words || book.words || 0), chapterCount: Number(exact.chapterCount || book.chapterCount || 0), automationReady: true }
          : { ...book, automationReady: true };
      });
    } catch {
      // The performance list is already filtered to active NovelFlow books.
      // Missing cover enrichment must not collapse a valid Top 200 to Top 50.
      return books.map((book) => ({ ...book, automationReady: true }));
    }
  }
  const enriched = [];
  for (let index = 0; index < books.length; index += 8) {
    const group = books.slice(index, index + 8);
    const results = await Promise.all(group.map(async (book) => {
      try {
        const exact = await providers.findExactBook(book.title, book.bookSkuId);
        return { ...book, title: exact.title, bookSkuId: exact.bookSkuId, cover: exact.cover, category: exact.category || book.category, tags: exact.tags || [], description: exact.description || '', words: Number(exact.words || book.words || 0), chapterCount: Number(exact.chapterCount || book.chapterCount || 0), automationReady: true };
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

function rangeForDays(days) {
  const endDate = shanghaiDay();
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

function catalogFilters(query) {
  const productLine = 'novelflow';
  const language = ['EN', 'ES'].includes(String(query?.language)) ? String(query.language) : 'EN';
  const completeSts = ['已完结', '连载中'].includes(String(query?.complete)) ? String(query.complete) : '已完结';
  const status = ['上架', '下架'].includes(String(query?.status)) ? String(query.status) : '上架';
  // The Writer Admin UI renders this as 是/否, while its API stores it as
  // numeric 1/0 rather than a JSON boolean.
  const isShort = query?.isShort === 'yes' ? 1 : query?.isShort === 'no' ? 0 : undefined;
  return { productLine: [productLine], language, completeSts, status, isShort };
}

async function catalogBooks(days, sortField, filters) {
  const window = rangeForDays(days);
  const minReadUnt = sortField === 'baseReadUnt' ? 0 : (days === 7 ? 50 : days === 30 ? 150 : 300);
  const result = await providers.contentDashboardBooks({
    ...window,
    sortField,
    minReadUnt,
    filters
  });
  return { ...result, window: { days, throughDate: window.endDate, startDate: window.startDate, endDate: window.endDate } };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (!isCron && !requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const source = req.query?.source === 'history' ? 'history' : 'catalog';
  const days = source === 'history'
    ? ([3, 7, 30].includes(Number(req.query?.days)) ? Number(req.query.days) : 7)
    : ([7, 30, 90].includes(Number(req.query?.days)) ? Number(req.query.days) : 30);
  const allowedSorts = new Set(['baseReadUnt', 'firstReadUntRate', 'read10wRate', 'read20wRate', 'ttProfit']);
  const sortField = allowedSorts.has(String(req.query?.sort)) ? String(req.query.sort) : 'baseReadUnt';
  const filters = source === 'catalog' ? catalogFilters(req.query) : null;
  const day = shanghaiDay();
  const filterKey = source === 'catalog' ? `${filters.productLine[0]}:${filters.language}:${filters.completeSts}:${filters.status}:${String(filters.isShort)}` : 'performance';
  // v9 invalidates the temporary coverless Top 200 cache.
  const key = `nf_social:leaderboard:${source}:v9:${day}:${days}:${source === 'catalog' ? sortField : 'performance'}:${filterKey}`;
  const refresh = isCron || req.query?.refresh === '1';
  try {
    if (!refresh) {
      const cached = await redis.get(key);
      if (cached) return res.status(200).json(typeof cached === 'string' ? JSON.parse(cached) : cached);
    }
    const result = source === 'history' ? await providers.performanceBooks(days) : await catalogBooks(days, sortField, filters);
    const books = await enrichBooks(result.books, source === 'catalog');
    if (!books.length) throw new providers.ProviderError('Top-book source returned no usable books');
    const payload = {
      books,
      generatedAt: new Date().toISOString(),
      day,
      source: source === 'history' ? 'unified_funnel_performance' : 'content_dashboard_performance',
      selectionMode: source,
      window: result.window,
      metrics: result.metrics || { sortField, candidateTotal: result.total, minReadUnt: result.minReadUnt || 0, filters }
    };
    await redis.set(key, JSON.stringify(payload), { ex: 36 * 60 * 60 });
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[social/leaderboard]', error);
    return res.status(502).json({ error: 'Unable to load today\'s Top 200' });
  }
};
