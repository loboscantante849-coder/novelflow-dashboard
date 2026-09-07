const { getRedis, listRunSummaries } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');
const { ACCOUNT_ROUTES, APPS, appByKey, normalizeDelivery } = require('./_lib/distribution');
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

async function loadRoute(route, topN, date, routeIndex, usedByAccount) {
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
  for (const book of eligible) {
    const sku = String(book.bookSkuId || '');
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    const used = usedByAccount.get(`${route.accountId}:${sku}`) === true;
    // Prefer unused rows, but backfill from verified rows if the route is sparse.
    if (!used) selected.push({ book, usage: 'unused' });
    if (selected.length >= topN) break;
  }
  if (selected.length < topN) {
    for (const book of eligible) {
      const sku = String(book.bookSkuId || '');
      if (!sku || selected.some((item) => String(item.book.bookSkuId) === sku)) continue;
      selected.push({ book, usage: 'used_backfill' });
      if (selected.length >= topN) break;
    }
  }
  return {
    accountId: route.accountId, accountTitle: route.accountTitle, appKey: route.appKey,
    appName: APPS[route.appKey]?.name || route.accountTitle, platform: route.platform,
    routeStatus: selected.length ? 'ready' : 'unavailable',
    slots: selected.map(({ book, usage }, slotIndex) => ({
      slot: slotIndex + 1, title: book.title, sku: book.bookSkuId, rank: Number(book.rank || slotIndex + 1),
      metrics: { baseReadUnt: Number(book.baseReadUnt || 0), firstReadUntRate: Number(book.firstReadUntRate || 0), read10wRate: Number(book.read10wRate || 0), read20wRate: Number(book.read20wRate || 0), ttProfit: Number(book.ttProfit || 0) },
      usage, scheduledAt: scheduleAt(date, route.platform, routeIndex, slotIndex),
      creativeVariantKey: `planner:${date}:${route.accountId}:${route.platform}:${book.bookSkuId}:${slotIndex + 1}`,
      copyStrategy: 'llm'
    }))
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const topN = Math.max(1, Math.min(10, Number(req.query?.topN) || 3));
  const date = shanghaiDate(req.query?.date);
  const copyStrategy = ['llm', 'evidence_fallback'].includes(String(req.query?.copyStrategy)) ? String(req.query.copyStrategy) : 'llm';
  const summaries = await listRunSummaries(redis, 500);
  const usedByAccount = new Map();
  summaries.forEach((run) => {
    const accountId = Number(run.input?.delivery?.accountId || 0);
    const sku = String(run.input?.sku || run.input?.verifiedBook?.bookSkuId || '');
    if (accountId && sku) usedByAccount.set(`${accountId}:${sku}`, true);
  });
  const settled = await Promise.allSettled(ACCOUNT_ROUTES.map((route, index) => loadRoute(route, topN, date, index, usedByAccount)));
  const routes = settled.map((entry, index) => entry.status === 'fulfilled' ? { ...entry.value, slots: entry.value.slots.map((slot) => ({ ...slot, copyStrategy })) } : ({
    accountId: ACCOUNT_ROUTES[index].accountId, accountTitle: ACCOUNT_ROUTES[index].accountTitle, appKey: ACCOUNT_ROUTES[index].appKey,
    platform: ACCOUNT_ROUTES[index].platform, routeStatus: 'unavailable', slots: [], error: String(entry.reason?.message || '排行 API 暂时不可用').slice(0, 180)
  }));
  return res.status(200).json({ generatedAt: new Date().toISOString(), date, timezone: 'Asia/Shanghai', topN, copyStrategy, routeCount: ACCOUNT_ROUTES.length, routes });
};
