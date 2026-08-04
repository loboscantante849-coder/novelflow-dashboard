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
  const body = { runs: [], capabilities: { storage: true }, videoLimit: { used: 0, limit: 5, remaining: 5 }, runLimit: 24 };
  const calls = { leaderboard: 0, today: 0, statusViews: 0, snapshot: 0 };
  const state = {
    runs: [], capabilities: body.capabilities, videoLimit: body.videoLimit,
    selectedId: '', detailOpen: false, statusLoading: false, statusRequest: null, statusLimit: 24,
    statusFingerprint: JSON.stringify({ runs: [], capabilities: body.capabilities, videoLimit: body.videoLimit, runLimit: 24 })
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
    renderRunLoadMore() {},
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

test('completed runs with a partial media branch are labelled as partial outcomes', () => {
  const context = {
    Object,
    labels: { completed: '已完成' },
    stageLabels: { P3_5: '海报' }
  };
  vm.createContext(context);
  vm.runInContext(between('function runOutcome(', 'function cover('), context);
  const outcome = context.runOutcome({ state: 'completed', stages: { P3_5: { status: 'partial' }, P6: { status: 'done' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { className: 'partial', label: '主体完成 · 海报部分完成' });
});

test('overview KPI filters use the same task definitions as their counters', () => {
  const state = { overviewFilter: 'active' };
  const context = { state, Array, Object, String };
  vm.createContext(context);
  vm.runInContext(between('function assetSummary(', 'function libraryRuns('), context);
  const active = { state: 'running', artifacts: {}, stages: {} };
  const usable = { state: 'completed', artifacts: { posts: [{ content: 'ready' }], images: [], video: null }, stages: {} };
  const partial = { state: 'completed', artifacts: {}, stages: { P3_5: { status: 'partial' } } };
  assert.equal(context.matchesOverviewFilter(active), true);
  assert.equal(context.matchesOverviewFilter(usable), false);
  state.overviewFilter = 'assets';
  assert.equal(context.matchesOverviewFilter(usable), true);
  state.overviewFilter = 'attention';
  assert.equal(context.matchesOverviewFilter(partial), true);
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

test('today recommendations reject zero, tiny-sample, and incomplete metric records', () => {
  const context = { Math, Number };
  vm.createContext(context);
  vm.runInContext(between('function todayScore(', 'function historyTodayScore('), context);
  const scored = context.todayScore([
    { title: 'Proven', baseReadUnt: 120, firstReadUntRate: 32, read10wRate: 38, read20wRate: 24, ttProfit: 110 },
    { title: 'One UV', baseReadUnt: 1, firstReadUntRate: 100, read10wRate: 100, read20wRate: 100, ttProfit: 0 },
    { title: 'Zero UV', baseReadUnt: 0, firstReadUntRate: 100, read10wRate: 100, read20wRate: 100, ttProfit: 0 },
    { title: 'Missing retention', baseReadUnt: 200, firstReadUntRate: 42, read10wRate: 0, read20wRate: 0, ttProfit: 40 }
  ]);
  assert.deepEqual(scored.map((book) => book.title), ['Proven']);
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

test('historical review translates book-level attribution into four explicit decisions', () => {
  const context = {
    state: { windowDays: 7 }, Math, Number,
    compactNumber: (value) => String(Number(value || 0)),
    percentage: (value) => `${Number(value || 0)}%`
  };
  vm.createContext(context);
  vm.runInContext(between('const historyDecisionMeta', 'function renderTodayRail('), context);
  const reviewed = context.historyReviewBooks([
    { title: 'Strong', pullUv: 200, firstReadRate: 20, d14Income: 20, incomePerUv: .2, confidence: 60, score: 80, assetCount: 3 },
    { title: 'Weak', pullUv: 50, firstReadRate: 2, d14Income: 0, incomePerUv: .01, confidence: 40, score: 20, assetCount: 2 },
    { title: 'Mixed', pullUv: 100, firstReadRate: 10, d14Income: 5, incomePerUv: .1, confidence: 20, score: 50, assetCount: 2 },
    { title: 'Tiny', pullUv: 10, firstReadRate: 1, d14Income: 0, incomePerUv: 0, confidence: 5, score: 10, assetCount: 1 }
  ]);
  const decisions = Object.fromEntries(reviewed.map((book) => [book.title, book.review.decision]));
  assert.deepEqual(decisions, { Strong: 'reinvest', Mixed: 'observe', Weak: 'pause', Tiny: 'insufficient' });
  assert.match(reviewed[0].review.basis, /书汇总/);
  assert.match(reviewed[0].review.basis, /留存未接入，不参与判断/);
});

test('closed task drawer does not rebuild hidden asset detail during polling', () => {
  const panel = { innerHTML: 'keep-existing-detail', classList: { toggle() {} }, setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  const scrim = { classList: { toggle() {} }, setAttribute() {} };
  const state = { runs: [{ id: 'run-1', _summary: false, input: {}, artifacts: {}, stages: {} }], selectedId: 'run-1', detailOpen: false };
  const context = { state, $: (selector) => selector === '#detailPanel' ? panel : scrim, Boolean, String };
  vm.createContext(context);
  vm.runInContext(between('function renderDetail()', 'function render()'), context);
  context.renderDetail();
  assert.equal(panel.innerHTML, 'keep-existing-detail');
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

test('auto-start AI plans leave the decision queue and remain only on their production run', () => {
  const context = { state: { planJobs: [], runs: [] }, Set, String };
  vm.createContext(context);
  vm.runInContext(between('function visibleCreativePlanJobs(', 'function renderCreativePlanQueue('), context);
  const visible = context.visibleCreativePlanJobs([
    { id: 'accepted', state: 'completed' },
    { id: 'ready', state: 'completed', input: { autoStartProduction: false } },
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
    state, Date, Math, Number,
    DASHBOARD_CACHE_KEY: 'snapshot', DASHBOARD_CACHE_MAX_AGE: 86400000,
    localStorage: { getItem: () => JSON.stringify(snapshot) },
    recommendationMetricsReady: () => true
  };
  vm.createContext(context);
  vm.runInContext([
    between('function leaderboardQueryKey(', 'function compactRunSnapshot('),
    between('function todayScore(', 'function historyTodayScore('),
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

test('worker dispatch lease releases after the request settles and keeps only a short debounce', async () => {
  let now = 1000;
  let settle;
  const DateShim = class extends Date { static now() { return now; } };
  const context = {
    state: { workerDispatches: new Map(), workerDispatchNotice: new Map() },
    Date: DateShim, Promise,
    WORKER_DISPATCH_COOLDOWN_MS: 4000,
    WORKER_DISPATCH_STALE_MS: 720000,
    fetch: () => new Promise((resolve) => { settle = resolve; }),
    api: async () => ({ ok: true })
  };
  vm.createContext(context);
  vm.runInContext(between('function workerDispatchBusy(', 'function selectedModelWaitMs('), context);
  assert.equal(context.dispatchWorkerOnce('run:1', { id: 'run-1' }), true);
  assert.equal(context.dispatchWorkerOnce('run:1', { id: 'run-1' }), false);
  settle({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  now += 4001;
  assert.equal(context.dispatchWorkerOnce('run:1', { id: 'run-1' }), true);
});

test('background polling does not repeatedly toast when it dispatches a long-running model task', async () => {
  let toastCount = 0;
  const state = { kickPromise: null, kicking: false, planJobs: [], runs: [{ id: 'run-1', state: 'running' }] };
  const context = {
    state,
    dispatchesForPlan: () => [],
    dispatchesForRun: () => [{ key: 'run:run-1', payload: { id: 'run-1' }, longTask: true, modelChoice: 'deepseek' }],
    workerDispatchBusy: () => false,
    dispatchWorkerOnce: () => true,
    WORKER_DISPATCH_COOLDOWN_MS: 4000,
    renderOneClickStatus() {},
    loadStatus: async () => {},
    setTimeout() {},
    showToast() { toastCount += 1; }
  };
  vm.createContext(context);
  vm.runInContext(between('async function kickWorker()', 'async function retryRun('), context);
  await context.kickWorker();
  await context.kickWorker();
  assert.equal(toastCount, 0);
});

test('a selected book exposes a stable pending production identity', () => {
  const state = { pendingProductions: new Map([['sku:sku-42', { title: 'Queued Book' }]]) };
  const context = { state, String };
  vm.createContext(context);
  vm.runInContext(between('function productionIdentity(', 'function bookIsShort('), context);
  assert.equal(context.pendingProductionFor({ title: 'Queued Book', bookSkuId: 'sku-42' }).title, 'Queued Book');
  assert.equal(context.productionIdentity({ title: 'Queued Book', sku: 'sku-42' }), 'sku:sku-42');
});

test('kick targets every active run instead of only the first one', () => {
  const context = { usesLongBackground: () => false, Date, Number, String };
  vm.createContext(context);
  vm.runInContext(between('function dispatchesForRun(', 'async function kickWorker('), context);
  const runs = [
    { id: 'run-1', state: 'running', stages: { P1: { status: 'running' } }, input: { creativeProfile: { modelChoice: 'hy3' } } },
    { id: 'run-2', state: 'running', stages: { P1: { status: 'running' } }, input: { creativeProfile: { modelChoice: 'hy3' } } }
  ];
  const targets = runs.flatMap(context.dispatchesForRun);
  assert.deepEqual(targets.map((item) => item.key), ['run:run-1', 'run:run-2']);
});

test('a malformed creative package is treated as background recovery work instead of a dead task', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(between('function hasAutomaticCreativeRecovery(', 'function dispatchesForPlan('), context);
  const run = {
    state: 'failed', stages: { P3: { status: 'failed', phase: 'waiting_for_operator', error: 'deepseek returned invalid structured output' } },
    artifacts: { book: { title: 'Book' }, evidence: { chapters: [{ order: 1, content: 'evidence' }] }, code: '44486', shortUrl: 'https://social.example/s/x' }
  };
  assert.equal(context.hasAutomaticCreativeRecovery(run), true);
  run.stages.P3.error = 'AC video ended with failed';
  assert.equal(context.hasAutomaticCreativeRecovery(run), false);
});

test('automatic production uses one task-wide worker route instead of parallel model sections', () => {
  const source = between('function dispatchesForRun(', 'async function kickWorker(');
  assert.doesNotMatch(source, /creativeSection/);
  assert.match(source, /key: `run:\$\{run\.id\}`/);
});

test('one-click status keeps a durable active run visible after request setup settles', () => {
  const panelSource = between('function activeAutopilotItems(', 'function todayScore(');
  assert.match(panelSource, /state\.runs/);
  assert.match(panelSource, /autopilot\?\.nextActionLabel/);
  assert.match(panelSource, /data-open-autopilot/);
  assert.match(panelSource, /关闭页面也会继续/);
});

test('blocked and paid-failed runs protect a book from duplicate one-click creation', () => {
  const context = { state: { runs: [] }, String, Array };
  vm.createContext(context);
  vm.runInContext(between('function productionIdentity(', 'function bookIsShort('), context);
  const book = { title: 'Protected Book', bookSkuId: 'sku-protected' };
  const blocked = { state: 'blocked', input: { title: book.title, sku: book.bookSkuId }, artifacts: {} };
  const paidFailed = { state: 'failed', input: { title: book.title, sku: book.bookSkuId }, artifacts: { video: { threadId: 'paid-video-task' }, images: [] } };
  const ordinaryFailed = { state: 'failed', input: { title: book.title, sku: book.bookSkuId }, artifacts: { video: null, images: [] } };
  context.state.runs = [blocked];
  assert.equal(context.activeRunFor(book), blocked);
  context.state.runs = [paidFailed];
  assert.equal(context.activeRunFor(book), paidFailed);
  context.state.runs = [ordinaryFailed];
  assert.equal(context.activeRunFor(book), undefined);
});

test('status reconciliation ignores an older completed run for the same book', () => {
  const pending = { title: 'Repeat Book', sku: 'sku-repeat', status: 'submitting', startedAt: Date.parse('2026-08-03T08:00:00.000Z') };
  const state = {
    pendingProductions: new Map([['sku:sku-repeat', pending]]),
    runs: [{ id: 'old-run', state: 'completed', createdAt: '2026-07-01T00:00:00.000Z', input: { title: pending.title, sku: pending.sku }, artifacts: {} }]
  };
  const context = { state, String, Array, Number, Date };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function bookIsShort('),
    between('function reconcilePendingProductions()', 'function renderStatusViews(')
  ].join('\n'), context);
  context.reconcilePendingProductions();
  assert.equal(state.pendingProductions.has('sku:sku-repeat'), true);
});

test('a recovered planning job clears the misleading failed pending state', () => {
  const pending = { title: 'Recovered Plan', sku: 'plan-sku', status: 'failed', error: 'request timed out' };
  const state = { planJobs: [], pendingProductions: new Map([['sku:plan-sku', pending]]), planningSession: 1 };
  const context = {
    state, String,
    renderCreativePlanQueue() {}, renderOneClickStatus() {}, icons() {}, dispatchWorkerOnce() {}, showToast() {},
    $: () => ({ close() {} })
  };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function runMatchesBook('),
    between('function queueCreativePlanJob(', 'async function recoverCreativePlanRequest(')
  ].join('\n'), context);
  context.queueCreativePlanJob({ id: 'plan-1', input: { title: pending.title, sku: pending.sku } }, 'HY3', 1);
  assert.equal(pending.status, 'planning');
  assert.equal(pending.error, '');
  assert.equal(pending.planId, 'plan-1');
});

test('video capacity waiting is shown as an automatic queue, not an unsubmitted task', () => {
  const context = { Date, Number };
  vm.createContext(context);
  vm.runInContext(between('function videoState(', 'function videoHtml('), context);
  const result = context.videoState({ stages: { P4: { status: 'prepared', blockedReason: 'hourly_video_limit', label: '额度已满，已自动排队', nextAttemptAt: '2026-08-03T09:00:00.000Z' } } }, null);
  assert.equal(result.kind, 'queued');
  assert.match(result.label, /自动排队/);
  assert.doesNotMatch(result.label, /等待提交/);
});

test('duplicate run responses are opened without claiming a second task was created', () => {
  const createSource = between('async function createProduction(', 'async function startProduction(');
  assert.match(createSource, /body\.duplicate/);
  assert.match(createSource, /已有任务/);
  assert.match(createSource, /_creationDuplicate/);
});
