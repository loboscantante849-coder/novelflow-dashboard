const { getRedis, listRunSummaries } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');
const { ACCOUNT_ROUTES, APPS, normalizeDelivery } = require('./_lib/distribution');
const leaderboard = require('./leaderboard');

const text = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';

function shanghaiDate(value) {
  const raw = text(value, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function scheduleAt(date, platform, routeIndex, slotIndex) {
  // Keep the operator's 19:50 anchor while separating adjacent platforms and accounts.
  const base = { tiktok: 19 * 60 + 20, instagram: 19 * 60 + 35, facebook: 19 * 60 + 50 }[platform] || 19 * 60 + 50;
  const minute = base + ((routeIndex % 5) * 10) + (slotIndex * 30);
  const dayOffset = Math.floor(minute / (24 * 60));
  const normalized = minute % (24 * 60);
  const hh = String(Math.floor(normalized / 60)).padStart(2, '0');
  const mm = String(normalized % 60).padStart(2, '0');
  const target = new Date(`${date}T${hh}:${mm}:00+08:00`);
  if (dayOffset) target.setTime(target.getTime() + dayOffset * 86400000);
  return target.toISOString();
}

function plannerFilters(route) {
  const target = normalizeDelivery({ accountId: route.accountId });
  return leaderboard.catalogFilters({ line: route.appKey, platform: route.platform, accountId: route.accountId, language: 'EN', complete: '已完结', status: '上架', readBaseMin: '0', firstReadMin: '0', longReadMin: '0' }, target);
}

function runUsageTime(run) {
  const values = [
    run.input?.campaign?.scheduledAt,
    run.artifacts?.review?.scheduledAt,
    run.createdAt,
    run.updatedAt
  ];
  for (const value of values) {
    const parsed = Date.parse(value || '');
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function usageState(lastUsedAt, planTime, cooldownDays) {
  if (!lastUsedAt) return 'never_used';
  const ageDays = Math.floor(Math.max(0, planTime - lastUsedAt) / 86400000);
  return ageDays >= cooldownDays ? 'cooldown_clear' : 'recent';
}

async function loadRoute(route, topN, date, routeIndex, recentByAccount, cooldownDays) {
  const target = normalizeDelivery({ accountId: route.accountId });
  const filters = plannerFilters(route);
  let verifiedTargetCatalog = null;
  if (['maxnovel', 'storyca', 'novelvio'].includes(route.appKey)) {
    verifiedTargetCatalog = await providers.topBooks(500, { applicationId: filters.applicationId, deadlineMs: 18000 });
    filters.skuIds = verifiedTargetCatalog.map((book) => book.bookSkuId);
  }
  const result = await leaderboard.catalogBooks(30, 'baseReadUnt', filters, { deadlineMs: 18000 });
  const enriched = await leaderboard.enrichBooks(result.books, true, filters, verifiedTargetCatalog);
  const eligible = enriched
    .filter((book) => book?.ownershipVerified === true && book?.automationReady !== false)
    .filter((book) => Number(book.baseReadUnt) > 0 && ['baseReadUnt', 'firstReadUntRate', 'read10wRate', 'read20wRate', 'ttProfit'].some((key) => Number.isFinite(Number(book[key]))))
    .sort((a, b) => Number(a.rank || 999999) - Number(b.rank || 999999));
  const selected = [];
  const seen = new Set();
  const planTime = Date.parse(`${date}T23:59:59+08:00`);
  for (const book of eligible) {
    const sku = String(book.bookSkuId || '');
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    const lastUsedAt = recentByAccount.get(`${route.accountId}:${sku}`) || 0;
    const usage = usageState(lastUsedAt, planTime, cooldownDays);
    // Keep books used by this account inside the cooling window out of the
    // first pass. Older books remain eligible so the catalogue can rotate.
    if (usage !== 'recent') selected.push({ book, usage, lastUsedAt });
    if (selected.length >= topN) break;
  }
  if (selected.length < topN) {
    const recentBackfill = eligible
      .map((book) => ({ book, lastUsedAt: recentByAccount.get(`${route.accountId}:${String(book.bookSkuId || '')}`) || 0 }))
      .filter(({ book, lastUsedAt }) => lastUsedAt && !selected.some((item) => String(item.book.bookSkuId) === String(book.bookSkuId)))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const { book, lastUsedAt } of recentBackfill) {
      const sku = String(book.bookSkuId || '');
      if (!sku || selected.some((item) => String(item.book.bookSkuId) === sku)) continue;
      selected.push({ book, usage: 'recent_backfill', lastUsedAt });
      if (selected.length >= topN) break;
    }
  }
  return {
    accountId: route.accountId, accountTitle: route.accountTitle, appKey: route.appKey,
    appName: APPS[route.appKey]?.name || route.accountTitle, platform: route.platform,
    routeStatus: selected.length ? 'ready' : 'unavailable',
    slots: selected.map(({ book, usage, lastUsedAt }, slotIndex) => ({
      slot: slotIndex + 1, title: book.title, sku: book.bookSkuId, rank: Number(book.rank || slotIndex + 1),
      metrics: { baseReadUnt: Number(book.baseReadUnt || 0), firstReadUntRate: Number(book.firstReadUntRate || 0), read10wRate: Number(book.read10wRate || 0), read20wRate: Number(book.read20wRate || 0), ttProfit: Number(book.ttProfit || 0) },
      usage, lastUsedAt: lastUsedAt ? new Date(lastUsedAt).toISOString() : '', cooldownDays,
      scheduledAt: scheduleAt(date, route.platform, routeIndex, slotIndex),
      creativeVariantKey: `planner:${date}:${route.accountId}:${route.platform}:${book.bookSkuId}:${slotIndex + 1}`,
      copyStrategy: 'llm', accountId: route.accountId, accountTitle: route.accountTitle, appKey: route.appKey, platform: route.platform
    }))
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try { results[index] = { status: 'fulfilled', value: await worker(items[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const topN = Math.max(1, Math.min(10, Number(req.query?.topN) || 3));
  const date = shanghaiDate(req.query?.date);
  const copyStrategy = ['llm', 'hy3', 'evidence_fallback'].includes(String(req.query?.copyStrategy)) ? String(req.query.copyStrategy) : 'llm';
  const cooldownDays = Math.max(1, Math.min(90, Number(req.query?.cooldownDays) || 7));
  const platform = ['facebook', 'instagram', 'tiktok'].includes(String(req.query?.platform || '').toLowerCase()) ? String(req.query.platform).toLowerCase() : '';
  const accountId = Number(req.query?.accountId || 0);
  const selectedRoutes = ACCOUNT_ROUTES.filter((route) => (!platform || route.platform === platform) && (!accountId || route.accountId === accountId));
  const summaries = await listRunSummaries(redis, 500);
  const recentByAccount = new Map();
  summaries.forEach((run) => {
    const runAccountId = Number(run.input?.delivery?.accountId || 0);
    const sku = String(run.input?.sku || run.input?.verifiedBook?.bookSkuId || '');
    const usedAt = runUsageTime(run);
    const key = `${runAccountId}:${sku}`;
    if (runAccountId && sku && usedAt > (recentByAccount.get(key) || 0)) recentByAccount.set(key, usedAt);
  });
  // A small parallel pool keeps every route independent without flooding the
  // ranking and bookstore upstreams. The previous 14-way burst commonly left
  // only the first two routes populated.
  const settled = await mapWithConcurrency(selectedRoutes, 3, (route, index) => loadRoute(route, topN, date, index, recentByAccount, cooldownDays));
  const routes = settled.map((entry, index) => entry.status === 'fulfilled' ? { ...entry.value, slots: entry.value.slots.map((slot) => ({ ...slot, copyStrategy })) } : ({
    accountId: selectedRoutes[index].accountId, accountTitle: selectedRoutes[index].accountTitle, appKey: selectedRoutes[index].appKey,
    platform: selectedRoutes[index].platform, routeStatus: 'unavailable', slots: [], error: String(entry.reason?.message || '排行 API 暂时不可用').slice(0, 180)
  }));
  return res.status(200).json({ generatedAt: new Date().toISOString(), date, timezone: 'Asia/Shanghai', topN, copyStrategy, cooldownDays, platform, accountId: accountId || null, routeCount: selectedRoutes.length, totalRouteCount: ACCOUNT_ROUTES.length, routes });
};
