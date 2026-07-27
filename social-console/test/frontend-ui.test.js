const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function between(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function renderCatalog(book, dataQuality, options = {}) {
  const nodes = new Map();
  const makeNode = () => ({
    hidden: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  });
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, makeNode());
      return nodes.get(selector);
    },
    querySelectorAll() { return []; }
  };
  const state = {
    leaderboard: [book], leaderboardSource: 'catalog', leaderboardLoading: false,
    leaderboardPage: 1, leaderboardWindow: null, leaderboardWarning: '',
    leaderboardMetrics: null, leaderboardDataQuality: dataQuality, leaderboardError: '',
    catalogSort: 'baseReadUnt', catalogFilters: options.filters || { length: 'all', genre: 'all' },
    selectedBooks: new Set(), runs: [], startingSku: '', coverFailures: new Map()
  };
  const context = {
    state, document, URL, Set, Number, Math,
    $: (selector) => document.querySelector(selector),
    escapeHtml: (value) => String(value ?? ''),
    compactNumber: (value) => String(value || 0),
    percentage: (value) => `${Number(value || 0)}%`,
    catalogSortLabels: { baseReadUnt: '阅读 UV' },
    activeRunFor: () => null,
    leaderboardCover: () => '<span></span>',
    coverDataAttributes: () => '',
    renderLeaderboardPager() {}, renderBatchBookBar() {}, renderCoverRetryControl() {},
    startProduction() {}, openCreativePlanDialog() {}, loadLeaderboard() {}
  };
  vm.createContext(context);
  vm.runInContext([
    between('function bookIsShort(', 'function bookGenre('),
    between('function bookGenre(', 'function catalogVisibleBooks('),
    between('function catalogVisibleBooks(', 'function metricHasSignal('),
    between('function metricHasSignal(', 'function catalogDataHealth('),
    between('function catalogDataHealth(', 'function renderBatchBookBar('),
    between('function renderLeaderboard()', 'function renderLeaderboardPager(')
  ].join('\n'), context);
  context.renderLeaderboard();
  return options.returnNodes ? nodes : nodes.get('#leaderboard').innerHTML;
}

