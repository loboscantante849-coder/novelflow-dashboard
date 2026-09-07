const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

const ACCOUNT_A = 13751295;
const ACCOUNT_B = 13943450;
const TARGET_A = { accountId: ACCOUNT_A, accountTitle: 'NovelFlow Facebook', appKey: 'novelflow', productLine: 'novelflow', platform: 'facebook' };
const TARGET_B = { accountId: ACCOUNT_B, accountTitle: 'NovelFlow Instagram', appKey: 'novelflow', productLine: 'novelflow', platform: 'instagram' };

function renderCatalog(book, dataQuality, options = {}) {
  const target = options.target || TARGET_A;
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
    catalogSort: options.sort || 'baseReadUnt', catalogDays: 30, catalogUsageFilter: 'all',
    catalogTarget: target,
    catalogFilters: { line: target.appKey, platform: target.platform, accountId: String(target.accountId), length: 'all', genre: 'all', ...(options.filters || {}) },
    selectedBooks: options.selectedBooks || new Set(), runs: options.runs || [], publicationDrafts: options.publicationDrafts || [],
    startingSku: '', startingProductions: new Set(), coverFailures: new Map()
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
    videoGenerationPaused: () => false,
    p0TargetForBook: (candidate = {}, explicitTarget = null) => explicitTarget || candidate.selectionTarget || state.catalogTarget,
    p0DecisionTarget: () => state.catalogTarget,
    startProduction() {}, openCreativePlanDialog() {}, openDetail() {}, loadLeaderboard() {}
  };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function bookIsShort('),
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
    baseReadUnt: 1200, firstReadUntRate: 28, read10wRate: 16, read20wRate: 9, ttProfit: 42, p0Receipt: 'fresh-test-receipt'
  }, 'verified_metrics');
  assert.match(html, /<span class="rank">中台 #1<\/span>/);
  assert.doesNotMatch(html, /data-select-sku="sku-2"[^>]*disabled/);
  assert.doesNotMatch(html, /class="plan-book"[^>]*disabled/);
  assert.doesNotMatch(html, /class="start-book[^>]*"[^>]*disabled/);
});

test('a verified catalog row without a fresh P0 receipt remains visible but cannot start production', () => {
  const html = renderCatalog({
    rank: 2, title: 'Cached verified book', bookSkuId: 'cached-sku', automationReady: true,
    baseReadUnt: 800, firstReadUntRate: 30, read10wRate: 12, read20wRate: 8
  }, 'verified_metrics');
  assert.match(html, /data-select-sku="cached-sku"[^>]*disabled/);
  assert.match(html, /P0 校验收据/);
  assert.match(html, /class="start-book[^>]*"[^>]*disabled/);
});

