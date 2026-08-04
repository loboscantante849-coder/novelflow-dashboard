const { getRedis } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');

const CATALOG_CACHE_VERSION = 'v14';
const VERIFIED_CATALOG_SOURCE = 'content_dashboard_performance';
const CATALOG_METRIC_KEYS = ['baseReadUnt', 'firstReadUntRate', 'read10wRate', 'read20wRate', 'ttProfit'];

function shanghaiDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function parseCachedPayload(value) {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function hasVerifiedCatalogMetrics(payload) {
  if (!payload || payload.source !== VERIFIED_CATALOG_SOURCE || payload.selectionMode !== 'catalog') return false;
  if (!Array.isArray(payload.books) || !payload.books.length) return false;
  if (payload.metrics?.fallback === true) return false;
  return payload.books.every((book) => String(book?.source || '') === 'content_dashboard'
    && CATALOG_METRIC_KEYS.some((key) => Object.prototype.hasOwnProperty.call(book, key)
      && book[key] !== null && book[key] !== '' && Number.isFinite(Number(book[key]))));
}

async function discardCache(redis, key) {
  try { await redis.del(key); } catch {}
}

function catalogFailure(error) {
  const message = String(error?.message || '').toLowerCase();
  const status = Number(error?.status || 0);
  if (/invalid_grant|oidc authentication|authentication failed|unauthori[sz]ed|token.*expired/.test(message)) {
    return {
      httpStatus: 503,
      reason: 'authentication_required',
      errorKind: /invalid_grant/.test(message) ? 'invalid_grant' : 'auth',
      credentialStatus: 'expired_or_invalid',
      warning: 'The content-dashboard session needs renewal before a fresh ranking can be loaded.'
    };
  }
  if (/timed out|timeout/.test(message)) {
    return {
      httpStatus: 504,
      reason: 'upstream_timeout',
      errorKind: 'timeout',
      credentialStatus: 'not_checked',
      warning: 'The content-dashboard request timed out; the console will retry after a short cooldown.'
    };
  }
  if (/invalid response shape/.test(message)) {
    return {
      httpStatus: 502,
      reason: 'invalid_response',
      errorKind: 'invalid_shape',
      credentialStatus: 'not_checked',
      warning: 'The content-dashboard returned an unexpected response and no unverified books were accepted.'
    };
  }
  if (status >= 500 || /gateway|upstream|http 5\d\d/.test(message)) {
    return {
      httpStatus: 502,
      reason: 'upstream_unavailable',
      errorKind: 'upstream_5xx',
      credentialStatus: 'not_checked',
      warning: 'The content-dashboard service is temporarily unavailable; no unverified ranking is shown.'
    };
  }
  return {
    httpStatus: 502,
    reason: 'source_unavailable',
    errorKind: 'unknown',
    credentialStatus: 'not_checked',
    warning: 'The verified content-dashboard ranking is temporarily unavailable.'
  };
}

function catalogPayload(payload, options = {}) {
  const stale = Boolean(options.stale);
  const status = stale ? 'stale' : options.cached ? 'cached' : 'healthy';
  const credentialStatus = options.credentialStatus || (options.cached ? 'not_checked' : 'verified');
  const response = {
    ...payload,
    source: VERIFIED_CATALOG_SOURCE,
    selectionMode: 'catalog',
    dataQuality: stale ? 'stale_verified_metrics' : 'verified_metrics',
    credentialStatus,
    sourceHealth: { status, source: 'content_dashboard', credentialStatus, ...(options.errorKind ? { errorKind: options.errorKind } : {}) }
  };
  if (stale) {
    response.stale = true;
    response.refreshWarning = options.warning || 'Fresh ranking data was unavailable; the last verified ranking is still shown.';
  } else {
    delete response.stale;
    delete response.refreshWarning;
  }
  return response;
}

function unavailableCatalogPayload(failure) {
  return {
    error: 'Verified catalog ranking is unavailable',
    dataQuality: 'unavailable',
    credentialStatus: failure.credentialStatus,
    sourceHealth: {
      status: 'unavailable',
      source: 'content_dashboard',
      reason: failure.reason,
      errorKind: failure.errorKind,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      credentialStatus: failure.credentialStatus
    },
    refreshWarning: failure.warning
  };
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

function previousDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function legacyCatalogCache(redis, days, sortField = 'baseReadUnt', filters = { productLine: ['novelflow'], language: 'EN', completeSts: '已完结', status: '上架' }) {
  if (!redis) return null;
  const filterKey = `${filters.productLine[0]}:${filters.language}:${filters.completeSts}:${filters.status}:${String(filters.isShort)}`;
  const today = shanghaiDay();
  const dates = [today, previousDay(today), previousDay(previousDay(today))];
  // Keep the requested window, sort, and filters intact. A real seven-day
  // cache is still misleading when the user asked for a 30-day ranking.
  for (const version of [CATALOG_CACHE_VERSION, 'v11', 'v10', 'v9', 'v8', 'v7']) {
    for (const day of dates) {
      const key = `nf_social:leaderboard:catalog:${version}:${day}:${days}:${sortField}:${filterKey}`;
      try {
        const payload = parseCachedPayload(await redis.get(key));
        if (hasVerifiedCatalogMetrics(payload)) return payload;
        if (payload) await discardCache(redis, key);
      } catch {}
    }
  }
  return null;
}

async function mergeHistoryMetrics(books, days, redis) {
  try {
    // History must stay available when the live content-dashboard credential
    // is down. Only merge a verified catalog snapshot already in Redis; never
    // turn a history page load into a fresh multi-page catalog request.
    const catalog = await legacyCatalogCache(redis, days);
    if (!catalog?.books?.length) return books;
    const bySku = new Map(catalog.books.map((book) => [String(book.bookSkuId), book]));
    const byTitle = new Map(catalog.books.map((book) => [providers.titleKey(book.title), book]));
    return books.map((book) => {
      const match = bySku.get(String(book.bookSkuId)) || byTitle.get(providers.titleKey(book.title));
      if (!match) return book;
      return {
        ...book,
        baseReadUnt: Number(match.baseReadUnt || book.baseReadUnt || book.pullUv || 0),
        firstReadUntRate: Number(match.firstReadUntRate ?? book.firstReadRate ?? 0),
        read10wRate: Number(match.read10wRate ?? 0),
        read20wRate: Number(match.read20wRate ?? 0),
        retentionRate: Number(match.read20wRate ?? match.read10wRate ?? book.retentionRate ?? 0),
        retentionWindow: Number(match.read20wRate) > 0 ? '20w' : Number(match.read10wRate) > 0 ? '10w' : ''
      };
    });
  } catch (error) {
    console.error('[social/leaderboard] history metric merge failed', error);
    return books;
  }
}

function rangeForDays(days, lagDays = 1) {
  // The content dashboard only publishes complete natural days. Querying the
  // still-open Shanghai day returns an upstream 500 and produces no ranking.
  const end = new Date(`${shanghaiDay()}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - lagDays);
  const endDate = end.toISOString().slice(0, 10);
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

async function catalogBooks(days, sortField, filters, options = {}) {
  const startedAt = Date.now();
  const deadlineMs = Math.max(4000, Number(options.deadlineMs || 14000));
  // One visible rule across every time range: books below 100 reads are too
  // small to treat as promotion candidates, but the threshold stays practical.
  const promotionMinUv = 100;
  const load = async (lagDays) => {
    const remainingMs = Math.max(1200, deadlineMs - (Date.now() - startedAt));
    const window = rangeForDays(days, lagDays);
    const result = await providers.contentDashboardBooks({
      ...window,
      sortField,
      minReadUnt: promotionMinUv,
      filters,
      maxPages: 10,
      deadlineMs: remainingMs
    });
    return { ...result, promotionMinUv, window: { days, dataLagDays: lagDays, throughDate: window.endDate, startDate: window.startDate, endDate: window.endDate } };
  };
  try {
    return await load(1);
  } catch (error) {
    // Shortly after midnight, the just-finished Shanghai day may not be
    // published yet. One read-only retry against the previous complete day
    // prevents a normal reporting lag from looking like a broken ranking.
    if (Number(error?.status || 0) < 500 || deadlineMs - (Date.now() - startedAt) < 1500) throw error;
    return load(2);
  }
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
  // v12 starts a clean catalog cache namespace. Earlier versions are read
  // only through legacyCatalogCache after their source provenance is checked.
  const key = `nf_social:leaderboard:${source}:${source === 'catalog' ? CATALOG_CACHE_VERSION : 'v11'}:${day}:${days}:${source === 'catalog' ? sortField : 'performance'}:${filterKey}`;
  const failureKey = `${key}:failure`;
  const refresh = isCron || req.query?.refresh === '1';
  let cachedPayload = null;
  try {
    const cached = parseCachedPayload(await redis.get(key));
    if (source === 'catalog') {
      if (hasVerifiedCatalogMetrics(cached)) cachedPayload = cached;
      else if (cached) await discardCache(redis, key);
    } else {
      cachedPayload = cached;
    }
    if (!refresh && cachedPayload) {
      return res.status(200).json(source === 'catalog' ? catalogPayload(cachedPayload, { cached: true }) : cachedPayload);
    }
    if (source === 'catalog' && !refresh) {
      const cachedFailure = parseCachedPayload(await redis.get(failureKey));
      if (cachedFailure && Date.parse(cachedFailure.retryAfter || '') > Date.now()) {
        const legacy = await legacyCatalogCache(redis, days, sortField, filters);
        if (legacy) return res.status(200).json(catalogPayload(legacy, { stale: true, credentialStatus: cachedFailure.credentialStatus, warning: cachedFailure.warning, errorKind: cachedFailure.errorKind }));
        return res.status(cachedFailure.httpStatus || 502).json(unavailableCatalogPayload(cachedFailure));
      }
    }
    const result = source === 'history'
      ? await providers.performanceBooks(days)
      : await catalogBooks(days, sortField, filters, { deadlineMs: isCron ? 105000 : refresh ? 65000 : 14000 });
    let books = await enrichBooks(result.books, source === 'catalog');
    if (source === 'history') books = await mergeHistoryMetrics(books, days, redis);
    if (!books.length) throw new providers.ProviderError('Top-book source returned no usable books');
    let payload = {
      books,
      generatedAt: new Date().toISOString(),
      day,
      source: source === 'history' ? 'unified_funnel_performance' : 'content_dashboard_performance',
      selectionMode: source,
      window: result.window,
      metrics: result.metrics || { sortField, candidateTotal: Number(result.candidateTotal || result.total || result.fetched || books.length), qualifiedTotal: Number(result.qualifiedTotal || books.length), observedTopUv: Number(result.observedTopUv || 0), promotionMinUv: Number(result.promotionMinUv || result.minReadUnt || 0), minReadUnt: Number(result.promotionMinUv || result.minReadUnt || 0), filters, partial: Boolean(result.partial), fetched: Number(result.fetched || books.length) }
    };
    if (source === 'catalog') {
      if (!hasVerifiedCatalogMetrics(payload)) throw new providers.ProviderError('Content dashboard ranking did not include verified metric provenance');
      payload = catalogPayload(payload);
    }
    await redis.set(key, JSON.stringify(payload), { ex: 36 * 60 * 60 });
    if (source === 'catalog') await discardCache(redis, failureKey);
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[social/leaderboard]', error);
    if (cachedPayload) {
      if (source === 'catalog') {
        const failure = catalogFailure(error);
        return res.status(200).json(catalogPayload(cachedPayload, { stale: true, credentialStatus: failure.credentialStatus, warning: failure.warning, errorKind: failure.errorKind }));
      }
      return res.status(200).json({ ...cachedPayload, stale: true, refreshWarning: 'Fresh ranking data was unavailable; the last verified ranking is still shown.' });
    }
    if (source === 'catalog') {
      const legacy = await legacyCatalogCache(redis, days, sortField, filters);
      const failure = catalogFailure(error);
      if (legacy) return res.status(200).json(catalogPayload(legacy, { stale: true, credentialStatus: failure.credentialStatus, warning: failure.warning, errorKind: failure.errorKind }));
      const cooldownSeconds = failure.errorKind === 'invalid_grant' || failure.errorKind === 'auth' ? 300 : failure.errorKind === 'timeout' ? 60 : 120;
      failure.retryAfter = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
      try { await redis.set(failureKey, JSON.stringify(failure), { ex: cooldownSeconds }); } catch {}
      return res.status(failure.httpStatus).json(unavailableCatalogPayload(failure));
    }
    return res.status(502).json({ error: 'Unable to load today\'s Top 200' });
  }
};