test('metric-less catalog books are unranked and cannot start production', () => {
  const html = renderCatalog({
    rank: 1, title: 'Metricless catalog book', bookSkuId: 'sku-1', automationReady: true,
    baseReadUnt: 0, firstReadUntRate: 0, read10wRate: 0, read20wRate: 0, ttProfit: 0
  }, 'catalog_without_metrics');
  assert.match(html, /<span class="rank">待验证<\/span>/);
  assert.match(html, /data-select-sku="sku-1"[^>]*disabled/);
  assert.match(html, /class="plan-book"[^>]*disabled/);
  assert.match(html, /class="start-book[^>]*"[^>]*disabled/);
  assert.doesNotMatch(html, /#1<\/span>/);
});

test('verified metric ranking keeps the intended actions available', () => {
  const html = renderCatalog({
    rank: 1, title: 'Verified ranked book', bookSkuId: 'sku-2', automationReady: true,
    baseReadUnt: 1200, firstReadUntRate: 28, read10wRate: 16, read20wRate: 9, ttProfit: 42
  }, 'verified_metrics');
  assert.match(html, /<span class="rank">#1<\/span>/);
  assert.doesNotMatch(html, /data-select-sku="sku-2"[^>]*disabled/);
  assert.doesNotMatch(html, /class="plan-book"[^>]*disabled/);
  assert.doesNotMatch(html, /class="start-book[^>]*"[^>]*disabled/);
});

test('unchanged status polling does not rebuild ranking or recommendation views', async () => {
  const body = { runs: [], capabilities: { storage: true }, videoLimit: { used: 0, limit: 5, remaining: 5 } };
  const calls = { leaderboard: 0, today: 0, statusViews: 0, snapshot: 0 };
  const state = {
    runs: [], capabilities: body.capabilities, videoLimit: body.videoLimit,
    selectedId: '', detailOpen: false, statusLoading: false, statusRequest: null,
    statusFingerprint: JSON.stringify({ runs: [], capabilities: body.capabilities, videoLimit: body.videoLimit })
  };
  const context = {
    state,
    api: async () => body,
    renderCapabilities() { calls.statusViews += 1; },
    renderStats() { calls.statusViews += 1; },
    renderFocusRun() { calls.statusViews += 1; },
    renderRunList() { calls.statusViews += 1; },
    renderDetail() { calls.statusViews += 1; },
    renderLeaderboard() { calls.leaderboard += 1; },
    renderTodayRail() { calls.today += 1; },
    icons() {},
    saveDashboardSnapshot() { calls.snapshot += 1; },
    showApp() {},
    hydrateRunDetail() {}
  };
  vm.createContext(context);
  vm.runInContext(between('function statusPayloadFingerprint(', 'async function loadLeaderboard('), context);
  await context.loadStatus({ silent: true });
  assert.equal(calls.statusViews, 0);
  assert.equal(calls.leaderboard, 0);
  assert.equal(calls.today, 0);
  assert.equal(calls.snapshot, 0);
});

test('asset copy requests only finished posts for a summary task', async () => {
  const state = { runs: [{ id: 'run-1', _summary: true, artifacts: { posts: [{ content: 'ready' }] } }] };
  let calls = 0;
  let requestedUrl = '';
  const context = {
    state,
    encodeURIComponent,
    api: async (url) => { calls += 1; requestedUrl = url; return { id: 'run-1', posts: [{ content: 'Finished post' }] }; }
  };
  vm.createContext(context);
  vm.runInContext(between('async function copyPostsForAsset(', 'function reportNumber('), context);
  const posts = await context.copyPostsForAsset('run-1');
  assert.equal(calls, 1);
  assert.match(requestedUrl, /asset=copy/);
  assert.equal(posts[0].content, 'Finished post');
  assert.equal(state.runs[0]._summary, true);
});

test('today ranking uses its own UV context and keeps fallback retention scores bounded', () => {
  const context = { state: { catalogSort: 'ttProfit', leaderboard: [] }, Math, Number, Boolean, String };
  vm.createContext(context);
  vm.runInContext([
    between('function metricHasSignal(', 'function catalogDataHealth('),
    between('function catalogDataHealth(', 'function renderBatchBookBar('),
    between('function todayScore(', 'function renderTodayRail(')
  ].join('\n'), context);
  const books = [
    { title: 'A', baseReadUnt: 100, firstReadUntRate: 20, read10wRate: 12, read20wRate: 0, ttProfit: 0 },
    { title: 'B', baseReadUnt: 50, firstReadUntRate: 10, read10wRate: 6, read20wRate: 0, ttProfit: 0 }
  ];
  assert.equal(context.responseAllowsCatalogRanking({ dataQuality: 'verified_metrics' }, books, 'baseReadUnt'), true);
  assert.equal(context.responseAllowsCatalogRanking({}, books, 'baseReadUnt'), false);
  assert.equal(context.responseAllowsCatalogRanking({ dataQuality: 'verified_metrics' }, books), false);
  const scored = context.todayScore(books);
  assert.equal(scored[0].title, 'A');
  assert.ok(scored.every((book) => book.todayScore >= 0 && book.todayScore <= 100));
});

test('verified historical candidates remain actionable when the new-book metric source is unavailable', () => {
  const context = { Math, Number };
  vm.createContext(context);
  vm.runInContext(between('function historyTodayScore(', 'function renderTodayRail('), context);
  const scored = context.historyTodayScore([
    { title: 'High revenue', pullUv: 100, d14Income: 80, score: 60 },
    { title: 'Low revenue', pullUv: 90, d14Income: 10, score: 50 }
  ]);
  assert.equal(scored[0].title, 'High revenue');
  assert.ok(scored.every((book) => book.todayScore > 0 && book.todayScore <= 100));
});

test('catalog outage automatically opens the clearly labelled verified review queue instead of an empty main ranking', () => {
  const state = {
    leaderboardSource: 'catalog', catalogDays: 30, catalogSort: 'baseReadUnt', windowDays: 7,
    catalogFilters: { line: 'novelflow', language: 'EN', complete: '已完结', status: '上架', length: 'all', genre: 'all' },
    todayDataQuality: 'history_verified', todayBooks: [{ title: 'Verified candidate', bookSkuId: 'sku-1' }],
    selectedBooks: new Set(['old']), leaderboard: []
  };
  const context = {
    state, Date, Set,
    document: { querySelectorAll: () => [{ dataset: { source: 'history' }, classList: { toggle() {} } }] }
  };
  vm.createContext(context);
  vm.runInContext([
    between('function leaderboardQueryKey(', 'function compactRunSnapshot('),
    between('function activateHistoricalLeaderboardFallback(', 'function renderBatchBookBar(')
  ].join('\n'), context);
  assert.equal(context.activateHistoricalLeaderboardFallback('继续策划'), true);
  assert.equal(state.leaderboardSource, 'history');
  assert.equal(state.leaderboard[0].title, 'Verified candidate');
  assert.equal(state.selectedBooks.size, 0);
  assert.match(state.leaderboardWarning, /已验证投放复盘候选/);
});

test('adopted AI plans leave the decision queue and remain only on their production run', () => {
  const context = { state: { planJobs: [], runs: [] }, Set, String };
  vm.createContext(context);
  vm.runInContext(between('function visibleCreativePlanJobs(', 'function renderCreativePlanQueue('), context);
  const visible = context.visibleCreativePlanJobs([
    { id: 'accepted', state: 'completed' },
    { id: 'ready', state: 'completed' },
    { id: 'running', state: 'running' },
    { id: 'failed', state: 'failed' }
  ], [
    { input: { planning: { planId: 'accepted' } } }
  ]);
  assert.deepEqual(visible.map((job) => job.id), ['ready', 'running', 'failed']);
});

test('selected quality models are not aborted by the old short UI timeout', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(between('const longBackgroundModels', 'function creativeProfileForForm('), context);
  assert.equal(context.selectedModelWaitMs('seed-2.1-turbo'), 210000);
  assert.equal(context.selectedModelWaitMs('qwen3.7-max'), 210000);
  assert.equal(context.selectedModelWaitMs('hy3'), 70000);
});

test('legacy snapshots without verified metric provenance are not restored as rankings', () => {
  const snapshot = {
    savedAt: Date.now(),
    leaderboardQueryKey: 'catalog:30:baseReadUnt:novelflow:EN:已完结:上架:all:all',
    leaderboard: [{ title: 'Old unverified result', baseReadUnt: 999 }],
    todayBooks: [{ title: 'Old recommendation', baseReadUnt: 999, firstReadUntRate: 30, read10wRate: 20 }]
  };
  const state = {
    runs: [], leaderboardSource: 'catalog', catalogDays: 30, catalogSort: 'baseReadUnt',
    catalogFilters: { line: 'novelflow', language: 'EN', complete: '已完结', status: '上架', length: 'all', genre: 'all' }
  };
  const context = {
    state, Date,
    DASHBOARD_CACHE_KEY: 'snapshot', DASHBOARD_CACHE_MAX_AGE: 86400000,
    localStorage: { getItem: () => JSON.stringify(snapshot) },
    recommendationMetricsReady: () => true
  };
  vm.createContext(context);
  vm.runInContext([
    between('function leaderboardQueryKey(', 'function compactRunSnapshot('),
    between('function restoreDashboardSnapshot()', 'state.detailHydrating')
  ].join('\n'), context);
  context.restoreDashboardSnapshot();
  assert.equal(context.state.leaderboard.length, 0);
  assert.equal(context.state.todayBooks.length, 0);
});

test('replanning inside an open dialog does not call showModal twice', () => {
  let modalCalls = 0;
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      open: id === '#creativePlanDialog', hidden: false, innerHTML: '', textContent: '', value: '',
      showModal() { modalCalls += 1; }, focus() {}, insertAdjacentHTML() {}
    });
    return nodes.get(id);
  };
  const context = { state: {}, $: node, setTimeout: (fn) => fn() };
  vm.createContext(context);
  vm.runInContext(between('function openCreativePlanDialog(', 'async function analyzeCreativePlan('), context);
  context.openCreativePlanDialog({ title: 'Replan Book', bookSkuId: 'sku' });
  assert.equal(modalCalls, 0);
  assert.equal(context.state.planning, false);
});