test('catalog cards derive durable used state from prior runs', () => {
  const nodes = renderCatalog({
    rank: 1, title: 'Already Promoted', bookSkuId: 'used-sku', automationReady: true,
    baseReadUnt: 1200, firstReadUntRate: 28, read10wRate: 16, read20wRate: 9, ttProfit: 42
  }, 'verified_metrics', { returnNodes: true, runs: [{ id: 'run-used', state: 'completed', updatedAt: '2026-08-01T00:00:00.000Z', input: { title: 'Already Promoted', sku: 'used-sku', delivery: { ...TARGET_A, accountTitle: 'NovelFlow' } }, stages: { P6: { status: 'done' } }, artifacts: {} }] });
  const html = nodes.get('#leaderboard').innerHTML;
  assert.match(html, /book-usage-badge used">已用过/);
  assert.match(html, /data-run-id="run-used"/);
  assert.match(html, /data-select-sku="used-sku"[^>]*disabled/);
  assert.match(html, /NovelFlow · Facebook/);
});

test('older SocialEcho drafts mark books as used even when their runs are outside the recent status page', () => {
  const target = { accountId: 15401748, accountTitle: 'AstraNovel', appKey: 'astranovel', productLine: 'astranovel', platform: 'instagram' };
  const nodes = renderCatalog({
    rank: 9, title: 'Older Draft Book', bookSkuId: 'draft-only-sku', automationReady: true,
    baseReadUnt: 700, firstReadUntRate: 30, read10wRate: 15, read20wRate: 8
  }, 'verified_metrics', { target, returnNodes: true, publicationDrafts: [{ id: 'pub-old', runId: 'run-old', status: 'external_draft', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z', book: { title: 'Older Draft Book', sku: 'draft-only-sku' }, accountId: target.accountId, accountTitle: 'AstraNovel', platform: 'instagram' }] });
  const html = nodes.get('#leaderboard').innerHTML;
  assert.match(html, /已做过/);
  assert.match(html, /AstraNovel · Instagram/);
  assert.match(html, /data-run-id="run-old"/);
  assert.match(html, /data-select-sku="draft-only-sku"[^>]*disabled/);
});

test('another account run and draft remain visible as history without blocking this account', () => {
  const book = {
    rank: 3, title: 'Shared Across Routes', bookSkuId: 'shared-route-sku', automationReady: true,
    baseReadUnt: 1800, firstReadUntRate: 34, read10wRate: 19, read20wRate: 12, p0Receipt: 'shared-fresh-receipt'
  };
  const runA = {
    id: 'run-account-a', state: 'completed', createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T01:00:00.000Z',
    input: { title: book.title, sku: book.bookSkuId, delivery: { ...TARGET_A, accountTitle: 'NovelFlow' } },
    stages: { P6: { status: 'done' } }, artifacts: {}
  };
  const draftA = {
    id: 'draft-account-a', runId: runA.id, status: 'external_draft', createdAt: '2026-08-10T01:00:00.000Z', updatedAt: '2026-08-10T02:00:00.000Z',
    book: { title: book.title, sku: book.bookSkuId }, accountId: ACCOUNT_A, accountTitle: 'NovelFlow', platform: 'facebook'
  };

  const nodes = renderCatalog(book, 'verified_metrics', { target: TARGET_B, returnNodes: true, runs: [runA], publicationDrafts: [draftA] });
  const html = nodes.get('#leaderboard').innerHTML;
  assert.match(html, /book-usage-badge unused/);
  assert.doesNotMatch(html, /data-select-sku="shared-route-sku"[^>]*disabled/);
  assert.match(html, /NovelFlow · Facebook/);

  const accountAHtml = renderCatalog(book, 'verified_metrics', { target: TARGET_A, runs: [runA], publicationDrafts: [draftA] });
  assert.match(accountAHtml, /book-usage-badge used/);
  assert.match(accountAHtml, /data-select-sku="shared-route-sku"[^>]*disabled/);
});

test('checkbox selection and usage are keyed by account plus SKU', () => {
  const book = {
    rank: 4, title: 'Selectable On Two Accounts', bookSkuId: 'route-selection-sku', automationReady: true,
    baseReadUnt: 1500, firstReadUntRate: 31, read10wRate: 18, read20wRate: 10, p0Receipt: 'route-fresh-receipt'
  };
  const keyA = `${ACCOUNT_A}:sku:${book.bookSkuId}`;
  const selectedOnA = new Set([keyA]);

  const accountAHtml = renderCatalog(book, 'verified_metrics', { target: TARGET_A, selectedBooks: selectedOnA });
  assert.match(accountAHtml, /book-usage-badge selected/);
  assert.match(accountAHtml, new RegExp(`data-select-key="${keyA}"[^>]*checked`));

  const accountBHtml = renderCatalog(book, 'verified_metrics', { target: TARGET_B, selectedBooks: selectedOnA });
  assert.match(accountBHtml, /book-usage-badge unused/);
  assert.match(accountBHtml, new RegExp(`data-select-key="${ACCOUNT_B}:sku:${book.bookSkuId}"`));
  assert.doesNotMatch(accountBHtml, new RegExp(`data-select-key="${ACCOUNT_B}:sku:${book.bookSkuId}"[^>]*checked`));
  assert.doesNotMatch(accountBHtml, /data-select-sku="route-selection-sku"[^>]*disabled/);
});

test('catalog usage filtering evaluates the explicitly requested account', () => {
  const book = { title: 'Account Scoped Filter', bookSkuId: 'filter-route-sku', isShort: false };
  const state = {
    leaderboard: [book], runs: [], publicationDrafts: [], selectedBooks: new Set([`${ACCOUNT_A}:sku:${book.bookSkuId}`]),
    catalogFilters: { length: 'all', genre: 'all' }, catalogUsageFilter: 'unused', catalogSort: 'baseReadUnt'
  };
  const context = {
    state, String, Number, Date, Array, Set,
    p0TargetForBook: (candidate = {}, explicitTarget = null) => explicitTarget || candidate.selectionTarget || TARGET_A,
    p0DecisionTarget: () => TARGET_A
  };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function bookIsShort('),
    between('function bookIsShort(', 'function normalizeRate(')
  ].join('\n'), context);

  assert.equal(context.bookUsageMeta(book, TARGET_A).status, 'selected');
  assert.equal(context.bookUsageMeta(book, TARGET_B).status, 'unused');
  assert.equal(context.catalogVisibleBooks(TARGET_A).length, 0);
  assert.equal(context.catalogVisibleBooks(TARGET_B).length, 1);
});

test('7/30/90 scoring uses daily momentum so a large old total does not dominate', () => {
  const context = { state: { catalogDays: 30 }, Math, Number };
  vm.createContext(context);
  vm.runInContext(between('function normalizeRate(', 'function metricHasSignal('), context);
  const scored = context.scoreCatalogBooks([
    { title: 'Large but flat', baseReadUnt: 3000, readerBase7d: 700, readerBase30d: 3000, readerBase90d: 9000, trend7v30: 0, trend30v90: 0, firstReadUntRate: 30, read10wRate: 20, read20wRate: 10 },
    { title: 'Smaller but rising', baseReadUnt: 2400, readerBase7d: 980, readerBase30d: 2400, readerBase90d: 4500, trend7v30: .75, trend30v90: .6, firstReadUntRate: 30, read10wRate: 20, read20wRate: 10 }
  ], 30);
  assert.equal(scored[0].title, 'Smaller but rising');
  assert.ok(scored[0].trendScore > scored[1].trendScore);
});

test('recommendation sorting preserves the familiar central reading rank label', () => {
  const html = renderCatalog({
    rank: 17, recommendationRank: 2, recommendationScore: 88.4, recommendationReady: true,
    title: 'Familiar Central Book', bookSkuId: 'central-17', automationReady: true,
    baseReadUnt: 900, firstReadUntRate: 32, read10wRate: 18, read20wRate: 11
  }, 'verified_metrics', { sort: 'recommendationScore' });
  assert.match(html, /中台 #17/);
  assert.doesNotMatch(html, /中台 #2/);
});

test('unchanged status polling does not rebuild ranking or recommendation views', async () => {
  const body = { runs: [], capabilities: { storage: true }, videoLimit: { used: 0, limit: 40, remaining: 40, scope: 'day' }, runLimit: 24 };
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

test('SocialEcho review stays collapsed and uses a first-frame image instead of a video player', () => {
  const publicationSource = between('function renderPublicationWorkbench()', 'async function loadPublicationAccounts(');
  assert.match(publicationSource, /publicationExpanded/);
  assert.match(publicationSource, /previewImageUrl/);
  assert.match(publicationSource, /<img src=/);
  assert.doesNotMatch(publicationSource, /<video/);
  assert.match(publicationSource, /workbenchStatuses/);
  assert.doesNotMatch(publicationSource, /draft\.status !== 'published'/);
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
    between('function normalizeRate(', 'function metricHasSignal('),
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
  const context = { state: { catalogDays: 30 }, Math, Number };
  vm.createContext(context);
  vm.runInContext([between('function normalizeRate(', 'function metricHasSignal('), between('function todayScore(', 'function historyTodayScore(')].join('\n'), context);
  const scored = context.todayScore([
    { title: 'Proven', baseReadUnt: 120, firstReadUntRate: 32, read10wRate: 38, read20wRate: 24, ttProfit: 110 },
    { title: 'One UV', baseReadUnt: 1, firstReadUntRate: 100, read10wRate: 100, read20wRate: 100, ttProfit: 0 },
    { title: 'Zero UV', baseReadUnt: 0, firstReadUntRate: 100, read10wRate: 100, read20wRate: 100, ttProfit: 0 },
    { title: 'Missing retention', baseReadUnt: 200, firstReadUntRate: 42, read10wRate: 0, read20wRate: 0, ttProfit: 40 }
  ]);
  assert.deepEqual(scored.map((book) => book.title), ['Proven']);
});

test('today rail keeps the book route stable for status checks and start clicks', () => {
  const listeners = {};
  const startButton = {
    dataset: { todayStart: '0' },
    addEventListener(type, handler) { listeners[type] = handler; }
  };
  const list = {
    innerHTML: '',
    querySelectorAll(selector) { return selector === '[data-today-start]' ? [startButton] : []; }
  };
  const nodes = new Map([
    ['#todayRailList', list],
    ['#todayRail', { hidden: false }],
    ['#todayRailDescription', { textContent: '' }]
  ]);
  const book = {
    title: 'Today Route Book', bookSkuId: 'today-route-sku', selectionTarget: TARGET_B,
    todayScore: 91, category: 'Romance', baseReadUnt: 900, firstReadUntRate: 30, read20wRate: 12
  };
  const observedTargets = [];
  let startedTarget = null;
  const context = {
    state: { todayBooks: [book], todayBooksLoading: false, todayBooksError: '', todayDataQuality: 'verified_metrics', todayRecommendationDays: 7 },
    $: (selector) => nodes.get(selector) || null,
    Array, Number, String,
    p0DecisionTarget: () => TARGET_A,
    p0TargetForBook: (candidate = {}, explicitTarget = null) => explicitTarget || candidate.selectionTarget || TARGET_A,
    activeRunFor: (candidate, target) => { observedTargets.push(target.accountId); return null; },
    pendingProductionFor: (candidate, target) => { observedTargets.push(target.accountId); return null; },
    bookUsageMeta: (candidate, target) => { observedTargets.push(target.accountId); return { status: 'unused', label: 'Unused', run: null }; },
    escapeHtml: (value) => String(value ?? ''), coverDataAttributes: () => '', leaderboardCover: () => '',
    bookGenre: () => 'other', compactNumber: (value) => String(value), percentage: (value) => `${value}%`,
    videoGenerationPaused: () => true,
    loadTodayRail() {}, openHistoryRanking() {}, openCreativePlanDialog() {}, openDetail() {},
    startProduction: (candidate, target) => { startedTarget = target; }
  };
  vm.createContext(context);
  vm.runInContext(between('function renderTodayRail()', 'async function loadTodayCovers()'), context);

  context.renderTodayRail();
  assert.deepEqual(observedTargets, [ACCOUNT_B, ACCOUNT_B, ACCOUNT_B]);
  listeners.click();
  assert.equal(startedTarget.accountId, ACCOUNT_B);
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
    between('function normalizeRate(', 'function metricHasSignal('),
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
  const context = { state: {}, $: node, setTimeout: (fn) => fn(), p0TargetForBook: () => ({ accountId: 13751295 }), p0SelectionForBook: () => ({ source: 'test' }) };
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

test('pending production identity separates accounts while deduping the same account and SKU', () => {
  const pendingA = { title: 'Queued Book', sku: 'sku-42', delivery: TARGET_A };
  const pendingB = { title: 'Queued Book', sku: 'sku-42', delivery: TARGET_B };
  const state = { pendingProductions: new Map([
    [`${ACCOUNT_A}:sku:sku-42`, pendingA],
    [`${ACCOUNT_B}:sku:sku-42`, pendingB]
  ]) };
  const context = { state, String, Number, p0TargetForBook: (book) => book.selectionTarget };
  vm.createContext(context);
  vm.runInContext(between('function productionIdentity(', 'function bookIsShort('), context);
  const bookA = { title: 'Queued Book', bookSkuId: 'sku-42', selectionTarget: TARGET_A };
  const bookB = { title: 'Queued Book', bookSkuId: 'sku-42', selectionTarget: TARGET_B };
  assert.equal(context.pendingProductionFor(bookA), pendingA);
  assert.equal(context.pendingProductionFor(bookB), pendingB);
  assert.equal(context.routeProductionIdentity(bookA), `${ACCOUNT_A}:sku:sku-42`);
  assert.equal(context.routeProductionIdentity(bookA), context.routeProductionIdentity({ ...bookA }));
  assert.notEqual(context.routeProductionIdentity(bookA), context.routeProductionIdentity(bookB));
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
  assert.match(panelSource, /服务端当前未开放新视频提交/);
  assert.match(panelSource, /40\/日 limiter/);
  assert.match(panelSource, /已有 threadId 只回收结果/);
});

test('one-click status keeps same-SKU work on different accounts separate', () => {
  const panel = { hidden: false, innerHTML: '', querySelectorAll() { return []; } };
  const runA = {
    id: 'active-a', state: 'running', createdAt: '2026-08-18T01:00:00.000Z', updatedAt: '2026-08-18T01:01:00.000Z',
    input: { title: 'Shared Queue Book', sku: 'shared-queue-sku', delivery: TARGET_A, creativeProfile: {} },
    artifacts: {}, autopilot: { enabled: true, nextActionLabel: 'Account A active' }
  };
  const pendingB = {
    key: `${ACCOUNT_B}:sku:shared-queue-sku`, title: 'Shared Queue Book', sku: 'shared-queue-sku', delivery: TARGET_B,
    status: 'submitting', startedAt: Date.parse('2026-08-18T01:02:00.000Z')
  };
  const state = { runs: [runA], pendingProductions: new Map([[pendingB.key, pendingB]]) };
  const context = {
    state, String, Number, Date, Set,
    p0TargetForBook: () => TARGET_A,
    completedHarnessStages: () => 1,
    currentStage: () => ['P2', { label: 'Evidence' }],
    modelLabel: () => 'HY3', stageLabels: { P2: 'Evidence' }, HARNESS_NODE_COUNT: 9,
    escapeHtml: (value) => String(value ?? ''), paidMediaAvailable: () => true,
    $: () => panel
  };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function bookIsShort('),
    between('function pendingProductionLabel(', 'function todayScore(')
  ].join('\n'), context);

  context.renderOneClickStatus();
  assert.equal((panel.innerHTML.match(/<article/g) || []).length, 2);

  const pendingA = { ...pendingB, key: `${ACCOUNT_A}:sku:shared-queue-sku`, delivery: TARGET_A };
  state.pendingProductions = new Map([[pendingA.key, pendingA]]);
  context.renderOneClickStatus();
  assert.equal((panel.innerHTML.match(/<article/g) || []).length, 1);
});

test('blocked and paid-failed runs protect a book from duplicate one-click creation', () => {
  const context = { state: { runs: [] }, String, Array, Number, p0TargetForBook: (book) => book.selectionTarget };
  vm.createContext(context);
  vm.runInContext(between('function productionIdentity(', 'function bookIsShort('), context);
  const book = { title: 'Protected Book', bookSkuId: 'sku-protected', selectionTarget: TARGET_A };
  const blocked = { state: 'blocked', input: { title: book.title, sku: book.bookSkuId, delivery: TARGET_A }, artifacts: {} };
  const paidFailed = { state: 'failed', input: { title: book.title, sku: book.bookSkuId, delivery: TARGET_A }, artifacts: { video: { threadId: 'paid-video-task' }, images: [] } };
  const ordinaryFailed = { state: 'failed', input: { title: book.title, sku: book.bookSkuId, delivery: TARGET_A }, artifacts: { video: null, images: [] } };
  context.state.runs = [blocked];
  assert.equal(context.activeRunFor(book), blocked);
  context.state.runs = [paidFailed];
  assert.equal(context.activeRunFor(book), paidFailed);
  context.state.runs = [ordinaryFailed];
  assert.equal(context.activeRunFor(book), undefined);
});

test('status reconciliation ignores an older completed run for the same book', () => {
  const key = `${ACCOUNT_A}:sku:sku-repeat`;
  const pending = { key, title: 'Repeat Book', sku: 'sku-repeat', delivery: TARGET_A, status: 'submitting', startedAt: Date.parse('2026-08-03T08:00:00.000Z') };
  const state = {
    pendingProductions: new Map([[key, pending]]),
    runs: [{ id: 'old-run', state: 'completed', createdAt: '2026-07-01T00:00:00.000Z', input: { title: pending.title, sku: pending.sku, delivery: TARGET_A }, artifacts: {} }]
  };
  const context = { state, String, Array, Number, Date, p0TargetForBook: () => TARGET_A };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function bookIsShort('),
    between('function reconcilePendingProductions()', 'function renderStatusViews(')
  ].join('\n'), context);
  context.reconcilePendingProductions();
  assert.equal(state.pendingProductions.has(key), true);
});

test('status reconciliation clears pending only for a matching account run', () => {
  const key = `${ACCOUNT_B}:sku:reconcile-sku`;
  const pendingB = {
    key, title: 'Reconcile Across Accounts', sku: 'reconcile-sku', delivery: TARGET_B,
    status: 'submitting', startedAt: Date.parse('2026-08-18T08:00:00.000Z')
  };
  const runA = {
    id: 'run-reconcile-a', state: 'running', createdAt: '2026-08-18T08:00:01.000Z',
    input: { title: pendingB.title, sku: pendingB.sku, delivery: TARGET_A }, artifacts: {}
  };
  const state = { pendingProductions: new Map([[key, pendingB]]), runs: [runA] };
  const context = { state, String, Array, Number, Date, p0TargetForBook: () => TARGET_B };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function bookIsShort('),
    between('function reconcilePendingProductions()', 'function renderStatusViews(')
  ].join('\n'), context);

  context.reconcilePendingProductions();
  assert.equal(state.pendingProductions.has(key), true);

  state.runs.push({
    id: 'run-reconcile-b', state: 'running', createdAt: '2026-08-18T08:00:02.000Z',
    input: { title: pendingB.title, sku: pendingB.sku, delivery: TARGET_B }, artifacts: {}
  });
  context.reconcilePendingProductions();
  assert.equal(state.pendingProductions.has(key), false);
  assert.equal(pendingB.runId, 'run-reconcile-b');
});

test('active-run fingerprint includes the target account', () => {
  const context = { String, Number, runProtectsBook: () => true };
  vm.createContext(context);
  vm.runInContext(between('function activeRunBookFingerprint(', 'function reconcilePendingProductions()'), context);
  const runFor = (delivery) => ({ input: { title: 'Fingerprint Book', sku: 'fingerprint-sku', delivery } });
  const fingerprintA = context.activeRunBookFingerprint([runFor(TARGET_A)]);
  const fingerprintB = context.activeRunBookFingerprint([runFor(TARGET_B)]);
  assert.notEqual(fingerprintA, fingerprintB);
  assert.equal(fingerprintA, context.activeRunBookFingerprint([runFor({ ...TARGET_A })]));
});

test('a recovered planning job updates only the matching account pending state', () => {
  const pendingA = { title: 'Recovered Plan', sku: 'plan-sku', delivery: TARGET_A, status: 'failed', error: 'A timeout' };
  const pendingB = { title: 'Recovered Plan', sku: 'plan-sku', delivery: TARGET_B, status: 'failed', error: 'B timeout' };
  const state = { planJobs: [], pendingProductions: new Map([
    [`${ACCOUNT_A}:sku:plan-sku`, pendingA],
    [`${ACCOUNT_B}:sku:plan-sku`, pendingB]
  ]), planningSession: 1 };
  const context = {
    state, String, Number,
    renderCreativePlanQueue() {}, renderOneClickStatus() {}, icons() {}, dispatchWorkerOnce() {}, showToast() {},
    $: () => ({ close() {} })
  };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function runMatchesBook('),
    between('function queueCreativePlanJob(', 'async function recoverCreativePlanRequest(')
  ].join('\n'), context);
  context.queueCreativePlanJob({ id: 'plan-1', input: { title: pendingB.title, sku: pendingB.sku, delivery: TARGET_B } }, 'HY3', 1);
  assert.equal(pendingA.status, 'failed');
  assert.equal(pendingA.error, 'A timeout');
  assert.equal(pendingA.planId, undefined);
  assert.equal(pendingB.status, 'planning');
  assert.equal(pendingB.error, '');
  assert.equal(pendingB.planId, 'plan-1');
});

test('creative-plan refresh applies a failed job only to its account pending', async () => {
  const pendingA = { title: 'Plan Refresh Book', sku: 'plan-refresh-sku', delivery: TARGET_A, status: 'planning', error: '' };
  const pendingB = { title: 'Plan Refresh Book', sku: 'plan-refresh-sku', delivery: TARGET_B, status: 'planning', error: '' };
  const failedJobB = {
    id: 'plan-failed-b', state: 'failed', input: { title: pendingB.title, sku: pendingB.sku, delivery: TARGET_B },
    stages: { analysis: { status: 'failed', error: 'B model failed' } }, artifacts: {}
  };
  const state = { planJobs: [], pendingProductions: new Map([
    [`${ACCOUNT_A}:sku:plan-refresh-sku`, pendingA],
    [`${ACCOUNT_B}:sku:plan-refresh-sku`, pendingB]
  ]) };
  const context = {
    state, String, Number,
    api: async () => ({ jobs: [failedJobB] }),
    renderCreativePlanQueue() {}, renderOneClickStatus() {}, icons() {}, showToast() {}
  };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function runMatchesBook('),
    between('async function loadCreativePlans(', 'function dispatchesForRun(')
  ].join('\n'), context);

  await context.loadCreativePlans({ silent: true });
  assert.equal(pendingA.status, 'planning');
  assert.equal(pendingA.error, '');
  assert.equal(pendingB.status, 'failed');
  assert.equal(pendingB.error, 'B model failed');
});

test('daily video capacity waiting is shown as an automatic queue, not an unsubmitted task', () => {
  const context = { Date, Number };
  vm.createContext(context);
  vm.runInContext(between('function videoState(', 'function videoHtml('), context);
  const result = context.videoState({ stages: { P4: { status: 'prepared', blockedReason: 'daily_video_limit', label: '额度已满，已自动排队', nextAttemptAt: '2026-08-03T09:00:00.000Z' } } }, null);
  assert.equal(result.kind, 'queued');
  assert.match(result.label, /自动排队/);
  assert.doesNotMatch(result.label, /等待提交/);
});

test('startProduction checks pending and requests against its explicit target', async () => {
  const book = { title: 'Explicit Start Route', bookSkuId: 'explicit-start-sku', selectionTarget: TARGET_A };
  const pendingA = {
    key: `${ACCOUNT_A}:sku:${book.bookSkuId}`, title: book.title, sku: book.bookSkuId,
    delivery: TARGET_A, status: 'submitting', startedAt: Date.now()
  };
  const state = {
    runs: [], publicationDrafts: [], selectedBooks: new Set(),
    pendingProductions: new Map([[pendingA.key, pendingA]]), productionRequests: new Map(), startingProductions: new Set(),
    catalogFilters: { line: 'novelflow', accountId: String(ACCOUNT_A) }, catalogDays: 30
  };
  const created = [];
  const context = {
    state, String, Number, Date, Array, Set,
    p0TargetForBook: (candidate = {}, explicitTarget = null) => explicitTarget || candidate.selectionTarget || TARGET_A,
    p0SelectionForBook: (candidate, target) => ({ target }),
    createProduction: async (input) => { created.push(input); return { id: 'run-b' }; },
    renderOneClickStatus() {}, renderLeaderboard() {}, icons() {}, openDetail() {}, showToast() {}
  };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function bookIsShort('),
    between('async function startProduction(', 'async function startSelectedProductions(')
  ].join('\n'), context);

  await context.startProduction(book, TARGET_B);
  assert.equal(created.length, 1);
  assert.equal(created[0].delivery.accountId, ACCOUNT_B);
  assert.equal(created[0].p0Selection.target.accountId, ACCOUNT_B);
  assert.equal(state.pendingProductions.has(pendingA.key), true);
  assert.equal(state.startingProductions.size, 0);
});

test('batch production resolves route-scoped selection keys against one locked target', async () => {
  const book = { title: 'Batch Route Book', bookSkuId: 'batch-route-sku', selectionTarget: TARGET_A };
  const pendingA = {
    key: `${ACCOUNT_A}:sku:${book.bookSkuId}`, title: book.title, sku: book.bookSkuId,
    delivery: TARGET_A, status: 'submitting', startedAt: Date.now()
  };
  const selectedKeyB = `${ACCOUNT_B}:sku:${book.bookSkuId}`;
  const state = {
    leaderboard: [book], runs: [], publicationDrafts: [], selectedBooks: new Set([selectedKeyB]),
    pendingProductions: new Map([[pendingA.key, pendingA]]), batchStarting: false,
    catalogFilters: { line: 'novelflow', accountId: String(ACCOUNT_B) }, catalogDays: 30
  };
  const created = [];
  const context = {
    state, String, Number, Date, Array, Set,
    p0DecisionTarget: () => TARGET_B,
    p0TargetForBook: (candidate = {}, explicitTarget = null) => explicitTarget || candidate.selectionTarget || TARGET_B,
    p0SelectionForBook: (candidate, target) => ({ target }),
    createProduction: async (input) => { created.push(input); return { id: 'batch-run' }; },
    renderBatchBookBar() {}, renderOneClickStatus() {}, icons() {}, showToast() {}, kickWorker: async () => 1
  };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function bookIsShort('),
    between('async function startSelectedProductions()', "$('#loginForm').addEventListener")
  ].join('\n'), context);

  await context.startSelectedProductions();
  assert.equal(created.length, 1);
  assert.equal(created[0].delivery.accountId, ACCOUNT_B);
  assert.equal(created[0].p0Selection.target.accountId, ACCOUNT_B);
  assert.equal(state.pendingProductions.has(pendingA.key), true);
  assert.equal(state.selectedBooks.size, 0);
});

test('createProduction runs the same SKU in parallel across accounts but dedupes a same-account double click', async () => {
  const submissions = [];
  const state = {
    runs: [], pendingProductions: new Map(), productionRequests: new Map(),
    catalogFilters: { accountId: '' }, selectedId: '', detailOpen: false, detailFingerprint: ''
  };
  const context = {
    state, String, Number, Date,
    p0TargetForBook: () => TARGET_A,
    api: (url, options) => new Promise((resolve) => submissions.push({ url, body: JSON.parse(options.body), resolve })),
    renderOneClickStatus() {}, renderLeaderboard() {}, icons() {}, render() {}, openDetail() {}, showToast() {},
    kickWorker: async () => 0
  };
  vm.createContext(context);
  vm.runInContext([
    between('function productionIdentity(', 'function bookIsShort('),
    between('function upsertRun(', 'async function startProduction(')
  ].join('\n'), context);

  const input = { title: 'Concurrent Book', sku: 'concurrent-sku', source: 'test', kick: false, notify: false };
  const requestA1 = context.createProduction({ ...input, delivery: TARGET_A });
  const requestA2 = context.createProduction({ ...input, delivery: TARGET_A });
  const requestB = context.createProduction({ ...input, delivery: TARGET_B });

  assert.equal(submissions.length, 2);
  assert.deepEqual(new Set(submissions.map((item) => item.body.accountId)), new Set([ACCOUNT_A, ACCOUNT_B]));
  assert.equal(state.productionRequests.size, 2);
  assert.equal(state.pendingProductions.size, 2);

  for (const submission of submissions) {
    submission.resolve({
      duplicate: false,
      run: {
        id: `run-${submission.body.accountId}`, state: 'queued',
        input: { title: input.title, sku: input.sku, delivery: { accountId: submission.body.accountId } }
      }
    });
  }
  const [runA1, runA2, runB] = await Promise.all([requestA1, requestA2, requestB]);
  assert.equal(runA1.id, runA2.id);
  assert.notEqual(runA1.id, runB.id);
  assert.equal(state.productionRequests.size, 0);
  assert.equal(state.pendingProductions.size, 0);
});

test('duplicate run responses are opened without claiming a second task was created', () => {
  const createSource = between('async function createProduction(', 'async function startProduction(');
  assert.match(createSource, /body\.duplicate/);
  assert.match(createSource, /已有任务/);
  assert.match(createSource, /_creationDuplicate/);
});

test('P0 controls and every production request carry a verified account route', () => {
  assert.match(indexSource, /id="catalogApplication"/);
  assert.match(indexSource, /id="catalogPlatform"/);
  assert.match(indexSource, /id="catalogAccount"/);
  assert.match(indexSource, /id="catalogReadBase"/);
  assert.match(indexSource, /id="catalogFirstRead"/);
  assert.match(indexSource, /id="catalogLongRead"/);
  assert.match(indexSource, /id="manualAccount"/);
  const createSource = between('async function createProduction(', 'async function startProduction(');
  assert.match(createSource, /if \(!accountId\) throw new Error/);
  assert.match(createSource, /JSON\.stringify\(\{ title, sku,[\s\S]*accountId, p0Selection \}\)/);
  assert.doesNotMatch(createSource, /applicationId/);
});

test('console exposes the P0-first decision rail and durable P0-P7 harness surface', () => {
  assert.match(indexSource, /data-console-version="harness-p0-p7"/);
  assert.match(indexSource, /id="p0DecisionRail"/);
  assert.match(indexSource, /id="p0DecisionContent"/);
  assert.match(indexSource, /id="harnessStageStrip"/);
  assert.match(source, /function renderP0DecisionRail\(/);
  assert.match(source, /function harnessLedgerHtml\(/);
  assert.match(source, /P7 SocialEcho 草稿/);
});

test('daily campaign console exposes the complete 12 by 3 operator contract', () => {
  assert.match(indexSource, /id="dailyCampaignPanel"/);
  assert.match(indexSource, /日常一键生产 36 套/);
  assert.match(indexSource, /12 个在线账号/);
  assert.match(indexSource, /同账号书籍硬去重/);
  assert.match(indexSource, /全活动优先不重复/);
  assert.match(indexSource, /阅读基数 · 首读 · 长读并集/);
  assert.match(indexSource, /12 种创意形式轮换/);
  assert.match(indexSource, /id="dailyCampaignStageCounts"/);
  assert.match(indexSource, /id="dailyCampaignOutcomeCounts"/);
  assert.match(indexSource, /status:1/);
  assert.match(indexSource, /scheduled_at/);
  assert.match(indexSource, /绝不正式发布/);
  assert.match(indexSource, /不依赖“最近 12\/30\/50 条”/);
});

test('daily campaign uses preview token confirmation and exact campaign reads', () => {
  const requestSource = between('async function previewDailyCampaign()', 'function publicationAccountOptions(');
  assert.match(requestSource, /api\('\/api\/daily-campaign'/);
  assert.match(requestSource, /action: 'preview'/);
  assert.match(requestSource, /action: 'create'/);
  assert.match(requestSource, /confirmationToken: state\.dailyCampaignConfirmationToken/);
  assert.match(requestSource, /confirmPaid: true/);
  assert.match(requestSource, /paidAuthorized: true/);
  assert.match(requestSource, /autoSubmit: true/);
  assert.match(requestSource, /\/api\/daily-campaign\?campaignId=/);
  assert.match(requestSource, /accountIds: DAILY_CAMPAIGN_ACCOUNT_IDS/);
  assert.match(requestSource, /dailyCampaignPhase = definitive \? 'preview' : 'create_ambiguous'/);
  assert.match(requestSource, /error\?\.status === 401/);
  assert.match(requestSource, /timeoutMs: 780000/);
  assert.match(requestSource, /已禁止重发/);
  assert.doesNotMatch(requestSource, /statusLimit|state\.runs/);
});

test('paid media controls follow server capabilities instead of a browser pause constant', () => {
  assert.doesNotMatch(source, /const VIDEO_GENERATION_PAUSED/);
  const context = { state: { capabilities: { video: true, paidMediaAvailable: true, videoGenerationPaused: false } } };
  vm.createContext(context);
  vm.runInContext(between('function paidMediaAvailable()', 'state.publicationDrafts'), context);
  assert.equal(context.paidMediaAvailable(), true);
  assert.equal(context.videoGenerationPaused(), false);
  context.state.capabilities.videoGenerationPaused = true;
  assert.equal(context.paidMediaAvailable(), false);
  assert.equal(context.videoGenerationPaused(), true);
  context.state.capabilities = { video: true, paidMediaAvailable: false, videoGenerationPaused: false };
  assert.equal(context.paidMediaAvailable(), false);
});

test('console renders the server-owned daily points ceiling separately from the video count', () => {
  assert.match(indexSource, /id="pointsCapacity"/);
  assert.match(indexSource, /每日受控积分/);
  assert.match(source, /pointsBudget: null/);
  assert.match(source, /pointsBudget: body\.pointsBudget \|\| null/);
  assert.match(source, /积分 \$\{pointsRemaining\}\/\$\{pointsLimit\}/);
  assert.match(source, /轮询、上传和创建 SocialEcho 草稿不计入/);
});

test('daily campaign gates creation on exactly 36 durable slots and counts only its manifest', () => {
  const accountIds = [13751295, 13943450, 13943940, 13943483, 13944009, 13943482, 13943764, 13943484, 13943914, 13943918, 13943485, 18185914];
  const assignments = accountIds.flatMap((accountId) => [1, 2, 3].map((slot) => ({
    accountId, slot, title: `Book ${accountId}-${slot}`, currentStage: 'P7', status: 'external_draft', draftId: `draft-${accountId}-${slot}`
  })));
  const state = {
    capabilities: { storage: true, pipeline: true, llm: true, video: true, image: false, imageGenerationPaused: true, publishing: true, paidMediaAvailable: true, videoGenerationPaused: false },
    dailyCampaign: { assignments, accounts: accountIds.map((accountId) => ({ accountId, online: true })) }, dailyCampaignPhase: 'preview', dailyCampaignConfirmationToken: 'confirm-once', runs: Array(50).fill({ state: 'failed' })
  };
  const context = {
    state, Date, Number, String, Array, Set,
    TARGET_ROUTE_FALLBACKS: accountIds.map((accountId) => ({ accountId, accountTitle: `Account ${accountId}`, appKey: 'app', platform: 'facebook' }))
  };
  vm.createContext(context);
  vm.runInContext([
    between('const DAILY_CAMPAIGN_ACCOUNT_IDS', 'state.publicationDrafts'),
    between('const DAILY_CAMPAIGN_STAGES', 'function renderDailyCampaign()')
  ].join('\n'), context);
  assert.equal(context.dailyCampaignPreviewReady(), true);
  assert.equal(context.dailyCampaignCapabilitiesReady(), true);
  assert.equal(context.dailyCampaignOutcomeMetrics().draft, 36);
  assert.equal(context.dailyCampaignStageDone('P7'), 36);
  state.dailyCampaign.assignments = assignments.slice(0, 35);
  assert.equal(context.dailyCampaignPreviewReady(), false);
  state.dailyCampaign.assignments = assignments;
  state.dailyCampaign.accounts[0].online = false;
  assert.equal(context.dailyCampaignPreviewReady(), false);
});
