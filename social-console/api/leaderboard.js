const { getRedis } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');
const { APPS, ACCOUNT_ROUTES, appByKey, appByProductLine, accountRoute, normalizeDelivery } = require('./_lib/distribution');
const { issueP0Receipt, RECEIPT_TTL_MS } = require('./_lib/p0-receipts');

const CATALOG_CACHE_VERSION = 'v21';
const VERIFIED_CATALOG_SOURCE = 'content_dashboard_performance';
const CATALOG_METRIC_KEYS = ['baseReadUnt', 'firstReadUntRate', 'read10wRate', 'read20wRate', 'ttProfit'];
const CANDIDATE_AXES = Object.freeze(['baseReadUnt', 'firstReadUntRate', 'read20wRate']);
const P0_SNAPSHOT_VERSION = 'p0_multi_axis_v1';

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

function stripP0Receipts(value) {
  if (Array.isArray(value)) return value.map(stripP0Receipts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'p0Receipt')
    .map(([key, nested]) => [key, stripP0Receipts(nested)]));
}

function metricValue(book, primary, fallback = '') {
  const hasPrimary = Object.prototype.hasOwnProperty.call(book || {}, primary)
    && book[primary] !== null && book[primary] !== '' && book[primary] !== undefined;
  const value = hasPrimary ? book[primary] : fallback ? book?.[fallback] : 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function hasVerifiedCatalogMetrics(payload) {
  if (!payload || payload.source !== VERIFIED_CATALOG_SOURCE || payload.selectionMode !== 'catalog') return false;
  if (!Array.isArray(payload.books) || !payload.books.length) return false;
  if (payload.metrics?.fallback === true) return false;
  return payload.books.every((book) => book?.ownershipVerified === true && String(book?.source || '') === 'content_dashboard'
    && Number.isFinite(Number(book?.baseReadUnt)) && Number(book.baseReadUnt) > 0
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
  const sanitizedPayload = stripP0Receipts(payload || {});
  const stale = Boolean(options.stale);
  const status = stale ? 'stale' : options.cached ? 'cached' : 'healthy';
  const credentialStatus = options.credentialStatus || (options.cached ? 'not_checked' : 'verified');
  const target = options.target || sanitizedPayload?.target || null;
  const selectedBooks = target ? attachSelectionTarget(sanitizedPayload.books, target) : sanitizedPayload.books;
  // A receipt can be re-issued from the same short-lived verified snapshot to
  // another account in the same app. This keeps a single campaign consistent
  // across its Facebook/Instagram/TikTok routes without trusting the browser
  // or rereading an unstable upstream response for every account.
  const generatedAt = Date.parse(sanitizedPayload?.generatedAt || '');
  const freshVerifiedSnapshot = Number.isFinite(generatedAt)
    && generatedAt <= Date.now()
    && Date.now() - generatedAt <= RECEIPT_TTL_MS;
  const canIssueReceipt = Boolean(target)
    && !stale
    && freshVerifiedSnapshot
    && String(payload?.source || '') === VERIFIED_CATALOG_SOURCE
    && String(payload?.selectionMode || '') === 'catalog'
    && String(process.env.SOCIAL_CONSOLE_SESSION_SECRET || '').length >= 32;
  const books = canIssueReceipt
    ? selectedBooks.map((book) => (book?.ownershipVerified === true && book?.automationReady === true
      ? {
        ...book,
        p0Receipt: issueP0Receipt(book, {
          target,
          source: VERIFIED_CATALOG_SOURCE,
          dataQuality: 'verified_metrics',
          sourceHealth: 'healthy',
          stale: false,
          generatedAt: sanitizedPayload.generatedAt,
          snapshotVersion: sanitizedPayload.snapshotVersion,
          windowDays: Number(sanitizedPayload?.window?.days || 0),
          filters: sanitizedPayload?.metrics?.filters || {}
        })
      }
      : book))
    : selectedBooks;
  const response = {
    ...sanitizedPayload,
    source: VERIFIED_CATALOG_SOURCE,
    selectionMode: 'catalog',
    dataQuality: stale ? 'stale_verified_metrics' : 'verified_metrics',
    credentialStatus,
    sourceHealth: { status, source: 'content_dashboard', credentialStatus, ...(options.errorKind ? { errorKind: options.errorKind } : {}) },
    ...(target ? { target, targetOptions: targetOptions(), books } : {})
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

async function verifiedHistoryFallback(filters, target, failure) {
  const history = await providers.performanceBooks(7);
  const candidates = Array.isArray(history?.books) ? history.books : [];
  const enriched = await enrichBooks(candidates, false, filters);
  const generatedAt = new Date().toISOString();
  const books = enriched
    .filter((book) => book.automationReady === true && Number(book.pullUv || 0) > 0)
    .map((book, index) => {
      const normalized = {
        ...book,
        source: 'unified_funnel_performance',
        ownershipVerified: true,
        baseReadUnt: Number(book.pullUv || 0),
        firstReadUntRate: Number(book.firstReadRate || 0),
        read10wRate: 0,
        read20wRate: 0,
        ttProfit: Number(book.d14Income || 0),
        rank: index + 1,
        selectionTarget: target
      };
      return {
        ...normalized,
        p0Receipt: issueP0Receipt(normalized, {
          target,
          source: 'unified_funnel_performance',
          dataQuality: 'verified_metrics',
          sourceHealth: 'healthy',
          stale: false,
          generatedAt,
          windowDays: 7,
          filters: { language: 'EN', complete: '', length: 'all', genre: '' }
        })
      };
    });
  if (!books.length) throw failure;
  return {
    books,
    generatedAt,
    day: shanghaiDay(),
    source: 'unified_funnel_performance',
    selectionMode: 'catalog',
    dataQuality: 'verified_metrics',
    credentialStatus: failure.credentialStatus,
    sourceHealth: { status: 'history_fallback', source: 'unified_funnel_performance', errorKind: failure.errorKind, credentialStatus: failure.credentialStatus },
    refreshWarning: 'Live content-dashboard ranking is unavailable; showing only exact-app books with verified seven-day funnel performance.',
    window: { days: 7, source: 'unified_funnel_performance' },
    metrics: { sortField: 'baseReadUnt', candidateTotal: books.length, qualifiedTotal: books.length, observedTopUv: Math.max(...books.map((book) => Number(book.baseReadUnt || 0))), promotionMinUv: 0, filters },
    target,
    targetOptions: targetOptions()
  };
}

function parseMetricThreshold(value, allowed, fallback = 0) {
  const numeric = Number(value);
  return allowed.includes(numeric) ? numeric : fallback;
}

function rankingTarget(query = {}) {
  const requestedApp = String(query.app || query.line || 'novelflow').trim().toLowerCase();
  const app = appByKey(requestedApp) || appByProductLine(requestedApp);
  if (!app) throw new providers.ProviderError('Unsupported target application', { status: 400 });

  const requestedAccountId = Number(query.accountId || 0);
  const requestedPlatform = String(query.platform || '').trim().toLowerCase();
  if (requestedPlatform && !['facebook', 'instagram', 'tiktok'].includes(requestedPlatform)) {
    throw new providers.ProviderError('Unsupported target platform', { status: 400 });
  }
  let route = requestedAccountId ? accountRoute(requestedAccountId) : null;
  if (requestedAccountId && (!route || route.appKey !== app.key)) {
    throw new providers.ProviderError('Target account does not belong to the selected application', { status: 400 });
  }
  if (route && requestedPlatform && route.platform !== requestedPlatform) {
    throw new providers.ProviderError('Target account does not belong to the selected platform', { status: 400 });
  }
  if (!route) {
    route = ACCOUNT_ROUTES.find((candidate) => candidate.appKey === app.key && (!requestedPlatform || candidate.platform === requestedPlatform))
      || ACCOUNT_ROUTES.find((candidate) => candidate.appKey === app.key);
  }
  if (!route) throw new providers.ProviderError('No verified SocialEcho route exists for the selected application', { status: 409 });
  return normalizeDelivery({ accountId: route.accountId });
}

function targetOptions() {
  return ACCOUNT_ROUTES.map((route) => normalizeDelivery({ accountId: route.accountId })).filter(Boolean);
}

function rateValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(numeric > 1 ? numeric / 100 : numeric, 1);
}

function applyMetricFilters(books, filters) {
  return (books || []).filter((book) => Number.isFinite(Number(book.baseReadUnt)) && Number(book.baseReadUnt) > 0
    && Number(book.baseReadUnt) >= filters.readBaseMin
    && rateValue(book.firstReadUntRate) >= filters.firstReadMin
    && rateValue(metricValue(book, 'read20wRate', 'read10wRate')) >= filters.longReadMin);
}

function attachSelectionTarget(books, target) {
  const selectionTarget = {
    accountId: target.accountId,
    accountTitle: target.accountTitle,
    appKey: target.appKey,
    appName: target.appName,
    applicationId: target.applicationId,
    productLine: target.productLine,
    platform: target.platform,
    publishType: target.publishType,
    includeLink: target.includeLink
  };
  return (books || []).map((book) => ({ ...book, selectionTarget }));
}

async function enrichBooks(books, catalogSource = false, filters = null, verifiedCatalog = null) {
  const app = appByProductLine(filters?.productLine?.[0]) || appByProductLine('novelflow');
  if (catalogSource) {
    const verifyRelaxedCandidates = async (candidates, alreadyVerified = 0) => {
      const exact = new Map();
      const targetCount = 12;
      for (let index = 0; index < candidates.length && alreadyVerified + exact.size < targetCount; index += 10) {
        const group = candidates.slice(index, index + 10);
        const settled = await Promise.allSettled(group.map((book) => providers.findExactBookBySku(book.bookSkuId, { applicationId: app.applicationId })));
        settled.forEach((entry, offset) => { if (entry.status === 'fulfilled') exact.set(String(group[offset].bookSkuId), entry.value); });
      }
      return exact;
    };
    try {
      const catalog = Array.isArray(verifiedCatalog)
        ? verifiedCatalog
        : await providers.topBooks(200, { applicationId: app.applicationId, deadlineMs: 12000 });
      const bySku = new Map(catalog.map((book) => [String(book.bookSkuId), book]));
      let exactFallback = new Map();
      // Low-volume books can be absent from the target bookstore Top 200 even
      // though the real-time content dashboard returned them. On the relaxed
      // product-line path, verify a bounded set by exact SKU instead of
      // incorrectly turning the whole live ranking into an outage.
      if (filters?.requireProductLineEcho === true) {
        const alreadyVerified = books.filter((book) => bySku.has(String(book.bookSkuId)) || book.productLineVerified === true).length;
        const unresolved = books.filter((book) => !bySku.has(String(book.bookSkuId)) && book.productLineVerified !== true);
        exactFallback = await verifyRelaxedCandidates(unresolved, alreadyVerified);
      }
      return books.map((book) => {
        // A same-title record with another SKU is not ownership proof. Only
        // the target application's exact SKU may upgrade a provisional row.
        const exact = bySku.get(String(book.bookSkuId)) || exactFallback.get(String(book.bookSkuId));
        return exact
          ? { ...book, title: exact.title, bookSkuId: exact.bookSkuId, cover: exact.cover || book.cover || '', category: exact.category || book.category, tags: exact.tags || [], words: Number(exact.words || book.words || 0), chapterCount: Number(exact.chapterCount || book.chapterCount || 0), ownershipVerified: true, automationReady: true }
          : { ...book, ownershipVerified: book.productLineVerified === true, automationReady: book.productLineVerified === true };
      });
    } catch {
      let exactFallback = new Map();
      if (filters?.requireProductLineEcho === true) {
        const alreadyVerified = books.filter((book) => book.productLineVerified === true).length;
        const unresolved = books.filter((book) => book.productLineVerified !== true);
        exactFallback = await verifyRelaxedCandidates(unresolved, alreadyVerified);
      }
      // A product-line echo is acceptable proof. If the bulk bookstore query
      // failed, an exact target-app SKU lookup may still prove ownership.
      return books.map((book) => {
        const exact = exactFallback.get(String(book.bookSkuId));
        if (exact) return { ...book, title: exact.title, bookSkuId: exact.bookSkuId, cover: exact.cover || book.cover || '', category: exact.category || book.category, tags: exact.tags || [], words: Number(exact.words || book.words || 0), chapterCount: Number(exact.chapterCount || book.chapterCount || 0), ownershipVerified: true, automationReady: true };
        return { ...book, ownershipVerified: book.productLineVerified === true, automationReady: book.productLineVerified === true };
      });
    }
  }
  const enriched = [];
  for (let index = 0; index < books.length; index += 8) {
    const group = books.slice(index, index + 8);
    const results = await Promise.all(group.map(async (book) => {
      try {
        const exact = await providers.findExactBook(book.title, book.bookSkuId, { applicationId: app.applicationId });
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
  const legacyFilterKey = `${filters.productLine[0]}:${filters.language}:${filters.completeSts}:${filters.status}:${String(filters.isShort)}`;
  const currentFilterKey = `${filters.appKey || filters.productLine[0]}:${filters.language}:${filters.completeSts}:${filters.status}:${String(filters.isShort)}:${filters.readBaseMin}:${filters.firstReadMin}:${filters.longReadMin}`;
  const today = shanghaiDay();
  const dates = [today, previousDay(today), previousDay(previousDay(today))];
  // Keep the requested window, sort, and filters intact. A real seven-day
  // cache is still misleading when the user asked for a 30-day ranking.
  for (const version of [CATALOG_CACHE_VERSION, 'v11', 'v10', 'v9', 'v8', 'v7']) {
    const filterKey = version === CATALOG_CACHE_VERSION ? currentFilterKey : legacyFilterKey;
    for (const day of dates) {
      // v12 comparison requests append a cache variant. Older fallback code
      // looked only for the unsuffixed key, so one expired credential could
      // hide a perfectly valid ranking loaded a few hours earlier.
      const keys = [
        `nf_social:leaderboard:catalog:${version}:${day}:${days}:${sortField}:${filterKey}:compare`,
        `nf_social:leaderboard:catalog:${version}:${day}:${days}:${sortField}:${filterKey}:single`,
        `nf_social:leaderboard:catalog:${version}:${day}:${days}:${sortField}:${filterKey}`
      ];
      for (const key of keys) {
        try {
          const payload = parseCachedPayload(await redis.get(key));
          if (hasVerifiedCatalogMetrics(payload)) return payload;
          if (payload) await discardCache(redis, key);
        } catch {}
      }
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

function catalogFilters(query, target = rankingTarget(query)) {
  const app = appByKey(target.appKey) || appByProductLine(target.productLine) || APPS.novelflow;
  const productLine = app.productLine;
  const language = ['EN', 'PT', 'ES'].includes(String(query?.language)) ? String(query.language) : 'EN';
  const completeSts = ['已完结', '连载中'].includes(String(query?.complete)) ? String(query.complete) : '已完结';
  const status = ['上架', '下架'].includes(String(query?.status)) ? String(query.status) : '上架';
  // The Writer Admin UI renders this as 是/否, while its API stores it as
  // numeric 1/0 rather than a JSON boolean.
  const isShort = query?.isShort === 'yes' ? 1 : query?.isShort === 'no' ? 0 : undefined;
  const readBaseMin = parseMetricThreshold(query?.readBaseMin, [0, 100, 500, 1000, 5000, 10000, 50000]);
  const firstReadMin = parseMetricThreshold(query?.firstReadMin, [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  const longReadMin = parseMetricThreshold(query?.longReadMin, [0, 0.05, 0.1, 0.15, 0.2, 0.3]);
  return {
    productLine: [productLine], language, completeSts, status, isShort,
    readBaseMin, firstReadMin, longReadMin,
    appKey: app.key, applicationId: app.applicationId,
    accountId: target.accountId, platform: target.platform
  };
}

async function catalogBooks(days, sortField, filters, options = {}) {
  const startedAt = Date.now();
  const deadlineMs = Math.max(4000, Number(options.deadlineMs || 14000));
  // Show the whole verified source in the operator-facing book picker. The
  // operator can see the UV directly and remains free to choose a niche book.
  const promotionMinUv = Number(filters.readBaseMin || 0);
  const supportsRelaxedProductLine = ['maxnovel', 'storyca', 'novelvio'].includes(String(filters.productLine?.[0] || '').toLowerCase());
  const mergeAxisResults = (axisResults) => {
    const bySku = new Map();
    // The report endpoint often returns only the requested sort column and
    // serializes the other metric columns as numeric zero. A plain object
    // spread would therefore erase a real value observed on an earlier axis.
    // Keep the strongest observed numeric signal for the union while retaining
    // genuine zeros when no other axis supplied a value.
    const metricKeys = ['baseReadUnt', 'exposureUV', 'bookDetailUV', 'firstReadUntRate', 'gt2FirstReadUntRate', 'readEndRate', 'read10wRate', 'read20wRate', 'ttProfit', 'avgSpend'];
    axisResults.forEach(({ axis, result }) => {
      (result.books || []).forEach((book, index) => {
        const sku = String(book?.bookSkuId || '');
        if (!sku) return;
        const existing = bySku.get(sku) || {};
        const axisRanks = { ...(existing.axisRanks || {}), [axis]: Number(book.rank || index + 1) };
        const candidateAxes = [...new Set([...(existing.candidateAxes || []), axis])];
        const merged = { ...existing, ...book, axisRanks, candidateAxes };
        for (const key of metricKeys) {
          const prior = Number(existing[key]);
          const incoming = Number(book[key]);
          if (Number.isFinite(prior) && prior > 0 && (!Number.isFinite(incoming) || incoming <= 0)) merged[key] = prior;
          else if (Number.isFinite(prior) && prior > 0 && Number.isFinite(incoming) && incoming > 0) merged[key] = Math.max(prior, incoming);
        }
        bySku.set(sku, merged);
      });
    });
    const merged = [...bySku.values()];
    const maxReaders = Math.max(1, ...merged.map((book) => Math.max(0, metricValue(book, 'baseReadUnt'))));
    const maxProfit = Math.max(0, ...merged.map((book) => Math.max(0, metricValue(book, 'ttProfit'))));
    const scored = merged.map((book) => {
      const uvScore = Math.log1p(Math.max(0, metricValue(book, 'baseReadUnt'))) / Math.log1p(maxReaders);
      const firstReadScore = rateValue(metricValue(book, 'firstReadUntRate'));
      const longReadScore = rateValue(metricValue(book, 'read20wRate', 'read10wRate'));
      const profitScore = maxProfit > 0 ? Math.max(0, metricValue(book, 'ttProfit')) / maxProfit : 0;
      return { ...book, selectionScore: Number((100 * (uvScore * .45 + firstReadScore * .25 + longReadScore * .25 + profitScore * .05)).toFixed(2)) };
    });
    return scored
      .sort((left, right) => metricValue(right, sortField) - metricValue(left, sortField)
        || Number(right.selectionScore || 0) - Number(left.selectionScore || 0)
        || metricValue(right, 'baseReadUnt') - metricValue(left, 'baseReadUnt'))
      .map((book, index) => ({ ...book, rank: index + 1, selectionRank: index + 1, recommendationRank: index + 1 }));
  };
  const load = async (lagDays, retryMode = 'normal') => {
    const remainingMs = Math.max(1200, deadlineMs - (Date.now() - startedAt));
    const window = rangeForDays(days, lagDays);
    const skuScoped = Array.isArray(filters.skuIds) && filters.skuIds.length > 0;
    const requestFilters = skuScoped || retryMode === 'relaxed_product_line'
      ? { ...filters, omitServerProductLine: true, requireProductLineEcho: true, allowMissingProductLineEcho: true, allowUnmatchedProductLine: true, minimalContract: true }
      : filters;
    // One report ordering cannot recall both scale winners and lower-volume
    // conversion/retention winners. Pull the three live Top lists against the
    // exact same window and target-app filters, then rank their SKU union.
    const settled = await Promise.allSettled(CANDIDATE_AXES.map((axis) => providers.contentDashboardBooks({
      ...window,
      sortField: axis,
      minReadUnt: promotionMinUv,
      filters: requestFilters,
      maxPages: 10,
      deadlineMs: remainingMs
    })));
    const failedIndex = settled.findIndex((entry) => entry.status === 'rejected');
    if (failedIndex >= 0) throw settled[failedIndex].reason;
    const axisResults = settled.map((entry, index) => ({ axis: CANDIDATE_AXES[index], result: entry.value }));
    const union = mergeAxisResults(axisResults);
    const books = applyMetricFilters(union, filters);
    if (!books.length) {
      throw new providers.ProviderError('Content dashboard returned no verified rows for the target product line', { status: 502 });
    }
    const axisCandidateTotals = Object.fromEntries(axisResults.map(({ axis, result }) => [axis, Number(result.candidateTotal || result.total || result.books?.length || 0)]));
    const axisFetched = Object.fromEntries(axisResults.map(({ axis, result }) => [axis, Number(result.fetched || result.books?.length || 0)]));
    return {
      ...axisResults[0].result,
      books,
      total: Math.max(...axisResults.map(({ result }) => Number(result.total || 0)), books.length),
      candidateTotal: union.length,
      promotionMinUv,
      qualifiedTotal: books.length,
      observedTopUv: Math.max(0, ...union.map((book) => metricValue(book, 'baseReadUnt'))),
      candidateAxes: [...CANDIDATE_AXES],
      axisCandidateTotals,
      axisFetched,
      partial: axisResults.some(({ result }) => result.partial === true),
      sourceRetryMode: retryMode,
      window: { days, dataLagDays: lagDays, throughDate: window.endDate, startDate: window.startDate, endDate: window.endDate }
    };
  };
  let firstError;
  if (Array.isArray(filters.skuIds) && filters.skuIds.length) {
    try {
      return await load(1, 'target_application_skus');
    } catch (error) {
      firstError = error;
    }
    if (Number(firstError?.status || 0) < 500 || deadlineMs - (Date.now() - startedAt) < 1500) throw firstError;
    return load(2, 'target_application_skus');
  }
  // Novelvio is a storefront assembled from several upstream product lines
  // (for example novelago and anystories). Sending the storefront name as a
  // report productLine is both semantically wrong and consistently burns two
  // credential-refresh attempts on a generic 500. Start from the global live
  // report and prove storefront ownership by exact application SKU instead.
  if (String(filters.appKey || '').toLowerCase() === 'novelvio') {
    try {
      return await load(1, 'relaxed_product_line');
    } catch (error) {
      firstError = error;
    }
    if (Number(firstError?.status || 0) < 500 || deadlineMs - (Date.now() - startedAt) < 1500) throw firstError;
    return load(2, 'relaxed_product_line');
  }
  try {
    return await load(1);
  } catch (error) {
    firstError = error;
  }
  if (Number(firstError?.status || 0) < 500 || deadlineMs - (Date.now() - startedAt) < 1500) throw firstError;
  // MaxNovel, Storyca, and Novelvio have seen a backend-specific generic 500
  // when productLine is sent. Try the strict-echo recovery before spending
  // the remaining budget on a different reporting day.
  if (supportsRelaxedProductLine) {
    try {
      return await load(1, 'relaxed_product_line');
    } catch (error) {
      firstError = error;
    }
    if (Number(firstError?.status || 0) < 500 || deadlineMs - (Date.now() - startedAt) < 1500) throw firstError;
  }
  try {
    return await load(2);
  } catch (previousDayError) {
    if (!supportsRelaxedProductLine || Number(previousDayError?.status || 0) < 500 || deadlineMs - (Date.now() - startedAt) < 1500) throw previousDayError;
    try {
      return await load(2, 'relaxed_product_line');
    } catch {
      throw previousDayError;
    }
  }
}

function attachWindowComparison(books, windows) {
  const indexes = Object.fromEntries([7, 30, 90].map((days) => [days, new Map((windows[days]?.books || []).map((book) => [String(book.bookSkuId), book]))]));
  const metric = (book, days, key) => {
    const value = indexes[days].get(String(book.bookSkuId))?.[key];
    return value === null || value === '' || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  return books.map((book) => {
    const readerBase7d = metric(book, 7, 'baseReadUnt');
    const readerBase30d = metric(book, 30, 'baseReadUnt');
    const readerBase90d = metric(book, 90, 'baseReadUnt');
    const readerDaily7d = readerBase7d === null ? null : readerBase7d / 7;
    const readerDaily30d = readerBase30d === null ? null : readerBase30d / 30;
    const readerDaily90d = readerBase90d === null ? null : readerBase90d / 90;
    const relative = (recent, baseline) => recent !== null && baseline !== null && baseline > 0 ? recent / baseline - 1 : null;
    return {
      ...book,
      readerBase7d, readerBase30d, readerBase90d,
      readerDaily7d, readerDaily30d, readerDaily90d,
      trend7v30: relative(readerDaily7d, readerDaily30d),
      trend30v90: relative(readerDaily30d, readerDaily90d),
      comparisonQuality: [readerBase7d, readerBase30d, readerBase90d].every((value) => value !== null) ? 'complete' : 'partial'
    };
  });
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
    : ([1, 7, 30, 90].includes(Number(req.query?.days)) ? Number(req.query.days) : 30);
  const allowedSorts = new Set(['baseReadUnt', 'firstReadUntRate', 'read10wRate', 'read20wRate', 'ttProfit']);
  const sortField = allowedSorts.has(String(req.query?.sort)) ? String(req.query.sort) : 'baseReadUnt';
  let target = null;
  let filters = null;
  if (source === 'catalog') {
    try {
      target = rankingTarget(req.query);
      filters = catalogFilters(req.query, target);
    } catch (error) {
      return res.status(Number(error?.status || 400)).json({ error: String(error?.message || 'Invalid ranking target') });
    }
  }
  const day = shanghaiDay();
  const filterKey = source === 'catalog'
    ? `${filters.appKey}:${filters.language}:${filters.completeSts}:${filters.status}:${String(filters.isShort)}:${filters.readBaseMin}:${filters.firstReadMin}:${filters.longReadMin}`
    : 'performance';
  const comparisonKey = source === 'catalog' && req.query?.compare === '1' ? 'compare' : 'single';
  // v12 starts a clean catalog cache namespace. Earlier versions are read
  // only through legacyCatalogCache after their source provenance is checked.
  const key = `nf_social:leaderboard:${source}:${source === 'catalog' ? CATALOG_CACHE_VERSION : 'v11'}:${day}:${days}:${source === 'catalog' ? sortField : 'performance'}:${filterKey}:${comparisonKey}`;
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
      return res.status(200).json(source === 'catalog' ? catalogPayload(cachedPayload, { cached: true, target }) : cachedPayload);
    }
    if (source === 'catalog' && !refresh) {
      const cachedFailure = parseCachedPayload(await redis.get(failureKey));
      if (cachedFailure && Date.parse(cachedFailure.retryAfter || '') > Date.now()) {
        const legacy = await legacyCatalogCache(redis, days, sortField, filters);
        if (legacy) return res.status(200).json(catalogPayload(legacy, { stale: true, target, credentialStatus: cachedFailure.credentialStatus, warning: cachedFailure.warning, errorKind: cachedFailure.errorKind }));
        return res.status(cachedFailure.httpStatus || 502).json(unavailableCatalogPayload(cachedFailure));
      }
    }
    let verifiedTargetCatalog = null;
    if (source === 'catalog' && ['maxnovel', 'storyca', 'novelvio'].includes(filters?.appKey)) {
      verifiedTargetCatalog = await providers.topBooks(500, { applicationId: filters.applicationId, deadlineMs: 30000 });
      if (!verifiedTargetCatalog.length) throw new providers.ProviderError(`${target.appName} target application returned no active catalog SKUs`, { status: 502 });
      filters = { ...filters, skuIds: verifiedTargetCatalog.map((book) => book.bookSkuId) };
    }
    const catalogDeadlineMs = isCron ? 105000 : refresh && filters?.appKey === 'novelvio' ? 105000 : refresh ? 65000 : ['maxnovel', 'storyca', 'novelvio'].includes(filters?.appKey) ? 45000 : 30000;
    const result = source === 'history'
      ? await providers.performanceBooks(days)
      : await catalogBooks(days, sortField, filters, { deadlineMs: catalogDeadlineMs });
    let books = await enrichBooks(result.books, source === 'catalog', filters, verifiedTargetCatalog);
    if (source === 'catalog') books = books.filter((book) => book.ownershipVerified === true);
    let comparisonWindows = null;
    if (source === 'catalog' && req.query?.compare === '1') {
      const windows = { [days]: result };
      const remaining = [7, 30, 90].filter((windowDays) => windowDays !== days);
      const comparisonFilters = { ...filters, readBaseMin: 0, firstReadMin: 0, longReadMin: 0 };
      // Storyca and Novelvio often need the product-line recovery path. Their
      // verified seven-day query already consumes most of an interactive
      // Vercel request budget, so loading two more windows here caused a 504
      // even though the primary ranking was valid. Return that verified window
      // immediately; cron may still prewarm all comparison windows.
      const deferInteractiveComparison = !isCron && ['storyca', 'novelvio'].includes(filters?.appKey);
      if (!deferInteractiveComparison) {
        const comparisonDeadlineMs = refresh ? 65000 : Math.max(18000, catalogDeadlineMs);
        const settled = await Promise.allSettled(remaining.map((windowDays) => catalogBooks(windowDays, 'baseReadUnt', comparisonFilters, { deadlineMs: comparisonDeadlineMs })));
        settled.forEach((entry, index) => { if (entry.status === 'fulfilled') windows[remaining[index]] = entry.value; });
      }
      books = attachWindowComparison(books, windows);
      comparisonWindows = Object.fromEntries([7, 30, 90].map((windowDays) => [windowDays, {
        available: Boolean(windows[windowDays]?.books?.length),
        startDate: windows[windowDays]?.window?.startDate || rangeForDays(windowDays).startDate,
        endDate: windows[windowDays]?.window?.endDate || rangeForDays(windowDays).endDate
      }]));
      if (deferInteractiveComparison) comparisonWindows.deferred = true;
    }
    if (source === 'catalog') books = attachSelectionTarget(books, target);
    if (source === 'history') books = await mergeHistoryMetrics(books, days, redis);
    if (!books.length) throw new providers.ProviderError('Top-book source returned no usable books');
    let payload = {
      books,
      generatedAt: new Date().toISOString(),
      day,
      source: source === 'history' ? 'unified_funnel_performance' : 'content_dashboard_performance',
      selectionMode: source,
      window: result.window,
      snapshotVersion: P0_SNAPSHOT_VERSION,
      metrics: {
        ...(result.metrics || { sortField, candidateTotal: Number(result.candidateTotal || result.total || result.fetched || books.length), qualifiedTotal: Number(result.qualifiedTotal || books.length), observedTopUv: Number(result.observedTopUv || 0), promotionMinUv: Number(result.promotionMinUv || result.minReadUnt || 0), minReadUnt: Number(result.promotionMinUv || result.minReadUnt || 0), filters, partial: Boolean(result.partial), fetched: Number(result.fetched || books.length) }),
        candidateAxes: result.candidateAxes || [...CANDIDATE_AXES],
        axisCandidateTotals: result.axisCandidateTotals || {},
        axisFetched: result.axisFetched || {},
        ...(comparisonWindows ? { comparisonWindows } : {})
      }
    };
    if (source === 'catalog') {
      payload.target = target;
      payload.targetOptions = targetOptions();
      if (payload.metrics?.filters?.skuIds) {
        payload.metrics.filters = { ...payload.metrics.filters };
        delete payload.metrics.filters.skuIds;
      }
      if (!hasVerifiedCatalogMetrics(payload)) throw new providers.ProviderError('Content dashboard ranking did not include verified metric provenance');
      payload = catalogPayload(payload, { target });
    }
    await redis.set(key, JSON.stringify(stripP0Receipts(payload)), { ex: 36 * 60 * 60 });
    if (source === 'catalog') await discardCache(redis, failureKey);
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[social/leaderboard]', error);
    if (cachedPayload) {
      if (source === 'catalog') {
        const failure = catalogFailure(error);
        return res.status(200).json(catalogPayload(cachedPayload, { stale: true, target, credentialStatus: failure.credentialStatus, warning: failure.warning, errorKind: failure.errorKind }));
      }
      return res.status(200).json({ ...cachedPayload, stale: true, refreshWarning: 'Fresh ranking data was unavailable; the last verified ranking is still shown.' });
    }
    if (source === 'catalog') {
      const legacy = await legacyCatalogCache(redis, days, sortField, filters);
      const failure = catalogFailure(error);
      if (legacy) return res.status(200).json(catalogPayload(legacy, { stale: true, target, credentialStatus: failure.credentialStatus, warning: failure.warning, errorKind: failure.errorKind }));
      const cooldownSeconds = failure.errorKind === 'invalid_grant' || failure.errorKind === 'auth' ? 300 : failure.errorKind === 'timeout' ? 60 : 120;
      failure.retryAfter = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
      try { await redis.set(failureKey, JSON.stringify(failure), { ex: cooldownSeconds }); } catch {}
      return res.status(failure.httpStatus).json(unavailableCatalogPayload(failure));
    }
    return res.status(502).json({ error: 'Unable to load today\'s Top 200' });
  }
};

module.exports.rankingTarget = rankingTarget;
module.exports.catalogFilters = catalogFilters;
module.exports.applyMetricFilters = applyMetricFilters;
module.exports.attachSelectionTarget = attachSelectionTarget;
module.exports.stripP0Receipts = stripP0Receipts;
module.exports.metricValue = metricValue;
// Narrow internal exports keep the ownership and cache-version invariants
// independently testable without broadening the HTTP contract.
module.exports.enrichBooks = enrichBooks;
module.exports.legacyCatalogCache = legacyCatalogCache;
module.exports.CATALOG_CACHE_VERSION = CATALOG_CACHE_VERSION;
module.exports.CANDIDATE_AXES = CANDIDATE_AXES;
module.exports.P0_SNAPSHOT_VERSION = P0_SNAPSHOT_VERSION;