test('zero matches after local genre filtering shows a useful empty state', () => {
  const nodes = renderCatalog({
    rank: 1, title: 'CEO Office Romance', bookSkuId: 'sku-filter', automationReady: true,
    baseReadUnt: 1200, firstReadUntRate: 28, read10wRate: 16, read20wRate: 9
  }, 'verified_metrics', { filters: { length: 'all', genre: 'werewolf' }, returnNodes: true });
  assert.equal(nodes.get('#leaderboard').innerHTML, '');
  assert.equal(nodes.get('#leaderboardEmpty').hidden, false);
  assert.match(nodes.get('#leaderboardEmpty').innerHTML, /当前组合没有匹配书籍/);
});

test('asset video state distinguishes generation, failure and completion', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(between('function videoAssetState(', 'function assetLibraryFingerprint('), context);
  assert.equal(context.videoAssetState({ artifacts: { video: { status: 'running' } }, stages: {} }).label, '视频生成中');
  assert.equal(context.videoAssetState({ artifacts: { video: { status: 'failed' } }, stages: {} }).label, '视频生成失败');
  assert.equal(context.videoAssetState({ artifacts: { video: { videoUrls: ['https://video.example/a.mp4'] } }, stages: {} }).label, '视频可播放');
});

test('cover markup shows a readable fallback before the remote image decodes', () => {
  const context = {
    state: { leaderboardSource: 'catalog', coverFailures: new Map() },
    escapeHtml: (value) => String(value ?? ''),
    coverSrc: (value) => value,
    coverOriginalSrc: (value) => value,
    String
  };
  vm.createContext(context);
  vm.runInContext(between('function leaderboardCover(', 'function coverDataAttributes('), context);
  const html = context.leaderboardCover({ title: 'Visible While Loading', bookSkuId: 'sku-cover', cover: 'https://cdn.example/cover.jpg' });
  assert.ok(html.indexOf('cover-fallback') < html.indexOf('data-cover-image'));
  assert.doesNotMatch(html, /cover-fallback[^>]*hidden/);
  assert.match(html, /onload="handleCoverImageLoad\(this\)"/);
  assert.match(html, /onerror="handleCoverImageError\(this\)"/);
});
