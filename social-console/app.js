const storedRecommendationHistory = (() => { try { return JSON.parse(localStorage.getItem('nf_social:recommendation_history') || '[]'); } catch { return []; } })();
const state = { runs: [], planJobs: [], capabilities: {}, videoLimit: null, pointsBudget: null, leaderboard: [], leaderboardUpdated: '', leaderboardWindow: null, leaderboardMetrics: null, leaderboardPage: 1, leaderboardCoverKey: '', leaderboardLoading: false, leaderboardSource: 'catalog', catalogDays: 30, catalogSort: 'baseReadUnt', catalogUsageFilter: 'all', catalogFilters: { line: 'novelflow', platform: 'facebook', accountId: '13751295', language: 'EN', complete: '已完结', status: '上架', length: 'all', genre: 'all', readBaseMin: '0', firstReadMin: '0', longReadMin: '0' }, catalogTarget: null, catalogTargetOptions: [], historyDecisionFilter: 'all', selectedBooks: new Set(), windowDays: 7, selectedId: '', view: 'operations', overviewFilter: 'all', density: 'comfortable', query: '', statusLimit: 12, statusScope: 'recent', statusCampaignId: '', detailFingerprint: '', detailOpen: false, detailTarget: '', selectedNode: '', kicking: false, kickPromise: null, longKickKey: '', startingProductions: new Set(), planning: false, assistantRunning: false, creativePlan: null, confirmation: null, creativeVariantRunId: '', recommendationCycle: 0, recommendationHistory: Array.isArray(storedRecommendationHistory) ? storedRecommendationHistory.slice(-9) : [], weeklyReport: null, weeklyReportDays: 7, weeklyReportLoading: false, todayRecommendationDays: 0 };
const TARGET_ROUTE_FALLBACKS = [
  [13751295, 'NovelFlow', 'novelflow', 'facebook'], [13943450, 'NovelFlow', 'novelflow', 'instagram'], [13943940, 'NovelFlow', 'novelflow', 'tiktok'],
  [13943483, 'AstraNovel', 'astranovel', 'facebook'], [15401748, 'AstraNovel', 'astranovel', 'instagram'], [13944009, 'astranovel_freenovels', 'astranovel', 'tiktok'],
  [13943482, 'MaxNovel', 'maxnovel', 'facebook'], [15590770, 'MaxNovel', 'maxnovel', 'instagram'], [13943764, 'maxnovel.app', 'maxnovel', 'tiktok'],
  [13943484, 'Storyca', 'storyca', 'facebook'], [13943914, 'Storyca', 'storyca', 'instagram'], [13943918, 'storyca.app', 'storyca', 'tiktok'],
  [13943485, 'Novelvio', 'novelvio', 'facebook'], [18185914, 'novelvio', 'novelvio', 'tiktok']
].map(([accountId, accountTitle, appKey, platform]) => ({ accountId, accountTitle, appKey, productLine: appKey, platform }));
const DAILY_CAMPAIGN_ACCOUNT_IDS = Object.freeze([
  13751295, 13943450, 13943940,
  13943483, 13944009,
  13943482, 13943764,
  13943484, 13943914, 13943918,
  13943485, 18185914
]);
function paidMediaAvailable() {
  const capabilities = state.capabilities || {};
  if (typeof capabilities.paidMediaAvailable === 'boolean') {
    return capabilities.paidMediaAvailable && capabilities.videoGenerationPaused !== true;
  }
  if (typeof capabilities.videoGenerationPaused === 'boolean') return capabilities.videoGenerationPaused === false;
  return capabilities.video === true;
}
function videoGenerationPaused() { return !paidMediaAvailable(); }
state.publicationDrafts = [];
state.publicationAccounts = [];
state.publicationLoading = false;
state.publicationAccountLoading = false;
state.publicationBusy = new Set();
state.publicationSaveTimers = new Map();
state.publicationExpanded = false;
state.adCampaigns = [];
state.adCampaign = null;
state.adCampaignId = 'whatsapp-ads-20260806';
state.adCampaignLoading = false;
state.adPerformance = null;
state.adPerformanceLoading = false;
state.adPerformanceError = '';
state.adPerformanceEditingId = '';
// These browser-only maps make the first click feel immediate while the
// durable run remains the source of truth. They are intentionally not
// persisted: a refresh reconciles them from /api/status.
state.pendingProductions = new Map();
state.productionRequests = new Map();
state.batchStarting = false;
state.batchProgress = null;
state.dailyCampaign = null;
state.dailyCampaignId = (() => { try { return localStorage.getItem('nf_social:daily_campaign_id') || ''; } catch { return ''; } })();
state.dailyCampaignPhase = state.dailyCampaignId ? 'created' : 'idle';
state.dailyCampaignLoading = false;
state.dailyCampaignAction = '';
state.dailyCampaignError = '';
state.dailyCampaignConfirmationToken = '';
// v2 invalidates browser snapshots created before product-line ownership was
// verified by exact application/SKU semantics.
const DASHBOARD_CACHE_KEY = 'nf_social:dashboard_snapshot:v2';
const DASHBOARD_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
let dashboardSnapshotHandle = null;

function leaderboardQueryKey(source = state.leaderboardSource) {
  if (source !== 'catalog') return `history:${state.windowDays}`;
  const filters = state.catalogFilters;
  return ['catalog', state.catalogDays, state.catalogSort, filters.line, filters.platform, filters.accountId, filters.language, filters.complete, filters.status, filters.length, filters.genre, filters.readBaseMin, filters.firstReadMin, filters.longReadMin].join(':');
}

function compactRunSnapshot(run) {
  const artifacts = run.artifacts || {};
  return {
    id: run.id,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    _summary: true,
    input: {
      title: run.input?.title || '',
      sku: run.input?.sku || '',
      creativeProfile: run.input?.creativeProfile || null,
      delivery: run.input?.delivery || null
    },
    stages: run.stages || {},
    artifacts: {
      book: artifacts.book ? { title: artifacts.book.title, bookSkuId: artifacts.book.bookSkuId, cover: artifacts.book.cover } : null,
      code: artifacts.code || '',
      shortUrl: artifacts.shortUrl || '',
      posts: Array.isArray(artifacts.posts) ? artifacts.posts.map(() => ({ content: 'cached' })) : [],
      images: Array.isArray(artifacts.images) ? artifacts.images.map(({ status, url, variant }) => ({ status, url, variant })) : [],
      video: artifacts.video ? {
        status: artifacts.video.status,
        videoUrls: artifacts.video.videoUrls || [],
        coverImageUrl: artifacts.video.coverImageUrl || '',
        videoModel: artifacts.video.videoModel || '',
        isUserAdCopy: artifacts.video.isUserAdCopy === true ? true : artifacts.video.isUserAdCopy === false ? false : null,
        error: artifacts.video.error || ''
      } : null,
      referenceVideo: artifacts.referenceVideo ? { status: artifacts.referenceVideo.status, videoUrls: artifacts.referenceVideo.videoUrls || [] } : null,
      videoRevision: artifacts.videoRevision ? { status: artifacts.videoRevision.status, videoUrls: artifacts.videoRevision.videoUrls || [] } : null,
      analytics: artifacts.analytics ? { summary: artifacts.analytics.summary || {} } : null,
      usage: artifacts.usage || {},
      modelActivity: Array.isArray(artifacts.modelActivity) ? artifacts.modelActivity.slice(-12) : []
    }
  };
}

function compactBookSnapshot(book) {
  return {
    // Covers are intentionally not persisted. Restoring fifty remote image
    // URLs can delay the first useful API responses on a cold browser load.
    rank: book.rank, recommendationRank: book.recommendationRank, recommendationScore: book.recommendationScore,
    scaleScore: book.scaleScore, qualityScore: book.qualityScore, trendScore: book.trendScore,
    readerBase7d: book.readerBase7d, readerBase30d: book.readerBase30d, readerBase90d: book.readerBase90d,
    readerDaily7d: book.readerDaily7d, readerDaily30d: book.readerDaily30d, readerDaily90d: book.readerDaily90d,
    trend7v30: book.trend7v30, trend30v90: book.trend30v90, comparisonQuality: book.comparisonQuality,
    title: book.title, bookSkuId: book.bookSkuId,
    p0Receipt: String(book.p0Receipt || ''),
    selectionTarget: book.selectionTarget ? {
      accountId: Number(book.selectionTarget.accountId || 0), accountTitle: String(book.selectionTarget.accountTitle || ''),
      appKey: String(book.selectionTarget.appKey || ''), appName: String(book.selectionTarget.appName || ''),
      productLine: String(book.selectionTarget.productLine || ''), platform: String(book.selectionTarget.platform || ''),
      publishType: String(book.selectionTarget.publishType || ''), applicationId: String(book.selectionTarget.applicationId || '')
    } : null,
    category: book.category || '', tags: Array.isArray(book.tags) ? book.tags.slice(0, 8) : [],
    description: String(book.description || '').slice(0, 240), productLine: book.productLine || '',
    isShort: book.isShort, automationReady: book.automationReady,
    baseReadUnt: book.baseReadUnt, firstReadUntRate: book.firstReadUntRate,
    read10wRate: book.read10wRate, read20wRate: book.read20wRate, ttProfit: book.ttProfit,
    pullUv: book.pullUv, firstReadRate: book.firstReadRate, retentionRate: book.retentionRate,
    retentionWindow: book.retentionWindow, assetCount: book.assetCount, score: book.score,
    confidence: book.confidence, todayScore: book.todayScore
  };
}

function persistDashboardSnapshot() {
  dashboardSnapshotHandle = null;
  try {
    localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      runs: state.runs.map(compactRunSnapshot),
      capabilities: state.capabilities,
      videoLimit: state.videoLimit,
      pointsBudget: state.pointsBudget,
      leaderboard: state.leaderboard.map(compactBookSnapshot),
      leaderboardUpdated: state.leaderboardUpdated,
      leaderboardWarning: state.leaderboardWarning,
      leaderboardDataQuality: state.leaderboardDataQuality,
      leaderboardCredentialStatus: state.leaderboardCredentialStatus,
      leaderboardWindow: state.leaderboardWindow,
      leaderboardMetrics: state.leaderboardMetrics,
      leaderboardQueryKey: state.leaderboardDataKey || leaderboardQueryKey(),
      todayBooks: state.todayBooks.map(compactBookSnapshot),
      todayDataQuality: state.todayDataQuality,
      todayRecommendationDays: state.todayRecommendationDays
    }));
  } catch {}
}

function saveDashboardSnapshot() {
  if (dashboardSnapshotHandle != null) return;
  if ('requestIdleCallback' in window) dashboardSnapshotHandle = window.requestIdleCallback(persistDashboardSnapshot, { timeout: 1500 });
  else dashboardSnapshotHandle = window.setTimeout(persistDashboardSnapshot, 250);
}

function restoreDashboardSnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(DASHBOARD_CACHE_KEY) || 'null');
    if (!snapshot || Date.now() - Number(snapshot.savedAt || 0) > DASHBOARD_CACHE_MAX_AGE) return false;
    state.runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
    state.capabilities = snapshot.capabilities || {};
    state.videoLimit = snapshot.videoLimit || null;
    state.pointsBudget = snapshot.pointsBudget || null;
    const cachedLeaderboardMatches = snapshot.leaderboardQueryKey === leaderboardQueryKey();
    const trustedLeaderboard = ['verified_metrics', 'stale_verified_metrics'].includes(String(snapshot.leaderboardDataQuality || ''));
    state.leaderboard = cachedLeaderboardMatches && trustedLeaderboard && Array.isArray(snapshot.leaderboard)
      ? snapshot.leaderboard.map(({ cover, ...book }) => book) : [];
    state.leaderboardUpdated = snapshot.leaderboardUpdated || '';
    state.leaderboardWarning = snapshot.leaderboardWarning || '';
    state.leaderboardDataQuality = state.leaderboard.length ? snapshot.leaderboardDataQuality : '';
    state.leaderboardCredentialStatus = snapshot.leaderboardCredentialStatus || '';
    state.leaderboardWindow = snapshot.leaderboardWindow || null;
    state.leaderboardMetrics = snapshot.leaderboardMetrics || null;
    state.leaderboardDataKey = state.leaderboard.length ? snapshot.leaderboardQueryKey : '';
    const cachedTodayBooks = Array.isArray(snapshot.todayBooks) ? snapshot.todayBooks.map(({ cover, ...book }) => book) : [];
    const trustedToday = ['verified_metrics', 'stale_verified_metrics', 'history_verified'].includes(String(snapshot.todayDataQuality || ''));
    const cachedRecommendationDays = Number(snapshot.todayRecommendationDays || 0);
    const cachedMinUv = cachedRecommendationDays === 30 ? 80 : 20;
    const filteredToday = snapshot.todayDataQuality === 'history_verified' ? cachedTodayBooks : todayScore(cachedTodayBooks, cachedMinUv);
    state.todayBooks = trustedToday && filteredToday.length >= 6 ? filteredToday : [];
    state.todayDataQuality = state.todayBooks.length ? snapshot.todayDataQuality : '';
    state.todayRecommendationDays = state.todayBooks.length ? (cachedRecommendationDays || 7) : 0;
    state.selectedId = state.runs[0]?.id || '';
    return state.runs.length > 0 || state.leaderboard.length > 0 || state.todayBooks.length > 0;
  } catch { return false; }
}
state.detailHydrating = '';
state.detailError = '';
state.detailHydrationJobs = new Set();
state.detailHydrationAttempts = new Set();
// Completed legacy runs may predate the lean asset snapshot. Warm those
// records quietly after the dashboard becomes usable, so opening a finished
// task does not make the operator wait on its first visit.
state.readyAssetCache = new Map();
state.readyAssetRequests = new Map();
// Browser polling can run while a long provider request is still in flight.
// Keep a per-run/section dispatch lease so the same paid or model task is not
// submitted again merely because the dashboard refreshed.
state.workerDispatches = new Map();
state.workerDispatchNotice = new Map();
const WORKER_DISPATCH_COOLDOWN_MS = 4000;
const WORKER_DISPATCH_STALE_MS = 12 * 60 * 1000;
state.leaderboardWarning = '';
state.leaderboardDataQuality = '';
state.leaderboardCredentialStatus = '';
state.leaderboardError = '';
state.todayBooks = [];
state.todayBooksLoading = false;
state.todayBooksError = '';
const TODAY_RECOMMENDATION_WINDOWS = [
  { days: 7, minUv: 0, minBooks: 1 },
  { days: 30, minUv: 0, minBooks: 1 }
];
state.todayDataQuality = '';
state.statusRequest = null;
state.statusLoading = false;
state.statusFingerprint = '';
state.leaderboardRequest = null;
state.leaderboardRequestId = 0;
state.leaderboardController = null;
state.leaderboardDataKey = '';
state.todayRailRequest = null;
state.coverInFlight = new Set();
state.coverFailures = new Map();
state.coverRetryTimer = null;
state.copilotMessages = (() => { try { return JSON.parse(localStorage.getItem('nf_social:copilot_messages') || '[]').slice(-14); } catch { return []; } })();
state.copilotBusy = false;
state.referencePosterChoice = {};
state.videoControlDrafts = new Map();
state.videoControlSaved = new Map();
state.videoControlAssets = new Map();
state.videoControlPreviews = new Map();
state.videoControlLoading = new Set();
state.videoControlLoaded = new Set();
state.videoControlRequests = new Map();
state.videoControlErrors = new Map();
state.videoControlSaving = new Set();
state.videoControlPreviewing = new Set();
state.characterAssetGenerating = new Set();
state.todayRailPaused = false;
state.analyticsRefresh = new Map();
const VIDEO_CONTROL_TEMPLATES = [
  { value: 'Ad_Plot_Seedance', label: 'Seedance 生产', maxReferences: 1, previewOnly: false },
  { value: 'Ad_Plot_Video_V4', label: 'V4 多参考实验（仅预览）', maxReferences: 9, previewOnly: true }
];
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
function taskIdForUi(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').slice(-12)).filter(Boolean).join(', ');
  return String(value || '').slice(-18);
}
function coverSrc(value) {
  const url = String(value || '').trim();
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'oss.novelago.app' && !parsed.searchParams.has('x-oss-process')) return `${url}${parsed.search ? '&' : '?'}x-oss-process=image/resize,w_320/quality,q_78/format,webp`;
  } catch {}
  return url;
}
function coverOriginalSrc(value) {
  const url = String(value || '').trim();
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('x-oss-process');
    return parsed.toString();
  } catch { return url; }
}
function handleCoverImageError(image) {
  const original = image.dataset.originalCover;
  if (original && image.dataset.originalTried !== '1' && image.src !== original) {
    image.dataset.originalTried = '1';
    image.src = original;
    return;
  }
  image.hidden = true;
  image.classList.remove('is-loaded');
}
function handleCoverImageLoad(image) {
  image.hidden = false;
  image.classList.add('is-loaded');
}
const labels = { queued: '排队中', running: '生产中', completed: '已完成', failed: '失败', blocked: '已暂停', partial: '部分完成', ambiguous: '需人工核验' };
const stageLabels = { P0: '选书锁定', P1: '书籍核验', P2: '证据', P3: '创意', P3_5: '海报', P4: '视频', P5: 'Code', P6: '审核包', P7: '草稿审核' };
const stageIcons = { P0: 'list-checks', P1: 'book-open-check', P2: 'library', P3: 'message-square-text', P3_5: 'images', P4: 'video', P5: 'link-2', P6: 'badge-check', P7: 'send-horizontal' };
// The operator-facing harness uses the conceptual P0→P7 order. Attribution
// (P5) may still execute early on the server, but it no longer makes the UI
// appear to jump backwards from creative work to Code allocation.
const pipelineOrder = ['P0', 'P1', 'P2', 'P3', 'P3_5', 'P4', 'P5', 'P6', 'P7'];
const HARNESS_NODE_COUNT = pipelineOrder.length;
const catalogSortLabels = { recommendationScore: '综合推荐分', baseReadUnt: '中台阅读排行', firstReadUntRate: '首读率', read20wRate: '长读留存', trend7v30: '近期趋势' };

let iconFrame = 0;
function icons() {
  if (!window.lucide || iconFrame) return;
  iconFrame = requestAnimationFrame(() => {
    iconFrame = 0;
    window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  });
}

const creativeProfileOptions = {
  copyStyle: { label: '文案', values: { system_best: '系统推荐：从原文选择最有张力的冲突', revenge_comeback: '复仇反杀：只在原文支持时突出夺回主动权', forbidden_tension: '禁忌拉扯：只在原文支持时突出欲望与边界', dark_redemption: '暗黑救赎：只在原文支持时突出危险与重获掌控' } },
  ctaStyle: { label: 'CTA', values: { story_cliffhanger: '系统推荐：用具体未解的情节问题收尾', identity_reveal: '身份反转：以已铺垫的秘密或认出为钩子', romantic_tension: '暧昧拉扯：以有证据的欲望、目光或边界收尾', revenge_payoff: '反击爽点：以有证据的清算或反转承诺收尾' } },
  videoStyle: { label: '视频剧情', values: { five_beat: '系统推荐：钩子、价值、升级、反转、悬念五拍', reversal: '强反转：把真实反转放在 8-11 秒', slow_burn: '慢热张力：用克制靠近和最终选择递进', revenge: '复仇兑现：只使用原文已有的反击或翻盘' } },
  posterStyle: { label: '海报', values: { system_best: '系统推荐：一张电影感，一张时尚情绪感', luminous_cinema: '电影氛围：强调高戏剧性的关键瞬间', editorial_romance: '时尚爱情：强调克制、情绪与留白' } },
  modelChoice: { label: '生产模型', values: { 'deepseek-v4-flash': 'DeepSeek V4 Flash：Token' } }
};

const modelLabels = { 'glm-5.3-flash': 'GLM 5.3 Flash', 'deepseek-v4-flash-preview': 'DeepSeek V4 Flash Preview', 'ling-3.0-flash': 'Ling 3.0 Flash', deepseek: 'DeepSeek V4 Flash Preview', 'deepseek-chat': 'DeepSeek', 'deepseek-v4-pro': 'DeepSeek V4 Pro', 'seed-2.1-turbo': 'Seed 2.1 Turbo', 'doubao-seed-2-1-turbo-260628': 'Seed 2.1 Turbo', 'qwen3.7-max': 'Qwen 3.7 Max', 'minimax-m2.7': 'MiniMax M2.7', hy3: 'HY3', 'kimi-k2.7-code': 'Kimi K2.7 Code', 'qwen3.5-flash': 'Qwen 3.5 Flash', 'glm-4.5-air': 'GLM 4.5 Air', 'kimi-k2.5': 'Kimi K2.5', 'minimax-m2.5': 'MiniMax M2.5', 'metrics-fallback': '中台指标兜底', 'glm-5.2': 'GLM 5.2', 'kimi-k3': 'Kimi K3', 'minimax-m3': 'MiniMax M3' };
function modelLabel(value) { return modelLabels[String(value || '').toLowerCase()] || String(value || 'AI'); }
function modelBrand(value) {
  const key = String(value || '').toLowerCase();
  if (key.includes('ling')) return { key: 'ling', mark: 'L', color: '16a085' };
  if (key.includes('deepseek')) return { key: 'deepseek', mark: 'DS', icon: 'deepseek', color: '1677ff' };
  if (key.includes('seed') || key.includes('doubao')) return { key: 'seed', mark: 'S', icon: 'bytedance', color: '1e88e5' };
  if (key.includes('qwen')) return { key: 'qwen', mark: 'Q', icon: 'qwen', color: '111827' };
  if (key.includes('minimax')) return { key: 'minimax', mark: 'M', icon: 'minimax', color: '5b48e8' };
  if (key.includes('kimi')) return { key: 'kimi', mark: 'K', icon: 'kimi', color: 'ed6a36' };
  if (key.includes('glm')) return { key: 'glm', mark: 'GLM' };
  if (key.includes('hy3')) return { key: 'hy3', mark: 'HY' };
  if (key.includes('metric')) return { key: 'metrics', mark: 'DATA' };
  return { key: 'generic', mark: 'AI' };
}
function modelLogoHtml(value, { compact = false, label = true } = {}) {
  const brand = modelBrand(value);
  const name = modelLabel(value);
  const icon = brand.icon ? `<img src="https://cdn.simpleicons.org/${brand.icon}/${brand.color}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false">` : '';
  return `<span class="model-logo model-logo-${brand.key}${compact ? ' compact' : ''}" title="实际模型：${escapeHtml(name)}">${icon}<b${brand.icon ? ' hidden' : ''}>${brand.mark}</b>${label ? `<em>${escapeHtml(name)}</em>` : ''}</span>`;
}
function renderModelBadges() {
  document.querySelectorAll('[data-model-select]').forEach((badge) => {
    const select = $(`#${badge.dataset.modelSelect}`);
    if (select) badge.innerHTML = modelLogoHtml(select.value, { compact: true, label: false });
  });
}
const longBackgroundModels = new Set(['glm-5.3-flash', 'deepseek-v4-flash-preview', 'ling-3.0-flash', 'deepseek', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'kimi-k2.7-code']);
const usesLongBackground = (choice) => longBackgroundModels.has(String(choice || '').toLowerCase());
function workerDispatchBusy(key, cooldownMs = WORKER_DISPATCH_COOLDOWN_MS) {
  const previous = state.workerDispatches.get(key);
  if (!previous) return false;
  const now = Date.now();
  if (!previous.finishedAt) return now - previous.startedAt < WORKER_DISPATCH_STALE_MS;
  return now - previous.finishedAt < cooldownMs;
}

function dispatchWorkerOnce(key, payload, { wait = false, timeoutMs = 55000, cooldownMs = WORKER_DISPATCH_COOLDOWN_MS } = {}) {
  if (workerDispatchBusy(key, cooldownMs)) return wait ? Promise.resolve(null) : false;
  const entry = { startedAt: Date.now(), payload };
  state.workerDispatches.set(key, entry);
  state.workerDispatchNotice.set(key, { status: 'dispatched', at: entry.startedAt });
  const request = wait
    ? api('/api/worker', { method: 'POST', body: JSON.stringify(payload), timeoutMs })
    : fetch('/api/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload) });
  const settled = request.then((result) => {
    entry.finishedAt = Date.now();
    entry.ok = true;
    state.workerDispatchNotice.set(key, { status: 'accepted', at: entry.finishedAt });
    return result;
  }, (error) => {
    entry.finishedAt = Date.now();
    entry.ok = false;
    entry.error = String(error?.message || error || 'Worker request failed');
    state.workerDispatchNotice.set(key, { status: 'retrying', at: entry.finishedAt, error: entry.error });
    if (wait) throw error;
    return null;
  });
  // Fire-and-forget calls still own their lease until fetch settles. Once it
  // settles the lease is released immediately, leaving only a short debounce.
  if (!wait) { settled.catch(() => null); return true; }
  return settled;
}
function selectedModelWaitMs(choice) {
  // The panel renders a local result immediately, so there is no reason to
  // abort a user-selected quality model at the old 32–45 second UI timer.
  return usesLongBackground(choice) ? 210000 : 70000;
}

function creativeProfileForForm() {
  return { copyStyle: $('#creativeStyle').value, ctaStyle: $('#ctaStyle').value, videoStyle: $('#videoStyle').value, posterStyle: $('#posterStyle').value, modelChoice: 'deepseek-v4-flash' };
}

function creativeProfileHtml(profile, preview = false) {
  const entries = Object.entries(creativeProfileOptions).map(([key, definition]) => {
    const value = profile?.[key] || Object.keys(definition.values)[0];
    const tag = preview ? 'article' : 'div';
    return `<${tag}><span>${escapeHtml(definition.label)}</span><strong>${escapeHtml(definition.values[value] || definition.values[Object.keys(definition.values)[0]])}</strong></${tag}>`;
  }).join('');
  return preview ? `<header><i data-lucide="sparkles"></i>本次创意策略预览</header>${entries}` : entries;
}

function productionModelRouteHtml(run) {
  const planning = run.input?.planning;
  const taskRoute = run.artifacts?.modelRoute || {};
  const production = taskRoute.activeModel || run.input?.creativeProfile?.modelChoice || planning?.actualModel || 'hy3';
  const taskPreferred = taskRoute.preferredModel || production;
  const taskSwitch = taskRoute.fallbackUsed && modelLabel(taskPreferred) !== modelLabel(production);
  if (!planning?.actualModel) {
    return `<div class="production-model-route"><i data-lucide="route"></i><div><span>本任务模型路线</span><strong><b>全程创意</b>${taskSwitch ? `${modelLogoHtml(taskPreferred, { compact: true })}<i data-lucide="arrow-right"></i>` : ''}${modelLogoHtml(production, { compact: true })}</strong><small>${taskSwitch ? '首选不可用后已整体切换一次；后续文案、视频、海报和质检保持同一模型。' : '文案、视频、海报和质检使用同一模型；不会按节点混用。'}</small></div></div>`;
  }
  const preferred = planning.preferredModel || planning.actualModel;
  const actual = planning.actualModel;
  const strategy = planning.fallbackUsed && modelLabel(preferred) !== modelLabel(actual)
    ? `${modelLogoHtml(preferred, { compact: true })}<i data-lucide="arrow-right"></i>${modelLogoHtml(actual, { compact: true })}`
    : modelLogoHtml(actual, { compact: true });
  return `<div class="production-model-route"><i data-lucide="route"></i><div><span>模型分工</span><strong><b>策划</b>${strategy}<b>生产</b>${taskSwitch ? `${modelLogoHtml(taskPreferred, { compact: true })}<i data-lucide="arrow-right"></i>` : ''}${modelLogoHtml(production, { compact: true })}</strong><small>${taskSwitch ? '生产任务已整体切换一次备用模型，后续创意节点保持同一模型。' : '生产的文案、视频、海报和质检保持同一模型。'}</small></div></div>`;
}

function renderCreativeProfilePreview() {
  const preview = $('#creativeProfilePreview');
  if (!preview) return;
  preview.innerHTML = creativeProfileHtml(creativeProfileForForm(), true);
  icons();
}

function profileSelect(key, value) {
  const definition = creativeProfileOptions[key];
  const id = `plan${key[0].toUpperCase()}${key.slice(1)}`;
  const badge = key === 'modelChoice' ? `<span class="selected-model-badge" data-model-select="${id}"></span>` : '';
  return `<label class="${key === 'modelChoice' ? 'model-select-label' : ''}">${escapeHtml(definition.label)}<span class="model-select-control"><select id="${id}">${Object.entries(definition.values).map(([option, label]) => `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(label.split('：')[0])}</option>`).join('')}</select>${badge}</span></label>`;
}

function creativePlanProfile() {
  return Object.fromEntries(Object.keys(creativeProfileOptions).map((key) => [key, $(`#plan${key[0].toUpperCase()}${key.slice(1)}`).value]));
}

function planResultHtml(result) {
  const plan = result.plan || {};
  const profile = plan.recommendedProfile || {};
  const rationale = plan.rationale || {};
  const copy = plan.copyBlueprint || {};
  const video = plan.videoBlueprint || {};
  const poster = plan.posterBlueprint || {};
  const evidence = Array.isArray(plan.evidence) ? plan.evidence.slice(0, 4) : [];
  const actualModel = result.usage?.model || result.modelChoice || 'hy3';
  const preferredModel = result.preferredModelChoice || actualModel;
  const routeText = result.fallbackUsed && modelLabel(preferredModel) !== modelLabel(actualModel) ? `${modelLabel(preferredModel)} 未及时返回，${modelLabel(actualModel)} 完成策划` : `${modelLabel(actualModel)} 完成策划`;
  const footer = result.autoStartProduction
    ? (result.productionRunId
      ? `<footer><button id="openAutoProduction" class="primary-command" type="button"><i data-lucide="activity"></i><span>查看自动生产进度</span></button><button id="replanCreativePlan" class="secondary-command" type="button"><i data-lucide="refresh-cw"></i><span>重新分析</span></button></footer>`
      : `<footer><span class="language-tag">生产任务正在由后台自动安排</span><button id="replanCreativePlan" class="secondary-command" type="button"><i data-lucide="refresh-cw"></i><span>重新分析</span></button></footer>`)
    : `<footer><button id="confirmCreativePlan" class="primary-command" type="button"><i data-lucide="zap"></i><span>采用方案并开始生产</span></button><button id="replanCreativePlan" class="secondary-command" type="button"><i data-lucide="refresh-cw"></i><span>重新分析</span></button></footer>`;
  return `<header><div><span class="dialog-kicker">RECOMMENDED DIRECTION</span><h3>${escapeHtml(result.book.title)}</h3><p>已分析全书 ${escapeHtml(result.evidenceScope.chapterCount)} 章结构，使用第 ${escapeHtml((result.evidenceScope.sampledChapters || []).join(' / '))} 章作为关键证据样本。</p></div><span class="plan-model">${modelLogoHtml(actualModel, { compact: true })}</span></header><div class="plan-model-route"><i data-lucide="route"></i><div><strong>策划路由</strong><span>${escapeHtml(routeText)}；本次实际完成模型：${modelLogoHtml(actualModel, { compact: true })}</span></div></div>
    <div class="plan-thesis"><strong>核心推广判断</strong><p>${escapeHtml(plan.editorialThesis)}</p></div>
    <div class="plan-profile">${Object.keys(creativeProfileOptions).map((key) => profileSelect(key, profile[key] || Object.keys(creativeProfileOptions[key].values)[0])).join('')}</div>
    <div class="plan-rationale">${Object.entries(creativeProfileOptions).map(([key, definition]) => `<article><span>${escapeHtml(definition.label)}</span><strong>${escapeHtml(rationale[key] || '以章节证据为准')}</strong></article>`).join('')}</div>
    <div class="plan-blueprints"><article><span>文案蓝图</span><strong>${escapeHtml(copy.hook || '')}</strong><p>${escapeHtml(copy.emotionalArc || copy.zhSummary || '')}</p><small>CTA：${escapeHtml(copy.cta || '')}</small></article><article><span>视频剧情</span><strong>${escapeHtml(video.opening || video.arc || '')}</strong><p>${escapeHtml(video.reversal || video.zhSummary || '')}</p><small>悬念：${escapeHtml(video.cliffhanger || '')}</small></article><article><span>海报方向</span><strong>${escapeHtml(poster.moment || '')}</strong><p>${escapeHtml(poster.mood || poster.zhSummary || '')}</p></article></div>
    ${evidence.length ? `<div class="plan-evidence">${evidence.map((item) => `<article><span>Ch.${escapeHtml(item.chapter)}</span><strong>“${escapeHtml(item.quote)}”</strong><p>${escapeHtml(item.why || '')}</p></article>`).join('')}</div>` : ''}
    ${footer}`;
}

function planJobResult(job) {
  const delivery = job.input?.delivery || null;
  const book = job.artifacts?.book || { title: job.input?.title || '', sku: job.input?.sku || '' };
  return { id: job.id, book: delivery ? { ...book, selectionTarget: delivery } : book, delivery, p0Selection: job.input?.p0Selection || null, plan: job.artifacts?.plan || {}, evidenceScope: job.artifacts?.evidenceScope || { chapterCount: 0, sampledChapters: [] }, usage: job.artifacts?.usage || {}, modelChoice: job.input?.modelChoice || 'hy3', preferredModelChoice: job.input?.preferredModelChoice || job.input?.modelChoice || 'hy3', fallbackUsed: Boolean(job.input?.fallbackUsed), modelHistory: job.input?.modelHistory || [], autoStartProduction: job.input?.autoStartProduction === true, productionRunId: job.input?.productionRunId || '' };
}

function visibleCreativePlanJobs(planJobs = state.planJobs, runs = state.runs) {
  // Auto-planned books move directly into production. The queue is only for
  // background work, exceptional failures, or explicitly manual planning.
  const adoptedPlanIds = new Set((runs || []).map((run) => String(run.input?.planning?.planId || '')).filter(Boolean));
  return (planJobs || []).filter((job) => ['queued', 'running', 'completed', 'failed'].includes(job.state)
    && !adoptedPlanIds.has(String(job.id))
    && !(job.state === 'completed' && job.input?.autoStartProduction === true)).slice(0, 5);
}

function renderCreativePlanQueue() {
  const queue = $('#creativePlanQueue');
  const launcher = $('#creativePlanQueueButton');
  const count = $('#creativePlanQueueCount');
  const list = $('#planQueueList');
  const jobs = visibleCreativePlanJobs();
  if (queue) queue.hidden = true;
  if (launcher) launcher.hidden = !jobs.length;
  if (count) count.textContent = String(jobs.length);
  const jobHtml = jobs.map((job) => {
    const stage = Object.values(job.stages || {}).find((item) => item.status === 'running') || Object.values(job.stages || {}).find((item) => item.status === 'waiting') || job.stages?.analysis || {};
    const icon = job.state === 'completed' ? 'circle-check-big' : job.state === 'failed' ? 'circle-alert' : 'loader-circle';
    const automatic = job.input?.autoStartProduction === true;
    const status = job.state === 'completed' ? '策划完成，生产任务已自动创建' : job.state === 'failed' ? '策划中断，点击从已保存证据恢复' : automatic ? `后台自动推进：${stage.label || 'AI 正在策划'}；完成后自动开始生产` : (stage.label || '后台策划中，可继续使用控制台');
    const dismiss = job.state === 'completed' ? `<button class="plan-dismiss" type="button" data-dismiss-plan="${escapeHtml(job.id)}" title="从策划队列移除"><i data-lucide="x"></i></button>` : '';
    return `<article class="plan-queue-item"><button class="creative-plan-job ${job.state === 'completed' ? 'done' : job.state === 'failed' ? 'failed' : ''}" type="button" data-plan-job="${escapeHtml(job.id)}"><span><strong>${escapeHtml(job.artifacts?.book?.title || job.input?.title || 'AI 智能策划')}</strong><span>${escapeHtml(status)}</span></span><i data-lucide="${icon}"></i></button>${dismiss}</article>`;
  }).join('');
  if (list) {
    list.innerHTML = jobHtml || '<div class="plan-queue-empty"><i data-lucide="brain-circuit"></i><span>暂无后台策划任务</span></div>';
    list.querySelectorAll('[data-plan-job]').forEach((button) => button.addEventListener('click', () => showPlanJob(button.dataset.planJob)));
    list.querySelectorAll('[data-dismiss-plan]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); dismissCreativePlan(button.dataset.dismissPlan); }));
  }
}

async function showPlanJob(id) {
  const job = state.planJobs.find((item) => item.id === id);
  if (!job) return;
  if (job.state === 'failed') { retryCreativePlanJob(job.id); return; }
  if (job.state !== 'completed') { showToast(job.stages?.analysis?.error || '该策划仍在后台推进，完成后这里会变为可查看方案'); return; }
  if (job._summary || !job.artifacts?.plan) {
    const button = document.querySelector(`[data-plan-job="${id}"]`);
    if (button) { button.disabled = true; button.classList.add('loading'); }
    try {
      const body = await api(`/api/creative-plan?id=${encodeURIComponent(id)}`, { timeoutMs: 45000 });
      if (!body.job) throw new Error('策划方案尚未准备完成');
      state.planJobs = state.planJobs.map((item) => item.id === id ? body.job : item);
      return showPlanJob(id);
    } catch (error) {
      showToast(`策划详情加载失败：${error.message}`, 'error');
      return;
    } finally {
      if (button) { button.disabled = false; button.classList.remove('loading'); }
    }
  }
  const result = planJobResult(job);
  state.creativePlan = result;
  state.planningTarget = result.delivery || p0TargetForBook(result.book);
  state.planningP0Selection = result.p0Selection || p0SelectionForBook(result.book);
  if ($('#planQueueDialog').open) $('#planQueueDialog').close();
  $('#creativePlanForm').hidden = true;
  $('#creativePlanLoading').hidden = true;
  $('#creativePlanResult').innerHTML = planResultHtml(result);
  $('#creativePlanResult').hidden = false;
  if (!$('#creativePlanDialog').open) $('#creativePlanDialog').showModal();
  bindCreativePlanActions(result);
  $('#planModelChoice')?.addEventListener('change', renderModelBadges);
  renderModelBadges();
  icons();
}

async function dismissCreativePlan(id) {
  const job = state.planJobs.find((item) => item.id === id);
  if (!job || job.state !== 'completed') return;
  try {
    await api('/api/creative-plan', { method: 'PATCH', body: JSON.stringify({ id, action: 'dismiss' }), timeoutMs: 20000 });
    state.planJobs = state.planJobs.filter((item) => item.id !== id);
    renderCreativePlanQueue(); icons();
    showToast('已从 AI 策划队列移除，方案不会影响已创建的生产任务');
  } catch (error) { showToast(`移除策划失败：${error.message}`, 'error'); }
}

async function retryCreativePlanJob(id) {
  try {
    await api('/api/creative-plan', { method: 'PATCH', body: JSON.stringify({ id, action: 'retry' }), timeoutMs: 10000 });
    showToast('已从锁定的章节证据恢复策划，首选模型会再次尝试');
    await loadCreativePlans({ silent: true });
    await kickWorker();
  } catch (error) { showToast(error.message, 'error'); }
}

function bindCreativePlanActions(result) {
  $('#openAutoProduction')?.addEventListener('click', () => {
    $('#creativePlanDialog').close();
    openDetail(result.productionRunId);
  });
  $('#confirmCreativePlan')?.addEventListener('click', async () => {
    const button = $('#confirmCreativePlan');
    button.disabled = true;
    try {
      const creativeProfile = creativePlanProfile();
      const actualPlanningModel = result.usage?.model || result.modelChoice || creativeProfile.modelChoice;
      await createProduction({ title: result.book.title, sku: result.book.bookSkuId || result.book.sku, source: 'ai_plan', creativeProfile, planning: { planId: result.id || '', preferredModel: result.preferredModelChoice || actualPlanningModel, actualModel: actualPlanningModel, fallbackUsed: Boolean(result.fallbackUsed) }, delivery: state.planningTarget, p0Selection: state.planningP0Selection });
      renderCreativePlanQueue();
      $('#creativePlanDialog').close();
      showToast(`策划由 ${modelLabel(actualPlanningModel)} 完成；生产使用 ${modelLabel(creativeProfile.modelChoice)}`);
    } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
  });
  $('#replanCreativePlan').addEventListener('click', () => openCreativePlanDialog({ title: result.book.title, bookSkuId: result.book.bookSkuId || result.book.sku }));
}

function openCreativePlanDialog(book = {}) {
  state.planningSession = Number(state.planningSession || 0) + 1;
  state.planning = false;
  state.creativePlan = null;
  state.planningTarget = p0TargetForBook(book);
  state.planningP0Selection = book?.title ? p0SelectionForBook(book) : { ...p0SelectionForBook({}), source: 'manual_plan' };
  $('#creativePlanForm').hidden = false;
  $('#creativePlanLoading').hidden = true;
  $('#creativePlanResult').hidden = true;
  $('#creativePlanResult').innerHTML = '';
  $('#creativePlanError').textContent = '';
  if (!$('#planningRequestModel')) $('#creativePlanInput').insertAdjacentHTML('beforeend', '<label class="plan-model-choice">首选策划模型<select id="planningRequestModel"><option value="glm-5.3-flash">GLM 5.3 Flash（默认）</option><option value="hy3">HY3（快速）</option><option value="deepseek-v4-flash-preview">DeepSeek V4 Flash Preview</option><option value="seed-2.1-turbo">Seed 2.1 Turbo（备用）</option><option value="qwen3.7-max">Qwen 3.7 Max（深度）</option><option value="minimax-m2.7">MiniMax M2.7（润色）</option><option value="kimi-k2.7-code">Kimi K2.7 Code（结构）</option></select></label>');
  $('#planTitle').value = book.title || '';
  $('#planSku').value = book.bookSkuId || '';
  if (!$('#creativePlanDialog').open) $('#creativePlanDialog').showModal();
  setTimeout(() => $('#planTitle').focus(), 0);
}

async function analyzeCreativePlan(title, sku) {
  const planningSession = state.planningSession;
  state.planning = true;
  const modelChoice = 'deepseek-v4-flash';
  const selectedModel = modelLabel(modelChoice);
  const accountId = Number(state.planningTarget?.accountId || state.catalogFilters.accountId || 0);
  const delivery = accountId ? { ...(state.planningTarget || {}), accountId } : null;
  const p0Selection = state.planningP0Selection;
  let planningPending = null;
  const requestId = crypto.randomUUID();
  $('#creativePlanForm').hidden = true;
  $('#creativePlanLoading').hidden = false;
  $('#creativePlanResult').hidden = true;
  $('#creativePlanLoading strong').textContent = `${selectedModel} 正在转入后台策划`;
  try {
    if (!accountId) throw new Error('请先选择一个已核验的目标账号');
    planningPending = markPendingProduction({ title, sku, source: 'ai_plan', creativeProfile: { modelChoice }, delivery, p0Selection });
    planningPending.status = 'planning';
    renderOneClickStatus();
    const body = await api('/api/creative-plan', { method: 'POST', body: JSON.stringify({ title, sku, modelChoice, requestId, autoStartProduction: true, paidAuthorized: true, promoter: 'xujt', accountId, p0Selection }), timeoutMs: 15000 });
    queueCreativePlanJob(body.job, selectedModel, planningSession);
  } catch (error) {
    if (planningSession !== state.planningSession) return;
    if (/请求超过|AbortError/i.test(String(error.message || error))) {
      $('#creativePlanLoading strong').textContent = '正在确认后台任务状态';
      const recovered = await recoverCreativePlanRequest(requestId, selectedModel, planningSession);
      if (planningSession !== state.planningSession || recovered) return;
    }
    if (planningPending) {
      planningPending.status = 'failed';
      planningPending.error = error.message || '策划请求失败';
    }
    renderOneClickStatus();
    const result = $('#creativePlanResult');
    result.hidden = false;
    result.innerHTML = `<div class="ai-failure"><i data-lucide="circle-alert"></i><strong>后台任务尚未确认</strong><p>${escapeHtml(error.message)}</p><div><button id="retryCreativePlan" class="primary-command" type="button">继续确认任务</button><button id="changeCreativePlanModel" class="secondary-command" type="button">换模型新建</button><button id="editCreativePlan" class="secondary-command" type="button">返回修改</button></div></div>`;
    $('#retryCreativePlan').addEventListener('click', async () => { if (!(await recoverCreativePlanRequest(requestId, selectedModel, planningSession))) showToast('后台仍未确认该请求，请稍后再确认；不要重复提交。'); });
    $('#changeCreativePlanModel').addEventListener('click', () => { result.hidden = true; $('#creativePlanForm').hidden = false; $('#planningRequestModel').focus(); });
    $('#editCreativePlan').addEventListener('click', () => { result.hidden = true; $('#creativePlanForm').hidden = false; $('#planTitle').focus(); });
    icons();
  } finally {
    if (planningSession === state.planningSession) {
      state.planning = false;
      $('#creativePlanLoading').hidden = true;
    }
  }
}

async function api(url, options = {}) {
  const { timeoutMs = 45000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  let response;
  try {
    response = await fetch(url, { ...fetchOptions, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) } });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止等待；可直接重试或切换模型`);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

function dashboardBookSummary(book) {
  return { title: book.title, sku: book.bookSkuId, baseReadUnt: book.baseReadUnt, firstReadUntRate: book.firstReadUntRate, read10wRate: book.read10wRate, read20wRate: book.read20wRate, ttProfit: book.ttProfit, rank: book.rank, isShort: Boolean(book.isShort) };
}

function catalogShortChoice() {
  return state.catalogFilters.length === 'short' ? 'yes' : state.catalogFilters.length === 'long' ? 'no' : 'all';
}

function catalogRequestQuery() {
  // Keep the provider request pinned to the familiar central reading ranking.
  // Other metrics only reorder the already verified rows in the browser, so
  // the displayed central rank never changes meaning.
  const filters = state.catalogFilters;
  return `&sort=baseReadUnt&compare=1&line=${encodeURIComponent(filters.line)}&platform=${encodeURIComponent(filters.platform)}&accountId=${encodeURIComponent(filters.accountId)}&language=${encodeURIComponent(filters.language)}&complete=${encodeURIComponent(filters.complete)}&status=${encodeURIComponent(filters.status)}&isShort=${catalogShortChoice()}&readBaseMin=${encodeURIComponent(filters.readBaseMin)}&firstReadMin=${encodeURIComponent(filters.firstReadMin)}&longReadMin=${encodeURIComponent(filters.longReadMin)}`;
}

function catalogTargetRoutes() {
  return state.catalogTargetOptions.length ? state.catalogTargetOptions : TARGET_ROUTE_FALLBACKS;
}

function syncCatalogTargetControls({ resetAccount = false } = {}) {
  const appKey = state.catalogFilters.line;
  const appRoutes = catalogTargetRoutes().filter((route) => String(route.appKey || route.productLine) === appKey);
  const availablePlatforms = [...new Set(appRoutes.map((route) => route.platform))];
  if (!availablePlatforms.includes(state.catalogFilters.platform)) state.catalogFilters.platform = availablePlatforms[0] || 'facebook';
  const routes = appRoutes.filter((route) => route.platform === state.catalogFilters.platform);
  if (resetAccount || !routes.some((route) => String(route.accountId) === String(state.catalogFilters.accountId))) {
    state.catalogFilters.accountId = routes[0] ? String(routes[0].accountId) : '';
  }
  const application = $('#catalogApplication');
  if (application) application.value = appKey;
  const platform = $('#catalogPlatform');
  if (platform) {
    platform.innerHTML = availablePlatforms.map((value) => `<option value="${value}">${{ facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' }[value] || value}</option>`).join('');
    platform.value = state.catalogFilters.platform;
  }
  const account = $('#catalogAccount');
  if (account) {
    account.innerHTML = routes.map((route) => `<option value="${route.accountId}">${escapeHtml(route.accountTitle || route.appName || route.appKey)} · ${{ facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' }[route.platform] || route.platform}</option>`).join('');
    account.value = state.catalogFilters.accountId;
  }
  const manual = $('#manualAccount');
  if (manual) {
    manual.innerHTML = catalogTargetRoutes().map((route) => `<option value="${route.accountId}" ${String(route.accountId) === String(state.catalogFilters.accountId) ? 'selected' : ''}>${escapeHtml(route.appName || route.appKey)} · ${escapeHtml(route.accountTitle || '')} · ${{ facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' }[route.platform] || route.platform}</option>`).join('');
  }
}

function p0TargetForBook(book = {}, explicitTarget = null) {
  const target = explicitTarget || book.selectionTarget || state.catalogTarget;
  const accountId = Number(target?.accountId || state.catalogFilters.accountId || 0);
  return accountId ? { ...target, accountId } : null;
}

function p0SelectionForBook(book = {}, explicitTarget = null) {
  const target = p0TargetForBook(book, explicitTarget);
  const windowKey = `readerBase${Number(state.catalogDays)}d`;
  return {
    source: 'content_dashboard_performance',
    windowDays: state.catalogDays,
    sourceRank: Number(book.rank || 0),
    recommendationRank: Number(book.recommendationRank || 0),
    readerBase: Number(book[windowKey] ?? book.baseReadUnt ?? 0),
    firstReadRate: Number(book.firstReadUntRate || 0),
    longReadRate: Number(book.read20wRate || book.read10wRate || 0),
    trend7v30: Number.isFinite(Number(book.trend7v30)) ? Number(book.trend7v30) : null,
    receipt: String(book.p0Receipt || ''),
    filters: {
      language: state.catalogFilters.language,
      complete: state.catalogFilters.complete,
      length: state.catalogFilters.length,
      genre: state.catalogFilters.genre,
      readBaseMin: Number(state.catalogFilters.readBaseMin || 0),
      firstReadMin: Number(state.catalogFilters.firstReadMin || 0),
      longReadMin: Number(state.catalogFilters.longReadMin || 0)
    },
    target
  };
}

function p0TargetLabel(target = {}) {
  const platformLabel = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' }[target.platform] || target.platform || '未选择平台';
  return `${target.appName || target.appKey || target.productLine || '未选择产品线'} / ${platformLabel} / ${target.accountTitle || target.accountId || '未选择账号'}`;
}

function p0Percent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${(numeric <= 1 ? numeric * 100 : numeric).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
}

function p0DecisionTarget() {
  const routes = catalogTargetRoutes();
  return state.catalogTarget || routes.find((route) => String(route.appKey || route.productLine) === String(state.catalogFilters.line)
    && route.platform === state.catalogFilters.platform
    && String(route.accountId) === String(state.catalogFilters.accountId)) || {
    appKey: state.catalogFilters.line,
    appName: state.catalogFilters.line,
    productLine: state.catalogFilters.line,
    platform: state.catalogFilters.platform,
    accountId: Number(state.catalogFilters.accountId || 0),
    accountTitle: ''
  };
}

function p0EligibleBooks() {
  if (state.leaderboardSource !== 'catalog') return [];
  const target = p0DecisionTarget();
  return catalogVisibleBooks(target).filter((book) => {
    const selectionTarget = book.selectionTarget || target;
    const sameRoute = String(selectionTarget.accountId || '') === String(target.accountId || '')
      && String(selectionTarget.platform || '') === String(target.platform || '')
      && String(selectionTarget.appKey || selectionTarget.productLine || '') === String(target.appKey || target.productLine || '');
    const usage = bookUsageMeta(book, target).status;
    return sameRoute && Boolean(book.p0Receipt) && book.automationReady !== false && book.recommendationReady !== false && ['unused', 'selected'].includes(usage);
  });
}

function renderP0DecisionRail() {
  const rail = $('#p0DecisionRail');
  const content = $('#p0DecisionContent');
  const status = $('#p0RouteStatus');
  if (!rail || !content || !status) return;
  const target = p0DecisionTarget();
  const locked = Boolean(target.accountId && target.platform && (target.appKey || target.productLine));
  const eligible = p0EligibleBooks();
  const selected = state.selectedBooks.size;
  const filters = state.catalogFilters;
  const windowDays = state.catalogDays;
  status.className = `route-lock-badge ${locked ? 'locked' : 'pending'}`;
  status.innerHTML = `<i data-lucide="${locked ? 'lock-keyhole' : 'unlock-keyhole'}"></i><strong>${locked ? '路由已锁定' : '等待锁定路由'}</strong>`;
  content.innerHTML = `<div class="p0-route-grid">
    <article class="p0-route-cell target"><span>目标应用</span><strong>${escapeHtml(target.appName || target.appKey || '—')}</strong><small>产品线：${escapeHtml(target.productLine || target.appKey || '—')}</small></article>
    <article class="p0-route-cell"><span>目标平台</span><strong>${escapeHtml({ facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' }[target.platform] || target.platform || '—')}</strong><small>发布规则：${target.includeLink ? '允许归因短链' : '只展示 Code'}</small></article>
    <article class="p0-route-cell account"><span>SocialEcho 账号</span><strong>${escapeHtml(target.accountTitle || '—')}</strong><small>账号 ID ${escapeHtml(String(target.accountId || '—'))}</small></article>
    <article class="p0-route-cell"><span>当前排行窗口</span><strong>近 ${windowDays} 天</strong><small>只在目标产品线内读取中台指标</small></article>
  </div>
  <div class="p0-metric-strip">
    <div><span>阅读基数门槛</span><strong>${Number(filters.readBaseMin || 0).toLocaleString('zh-CN')}</strong><small>读者用户</small></div>
    <div><span>首读率门槛</span><strong>${p0Percent(filters.firstReadMin)}</strong><small>开篇转化</small></div>
    <div><span>长读留存门槛</span><strong>${p0Percent(filters.longReadMin)}</strong><small>20w 优先，缺失用 10w</small></div>
    <div class="p0-eligibility"><span>当前可选候选</span><strong>${eligible.length}</strong><small>${selected ? `已选 ${selected} 本` : '未选书籍'} · 未使用记录优先</small></div>
  </div>
  <div class="p0-rail-footer"><span><i data-lucide="shield-check"></i> ${locked ? `当前榜单只来自 ${escapeHtml(target.appName || target.appKey || '目标')} 产品线` : '先从下方筛选器选择目标应用、平台和账号'}</span><button type="button" class="p0-jump-action" data-p0-focus="catalogApplication"><i data-lucide="sliders-horizontal"></i>调整 P0 筛选</button></div>`;
  content.querySelector('[data-p0-focus]')?.addEventListener('click', () => { $('#catalogApplication')?.focus(); $('#catalogApplication')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
}

function renderHarnessStageStrip() {
  const strip = $('#harnessStageStrip');
  if (!strip) return;
  const run = state.runs.find((item) => item.id === state.selectedId) || state.runs[0];
  const projection = run ? harnessProjectionForUi(run) : null;
  const stages = new Map((projection?.stages || []).map((stage) => [stage.key, stage]));
  strip.querySelectorAll('[data-harness-stage]').forEach((node) => {
    const key = node.dataset.harnessStage;
    const stage = stages.get(key);
    node.className = stage ? `status-${stage.status || 'waiting'}` : key === 'P0' && p0DecisionTarget().accountId ? 'status-prepared' : '';
    if (stage?.purpose) node.title = stage.purpose;
  });
}

async function assistantSnapshot(mode) {
  const activeRuns = state.runs.filter((run) => ['queued', 'running', 'blocked', 'failed'].includes(run.state)).slice(0, 8).map((run) => ({
    id: run.id, title: run.input?.title, state: run.state, code: run.artifacts?.code || '', completedStages: completedHarnessStages(run),
    updatedAt: run.updatedAt, selectedModel: modelLabel(run.input?.creativeProfile?.modelChoice),
    stages: Object.fromEntries(Object.entries(run.stages || {}).map(([key, stage]) => [key, { status: stage.status, phase: stage.phase || '', recoverable: Boolean(stage.recoverable), nextAttemptAt: stage.nextAttemptAt || '', error: String(stage.error || '').slice(0, 160) }])),
    assets: assetSummary(run), optimization: run.artifacts?.optimization?.status || '', lastEvent: run.events?.at(-1)?.message || ''
  }));
  const assets = state.runs.filter((run) => assetSummary(run).total > 0).slice(0, 12).map((run) => ({
    id: run.id, title: run.input?.title, code: run.artifacts?.code || '', shortUrl: run.artifacts?.shortUrl || '', ...assetSummary(run),
    analytics: run.artifacts?.analytics || null
  }));
  if (mode === 'assets') return { activeRuns, assets, leaderboard: state.leaderboard.slice(0, 8).map(dashboardBookSummary) };
  if (mode !== 'books') return { activeRuns, assets, leaderboard: state.leaderboard.slice(0, 8).map(dashboardBookSummary) };
  const body = await api(`/api/leaderboard?source=catalog&days=7${catalogRequestQuery()}`);
  if (!responseAllowsCatalogRanking(body, body.books || []) || !recommendationMetricsReady(body.books || [])) {
    throw new Error('中台真实指标尚未通过验证，AI 不会从普通书库冒充 Top 榜推荐');
  }
  const topTwoHundred = (body.books || []).filter((book) => book.automationReady !== false).slice(0, 200);
  const seen = new Set(state.recommendationHistory.map((title) => String(title).toLowerCase()));
  const unseen = topTwoHundred.filter((book) => !seen.has(String(book.title || '').toLowerCase()));
  const candidates = unseen.length >= 3 ? unseen : topTwoHundred;
  // Give the model a varied, ranked subset rather than a 200-row prompt. The
  // rotating stride prevents the same few highest-UV books appearing forever.
  const stride = Math.max(1, Math.ceil(candidates.length / 36));
  const layered = candidates.filter((_, index) => index < 24 || index % stride === state.recommendationCycle % stride).slice(0, 40);
  const offset = layered.length ? state.recommendationCycle % layered.length : 0;
  const rotated = [...layered.slice(offset), ...layered.slice(0, offset)].slice(0, 18);
  state.recommendationCycle += 3;
  return { activeRuns, leaderboard: rotated.map(dashboardBookSummary), recommendationContext: { windowDays: 7, candidateCount: topTwoHundred.length, recentRecommendationTitles: state.recommendationHistory, rule: 'Recommend only from a rotating, metric-diverse shortlist drawn from the current weekly Top 200. Prefer titles not in recentRecommendationTitles.' } };
}

function assistantHtml(analysis, selectedModel = 'AI') {
  const actions = Array.isArray(analysis.actions) ? analysis.actions : [];
  const recommendations = Array.isArray(analysis.recommendations) ? analysis.recommendations : [];
  const actionCard = (item) => {
    const run = state.runs.find((candidate) => candidate.id === item.runId);
    const recoverable = run && (['queued', 'running'].includes(run.state) || Object.values(run.stages || {}).some((stage) => stage.recoverable));
    return `<article class="priority-${escapeHtml(item.priority || 'medium')}"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.reason)}</p>${item.runId ? `<div class="assistant-actions"><button type="button" data-assistant-run="${escapeHtml(item.runId)}">打开任务</button>${recoverable ? `<button type="button" data-assistant-resume="${escapeHtml(item.runId)}">继续后台推进</button>` : ''}</div>` : ''}</article>`;
  };
  const recommendationCard = (item) => `<article><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.reason)}</p><small>${escapeHtml(item.caveat || '')}</small><button type="button" data-assistant-book="${escapeHtml(item.title)}">打开 AI 策划</button></article>`;
  return `<header><span class="assistant-mark"><i data-lucide="waves"></i><i data-lucide="sparkles"></i></span><div><small>鲸灵建议 · ${escapeHtml(selectedModel)}</small><strong>${escapeHtml(analysis.headline || `${selectedModel} 分析完成`)}</strong><p>${escapeHtml(analysis.summary || '')}</p></div></header>${actions.length ? `<div class="assistant-section"><span>优先动作</span>${actions.map(actionCard).join('')}</div>` : ''}${recommendations.length ? `<div class="assistant-section"><span>推荐书籍</span>${recommendations.map(recommendationCard).join('')}</div>` : ''}`;
}

function localAssistantAnalysis(snapshot, mode) {
  if (mode === 'books') {
    const used = new Set();
    const take = (compare, reason) => {
      const book = [...(snapshot.leaderboard || [])].filter((item) => !used.has(item.title)).sort(compare)[0];
      if (!book) return null;
      used.add(book.title);
      return { title: book.title, reason: reason(book), caveat: '基于当前榜单真实指标；可打开 AI 策划进一步阅读原文结构。' };
    };
    return { headline: 'Top 200 实时选书', summary: '模型暂未返回，先按规模、首读和长读留存给出不重复候选。', actions: [], recommendations: [
      take((a, b) => Number(b.baseReadUnt || 0) - Number(a.baseReadUnt || 0), (book) => `阅读 UV ${compactNumber(book.baseReadUnt)}，当前规模优势明显。`),
      take((a, b) => Number(b.firstReadUntRate || 0) - Number(a.firstReadUntRate || 0), (book) => `首读率 ${percentage(book.firstReadUntRate)}，适合验证开篇钩子。`),
      take((a, b) => Number(b.read20wRate || b.read10wRate || 0) - Number(a.read20wRate || a.read10wRate || 0), (book) => `长读留存 ${percentage(book.read20wRate || book.read10wRate)}，后段承接更有潜力。`)
    ].filter(Boolean) };
  }
  const actions = [];
  (snapshot.activeRuns || []).forEach((run) => {
    if (actions.length >= 3) return;
    const stages = Object.entries(run.stages || {});
    const blocked = stages.find(([, stage]) => ['failed', 'blocked', 'ambiguous'].includes(stage.status));
    const recovering = stages.find(([, stage]) => stage.recoverable);
    if (blocked) actions.push({ priority: 'high', title: `${run.title}：需要处理`, reason: `${blocked[0]} 当前为 ${blocked[1].status}，打开任务查看保存的原因与处理入口。`, runId: run.id });
    else if (recovering) actions.push({ priority: 'medium', title: `${run.title}：后台恢复中`, reason: `${recovering[0]} 会从已保存节点继续，不会重新创建追踪或付费任务。`, runId: run.id });
    else actions.push({ priority: 'low', title: `${run.title}：继续生产`, reason: `已完成 ${run.completedStages || 0}/${HARNESS_NODE_COUNT} 个节点，可打开查看当前产物。`, runId: run.id });
  });
  return { headline: mode === 'assets' ? '素材实时检查' : '实时生产诊断', summary: actions.length ? '结论直接来自当前任务状态，模型不可用时也可以继续操作。' : '当前没有需要立即处理的任务。', actions, recommendations: [] };
}

function bindAssistantActions(result) {
  result.querySelectorAll('[data-assistant-run]').forEach((button) => button.addEventListener('click', () => { $('#assistantDialog').close(); openDetail(button.dataset.assistantRun); }));
  result.querySelectorAll('[data-assistant-resume]').forEach((button) => button.addEventListener('click', async () => { $('#assistantDialog').close(); openDetail(button.dataset.assistantResume); showToast('已唤醒后台生产，系统会从已保存节点继续'); await kickWorker(); }));
  result.querySelectorAll('[data-assistant-book]').forEach((button) => button.addEventListener('click', () => {
    const book = state.leaderboard.find((item) => String(item.title || '').toLowerCase() === String(button.dataset.assistantBook || '').toLowerCase());
    $('#assistantDialog').close();
    if (book) openCreativePlanDialog(book); else { openCatalogRanking(); showToast('已打开 Top 200 榜单，请刷新后选择该书'); }
  }));
}

async function runAssistant(mode) {
  if (state.assistantRunning) return;
  const result = $('#assistantResult');
  const select = $('#assistantModelChoice');
  const modelChoice = select?.value || 'hy3';
  const selectedModel = modelLabel(modelChoice);
  state.assistantRunning = true;
  const activeCount = state.runs.filter((run) => ['queued', 'running'].includes(run.state)).length;
  const attentionCount = state.runs.filter((run) => ['failed', 'blocked'].includes(run.state)).length;
  result.className = 'assistant-result loading';
  result.innerHTML = `<i data-lucide="loader-circle"></i><strong>已扫描 ${state.runs.length} 个任务，${selectedModel} 正在判断</strong><span>${activeCount} 个生产中 · ${attentionCount} 个需处理 · 将给出可点击的下一步</span>`;
  icons();
  let snapshot = {};
  try {
    snapshot = await assistantSnapshot(mode);
    result.className = 'assistant-result';
    result.innerHTML = assistantHtml(localAssistantAnalysis(snapshot, mode), '实时任务数据');
    bindAssistantActions(result);
    icons();
    const body = await api('/api/assistant', { method: 'POST', body: JSON.stringify({ mode, modelChoice, snapshot }), timeoutMs: selectedModelWaitMs(modelChoice) });
    result.className = 'assistant-result';
    const actualModel = modelLabel(body.usage?.model || selectedModel);
    result.innerHTML = assistantHtml(body.analysis || {}, actualModel);
    bindAssistantActions(result);
    if (body.usage?.fallbackFrom) showToast(actualModel === '中台指标兜底' ? `${selectedModel} 暂未返回，已展示本周真实指标候选` : `${selectedModel} 未在时限内返回，已由 ${actualModel} 完成分析`);
    if (mode === 'books') {
      const titles = (body.analysis?.recommendations || []).map((item) => String(item.title || '').trim()).filter(Boolean);
      state.recommendationHistory = [...state.recommendationHistory, ...titles].slice(-9);
      try { localStorage.setItem('nf_social:recommendation_history', JSON.stringify(state.recommendationHistory)); } catch {}
    }
    icons();
  } catch (error) {
    result.className = 'assistant-result';
    result.innerHTML = assistantHtml(localAssistantAnalysis(snapshot || {}, mode), '实时任务数据');
    bindAssistantActions(result);
    showToast(`${selectedModel} 暂未及时返回，已切换为实时任务诊断`);
    icons();
  } finally {
    state.assistantRunning = false;
  }
}

function copilotContext() {
  const selected = state.runs.find((run) => run.id === state.selectedId);
  return {
    activeRuns: state.runs.slice(0, 10).map((run) => ({ id: run.id, title: run.input?.title, sku: run.input?.sku, state: run.state, code: run.artifacts?.code || '', stages: Object.fromEntries(Object.entries(run.stages || {}).map(([key, value]) => [key, value.status])), lastEvent: run.events?.at(-1)?.message || '' })),
    selectedRun: selected ? { id: selected.id, title: selected.input?.title, state: selected.state, code: selected.artifacts?.code || '', stages: selected.stages } : null,
    todayBooks: state.todayBooks.slice(0, 12).map((book) => ({ title: book.title, sku: book.bookSkuId, genre: bookGenre(book), uv: book.baseReadUnt, firstReadRate: book.firstReadUntRate, longReadRate: book.read20wRate || book.read10wRate, score: book.todayScore })),
    filters: { days: state.catalogDays, genre: state.catalogFilters.genre, length: state.catalogFilters.length }
  };
}

function renderCopilotThread() {
  const thread = $('#copilotThread');
  if (!thread) return;
  const messages = state.copilotMessages.filter((message) => message.role !== 'tool').slice(-10);
  thread.innerHTML = messages.length ? messages.map((message) => `<article class="copilot-message ${message.role === 'user' ? 'user' : 'whale'}"><span>${message.role === 'user' ? '你' : '鲸灵'}</span><p>${escapeHtml(message.content || (message.toolCalls?.length ? '正在执行控制台动作…' : '')).replace(/\n/g, '<br>')}</p>${message.toolCalls?.length ? `<small>已执行：${message.toolCalls.map((call) => escapeHtml(call.name)).join(' · ')}</small>` : ''}</article>`).join('') : '<article class="copilot-message whale"><span>鲸灵</span><p>我已经看到当前任务和今日推荐。你可以直接问我：哪个任务该先处理？或推荐一本适合今天推的书。</p></article>';
  thread.scrollTop = thread.scrollHeight;
}

function persistCopilot() { try { localStorage.setItem('nf_social:copilot_messages', JSON.stringify(state.copilotMessages.slice(-14))); } catch {} }

async function executeCopilotTool(call) {
  let args = {};
  try { args = JSON.parse(call.arguments || '{}'); } catch { return '工具参数无效，未执行任何页面动作。'; }
  if (call.name === 'open_task') {
    const run = state.runs.find((item) => item.id === args.runId);
    if (!run) return '该任务不在当前摘要中，未执行。';
    openDetail(run.id); return `已打开任务《${run.input?.title || run.id}》。`;
  }
  if (call.name === 'open_book_planning') {
    const book = [...state.todayBooks, ...state.leaderboard].find((item) => String(item.bookSkuId || '') === String(args.sku || '') || String(item.title || '').toLowerCase() === String(args.title || '').toLowerCase()) || { title: args.title, bookSkuId: args.sku || '' };
    openCreativePlanDialog(book); return `已打开《${book.title}》的 AI 策划面板；尚未创建 Code、链接或付费素材。`;
  }
  if (call.name === 'prefill_new_task') {
    openRunDialog(); $('#manualTitle').value = String(args.title || ''); $('#manualSku').value = String(args.sku || ''); renderCreativeProfilePreview();
    return `已预填《${args.title || ''}》；仍需由你点击“立即智能生成”。`;
  }
  if (call.name === 'set_catalog_filters') {
    state.leaderboardSource = 'catalog';
    if ([7, 30, 90].includes(Number(args.days))) state.catalogDays = Number(args.days);
    if (['all', 'werewolf', 'ceo', 'mafia', 'vampire'].includes(args.genre)) state.catalogFilters.genre = args.genre;
    if (['all', 'short', 'long'].includes(args.length)) state.catalogFilters.length = args.length;
    $('#catalogSort').value = state.catalogSort;
    document.querySelectorAll('#catalogWindowControl button').forEach((button) => button.classList.toggle('active', Number(button.dataset.days) === state.catalogDays));
    await loadLeaderboard({ silent: true }); openCatalogRanking();
    return `已切换新推书库筛选：近 ${state.catalogDays} 天、${state.catalogFilters.genre}、${state.catalogFilters.length}。`;
  }
  if (call.name === 'refresh_dashboard') {
    await Promise.all([loadStatus({ silent: true }), loadLeaderboard({ silent: true }), loadTodayRail()]);
    return '已刷新任务摘要、榜单和今日推荐。';
  }
  return '该动作不在鲸灵的安全白名单内，未执行。';
}

async function sendCopilot(text) {
  const value = String(text || '').trim();
  if (!value || state.copilotBusy) return;
  state.copilotBusy = true;
  state.copilotMessages.push({ role: 'user', content: value }); persistCopilot(); renderCopilotThread();
  const input = $('#copilotInput'); const button = $('#copilotForm button'); input.value = ''; button.disabled = true;
  try {
    const modelChoice = $('#assistantModelChoice')?.value || 'hy3';
    const body = await api('/api/copilot', { method: 'POST', body: JSON.stringify({ messages: state.copilotMessages, context: copilotContext(), modelChoice }), timeoutMs: selectedModelWaitMs(modelChoice) });
    const reply = { role: 'assistant', content: body.message?.content || '', toolCalls: body.message?.toolCalls || [] };
    state.copilotMessages.push(reply); renderCopilotThread();
    if (reply.toolCalls.length) {
      for (const call of reply.toolCalls) state.copilotMessages.push({ role: 'tool', toolCallId: call.id, content: await executeCopilotTool(call) });
      const final = await api('/api/copilot', { method: 'POST', body: JSON.stringify({ messages: state.copilotMessages, context: copilotContext(), modelChoice }), timeoutMs: selectedModelWaitMs(modelChoice) });
      state.copilotMessages.push({ role: 'assistant', content: final.message?.content || '页面动作已完成。' });
    }
    persistCopilot(); renderCopilotThread(); icons();
  } catch (error) {
    state.copilotMessages.push({ role: 'assistant', content: `我暂时没有拿到模型回复：${error.message}。你仍可以使用上方的巡检与推荐入口。` });
    persistCopilot(); renderCopilotThread();
  } finally { state.copilotBusy = false; button.disabled = false; input.focus(); }
}

function showLogin() {
  $('#loginView').hidden = false;
  $('#appView').hidden = true;
  requestAnimationFrame(() => $('#password')?.focus());
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
}

function capabilityName(key) {
  return { storage: '任务存储', pipeline: '书库与短链', llm: 'AI 创意模型', video: 'AC 视频', image: '海报生成', report: '归因数据', publishing: 'SocialEcho 发布' }[key] || key;
}

function renderCapabilities() {
  const readinessEntries = Object.entries(state.capabilities).filter(([key]) => !['videoGenerationPaused', 'imageGenerationPaused', 'paidMediaAvailable', 'image'].includes(key));
  const imageOptional = Object.prototype.hasOwnProperty.call(state.capabilities, 'image')
    ? [['image', state.capabilities.image]]
    : [];
  $('#capabilities').innerHTML = readinessEntries.concat(imageOptional).map(([key, ok]) => `<div class="cap-row ${ok ? 'ok' : ''}${key === 'image' ? ' optional' : ''}"><span>${escapeHtml(capabilityName(key))}${key === 'image' ? '（可选）' : ''}</span><i></i></div>`).join('');
  const values = readinessEntries.map(([, value]) => value);
  const readyCount = values.filter(Boolean).length;
  const allReady = values.length > 0 && readyCount === values.length;
  $('#systemState').classList.toggle('online', allReady);
  $('#systemState').innerHTML = `<span class="pulse-dot"></span>生产配置 ${readyCount}/${values.length || 6}`;
  const video = state.videoLimit || { used: 0, limit: 40, remaining: 40, scope: 'day', timeZone: 'Asia/Shanghai' };
  const capacity = $('#videoCapacity');
  capacity.classList.toggle('at-limit', Number(video.remaining) === 0);
  const reset = Date.parse(video.resetAt || '');
  const resetLabel = Number.isFinite(reset) ? new Date(reset).toLocaleString('zh-CN', { timeZone: video.timeZone || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '次日 00:00';
  capacity.title = `本网站每天最多提交 ${video.limit} 条付费视频；已用 ${video.used} 条，北京时间 ${resetLabel} 重置。`;
  capacity.innerHTML = `<i data-lucide="video"></i><strong>视频额度 ${video.remaining}/${video.limit}</strong><small>${video.used} 已用 · ${resetLabel} 重置</small>`;
  const points = state.pointsBudget || { used: 0, limit: 1000, remaining: 1000, scope: 'day', timeZone: 'Asia/Shanghai' };
  const pointsCapacity = $('#pointsCapacity');
  if (pointsCapacity) {
    const pointsUsed = Number.isFinite(Number(points.used)) ? Number(points.used) : 0;
    const pointsLimit = Number.isFinite(Number(points.limit)) ? Number(points.limit) : 1000;
    const pointsRemaining = Math.max(0, Number.isFinite(Number(points.remaining)) ? Number(points.remaining) : pointsLimit - pointsUsed);
    const pointsReset = Date.parse(points.resetAt || '');
    const pointsResetLabel = Number.isFinite(pointsReset) ? new Date(pointsReset).toLocaleString('zh-CN', { timeZone: points.timeZone || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '次日 00:00';
    pointsCapacity.classList.toggle('at-limit', pointsRemaining === 0);
    pointsCapacity.title = `每日受控付费 AC 积分上限 ${pointsLimit}；已预留/计入 ${pointsUsed}，剩余 ${pointsRemaining}，北京时间 ${pointsResetLabel} 重置。`;
    pointsCapacity.innerHTML = `<i data-lucide="coins"></i><strong>积分 ${pointsRemaining}/${pointsLimit}</strong><small>${pointsUsed} 已计入 · ${pointsResetLabel} 重置</small>`;
  }
  const commandSummary = $('#commandCapabilitySummary');
  if (commandSummary) commandSummary.textContent = paidMediaAvailable()
    ? '先用中台实时阅读规模、质量和趋势选书；付费媒体提交已由服务端能力与 40/日额度门禁接管。'
    : '先用中台实时阅读规模、质量和趋势选书；服务端当前未开放新的付费媒体提交。';
}

const DAILY_CAMPAIGN_STAGES = Object.freeze([
  ['P0', '选书'], ['P1', '核验'], ['P2', '证据'], ['P3', '创意'],
  ['P4', '视频'], ['P5', '归因'], ['P6', '审核'], ['P7', '草稿']
]);

function dailyPlatformLabel(value) {
  return { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' }[String(value || '').toLowerCase()] || String(value || '待核验');
}

function dailyCampaignAssignments(campaign = state.dailyCampaign) {
  const candidates = [
    campaign?.assignments, campaign?.slots, campaign?.items,
    campaign?.manifest?.assignments, campaign?.manifest?.slots,
    campaign?.progress?.items, campaign?.runs
  ];
  return candidates.find(Array.isArray) || [];
}

function dailyAssignmentAccountId(item) {
  return Number(item?.accountId || item?.route?.accountId || item?.delivery?.accountId || item?.input?.delivery?.accountId || item?.input?.campaign?.accountId || 0);
}

function dailyAssignmentProfile(item) {
  return item?.creativeProfile || item?.input?.creativeProfile || item?.campaign?.creativeProfile || {};
}

function dailyCampaignRoutes(campaign = state.dailyCampaign) {
  const assignments = dailyCampaignAssignments(campaign);
  const responseRoutes = [campaign?.accounts, campaign?.onlineAccounts, campaign?.routes, campaign?.targets, campaign?.manifest?.routes].find(Array.isArray) || [];
  return DAILY_CAMPAIGN_ACCOUNT_IDS.map((accountId, index) => {
    const fallback = TARGET_ROUTE_FALLBACKS.find((route) => Number(route.accountId) === accountId) || { accountId, accountTitle: `账号 ${accountId}`, platform: '' };
    const fromResponse = responseRoutes.find((route) => Number(route?.accountId || route?.id) === accountId) || {};
    const fromAssignment = assignments.find((item) => dailyAssignmentAccountId(item) === accountId) || {};
    const status = fromResponse.status;
    const explicitOnline = typeof fromResponse.online === 'boolean' ? fromResponse.online
      : typeof fromResponse.available === 'boolean' ? fromResponse.available
        : Number.isFinite(Number(status)) && status !== '' ? Number(status) === 1
          : ['online', 'active', 'ready'].includes(String(status || '').toLowerCase()) ? true
            : ['offline', 'disabled', 'expired'].includes(String(status || '').toLowerCase()) ? false
              : null;
    return {
      ...fallback,
      ...fromResponse,
      accountId,
      accountTitle: fromResponse.accountTitle || fromResponse.title || fromResponse.name || fromAssignment.accountTitle || fromAssignment.input?.delivery?.accountTitle || fallback.accountTitle,
      appKey: fromResponse.appKey || fromAssignment.appKey || fromAssignment.input?.delivery?.appKey || fallback.appKey,
      platform: fromResponse.platform || fromAssignment.platform || fromAssignment.input?.delivery?.platform || fallback.platform,
      online: explicitOnline,
      accountIndex: index
    };
  });
}

function unwrapDailyCampaignResponse(body = {}) {
  const payload = body.campaign || body.preview || body.manifest || body.data?.campaign || body.data?.preview || body.data || body;
  const normalized = payload && typeof payload === 'object' ? { ...payload } : {};
  const confirmationToken = body.confirmationToken || body.confirmPaidToken || body.authorizationToken
    || normalized.confirmationToken || normalized.confirmPaidToken || normalized.authorizationToken || '';
  return {
    ...normalized,
    confirmationToken,
    campaignId: normalized.campaignId || normalized.id || body.campaignId || body.id || '',
    responseCapabilities: body.capabilities || normalized.capabilities || null,
    responseVideoLimit: body.videoLimit || normalized.videoLimit || null,
    responsePointsBudget: body.pointsBudget || normalized.pointsBudget || null
  };
}

function dailyCampaignStatus(campaign = state.dailyCampaign) {
  return String(campaign?.status || campaign?.state || campaign?.phase || '').toLowerCase();
}

function dailyCampaignIsStale(campaign = state.dailyCampaign) {
  const quality = String(campaign?.dataQuality || campaign?.snapshot?.dataQuality || '').toLowerCase();
  if (quality.includes('stale') || quality.includes('expired')) return true;
  const expiresAt = Date.parse(campaign?.receiptExpiresAt || campaign?.snapshotExpiresAt || campaign?.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function applyDailyCampaignResponse(body, action = '') {
  const next = unwrapDailyCampaignResponse(body);
  state.dailyCampaign = { ...(state.dailyCampaign || {}), ...next };
  state.dailyCampaignId = String(next.campaignId || state.dailyCampaignId || '');
  state.dailyCampaignConfirmationToken = String(next.confirmationToken || state.dailyCampaignConfirmationToken || '');
  if (next.responseCapabilities && typeof next.responseCapabilities === 'object') state.capabilities = { ...state.capabilities, ...next.responseCapabilities };
  if (next.responseVideoLimit && typeof next.responseVideoLimit === 'object') state.videoLimit = next.responseVideoLimit;
  if (next.responsePointsBudget && typeof next.responsePointsBudget === 'object') state.pointsBudget = next.responsePointsBudget;
  const status = dailyCampaignStatus(state.dailyCampaign);
  if (action === 'create' || ['created', 'queued', 'running', 'completed', 'partial', 'failed'].includes(status)) state.dailyCampaignPhase = 'created';
  else if (action === 'preview' || status.includes('preview')) state.dailyCampaignPhase = 'preview';
  if (state.dailyCampaignPhase === 'created' && state.dailyCampaignId) {
    try { localStorage.setItem('nf_social:daily_campaign_id', state.dailyCampaignId); } catch {}
  }
  state.dailyCampaignError = '';
}

function dailyCountValue(value) {
  if (Number.isFinite(Number(value)) && value !== '' && value != null) return Number(value);
  if (!value || typeof value !== 'object') return null;
  for (const key of ['completed', 'done', 'success', 'count', 'value']) {
    if (Number.isFinite(Number(value[key]))) return Number(value[key]);
  }
  return null;
}

function dailyExplicitCount(campaign, keys = []) {
  const sources = [campaign?.counts, campaign?.statusCounts, campaign?.outcomes, campaign?.progress?.counts, campaign?.summary?.counts, campaign?.summary];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const count = dailyCountValue(source[key]);
      if (count != null) return count;
    }
  }
  return null;
}

function dailyAssignmentStatus(item) {
  const stage = item?.currentStage || item?.stage || item?.phase || item?.run?.currentStage || '';
  const status = item?.status || item?.state || item?.run?.state || item?.publication?.status || '';
  return { stage: String(stage || '').toUpperCase(), status: String(status || '').toLowerCase() };
}

function dailyCampaignOutcomeMetrics(campaign = state.dailyCampaign) {
  const items = dailyCampaignAssignments(campaign);
  const derived = { created: 0, waiting: 0, running: 0, failed: 0, draft: 0 };
  for (const item of items) {
    const { status } = dailyAssignmentStatus(item);
    if (item?.runId || item?.id && String(item.id).startsWith('run_') || item?.run?.id) derived.created += 1;
    if (/failed|error|ambiguous/.test(status)) derived.failed += 1;
    else if (/external_draft|draft_ready|drafted/.test(status) || item?.draftId || item?.publication?.externalDraftId) derived.draft += 1;
    else if (/queued|waiting|prepared|pending|capacity|limit/.test(status)) derived.waiting += 1;
    else if (/running|processing|generating|uploading|submitting/.test(status)) derived.running += 1;
  }
  const value = (keys, fallback) => {
    const explicit = dailyExplicitCount(campaign, keys);
    return explicit == null ? fallback : explicit;
  };
  return {
    total: value(['total', 'requested', 'selected'], items.length || 36),
    created: value(['created', 'runs', 'submitted'], derived.created || (state.dailyCampaignPhase === 'created' ? items.length : 0)),
    waiting: value(['waiting', 'queued', 'pending'], derived.waiting),
    running: value(['running', 'processing', 'active'], derived.running),
    failed: value(['failed', 'errors', 'blocked'], derived.failed),
    draft: value(['draft', 'drafts', 'externalDrafts', 'external_draft'], derived.draft)
  };
}

function dailyStageSource(campaign = state.dailyCampaign) {
  return campaign?.stageCounts || campaign?.progress?.stageCounts || campaign?.progress?.stages || campaign?.stages || campaign?.counts?.stages || null;
}

function dailyCampaignStageDone(stage, campaign = state.dailyCampaign) {
  const source = dailyStageSource(campaign);
  const explicit = dailyCountValue(Array.isArray(source) ? source.find((item) => item?.stage === stage) : source?.[stage]);
  if (explicit != null) return explicit;
  const assignments = dailyCampaignAssignments(campaign);
  if (!assignments.length) return null;
  const wanted = DAILY_CAMPAIGN_STAGES.findIndex(([key]) => key === stage);
  let hasExactStageState = false;
  let completed = 0;
  for (const item of assignments) {
    let itemCompleted = false;
    const stageState = item?.stages?.[stage] || item?.run?.stages?.[stage];
    if (stageState) {
      hasExactStageState = true;
      itemCompleted = ['completed', 'success', 'ready', 'skipped'].includes(String(stageState.status || stageState.state || '').toLowerCase());
      if (itemCompleted) completed += 1;
      continue;
    }
    const current = dailyAssignmentStatus(item).stage;
    const currentIndex = DAILY_CAMPAIGN_STAGES.findIndex(([key]) => key === current);
    if (currentIndex >= 0) {
      hasExactStageState = true;
      itemCompleted = currentIndex > wanted || (currentIndex === wanted && ['completed', 'success', 'external_draft'].includes(dailyAssignmentStatus(item).status));
      if (itemCompleted) completed += 1;
    }
    if (!itemCompleted && stage === 'P7' && (item?.draftId || /external_draft|draft_ready/.test(dailyAssignmentStatus(item).status))) {
      hasExactStageState = true;
      completed += 1;
    }
  }
  return hasExactStageState ? completed : null;
}

function dailySelectionSummary(campaign = state.dailyCampaign) {
  const summary = campaign?.selectionSummary || campaign?.summary?.selection || campaign?.summary || {};
  const assignments = dailyCampaignAssignments(campaign);
  const byTier = (tiers) => assignments.filter((item) => tiers.includes(String(item?.selectionTier || item?.selection?.tier || ''))).length;
  const count = (key, fallback) => dailyCountValue(summary[key]) ?? fallback;
  const titles = assignments.map((item) => String(item?.title || item?.book?.title || item?.input?.title || '').trim().toLowerCase()).filter(Boolean);
  return {
    uniqueHigh: count('highQualityUnique', byTier(['unique_high'])),
    expanded: count('expandedUnique', byTier(['unique_expanded', 'unique_current'])),
    repeat: count('repeatedForQuality', byTier(['quality_repeat'])),
    backfill: count('backfilled', byTier(['quality_backfill'])),
    uniqueTitles: count('uniqueTitles', titles.length ? new Set(titles).size : null)
  };
}

function dailyCampaignPreviewReady() {
  if (state.dailyCampaignPhase !== 'preview' || dailyCampaignIsStale()) return false;
  const assignments = dailyCampaignAssignments();
  const routes = dailyCampaignRoutes();
  return assignments.length === 36 && routes.length === 12 && routes.every((route) => route.online === true) && Boolean(state.dailyCampaignConfirmationToken);
}

function dailyCampaignCapabilitiesReady() {
  const capabilities = state.capabilities || {};
  // Daily social campaigns produce video and copy only; poster/image
  // generation is optional and may be intentionally paused.
  return paidMediaAvailable() && ['storage', 'pipeline', 'llm', 'video', 'publishing'].every((key) => capabilities[key] === true);
}

function dailyCampaignFreshnessLabel(campaign = state.dailyCampaign) {
  if (!campaign) return '待预检';
  if (dailyCampaignIsStale(campaign)) return '快照已过期';
  const generatedAt = Date.parse(campaign.snapshotGeneratedAt || campaign.generatedAt || campaign.snapshot?.generatedAt || campaign.updatedAt || '');
  if (!Number.isFinite(generatedAt)) return '实时收据已核验';
  return `${new Date(generatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} 快照`;
}

function dailySlotTone(item) {
  const { status } = dailyAssignmentStatus(item);
  if (/failed|error|ambiguous/.test(status)) return 'failed';
  if (/external_draft|draft_ready|drafted/.test(status) || item?.draftId || item?.publication?.externalDraftId) return 'draft';
  if (/queued|waiting|prepared|pending|capacity|limit/.test(status)) return 'waiting';
  return '';
}

function dailySlotHtml(item, slot, accountIndex) {
  if (!item) return `<article class="daily-slot empty"><span>SLOT ${accountIndex * 3 + slot}</span><small>待实时预览</small></article>`;
  const profile = dailyAssignmentProfile(item);
  const title = item.title || item.book?.title || item.input?.title || '待核验书名';
  const tier = item.selectionTier || item.selection?.tier || '待记录选书层级';
  const form = profile.creativeForm || item.creativeForm || '创意形式待锁定';
  const score = item.qualityScore ?? item.selection?.qualityScore ?? item.campaignScore;
  const rankingDays = Number(item.rankingWindowDays || item.p0Selection?.windowDays || item.input?.p0Selection?.windowDays || 0);
  const completion = String(item.completionStatus || item.p0Selection?.filters?.complete || item.input?.p0Selection?.filters?.complete || '');
  const rankingLabel = rankingDays ? `${rankingDays}天${completion || '实时榜'}` : '';
  const status = dailyAssignmentStatus(item);
  const stateLabel = item.draftId || /external_draft|draft_ready/.test(status.status) ? '草稿已就绪' : status.stage || status.status || '已选书';
  return `<article class="daily-slot ${dailySlotTone(item)}"><header><span>SLOT ${accountIndex * 3 + slot}</span><b>${escapeHtml(stateLabel)}</b></header><h3 title="${escapeHtml(title)}">${escapeHtml(title)}</h3><p><span>${escapeHtml(String(tier).replaceAll('_', ' '))}</span><span>${escapeHtml(String(form).replaceAll('_', ' '))}</span>${rankingLabel ? `<span>${escapeHtml(rankingLabel)}</span>` : ''}${score != null ? `<span>质量 ${escapeHtml(score)}</span>` : ''}</p></article>`;
}

function renderDailyCampaign() {
  const panel = $('#dailyCampaignPanel');
  if (!panel) return;
  const campaign = state.dailyCampaign;
  const assignments = dailyCampaignAssignments(campaign);
  const routes = dailyCampaignRoutes(campaign);
  const metrics = dailyCampaignOutcomeMetrics(campaign);
  const mediaAvailable = paidMediaAvailable();
  const campaignCapabilitiesReady = dailyCampaignCapabilitiesReady();
  const remaining = Number(state.videoLimit?.remaining ?? state.videoLimit?.limit ?? 40);
  const capability = $('#dailyCampaignCapability');
  capability.className = `daily-campaign-capability ${campaignCapabilitiesReady ? remaining > 0 ? '' : 'queued' : 'blocked'}`;
  capability.innerHTML = campaignCapabilitiesReady
    ? remaining > 0 ? `<i data-lucide="circle-check"></i><b>生产链路可用 · 今日视频余 ${remaining}</b>` : '<i data-lucide="clock-3"></i><b>今日额度已满 · 后端排队</b>'
    : mediaAvailable ? '<i data-lucide="circle-alert"></i><b>生产链路配置未全部就绪</b>' : '<i data-lucide="circle-pause"></i><b>服务端未开放付费媒体</b>';
  panel.setAttribute('aria-busy', state.dailyCampaignLoading ? 'true' : 'false');
  $('#dailyCampaignAccountCount').textContent = campaign ? String(routes.filter((route) => route.online === true).length) : '12';
  $('#dailyCampaignSlotCount').textContent = String(assignments.length || 36);
  $('#dailyCampaignFreshness').textContent = dailyCampaignFreshnessLabel(campaign);
  $('#dailyCampaignAccounts').innerHTML = routes.map((route) => `<span class="daily-account-chip ${route.online === true ? 'online' : route.online === false ? 'offline' : ''}"><i></i>${escapeHtml(route.accountTitle)} · ${escapeHtml(dailyPlatformLabel(route.platform))}</span>`).join('');

  const selection = dailySelectionSummary(campaign);
  const summaryValue = (value) => value == null ? '—' : String(value);
  $('#dailyCampaignTierSummary').innerHTML = [
    ['优质全局唯一', selection.uniqueHigh, ''], ['扩展仍唯一', selection.expanded, ''],
    ['为质量解释重复', selection.repeat, 'fallback'], ['质量回填', selection.backfill, 'backfill'], ['本次唯一书名', selection.uniqueTitles, '']
  ].map(([label, value, tone]) => `<article class="${tone}"><span>${label}</span><strong>${summaryValue(value)}</strong></article>`).join('');

  $('#dailyCampaignIdentity').textContent = state.dailyCampaignId ? `Campaign ${state.dailyCampaignId}` : '尚未创建 Campaign';
  const updatedAt = Date.parse(campaign?.updatedAt || campaign?.createdAt || '');
  $('#dailyCampaignUpdated').textContent = Number.isFinite(updatedAt) ? `更新 ${new Date(updatedAt).toLocaleString('zh-CN', { hour12: false })}` : state.dailyCampaignLoading ? '正在读取' : '等待预览';
  $('#dailyCampaignStageCounts').innerHTML = DAILY_CAMPAIGN_STAGES.map(([stage, label]) => {
    const done = dailyCampaignStageDone(stage, campaign);
    const progress = done == null ? 0 : Math.max(0, Math.min(100, done / 36 * 100));
    return `<article class="daily-stage-count" style="--stage-progress:${progress}%"><span>${stage}</span><strong>${done == null ? '—' : done}/36</strong><small>${label}</small></article>`;
  }).join('');
  $('#dailyCampaignOutcomeCounts').innerHTML = [
    ['已建任务', metrics.created, ''], ['等待 / 排队', metrics.waiting, 'waiting'], ['生产中', metrics.running, ''], ['失败 / 歧义', metrics.failed, 'failed'], ['SocialEcho 草稿', metrics.draft, 'draft']
  ].map(([label, value, tone]) => `<article class="${tone}"><span>${label}</span><strong>${value}</strong></article>`).join('');

  const notice = $('#dailyCampaignNotice');
  notice.className = 'daily-campaign-notice';
  if (state.dailyCampaignPhase === 'create_ambiguous') {
    notice.classList.add('warning');
    notice.textContent = '创建请求的返回结果不确定，已禁止重复付费提交。请用右上角刷新按 Campaign ID 对账；只有后端确认仍是 preview 才会重新解锁。';
  } else if (state.dailyCampaignError) {
    notice.classList.add('error');
    notice.textContent = state.dailyCampaignError;
  } else if (state.dailyCampaignLoading) {
    notice.textContent = state.dailyCampaignAction === 'create' ? '正在幂等创建 36 个 durable run；请勿重复点击。' : '正在核验 12 个账号、实时三轴榜单和 36 个选书位。';
  } else if (dailyCampaignIsStale(campaign)) {
    notice.classList.add('error');
    notice.textContent = '这份选书快照或 P0 收据已过期，不能创建付费任务；请重新预览实时榜单。';
  } else if (state.dailyCampaignPhase === 'created') {
    notice.classList.add(metrics.failed ? 'warning' : 'success');
    notice.textContent = `已按 Campaign ID 精确跟踪 ${metrics.total} 个 slot：${metrics.draft} 条 SocialEcho 定时任务，${metrics.waiting} 条等待 / 排队，${metrics.failed} 条失败或歧义。不会立即发布。`;
  } else if (dailyCampaignPreviewReady()) {
    notice.classList.add('success');
    notice.textContent = '预览已锁定 12 个在线账号和 36 个优质 slot。勾选一次性付费确认后才能创建；SocialEcho 将保存 status:1 + scheduled_at 定时任务。';
  } else if (state.dailyCampaignPhase === 'preview') {
    notice.classList.add('warning');
    notice.textContent = assignments.length !== 36 ? `预览只返回 ${assignments.length}/36 个 slot，已禁止创建。` : '预览尚未返回一次性付费确认 token，已禁止创建。';
  } else {
    notice.textContent = '先预览：后台会核验 12 个 SocialEcho 账号、实时榜单、36 个选书与今日视频额度，不会产生付费任务。';
  }

  const preview = $('#previewDailyCampaign');
  preview.disabled = state.dailyCampaignLoading || state.dailyCampaignPhase === 'create_ambiguous';
  preview.classList.toggle('loading', state.dailyCampaignLoading && state.dailyCampaignAction === 'preview');
  preview.innerHTML = state.dailyCampaignLoading && state.dailyCampaignAction === 'preview' ? '<i data-lucide="loader-circle"></i><span>正在实时预览</span>' : '<i data-lucide="scan-search"></i><span>预览今日选书</span>';
  const refresh = $('#refreshDailyCampaign');
  refresh.hidden = !state.dailyCampaignId;
  refresh.disabled = state.dailyCampaignLoading;
  const retryCreative = $('#retryDailyCampaignCreative');
  retryCreative.hidden = !state.dailyCampaignId || Number(metrics.failed || 0) < 1;
  retryCreative.disabled = state.dailyCampaignLoading;
  const ready = dailyCampaignPreviewReady() && campaignCapabilitiesReady && state.dailyCampaignPhase !== 'created';
  const checkbox = $('#dailyCampaignPaidConfirm');
  checkbox.disabled = !ready || state.dailyCampaignLoading;
  if (!ready) checkbox.checked = false;
  $('#dailyCampaignPaidLabel').classList.toggle('disabled', checkbox.disabled);
  const create = $('#createDailyCampaign');
  create.disabled = !ready || !checkbox.checked || state.dailyCampaignLoading;
  create.classList.toggle('loading', state.dailyCampaignLoading && state.dailyCampaignAction === 'create');
  create.innerHTML = state.dailyCampaignLoading && state.dailyCampaignAction === 'create'
    ? '<i data-lucide="loader-circle"></i><span>正在创建 36 条</span>'
    : remaining < 36 && mediaAvailable ? '<i data-lucide="clock-3"></i><span>创建 36 条（超额后端排队）</span>' : '<i data-lucide="sparkles"></i><span>一键创建 36 条生产任务</span>';

  $('#dailyCampaignSlots').innerHTML = routes.map((route, accountIndex) => {
    const accountItems = assignments.filter((item) => dailyAssignmentAccountId(item) === route.accountId);
    return `<section class="daily-account-row"><header class="daily-account-route"><span>${accountIndex + 1}</span><div><strong>${escapeHtml(route.accountTitle)}</strong><small>${escapeHtml(route.appKey || '')} · ${escapeHtml(dailyPlatformLabel(route.platform))} · ${route.accountId}</small></div></header>${[1, 2, 3].map((slot) => {
      const item = accountItems.find((candidate, index) => Number(candidate?.slot || candidate?.slotIndex || candidate?.campaignSlot || candidate?.input?.campaign?.slot || index + 1) === slot);
      return dailySlotHtml(item, slot, accountIndex);
    }).join('')}</section>`;
  }).join('');
}

async function previewDailyCampaign() {
  if (state.dailyCampaignLoading) return;
  state.dailyCampaignLoading = true;
  state.dailyCampaignAction = 'preview';
  state.dailyCampaignError = '';
  state.dailyCampaignConfirmationToken = '';
  renderDailyCampaign(); icons();
  try {
    const body = await api('/api/daily-campaign', {
      method: 'POST', timeoutMs: 780000,
      body: JSON.stringify({ action: 'preview', accountIds: DAILY_CAMPAIGN_ACCOUNT_IDS, accountCount: 12, itemsPerAccount: 3, slotsPerAccount: 3, totalSlots: 36, avoidDays: 14, autoSubmit: true })
    });
    applyDailyCampaignResponse(body, 'preview');
    showToast('今日 12 × 3 选书预览已生成，未创建付费任务');
  } catch (error) {
    state.dailyCampaignError = error.message || '无法生成今日预览';
    showToast(state.dailyCampaignError, 'error');
  } finally {
    state.dailyCampaignLoading = false;
    state.dailyCampaignAction = '';
    renderDailyCampaign(); renderCapabilities(); icons();
  }
}

async function createDailyCampaign() {
  if (state.dailyCampaignLoading || !dailyCampaignPreviewReady()) return;
  if (!dailyCampaignCapabilitiesReady()) { showToast('服务端存储、榜单、AI、媒体或 SocialEcho 能力未全部就绪', 'error'); return; }
  if (!$('#dailyCampaignPaidConfirm').checked) { showToast('请先勾选本次 36 条一次性付费确认'); return; }
  state.dailyCampaignLoading = true;
  state.dailyCampaignAction = 'create';
  state.dailyCampaignError = '';
  renderDailyCampaign(); icons();
  try {
    const body = await api('/api/daily-campaign', {
      method: 'POST', timeoutMs: 780000,
      body: JSON.stringify({
        action: 'create', campaignId: state.dailyCampaignId, confirmationToken: state.dailyCampaignConfirmationToken,
        confirmPaid: true, paidAuthorized: true, autoSubmit: true,
        accountIds: DAILY_CAMPAIGN_ACCOUNT_IDS, accountCount: 12, itemsPerAccount: 3, slotsPerAccount: 3, totalSlots: 36
      })
    });
    applyDailyCampaignResponse(body, 'create');
    $('#dailyCampaignPaidConfirm').checked = false;
    showToast('已创建 36 条 durable 生产任务；完成后按排期提交 SocialEcho status:1 定时任务');
  } catch (error) {
    const definitive = Number(error?.status || 0) >= 400 && Number(error?.status || 0) < 500;
    state.dailyCampaignPhase = definitive ? 'preview' : 'create_ambiguous';
    if (!definitive && state.dailyCampaignId) {
      try { localStorage.setItem('nf_social:daily_campaign_id', state.dailyCampaignId); } catch {}
    }
    state.dailyCampaignError = error.message || '无法创建今日 Campaign';
    if (error?.status === 401) showLogin();
    showToast(definitive ? state.dailyCampaignError : '创建返回不确定，已禁止重发；请刷新 Campaign 对账', 'error');
  } finally {
    state.dailyCampaignLoading = false;
    state.dailyCampaignAction = '';
    renderDailyCampaign(); renderCapabilities(); icons();
  }
}

async function retryDailyCampaignCreative() {
  if (!state.dailyCampaignId || state.dailyCampaignLoading) return;
  state.dailyCampaignLoading = true;
  state.dailyCampaignAction = 'retry_creative';
  renderDailyCampaign(); icons();
  try {
    const body = await api('/api/daily-campaign', {
      method: 'POST', timeoutMs: 120000,
      body: JSON.stringify({ action: 'retry_failed_creative', campaignId: state.dailyCampaignId })
    });
    applyDailyCampaignResponse(body);
    showToast(`已重新入队 ${Number(body.retried || 0)} 条失败创意；付费媒体任务未被重试`);
    await kickWorker();
  } catch (error) {
    state.dailyCampaignError = error.message || '无法重试失败创意';
    showToast(state.dailyCampaignError, 'error');
  } finally {
    state.dailyCampaignLoading = false;
    state.dailyCampaignAction = '';
    renderDailyCampaign(); icons();
  }
}

async function loadDailyCampaign({ silent = false } = {}) {
  if (!state.dailyCampaignId || state.dailyCampaignLoading) return;
  state.dailyCampaignLoading = true;
  state.dailyCampaignAction = 'refresh';
  if (!silent) { renderDailyCampaign(); icons(); }
  try {
    const body = await api(`/api/daily-campaign?campaignId=${encodeURIComponent(state.dailyCampaignId)}`, { timeoutMs: 45000 });
    applyDailyCampaignResponse(body);
  } catch (error) {
    state.dailyCampaignError = error.message || '无法读取 Campaign 状态';
    if (!silent) showToast(state.dailyCampaignError, 'error');
  } finally {
    state.dailyCampaignLoading = false;
    state.dailyCampaignAction = '';
    renderDailyCampaign(); renderCapabilities(); icons();
  }
}

function showToast(message, kind = '') {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 4600);
}

const publicationStatusLabels = {
  ready_for_review: '内部草稿待确认', uploading: '上传视频中', submitting: '保存草稿中', external_draft: 'SocialEcho 草稿已就绪', submitted: '已提交平台',
  published: '已发布', publish_ambiguous: '需核对平台记录', failed: '提交失败', internal_draft: '内部草稿（未提交）'
};

function publicationScheduleLabel(draft) {
  const mode = String(draft?.deliveryMode || '').toLowerCase();
  const scheduledAt = Date.parse(draft?.scheduledAt || '');
  if (draft?.status === 'external_draft' && mode === 'scheduled' && Number.isFinite(scheduledAt)) {
    return `已创建定时任务 · ${new Date(scheduledAt).toLocaleString('zh-CN', { hour12: false })}`;
  }
  if (mode === 'scheduled' && Number.isFinite(scheduledAt)) {
    return `待提交定时 · ${new Date(scheduledAt).toLocaleString('zh-CN', { hour12: false })}`;
  }
  return 'status:0 内部草稿 · 未排期';
}

function publicationAccountOptions(draft) {
  const placeholder = `<option value="">选择发布账号</option>`;
  const options = state.publicationAccounts.map((account) => {
    const disabled = account.status !== 1 || !account.supported;
    const suffix = account.supported ? '' : ' · 暂未开放';
    return `<option value="${account.id}" ${Number(draft.accountId) === account.id ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${escapeHtml(account.title || account.account)} · ${escapeHtml(account.platformTitle || account.platform)}${suffix}</option>`;
  }).join('');
  return placeholder + options;
}

function updatePublicationDraft(id, patch) {
  const draft = state.publicationDrafts.find((item) => item.id === id);
  if (!draft) return;
  Object.assign(draft, patch);
  clearTimeout(state.publicationSaveTimers.get(id));
  const timer = setTimeout(async () => {
    state.publicationSaveTimers.delete(id);
    try {
      const body = await api('/api/publications', { method: 'PATCH', body: JSON.stringify({ id, ...patch }) });
      const index = state.publicationDrafts.findIndex((item) => item.id === id);
      if (index >= 0) state.publicationDrafts[index] = body.draft;
      const marker = document.querySelector(`[data-publication-saved="${id}"]`);
      if (marker) marker.textContent = '已自动保存';
    } catch (error) {
      const marker = document.querySelector(`[data-publication-saved="${id}"]`);
      if (marker) marker.textContent = '保存失败';
      showToast(error.message, 'error');
    }
  }, 450);
  const marker = document.querySelector(`[data-publication-saved="${id}"]`);
  if (marker) marker.textContent = '正在保存…';
}

function bindPublicationWorkbench() {
  const list = $('#publicationList');
  if (!list) return;
  list.querySelectorAll('[data-publication-caption]').forEach((input) => input.addEventListener('input', () => updatePublicationDraft(input.dataset.publicationCaption, { caption: input.value })));
  list.querySelectorAll('[data-publication-account]').forEach((select) => select.addEventListener('change', () => {
    const account = state.publicationAccounts.find((item) => item.id === Number(select.value));
    updatePublicationDraft(select.dataset.publicationAccount, { accountId: Number(select.value), accountTitle: account?.title || '', platform: account?.platform || '', publishType: account?.publishType || '' });
  }));
  list.querySelectorAll('[data-publication-post]').forEach((select) => select.addEventListener('change', () => {
    const draft = state.publicationDrafts.find((item) => item.id === select.dataset.publicationPost);
    const postIndex = Number(select.value);
    const caption = draft?.posts?.[postIndex]?.content || '';
    if (!draft || !caption) return;
    draft.postIndex = postIndex;
    draft.caption = caption;
    const textarea = list.querySelector(`[data-publication-caption="${draft.id}"]`);
    if (textarea) textarea.value = caption;
    updatePublicationDraft(draft.id, { postIndex, caption });
  }));
  list.querySelectorAll('[data-publication-publish]').forEach((button) => button.addEventListener('click', () => publishPublication(button.dataset.publicationPublish)));
  list.querySelectorAll('[data-publication-reconcile]').forEach((button) => button.addEventListener('click', () => reconcilePublication(button.dataset.publicationReconcile)));
}

function renderPublicationWorkbench() {
  const section = $('#publicationWorkbench');
  const list = $('#publicationList');
  if (!section || !list) return;
  // Keep terminal provider states visible. Hiding external_draft made a
  // successful P7 look like “0 条待审核” and forced operators to guess whether
  // the API call had actually created anything.
  const workbenchStatuses = new Set(['ready_for_review', 'uploading', 'submitting', 'publish_ambiguous', 'failed', 'external_draft', 'submitted', 'published']);
  const visible = state.publicationDrafts.filter((draft) => workbenchStatuses.has(draft.status));
  section.hidden = !state.publicationLoading && !visible.length;
  const reviewCount = visible.filter((draft) => draft.status === 'ready_for_review').length;
  const externalCount = visible.filter((draft) => ['external_draft', 'submitted', 'published'].includes(draft.status)).length;
  $('#publicationCount').textContent = externalCount ? `${reviewCount} 条待审核 · ${externalCount} 条已入 SocialEcho` : `${reviewCount} 条待审核`;
  section.classList.toggle('is-expanded', state.publicationExpanded);
  const toggle = $('#togglePublicationWorkbench');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(state.publicationExpanded));
    toggle.querySelector('small').textContent = state.publicationExpanded ? '收起审核区' : '点击进入审核';
    toggle.onclick = () => { state.publicationExpanded = !state.publicationExpanded; renderPublicationWorkbench(); };
  }
  list.hidden = !state.publicationExpanded;
  if (state.publicationLoading && !visible.length) {
    list.innerHTML = '<div class="publication-empty"><i data-lucide="loader-circle"></i><span>正在读取待审核草稿</span></div>';
    icons();
    return;
  }
  list.innerHTML = visible.map((draft) => {
    const busy = state.publicationBusy.has(draft.id) || ['uploading', 'submitting'].includes(draft.status);
    const terminal = ['external_draft', 'submitted', 'published'].includes(draft.status);
    const canPublish = draft.status === 'ready_for_review' && draft.accountId && !busy;
    const account = state.publicationAccounts.find((item) => item.id === Number(draft.accountId));
    const status = publicationStatusLabels[draft.status] || draft.status;
    const terminalProviderState = ['external_draft', 'submitted', 'published'].includes(draft.status);
    const externalId = draft.provider?.externalDraftId || '';
    const internalId = draft.id || '';
    const providerAction = draft.status === 'external_draft'
      ? `<a class="primary-command" href="${escapeHtml(draft.provider?.socialEchoUrl || 'https://app.socialecho.net/')}" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i><span>去 SocialEcho 预览</span></a>`
      : terminalProviderState
        ? `<span class="publication-terminal-note">${draft.status === 'published' ? '已发布（只读）' : '已提交平台（只读）'}</span>`
        : `<button class="primary-command" data-publication-publish="${escapeHtml(draft.id)}" type="button" ${canPublish ? '' : 'disabled'}><i data-lucide="save"></i><span>${busy ? '正在保存草稿' : '保存到 SocialEcho 草稿'}</span></button>`;
    return `<article class="publication-draft status-${escapeHtml(draft.status)}" data-publication-id="${escapeHtml(draft.id)}">
      <div class="publication-media"><img src="${escapeHtml(draft.previewImageUrl || draft.book?.cover || '')}" alt="${escapeHtml(draft.book?.title || '素材首帧')}" loading="lazy"><span>${escapeHtml(account?.platformTitle || draft.platform || '待选平台')}</span></div>
      <div class="publication-editor">
        <header><div><span>${escapeHtml(status)}</span><h3>${escapeHtml(draft.book?.title || '未命名素材')}</h3></div><small data-publication-saved="${escapeHtml(draft.id)}">已保存为内部草稿</small></header>
        <div class="publication-fields">
          <label>${draft.routeLocked ? 'P0 锁定账号' : '发布账号'}<select data-publication-account="${escapeHtml(draft.id)}" ${terminal || busy || draft.routeLocked ? 'disabled' : ''}>${publicationAccountOptions(draft)}</select></label>
          <label>文案版本<select data-publication-post="${escapeHtml(draft.id)}" ${terminal || busy ? 'disabled' : ''}>${draft.posts.map((post) => `<option value="${post.index}" ${Number(draft.postIndex) === post.index ? 'selected' : ''}>版本 ${post.index + 1}${post.type ? ` · ${escapeHtml(post.type)}` : ''}</option>`).join('')}</select></label>
        </div>
        <label class="publication-caption">英文发布文案<textarea data-publication-caption="${escapeHtml(draft.id)}" maxlength="12000" ${terminal || busy ? 'disabled' : ''}>${escapeHtml(draft.caption)}</textarea></label>
        <div class="publication-tracking"><span>Code <strong>${escapeHtml(draft.tracking?.code || '不创建')}</strong></span>${draft.tracking?.shortUrl ? `<a href="${escapeHtml(draft.tracking.shortUrl)}" target="_blank" rel="noreferrer">${escapeHtml(draft.tracking.shortUrl)}</a>` : '<span>本品牌暂不创建归因链接</span>'}</div>
        <div class="publication-provider-meta"><span>${escapeHtml(publicationScheduleLabel(draft))}</span><span>内部 ID ${escapeHtml(internalId)}</span>${externalId && terminalProviderState ? `<span>外部 ID ${escapeHtml(externalId)}</span>` : '<span>外部 ID 待确认</span>'}</div>
        ${draft.error ? `<p class="publication-error">${escapeHtml(draft.error)}</p>` : ''}
        <footer><span>${terminalProviderState ? '已取得 SocialEcho 外部记录；正式发布仍由人工操作' : draft.deliveryMode === 'scheduled' ? '确认后提交 status:1 + scheduled_at，不会立即发布' : '确认后保存 status:0 草稿，不会正式发布'}</span>${draft.status === 'publish_ambiguous' ? `<button class="secondary-command" data-publication-reconcile="${escapeHtml(draft.id)}" type="button"><i data-lucide="refresh-cw"></i>核对平台记录</button>` : ''}${providerAction}</footer>
      </div>
    </article>`;
  }).join('');
  bindPublicationWorkbench();
  icons();
}

async function loadPublicationAccounts() {
  if (state.publicationAccountLoading || state.publicationAccounts.length) return;
  state.publicationAccountLoading = true;
  try {
    const body = await api('/api/publications?action=accounts', { timeoutMs: 60000 });
    state.publicationAccounts = body.accounts || [];
    renderPublicationWorkbench();
  } catch (error) { showToast(`SocialEcho 账号读取失败：${error.message}`, 'error'); }
  finally { state.publicationAccountLoading = false; }
}

async function loadPublications({ silent = false } = {}) {
  if (state.publicationLoading) return;
  state.publicationLoading = true;
  renderPublicationWorkbench();
  try {
    const body = await api('/api/publications', { method: 'POST', body: JSON.stringify({ action: 'sync' }), timeoutMs: 60000 });
    state.publicationDrafts = body.drafts || [];
    if (state.publicationDrafts.some((draft) => ['ready_for_review', 'failed'].includes(draft.status))) loadPublicationAccounts();
  } catch (error) {
    if (error.status === 401) showLogin();
    else if (!silent) showToast(error.message, 'error');
  } finally { state.publicationLoading = false; renderPublicationWorkbench(); renderAdCampaignWorkspace(); renderLeaderboard(); renderTodayRail(); }
}

const adVersionLabels = { original: '原始版', paced: '节奏版', optimized: '优化版' };
const adStatusLabels = { completed: '视频完成', running: '视频生成中', prepared: '等待提交', failed: '视频失败', submit_ambiguous: '提交待对账', localization_failed: '语言处理失败' };

function adDraftFor(item) {
  return state.publicationDrafts.find((draft) => draft.id === item.draft?.internalId) || null;
}

function adStatus(value, readyValues = []) {
  const ready = readyValues.includes(String(value || ''));
  const pending = !ready && !/failed|ambiguous/.test(String(value || ''));
  return `<span class="ad-status ${ready ? 'ready' : pending ? 'pending' : ''}">${escapeHtml(value || 'pending')}</span>`;
}

function renderAdCampaignWorkspace() {
  const section = $('#adCampaignWorkspace');
  const summary = $('#adCampaignSummary');
  const books = $('#adCampaignBooks');
  if (!section || !summary || !books || section.hidden) return;
  const campaign = state.adCampaign;
  if (state.adCampaignLoading && !campaign) {
    summary.innerHTML = '';
    books.innerHTML = '<div class="ad-empty"><i data-lucide="loader-circle"></i><span>正在读取 Campaign</span></div>';
    icons();
    return;
  }
  if (!campaign?.items?.length) {
    summary.innerHTML = '';
    books.innerHTML = '<div class="ad-empty"><i data-lucide="inbox"></i><span>当前没有广告素材 Campaign</span></div>';
    icons();
    return;
  }
  const items = campaign.items;
  const grouped = [...items.reduce((map, item) => {
    if (!map.has(item.title)) map.set(item.title, []);
    map.get(item.title).push(item);
    return map;
  }, new Map()).entries()];
  const completed = items.filter((item) => item.status === 'completed').length;
  const drafts = items.filter((item) => item.draft?.status === 'external_draft').length;
  const tracking = items.filter((item) => item.attribution?.status === 'ready').length;
  const metaBound = items.filter((item) => item.meta?.status === 'bound').length;
  const languageCounts = Object.fromEntries(['en', 'pt', 'es'].map((language) => [language, items.filter((item) => item.language === language).length]));
  summary.innerHTML = [
    ['书籍', grouped.length, `${items.length} 条素材`, 'ready'],
    ['视频', completed, `${items.length} 条`, completed === items.length ? 'ready' : 'pending'],
    ['SocialEcho 草稿', drafts, `${items.length} 条`, drafts === items.length ? 'ready' : 'pending'],
    ['归因', tracking, `${items.length} 条`, tracking === items.length ? 'ready' : 'pending'],
    ['多语言', `${languageCounts.en}/${languageCounts.pt}/${languageCounts.es}`, 'EN / PT / ES', 'ready'],
    ['Meta 已绑定', metaBound, `${items.length} 条`, metaBound === items.length ? 'ready' : 'pending']
  ].map(([label, value, note, status]) => `<article class="${status}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('');
  books.innerHTML = grouped.map(([title, variants]) => {
    variants.sort((left, right) => ['original', 'paced', 'optimized'].indexOf(left.version) - ['original', 'paced', 'optimized'].indexOf(right.version));
    const first = variants.find((item) => item.previewImageUrl) || variants[0];
    const bookDrafts = variants.filter((item) => item.draft?.status === 'external_draft').length;
    const bookMeta = variants.filter((item) => item.meta?.status === 'bound').length;
    const cover = first.previewImageUrl ? `<img class="ad-book-cover" src="${escapeHtml(first.previewImageUrl)}" alt="${escapeHtml(title)} 首帧" loading="lazy">` : '<span class="ad-book-cover-fallback">无首帧</span>';
    const rows = variants.map((item) => {
      const draft = adDraftFor(item);
      const caption = String(draft?.caption || '');
      const meta = item.meta || {};
      const queryId = meta.copywritingId || item.attribution?.linkId || item.attribution?.code || '';
      const metaLines = [['Campaign', meta.campaignId], ['Ad set', meta.adsetId], ['Ad', meta.adId], ['Creative', meta.creativeId], ['Copywriting', meta.copywritingId]].filter(([, value]) => value);
      return `<article class="ad-variant-row" data-ad-item="${escapeHtml(item.id)}">
        <div class="ad-variant-cell"><div class="ad-version"><b>${escapeHtml(adVersionLabels[item.version] || item.version)}</b></div><span class="ad-language">${escapeHtml(item.language.toUpperCase())} / ${escapeHtml(item.country)}</span>${item.revision ? `<span class="ad-status pending">修订 ${item.revision}</span>` : ''}</div>
        <div class="ad-variant-cell"><span>广告正文</span><strong>${caption ? `${caption.length} 字 · XLSX 对应版本` : `${item.captionLength || 0} 字 · 正文同步中`}</strong><details class="ad-copy-details"><summary>查看完整正文</summary><pre>${escapeHtml(caption || '正在从 SocialEcho 草稿读取正文')}</pre></details></div>
        <div class="ad-variant-cell"><span>AC 视频</span><strong>${escapeHtml(adStatusLabels[item.status] || item.status)}</strong><div class="ad-id">${escapeHtml(item.threadId || '尚无 threadId')}</div>${item.priorThreadId ? `<div class="ad-id">旧任务 ${escapeHtml(item.priorThreadId)}</div>` : ''}</div>
        <div class="ad-variant-cell"><span>${escapeHtml(item.attribution?.application || '归因')}</span><strong>Code ${escapeHtml(item.attribution?.code || '—')}</strong>${adStatus(item.attribution?.status, ['ready'])}<div class="ad-links">${item.attribution?.shortUrl ? `<a href="${escapeHtml(item.attribution.shortUrl)}" target="_blank" rel="noreferrer"><i data-lucide="link-2"></i>短链</a>` : ''}${queryId ? `<button type="button" data-ad-query="${escapeHtml(queryId)}"><i data-lucide="chart-spline"></i>数据</button>` : ''}</div></div>
        <div class="ad-variant-cell"><span>SocialEcho</span><strong>${item.draft?.externalId ? `草稿 ${escapeHtml(item.draft.externalId)}` : '尚无草稿'}</strong>${adStatus(item.draft?.status, ['external_draft'])}<div class="ad-links">${item.draft?.externalId ? '<a href="https://app.socialecho.net/publish" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i>预览</a>' : ''}</div></div>
        <div class="ad-variant-cell"><span>Meta 映射</span><strong>${meta.status === 'bound' ? '已绑定' : '未绑定'}</strong>${adStatus(meta.status, ['bound'])}<div class="ad-meta-list">${metaLines.length ? metaLines.map(([label, value]) => `<span>${label} ${escapeHtml(value)}</span>`).join('') : '<span>等待 campaign / ad set / ad / creative ID</span>'}</div></div>
      </article>`;
    }).join('');
    return `<section class="ad-book-group"><header class="ad-book-head">${cover}<div><h2>${escapeHtml(title)}</h2><p>${variants.map((item) => `${item.language.toUpperCase()}/${item.country}`).filter((value, index, all) => all.indexOf(value) === index).join(' · ')}</p></div><div class="ad-book-progress"><span>${bookDrafts}/${variants.length} 草稿</span><span>${bookMeta}/${variants.length} Meta</span></div></header><div class="ad-variant-head"><span>版本</span><span>正文</span><span>AC</span><span>归因</span><span>SocialEcho</span><span>Meta</span></div>${rows}</section>`;
  }).join('');
  books.querySelectorAll('[data-ad-query]').forEach((button) => button.addEventListener('click', () => {
    $('#dataQueryInput').value = button.dataset.adQuery;
    $('#dataQueryDialog').showModal();
    runDataQuery();
  }));
  icons();
}

async function loadAdCampaign({ refreshList = false, silent = false } = {}) {
  if (state.adCampaignLoading) return;
  state.adCampaignLoading = true;
  renderAdCampaignWorkspace();
  try {
    if (refreshList || !state.adCampaigns.length) {
      const list = await api('/api/ad-video-campaign?action=list&limit=30', { timeoutMs: 30000 });
      state.adCampaigns = list.campaigns || [];
      if (!state.adCampaigns.some((item) => item.id === state.adCampaignId)) state.adCampaignId = state.adCampaigns[0]?.id || 'whatsapp-ads-20260806';
    }
    const body = await api(`/api/ad-video-campaign?campaignId=${encodeURIComponent(state.adCampaignId)}`, { timeoutMs: 30000 });
    state.adCampaign = body.campaign || null;
    const select = $('#adCampaignSelect');
    if (select) select.innerHTML = state.adCampaigns.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.adCampaignId ? 'selected' : ''}>${escapeHtml(item.id)} · ${item.bookCount} 本 / ${item.itemCount} 条</option>`).join('');
  } catch (error) {
    if (!silent) showToast(error.message, 'error');
  } finally {
    state.adCampaignLoading = false;
    renderAdCampaignWorkspace();
  }
}

function adPerformanceDate(daysAgo = 0) {
  const date = new Date(Date.now() - Number(daysAgo || 0) * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((value, part) => ({ ...value, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function adMetric(value, fallback = null) {
  if (value === '' || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function adMetricFrom(value, keys, fallback = null) {
  for (const key of keys) {
    const current = key.split('.').reduce((entry, part) => entry?.[part], value);
    const number = adMetric(current, null);
    if (number != null) return number;
  }
  return fallback;
}

function formatAdInteger(value) {
  const number = adMetric(value, null);
  return number == null ? '—' : Math.round(number).toLocaleString('en-US');
}

function formatAdCurrency(value) {
  const number = adMetric(value, null);
  return number == null ? '—' : `$${number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function adSourceBadge(source, readyLabel = '已连接') {
  const status = String(source?.status || source || 'unmapped');
  const labels = {
    ok: readyLabel, no_data: '暂无数据', unmapped: '待绑定', not_configured: '未配置', unconfigured: '未配置',
    unavailable: '暂不可用', failed: '暂不可用', auth_error: '凭证失效', account_mismatch: '账户不匹配', disabled: '已停用', partial: '部分可用'
  };
  const kind = status === 'ok' ? 'ok' : ['no_data', 'unmapped', 'not_configured', 'unconfigured', 'partial'].includes(status) ? 'warn' : 'error';
  return `<span class="ad-source-state ${kind}">${escapeHtml(labels[status] || status)}</span>`;
}

function adPerformanceItems() {
  const value = state.adPerformance || {};
  return Array.isArray(value.ads) ? value.ads : Array.isArray(value.items) ? value.items : Array.isArray(value.records) ? value.records : [];
}

function socialSourceForAd(ad) {
  const social = ad.social || ad.report || {};
  if (social.primary?.summary) return social.primary;
  if (social.funnel?.status === 'ok') return social.funnel;
  if (social.putreport?.status === 'ok') return social.putreport;
  return social.funnel || social.putreport || social;
}

function renderAdPerformance() {
  const section = $('#adPerformanceWorkspace');
  const summary = $('#adPerformanceSummary');
  const table = $('#adPerformanceTable');
  const notice = $('#adPerformanceNotice');
  if (!section || !summary || !table || section.hidden) return;
  const payload = state.adPerformance || {};
  const items = adPerformanceItems();
  const apiWindow = payload.window || {};
  if (!$('#adPerformanceFrom').value) $('#adPerformanceFrom').value = apiWindow.from || adPerformanceDate(7);
  if (!$('#adPerformanceTo').value) $('#adPerformanceTo').value = apiWindow.to || adPerformanceDate(1);
  const sourceWarnings = Object.values(payload.sourceStatus || {}).flatMap((source) => Array.isArray(source?.warnings) ? source.warnings : []);
  const warnings = [...new Set([state.adPerformanceError, ...(Array.isArray(payload.warnings) ? payload.warnings : []), ...sourceWarnings].filter(Boolean))];
  notice.hidden = !warnings.length;
  notice.classList.toggle('error', Boolean(state.adPerformanceError));
  notice.textContent = warnings.join(' · ');
  if (state.adPerformanceLoading && !items.length) {
    summary.innerHTML = '';
    table.innerHTML = '<div class="ad-performance-loading"><i data-lucide="loader-circle"></i><span>正在读取广告数据</span></div>';
    icons();
    return;
  }
  if (!items.length) {
    summary.innerHTML = '';
    table.innerHTML = '<div class="ad-performance-empty"><i data-lucide="inbox"></i><span>暂无已登记广告</span></div>';
    icons();
    return;
  }
  const enabled = items.filter((item) => item.registry?.active !== false && item.active !== false);
  const metaStatus = String(payload.sourceStatus?.meta?.status || 'unconfigured');
  const metaAvailable = ['ok', 'partial', 'no_data'].includes(metaStatus);
  const spend = enabled.reduce((total, item) => total + (adMetricFrom(item, ['meta.summary.spend', 'meta.metrics.spend', 'meta.spend'], 0) || 0), 0);
  const impressions = enabled.reduce((total, item) => total + (adMetricFrom(item, ['meta.summary.impressions', 'meta.metrics.impressions', 'meta.impressions'], 0) || 0), 0);
  const clicks = enabled.reduce((total, item) => total + (adMetricFrom(item, ['meta.summary.linkClicks', 'meta.metrics.linkClicks', 'meta.linkClicks', 'meta.inlineLinkClicks', 'meta.clicks'], 0) || 0), 0);
  const reportMapped = enabled.filter((item) => item.reportId || item.registry?.reportId || item.mapping?.reportId).length;
  const beidouMapped = enabled.filter((item) => item.beidouCampaignName || item.registry?.beidouCampaignName || item.mapping?.beidouCampaignName).length;
  summary.innerHTML = [
    ['白名单广告', enabled.length, `${items.length} 条已登记`, ''],
    ['Meta 花费', metaAvailable ? formatAdCurrency(payload.summary?.meta?.spend ?? spend) : '—', `${apiWindow.from || $('#adPerformanceFrom').value} 至 ${apiWindow.to || $('#adPerformanceTo').value}`, 'meta'],
    ['展示', metaAvailable ? formatAdInteger(payload.summary?.meta?.impressions ?? impressions) : '—', 'Meta Insights', 'meta'],
    ['链接点击', metaAvailable ? formatAdInteger(payload.summary?.meta?.linkClicks ?? clicks) : '—', clicks > 0 ? `平均 ${formatAdCurrency(spend / clicks)}` : 'Meta Insights', 'meta'],
    ['源映射', `${reportMapped}/${beidouMapped}`, '社媒报表 / 北斗', 'report']
  ].map(([label, value, note, kind]) => `<article class="${kind}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join('');
  const rows = items.map((item) => {
    const registry = item.registry || item;
    const meta = item.meta || {};
    const hasMeta = Boolean(item.meta);
    const metrics = meta.summary || meta.metrics || meta;
    const social = socialSourceForAd(item);
    const socialSummary = social?.summary || social?.metrics || {};
    const beidou = item.beidou || {};
    const beidouSummary = beidou.summary || beidou.metrics || beidou;
    const metaAdId = String(item.metaAdId || registry.metaAdId || meta.adId || meta.id || '');
    const language = String(item.language || registry.language || 'other').toLowerCase();
    const label = String(meta.adName || meta.name || item.name || registry.name || `Meta ${metaAdId}`);
    const effectiveStatus = String(meta.effectiveStatus || meta.effective_status || meta.delivery || (meta.rows?.length ? '有数据' : (registry.active === false ? '已停用' : '—')));
    const itemSpend = adMetricFrom(metrics, ['spend']);
    const itemImpressions = adMetricFrom(metrics, ['impressions']);
    const itemClicks = adMetricFrom(metrics, ['linkClicks', 'inlineLinkClicks', 'clicks']);
    const itemCpc = adMetricFrom(metrics, ['costPerLinkClick', 'cpc'], itemClicks > 0 && itemSpend != null ? itemSpend / itemClicks : null);
    const metaItemStatus = String(item.metaStatus || (hasMeta ? 'ok' : payload.sourceStatus?.meta?.status || 'no_data'));
    const beidouStatus = String(item.beidouStatus || beidou.status || (beidou.rows ? (beidou.rows.length ? 'ok' : 'no_data') : registry.beidouCampaignName ? payload.sourceStatus?.beidou?.status || 'no_data' : 'unmapped'));
    const socialStatus = String(item.socialStatus || social?.status || (social?.rows ? (social.rows.length ? 'ok' : 'no_data') : registry.reportId ? payload.sourceStatus?.social?.status || 'no_data' : 'unmapped'));
    const beidouCell = beidouStatus === 'ok'
      ? `<span class="ad-performance-number">${formatAdInteger(adMetricFrom(beidouSummary, ['visits', 'totalVisits', 'value'], 0))}</span><span class="ad-performance-sub">Campaign 访问</span>`
      : adSourceBadge(beidouStatus);
    const socialCell = socialStatus === 'ok'
      ? `<span class="ad-performance-number">${formatAdInteger(adMetricFrom(socialSummary, ['pullUv', 'activeUv'], 0))} UV</span><span class="ad-performance-sub">D14 ${formatAdCurrency(adMetricFrom(socialSummary, ['d14Income'], 0))}</span>`
      : adSourceBadge(socialStatus);
    return `<tr class="${registry.active === false ? 'disabled' : ''}">
      <td><div class="ad-performance-name"><span class="ad-performance-language ${escapeHtml(language)}">${escapeHtml(language)}</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(metaAdId)}</small></div></div></td>
      <td>${hasMeta ? `<span class="ad-source-state ${meta.rows?.length || effectiveStatus === 'ACTIVE' ? 'ok' : 'warn'}">${escapeHtml(effectiveStatus)}</span>` : adSourceBadge(metaItemStatus)}</td>
      <td><span class="ad-performance-number">${formatAdCurrency(itemSpend)}</span></td>
      <td><span class="ad-performance-number">${formatAdInteger(itemImpressions)}</span></td>
      <td><span class="ad-performance-number">${formatAdInteger(itemClicks)}</span></td>
      <td><span class="ad-performance-number">${formatAdCurrency(itemCpc)}</span></td>
      <td>${beidouCell}</td><td>${socialCell}</td>
      <td><button class="icon-button ad-performance-row-action" type="button" data-edit-meta-ad="${escapeHtml(metaAdId)}" title="编辑映射"><i data-lucide="pencil"></i></button></td>
    </tr>`;
  }).join('');
  table.innerHTML = `<div class="ad-performance-scroll"><table><thead><tr><th>广告</th><th>投放</th><th>花费</th><th>展示</th><th>链接点击</th><th>CPC</th><th>北斗</th><th>社媒报表</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  table.querySelectorAll('[data-edit-meta-ad]').forEach((button) => button.addEventListener('click', () => openAdRegistry(button.dataset.editMetaAd)));
  icons();
}

async function loadAdPerformance({ force = false, silent = false } = {}) {
  if (state.adPerformanceLoading) return;
  state.adPerformanceLoading = true;
  state.adPerformanceError = '';
  renderAdPerformance();
  const from = $('#adPerformanceFrom').value || adPerformanceDate(7);
  const to = $('#adPerformanceTo').value || adPerformanceDate(1);
  try {
    const query = new URLSearchParams({ from, to });
    if (force) query.set('refresh', '1');
    const body = await api(`/api/ad-performance?${query}`, { timeoutMs: 150000 });
    state.adPerformance = body.performance || body;
  } catch (error) {
    state.adPerformanceError = error.message;
    if (error.status === 401) showLogin();
    else if (!silent) showToast(error.message, 'error');
  } finally {
    state.adPerformanceLoading = false;
    renderAdPerformance();
  }
}

function openAdRegistry(metaAdId = '') {
  const item = adPerformanceItems().find((value) => String(value.metaAdId || value.registry?.metaAdId || value.meta?.adId || value.meta?.id || '') === String(metaAdId));
  const registry = item?.registry || item || {};
  state.adPerformanceEditingId = String(metaAdId || '');
  $('#registryMetaAdId').value = metaAdId || '';
  $('#registryMetaAdId').readOnly = Boolean(metaAdId);
  $('#registryLanguage').value = registry.language || 'pt';
  $('#registryLabel').value = registry.name || item?.meta?.adName || item?.meta?.name || '';
  $('#registryReportDimension').value = registry.reportDimension || registry.mapping?.reportDimension || '';
  $('#registryReportId').value = registry.reportId || registry.mapping?.reportId || '';
  $('#registryBeidouCampaignName').value = registry.beidouCampaignName || registry.mapping?.beidouCampaignName || '';
  $('#registryEnabled').checked = registry.active !== false;
  $('#adRegistryDialog').showModal();
  icons();
}

async function saveAdRegistry(event) {
  event.preventDefault();
  const button = $('#saveAdRegistry');
  button.disabled = true;
  const record = {
    action: 'upsert', metaAdId: $('#registryMetaAdId').value.trim(), language: $('#registryLanguage').value,
    name: $('#registryLabel').value.trim(), reportDimension: $('#registryReportDimension').value,
    reportId: $('#registryReportId').value.trim(), beidouCampaignName: $('#registryBeidouCampaignName').value.trim(),
    active: $('#registryEnabled').checked
  };
  try {
    await api('/api/ad-performance', { method: 'POST', timeoutMs: 45000, body: JSON.stringify(record) });
    $('#adRegistryDialog').close();
    showToast(state.adPerformanceEditingId ? '广告映射已更新' : '广告已加入白名单');
    state.adPerformanceEditingId = '';
    await loadAdPerformance({ force: true, silent: true });
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function publishPublication(id) {
  const draft = state.publicationDrafts.find((item) => item.id === id);
  if (!draft || !draft.accountId || state.publicationBusy.has(id)) return;
  clearTimeout(state.publicationSaveTimers.get(id));
  state.publicationBusy.add(id);
  renderPublicationWorkbench();
  try {
    const body = await api('/api/publications', { method: 'POST', timeoutMs: 360000, body: JSON.stringify({ action: 'save_external_draft', id, accountId: draft.accountId, accountTitle: draft.accountTitle, platform: draft.platform, publishType: draft.publishType, postIndex: draft.postIndex, caption: draft.caption }) });
    const index = state.publicationDrafts.findIndex((item) => item.id === id);
    if (index >= 0) state.publicationDrafts[index] = body.draft;
    showToast('已保存到 SocialEcho 草稿；正式发布仍由你在 SocialEcho 决定');
  } catch (error) {
    if (error.details?.draft) {
      const index = state.publicationDrafts.findIndex((item) => item.id === id);
      if (index >= 0) state.publicationDrafts[index] = error.details.draft;
    }
    showToast(error.details?.ambiguous ? '提交结果不明确，已停止重试；请核对平台记录' : error.message, 'error');
  } finally { state.publicationBusy.delete(id); renderPublicationWorkbench(); }
}

async function reconcilePublication(id) {
  if (state.publicationBusy.has(id)) return;
  state.publicationBusy.add(id); renderPublicationWorkbench();
  try {
    const body = await api('/api/publications', { method: 'POST', body: JSON.stringify({ action: 'reconcile', id }) });
    const index = state.publicationDrafts.findIndex((item) => item.id === id);
    if (index >= 0) state.publicationDrafts[index] = body.draft;
    showToast(body.found ? '已找到对应平台记录' : '暂未找到对应记录，仍保持停止重试');
  } catch (error) { showToast(error.message, 'error'); }
  finally { state.publicationBusy.delete(id); renderPublicationWorkbench(); }
}

function openDetail(id, target = '') {
  $('#detailPanel').hidden = false;
  $('#detailScrim').hidden = false;
  state.selectedId = id;
  state.detailOpen = true;
  state.detailTarget = target;
  state.detailFingerprint = '';
  state.detailError = '';
  render();
  hydrateRunDetail(id);
}

function loadReadyAssetSnapshot(id) {
  if (state.readyAssetCache.has(id)) return Promise.resolve(state.readyAssetCache.get(id));
  if (state.readyAssetRequests.has(id)) return state.readyAssetRequests.get(id);
  const request = api(`/api/runs?id=${encodeURIComponent(id)}&asset=ready`, { timeoutMs: 45000 })
    .then((body) => {
      if (!body?.run) throw new Error('服务端没有返回已生成素材');
      state.readyAssetCache.set(id, body.run);
      return body.run;
    })
    .finally(() => state.readyAssetRequests.delete(id));
  state.readyAssetRequests.set(id, request);
  return request;
}

function warmReadyAssetSnapshots() {
  const queue = state.runs
    .filter((run) => run?._summary && runHasUsableAssets(run) && !state.readyAssetCache.has(run.id))
    .slice(0, 12);
  if (!queue.length) return;
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length) {
      const run = queue.shift();
      try { await loadReadyAssetSnapshot(run.id); } catch {}
    }
  });
  Promise.all(workers).catch(() => {});
}

async function refreshRunAnalytics(id) {
  try {
    const button = document.querySelector(`[data-refresh-analytics="${CSS.escape(id)}"]`);
    if (button) { button.disabled = true; button.classList.add('loading'); }
    const days = Number(document.querySelector(`[data-analytics-days="${CSS.escape(id)}"]`)?.value || 30);
    const body = await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id, action: 'refresh_analytics', days }), timeoutMs: 65000 });
    if (!body?.run) return;
    state.runs = state.runs.map((item) => item.id === id ? body.run : item);
    state.detailFingerprint = '';
    if (state.detailOpen && state.selectedId === id) renderDetail();
  } catch (error) { showToast(`数据刷新失败：${error.message}；已保留上次有效结果`, 'error'); }
  finally {
    const button = document.querySelector(`[data-refresh-analytics="${CSS.escape(id)}"]`);
    if (button) { button.disabled = false; button.classList.remove('loading'); }
  }
}

function renderDataQueryResult(result) {
  const target = $('#dataQueryResult');
  if (!target) return;
  if (!result) { target.innerHTML = '<span>输入追踪值后，系统会同时读取真实漏斗、putreport 和历史快照，并明确标注来源，不把不同来源重复相加。</span>'; return; }
  if (result.error) { target.innerHTML = `<div class="data-query-error"><i data-lucide="circle-alert"></i><strong>${escapeHtml(result.error)}</strong><small>请确认 Code、linkId 或短链属于 NovelFlow。</small></div>`; icons(); return; }
  const summary = result.sources?.socialFunnel?.summary || result.sources?.aggregate?.summary || {};
  const format = (value) => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const sourceStatus = (name, source) => `<article><header><strong>${name}</strong><span>${escapeHtml(source?.status || 'unavailable')}</span></header><div><span>拉起 UV</span><b>${format(source?.summary?.pullUv)}</b></div><div><span>激活 UV</span><b>${format(source?.summary?.activeUv)}</b></div><div><span>D7 收入</span><b>${format(source?.summary?.d7Income)}</b></div><small>${escapeHtml(source?.source || '未返回来源')}</small></article>`;
  target.innerHTML = `<div class="data-query-head"><strong>${escapeHtml(result.identifier || result.input)}</strong><span>${escapeHtml(result.window?.from || '--')} 至 ${escapeHtml(result.window?.to || '--')}</span></div><div class="analytics-grid"><div class="metric"><span>主来源拉起 UV</span><strong>${format(summary.pullUv)}</strong></div><div class="metric"><span>主来源激活 UV</span><strong>${format(summary.activeUv)}</strong></div><div class="metric"><span>激活率</span><strong>${summary.activationRate == null ? '—' : `${format(summary.activationRate)}%`}</strong></div><div class="metric"><span>D7 收入</span><strong>${format(summary.d7Income)}</strong></div></div><div class="data-query-sources">${sourceStatus('Social funnel', result.sources?.socialFunnel)}${sourceStatus('Putreport', result.sources?.putreport)}${sourceStatus('Unified aggregate', result.sources?.aggregate)}</div><p class="data-query-guidance">${escapeHtml(result.guidance || '不同来源是独立视图，不能直接相加。')}</p>`;
  icons();
}

async function runDataQuery() {
  const input = $('#dataQueryInput')?.value.trim();
  const days = Number($('#dataQueryDays')?.value || 30);
  const error = $('#dataQueryError');
  const button = $('#submitDataQuery');
  if (!input) return;
  if (error) error.textContent = '';
  if (button) { button.disabled = true; button.classList.add('loading'); }
  renderDataQueryResult(null);
  try {
    const result = await api(`/api/quick-stats?q=${encodeURIComponent(input)}&days=${days}`, { timeoutMs: 120000 });
    renderDataQueryResult(result);
  } catch (requestError) {
    renderDataQueryResult({ error: requestError.message || '数据查询失败' });
  } finally {
    if (button) { button.disabled = false; button.classList.remove('loading'); }
  }
}

async function hydrateRunDetail(id) {
  const run = state.runs.find((item) => item.id === id);
  if ((!run?._summary && !run?._detailPartial) || state.detailHydrating === id) return;
  state.detailHydrating = id;
  state.detailFingerprint = '';
  renderDetail();
  try {
    // Finished assets have their own bounded projection. It never waits for
    // chapter evidence or provider diagnostics, so a completed task opens
    // even when an old full-detail snapshot is too large to read quickly.
    const readyAssets = await loadReadyAssetSnapshot(id);
    state.runs = state.runs.map((item) => item.id === id ? readyAssets : item);
    state.detailError = '';
    state.detailFingerprint = '';
    render();
    // Opening a task is read-only. Do not silently issue analytics, model, or
    // paid-media work from a detail click.
  } catch (error) {
    const current = state.runs.find((item) => item.id === id);
    state.detailError = `完整素材暂未同步（${error.message || '请求未完成'}）。任务进度、Code 和已完成素材仍可立即使用。`;
    state.detailFingerprint = '';
    renderDetail();
  } finally {
    if (state.detailHydrating === id) state.detailHydrating = '';
  }
}

function requestDetailHydration(id) {
  // Rebuild at most once automatically. The old five-second retry loop could
  // turn one slow record into an endless queue of duplicate HTTP requests.
  if (state.detailHydrationJobs.has(id) || state.detailHydrationAttempts.has(id)) return;
  state.detailHydrationAttempts.add(id);
  state.detailHydrationJobs.add(id);
  fetch(`/api/worker?id=${encodeURIComponent(id)}&detailOnly=1`, { method: 'POST', credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok || !state.detailOpen || state.selectedId !== id) return null;
      return hydrateRunDetail(id);
    })
    .catch(() => null)
    .finally(() => state.detailHydrationJobs.delete(id));
}

function retryRunDetail(id) {
  state.detailError = '';
  state.detailHydrationAttempts.delete(id);
  state.detailFingerprint = '';
  renderDetail();
  hydrateRunDetail(id);
}

function closeDetail() {
  state.detailOpen = false;
  state.detailTarget = '';
  $('#detailPanel').setAttribute('aria-hidden', 'true');
  $('#detailScrim').setAttribute('aria-hidden', 'true');
  $('#detailPanel').classList.remove('open');
  $('#detailScrim').classList.remove('open');
  $('#detailPanel').hidden = true;
  $('#detailScrim').hidden = true;
}

function openNodeDecision(id, node) {
  state.selectedNode = node;
  openDetail(id, 'decision');
}

function compactNumber(value) {
  return Number(value || 0).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

function percentage(value) { return value == null ? '样本不足' : `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`; }

function leaderboardCover(book, fallbackLabel = '') {
  const fallback = fallbackLabel || (state.leaderboardSource === 'history' ? 'HISTORY' : 'RANK');
  const sku = String(book.bookSkuId || '');
  const failure = sku ? state.coverFailures.get(sku) : null;
  const pendingLabel = failure?.kind === 'missing' ? '暂无封面' : failure?.attempts >= 3 ? '封面查询失败' : failure?.attempts ? `重试 ${failure.attempts}/3` : '封面同步中';
  const fallbackHtml = `<span class="cover-fallback ${book.cover ? 'cover-loading' : 'cover-pending'}"><small>${book.cover ? fallback : escapeHtml(pendingLabel)}</small><strong>${escapeHtml(String(book.title || 'N').slice(0, 1))}</strong></span>`;
  return book.cover
    ? `${fallbackHtml}<img data-cover-image src="${escapeHtml(coverSrc(book.cover))}" data-original-cover="${escapeHtml(coverOriginalSrc(book.cover))}" alt="${escapeHtml(book.title || '')}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onload="handleCoverImageLoad(this)" onerror="handleCoverImageError(this)">`
    : fallbackHtml;
}

function coverDataAttributes(book) {
  return `data-cover-sku="${escapeHtml(book.bookSkuId || '')}" data-cover-title="${escapeHtml(book.title || '')}"`;
}

function updateCoverNodes(covers) {
  const entries = Object.entries(covers || {});
  if (!entries.length) return;
  const coverMap = new Map(entries.map(([sku, url]) => [String(sku), url]));
  document.querySelectorAll('[data-cover-sku]').forEach((node) => {
    const url = coverMap.get(String(node.dataset.coverSku || ''));
    if (!url) return;
    const book = { title: node.dataset.coverTitle || '', bookSkuId: node.dataset.coverSku || '', cover: url };
    node.innerHTML = leaderboardCover(book);
  });
  renderCoverRetryControl();
}

function updateCoverFailureNodes(sku, attempts, kind = '') {
  document.querySelectorAll('[data-cover-sku]').forEach((node) => {
    if (String(node.dataset.coverSku || '') !== String(sku)) return;
    const label = node.querySelector('.cover-fallback small');
    if (label) label.textContent = kind === 'missing' ? '暂无封面' : attempts >= 3 ? '封面查询失败' : `重试 ${attempts}/3`;
    node.classList.toggle('cover-unavailable', attempts >= 3);
  });
}

function renderCoverRetryControl() {
  const button = $('#retryCovers');
  if (!button) return;
  const exhausted = [...state.coverFailures.values()].filter((item) => item.attempts >= 3 && item.kind !== 'missing').length;
  button.hidden = exhausted === 0;
  button.title = exhausted ? `${exhausted} 个封面暂未取回，点击重试` : '重试未加载封面';
  button.setAttribute('aria-label', button.title);
}

function productionIdentity({ title = '', bookSkuId = '', sku = '' } = {}) {
  const normalizedSku = String(bookSkuId || sku || '').trim();
  return normalizedSku ? `sku:${normalizedSku}` : `title:${String(title || '').trim().toLowerCase()}`;
}

function routeProductionIdentity(book = {}, target = p0TargetForBook(book)) {
  const accountId = Number(target?.accountId || 0);
  return accountId ? `${accountId}:${productionIdentity(book)}` : productionIdentity(book);
}

function creativePlanJobBook(job = {}) {
  return { title: job.input?.title || job.artifacts?.book?.title || '', sku: job.input?.sku || job.artifacts?.book?.bookSkuId || job.artifacts?.book?.sku || '' };
}

function pendingMatchesCreativePlanJob(pending, job) {
  const jobAccountId = Number(job?.input?.delivery?.accountId || 0);
  const pendingAccountId = Number(pending?.delivery?.accountId || 0);
  if (!jobAccountId || jobAccountId !== pendingAccountId) return false;
  const jobBook = creativePlanJobBook(job);
  const jobSku = String(jobBook.sku || '').trim();
  const pendingSku = String(pending?.sku || '').trim();
  if (jobSku && pendingSku) return jobSku === pendingSku;
  return String(jobBook.title || '').trim().toLowerCase() === String(pending?.title || '').trim().toLowerCase();
}

function pendingProductionForCreativePlanJob(job) {
  const jobBook = creativePlanJobBook(job);
  const exact = state.pendingProductions.get(routeProductionIdentity(jobBook, job?.input?.delivery || {}));
  return exact || [...state.pendingProductions.values()].find((pending) => pendingMatchesCreativePlanJob(pending, job));
}

function runMatchesTargetAccount(run, target) {
  const accountId = Number(target?.accountId || 0);
  return !accountId || Number(run?.input?.delivery?.accountId || 0) === accountId;
}

function draftMatchesTargetAccount(draft, target) {
  const accountId = Number(target?.accountId || 0);
  return !accountId || Number(draft?.accountId || 0) === accountId;
}

function runMatchesBook(run, book) {
  const bookSku = String(book?.bookSkuId || book?.sku || '').trim();
  const runSku = String(run?.input?.sku || '').trim();
  if (bookSku && runSku && bookSku === runSku) return true;
  return String(run?.input?.title || '').trim().toLowerCase() === String(book?.title || '').trim().toLowerCase();
}

function draftMatchesBook(draft, book) {
  const bookSku = String(book?.bookSkuId || book?.sku || '').trim();
  const draftSku = String(draft?.book?.sku || '').trim();
  if (bookSku && draftSku && bookSku === draftSku) return true;
  return String(draft?.book?.title || '').trim().toLowerCase() === String(book?.title || '').trim().toLowerCase();
}

function runProtectsBook(run) {
  if (['queued', 'running', 'blocked'].includes(String(run?.state || ''))) return true;
  if (run?.state !== 'failed') return false;
  return Boolean(run.artifacts?.video?.threadId)
    || (Array.isArray(run.artifacts?.images) && run.artifacts.images.some((item) => item?.taskId));
}

function activeRunFor(book, target = p0TargetForBook(book)) {
  return state.runs.find((run) => runMatchesBook(run, book) && runMatchesTargetAccount(run, target) && runProtectsBook(run));
}

function bookUsageMeta(book, target = p0TargetForBook(book)) {
  const matches = state.runs.filter((run) => runMatchesBook(run, book) && runMatchesTargetAccount(run, target)).sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''));
  const latest = matches[0] || null;
  const publication = state.publicationDrafts.filter((draft) => draftMatchesBook(draft, book) && draftMatchesTargetAccount(draft, target)).sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''))[0] || null;
  const selected = state.selectedBooks.has(routeProductionIdentity(book, target));
  if (!latest && publication) return { status: 'used', label: '已做过', run: { id: publication.runId, state: 'completed', createdAt: publication.createdAt, updatedAt: publication.updatedAt, input: { title: publication.book?.title, sku: publication.book?.sku }, stages: { P6: { status: 'done' } }, artifacts: {} } };
  if (!latest) return selected ? { status: 'selected', label: '本次已选', run: null } : { status: 'unused', label: '未用过', run: null };
  const protectedRun = matches.find((run) => runProtectsBook(run));
  if (protectedRun) return { status: 'active', label: protectedRun.state === 'blocked' || protectedRun.state === 'failed' ? '待人工处理' : '生产中', run: protectedRun };
  if (latest.state === 'failed') return { status: 'failed', label: '失败待处理', run: latest };
  if (latest.state === 'completed' || latest.stages?.P6?.status === 'done') return { status: 'used', label: '已用过', run: latest };
  return { status: 'used', label: '已选过', run: latest };
}

function bookRouteHistory(book) {
  const platformLabel = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
  const matches = state.runs.filter((run) => runMatchesBook(run, book)).sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''));
  const seen = new Set();
  const draftRoutes = state.publicationDrafts.filter((draft) => draftMatchesBook(draft, book)).map((draft) => {
    const account = String(draft.accountTitle || '').trim();
    const platform = String(draft.platform || '').toLowerCase();
    const routeKey = `${account.toLowerCase()}:${platform}`;
    if (seen.has(routeKey)) return null;
    seen.add(routeKey);
    const at = draft.updatedAt || draft.createdAt;
    return { runId: draft.runId, account: account || '历史草稿', platform: platformLabel[platform] || platform || '平台待补', date: at ? new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '', draftStatus: draft.status || '' };
  }).filter(Boolean);
  const runRoutes = matches.map((run) => {
    const draft = state.publicationDrafts.find((item) => item.runId === run.id);
    const delivery = run.input?.delivery || {};
    const account = String(draft?.accountTitle || delivery.accountTitle || delivery.appName || '').trim();
    const platform = String(draft?.platform || delivery.platform || '').toLowerCase();
    const routeKey = `${account.toLowerCase()}:${platform}`;
    if (seen.has(routeKey)) return null;
    seen.add(routeKey);
    const at = run.updatedAt || run.createdAt;
    return {
      runId: run.id,
      account: account || '历史任务',
      platform: platformLabel[platform] || platform || '平台待补',
      date: at ? new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '',
      draftStatus: draft?.status || ''
    };
  }).filter(Boolean);
  return [...draftRoutes, ...runRoutes];
}

function pendingProductionFor(book, target = p0TargetForBook(book)) {
  return state.pendingProductions?.get?.(routeProductionIdentity(book, target));
}

function bookIsShort(book) {
  return book.isShort === true || book.isShort === 1 || ['1', 'true', 'yes', '是'].includes(String(book.isShort || '').toLowerCase());
}

function bookGenre(book) {
  const signal = [book.title, book.category, ...(book.tags || []), book.description].join(' ').toLowerCase();
  if (/werewolf|wolf|lycan|luna|alpha|shifter|mate/.test(signal)) return 'werewolf';
  if (/mafia|don\b|mob|underworld/.test(signal)) return 'mafia';
  if (/\bceo\b|billionaire|boss|office romance/.test(signal)) return 'ceo';
  if (/vampire|blood prince|blood king/.test(signal)) return 'vampire';
  return 'other';
}

function catalogVisibleBooks(target = p0DecisionTarget()) {
  const filtered = state.leaderboard.filter((book) => {
    const { length, genre } = state.catalogFilters;
    const lengthMatches = length === 'all' || (length === 'short' ? bookIsShort(book) : !bookIsShort(book));
    const usage = bookUsageMeta(book, target).status;
    const usageMatches = state.catalogUsageFilter === 'all'
      || (state.catalogUsageFilter === 'used' ? ['used', 'active', 'failed'].includes(usage) : usage === state.catalogUsageFilter);
    return lengthMatches && (genre === 'all' || bookGenre(book) === genre) && usageMatches;
  });
  const key = state.catalogSort;
  return filtered.sort((left, right) => Number(right[key] ?? -1) - Number(left[key] ?? -1) || Number(right.baseReadUnt || 0) - Number(left.baseReadUnt || 0));
}

function normalizeRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(1, numeric > 1 ? numeric / 100 : numeric);
}

function scoreCatalogBooks(books, days = state.catalogDays) {
  const windowKey = `readerBase${Number(days)}d`;
  const scaleValue = (book) => Number.isFinite(Number(book?.[windowKey])) ? Number(book[windowKey]) : Number(book?.baseReadUnt || 0);
  const maxScale = Math.max(1, ...(books || []).map(scaleValue));
  return (books || []).map((book) => {
    const readers = Math.max(0, scaleValue(book));
    const scaleScore = Math.round(Math.log1p(readers) / Math.log1p(maxScale) * 1000) / 10;
    const qualityParts = [
      [normalizeRate(book.firstReadUntRate), .45],
      [normalizeRate(book.read10wRate), .30],
      [normalizeRate(book.read20wRate), .25]
    ].filter(([value]) => value !== null);
    const qualityWeight = qualityParts.reduce((sum, [, weight]) => sum + weight, 0);
    const qualityScore = qualityWeight >= .7
      ? Math.round(qualityParts.reduce((sum, [value, weight]) => sum + value * weight, 0) / qualityWeight * 1000) / 10
      : null;
    const trends = [[book.trend7v30, .65], [book.trend30v90, .35]].filter(([value]) => Number.isFinite(Number(value)));
    const trendWeight = trends.reduce((sum, [, weight]) => sum + weight, 0);
    const trendGrowth = trendWeight ? trends.reduce((sum, [value, weight]) => sum + Math.max(-1, Math.min(1, Number(value))) * weight, 0) / trendWeight : null;
    const trendScore = trendGrowth === null ? null : Math.round((50 + trendGrowth * 50) * 10) / 10;
    const recommendationScore = qualityScore === null ? null : Math.round((trendScore === null
      ? scaleScore * .56 + qualityScore * .44
      : scaleScore * .45 + qualityScore * .35 + trendScore * .20) * 10) / 10;
    return { ...book, scaleScore, qualityScore, trendScore, recommendationScore, recommendationReady: recommendationScore !== null };
  }).sort((left, right) => Number(right.recommendationScore ?? -1) - Number(left.recommendationScore ?? -1) || Number(right.baseReadUnt || 0) - Number(left.baseReadUnt || 0))
    .map((book, index) => ({ ...book, recommendationRank: book.recommendationScore === null ? null : index + 1 }));
}

function metricHasSignal(books, key) {
  return (books || []).some((book) => {
    const value = Number(book?.[key]);
    return Number.isFinite(value) && value !== 0;
  });
}

function catalogDataHealth(books = state.leaderboard, sortKey = state.catalogSort) {
  const uv = metricHasSignal(books, 'baseReadUnt');
  const firstRead = metricHasSignal(books, 'firstReadUntRate');
  const read10w = metricHasSignal(books, 'read10wRate');
  const read20w = metricHasSignal(books, 'read20wRate');
  const profit = metricHasSignal(books, 'ttProfit');
  const promotionScore = metricHasSignal(books, 'promotionScore');
  const recommendationScore = metricHasSignal(books, 'recommendationScore');
  const byMetric = { recommendationScore, promotionScore, baseReadUnt: uv, firstReadUntRate: firstRead, read10wRate: read10w, read20wRate: read20w, ttProfit: profit };
  return { uv, firstRead, read10w, read20w, profit, promotionScore, recommendationScore, selected: Boolean(byMetric[sortKey]), any: uv || firstRead || read10w || read20w || profit };
}

function catalogQualityAllowsRanking(books = state.leaderboard, quality = state.leaderboardDataQuality) {
  const normalized = String(quality || '').toLowerCase();
  const trustedQuality = ['verified_metrics', 'stale_verified_metrics'].includes(normalized);
  return trustedQuality && catalogDataHealth(books).selected;
}

function recommendationMetricsReady(books = []) {
  const health = catalogDataHealth(books);
  return health.uv && (health.firstRead || health.read10w || health.read20w);
}

function responseAllowsCatalogRanking(body, books, sortKey = state.catalogSort) {
  const quality = String(body?.dataQuality || '').toLowerCase();
  return ['verified_metrics', 'stale_verified_metrics'].includes(quality) && catalogDataHealth(books, sortKey).selected;
}

function activateHistoricalLeaderboardFallback(reason = '') {
  // A source outage must never strand the operator in an empty primary area.
  // These are already verified attribution records, not a substitute for the
  // new-book ranking: switch the view and label it as the review queue.
  if (state.todayDataQuality !== 'history_verified' || !Array.isArray(state.todayBooks) || !state.todayBooks.length) return false;
  state.leaderboardSource = 'history';
  state.leaderboard = state.todayBooks.slice();
  state.leaderboardDataQuality = 'history_verified';
  state.leaderboardUpdated = new Date().toISOString();
  state.leaderboardWindow = { days: 30, source: 'verified_promotion_review' };
  state.leaderboardMetrics = null;
  state.leaderboardWarning = `新推广中台暂不可用，当前自动切换为已验证投放复盘候选${reason ? `：${reason}` : ''}`;
  state.leaderboardError = '';
  state.leaderboardDataKey = leaderboardQueryKey('history');
  state.leaderboardPage = 1;
  state.leaderboardCoverKey = '';
  state.selectedBooks.clear();
  document.querySelectorAll('#leaderboardSource button').forEach((button) => button.classList.toggle('active', button.dataset.source === 'history'));
  return true;
}

function renderBatchBookBar() {
  const bar = $('#batchBookBar');
  const count = state.selectedBooks.size;
  const working = state.batchStarting;
  bar.hidden = count === 0 && !working;
  $('#batchBookCount').textContent = working && state.batchProgress
    ? `正在入队 ${state.batchProgress.completed}/${state.batchProgress.total} 本`
    : `已选 ${count} 本`;
  const start = $('#startSelectedBooks');
  if (start) {
    start.disabled = working || count === 0;
    start.innerHTML = working
      ? '<i data-lucide="loader-circle"></i><span>后台入队中</span>'
      : `<i data-lucide="file-pen-line"></i><span>生成已选 ${count} 本文案</span>`;
  }
  const clear = $('#clearBookSelection');
  if (clear) clear.disabled = working;
  const note = bar?.querySelector('small');
  if (note) note.textContent = paidMediaAvailable()
    ? '批量任务会生成策划、归因和文案；付费媒体由后端额度门禁控制。'
    : '批量任务会生成策划、归因和文案；服务端当前未开放新付费媒体提交。';
}

function pendingProductionLabel(item) {
  if (item.status === 'failed') return `任务未入队：${item.error || '连接失败'}`;
  if (item.status === 'planning') return 'AI 正在先分析全书，完成后自动进入生产';
  if (item.status === 'accepted') return '任务已建立，后台正在接管';
  return '已点击 · 正在创建唯一任务，不需要再次点击';
}

function activeAutopilotItems() {
  return state.runs
    .filter((run) => ['queued', 'running', 'blocked', 'failed'].includes(run.state) && run.autopilot?.enabled !== false)
    .slice(0, 6)
    .map((run) => {
      const done = completedHarnessStages(run);
      const live = currentStage(run);
      const model = modelLabel(run.artifacts?.modelRoute?.activeModel || run.input?.creativeProfile?.modelChoice || 'hy3');
      const next = run.autopilot?.nextActionLabel || live?.[1]?.label || stageLabels[live?.[0]] || '后台正在推进';
      return {
        kind: 'run', key: `run:${run.id}`, runId: run.id, title: run.input?.title || run.artifacts?.book?.title || '未命名任务',
        routeIdentity: routeProductionIdentity({ title: run.input?.title || run.artifacts?.book?.title, sku: run.input?.sku || run.artifacts?.book?.bookSkuId }, run.input?.delivery || {}),
        status: run.state, startedAt: Date.parse(run.updatedAt || run.createdAt || '') || 0,
        label: `${next} · ${done}/${HARNESS_NODE_COUNT} 节点 · ${model}`
      };
    });
}

function renderOneClickStatus() {
  const panel = $('#oneClickStatus');
  if (!panel) return;
  const pending = [...state.pendingProductions.values()].sort((left, right) => right.startedAt - left.startedAt);
  const active = activeAutopilotItems();
  const activeRoutes = new Set(active.map((item) => item.routeIdentity));
  const activeRunIds = new Set(active.map((item) => item.runId).filter(Boolean));
  const items = [...pending.filter((item) => !activeRunIds.has(item.runId) && !activeRoutes.has(routeProductionIdentity(item, item.delivery))), ...active];
  panel.hidden = items.length === 0;
  if (!items.length) { panel.innerHTML = ''; return; }
  const mediaStatusCopy = paidMediaAvailable()
    ? '付费视频依服务端能力和 40/日 limiter 自动提交或排队，已有 threadId 安全回收结果。'
    : '服务端当前未开放新视频提交，已有 threadId 只回收结果。';
  panel.innerHTML = `<header><span><i data-lucide="file-pen-line"></i></span><div><strong>文案生产与历史任务</strong><small>后台继续完成书籍核验、全书策划、Code / Link 和六步法文案；${mediaStatusCopy}</small></div></header><div class="one-click-items">${items.map((item) => {
    const failed = item.status === 'failed';
    const blocked = item.status === 'blocked';
    const icon = failed || blocked ? 'triangle-alert' : item.kind === 'run' ? 'activity' : 'loader-circle';
    const label = item.kind === 'run' ? item.label : pendingProductionLabel(item);
    const action = item.kind === 'run'
      ? `<button type="button" data-open-autopilot="${escapeHtml(item.runId)}">${failed || blocked ? '查看修复' : '查看进度'}</button>`
      : failed
        ? `<button type="button" data-retry-production="${escapeHtml(item.key)}">重新入队</button>`
        : '<b>后台推进中</b>';
    return `<article class="${item.kind === 'run' ? 'active' : ''} ${failed ? 'failed' : ''} ${blocked ? 'blocked' : ''}"><span class="one-click-pulse"><i data-lucide="${icon}"></i></span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(label)}</small></div>${action}</article>`;
  }).join('')}</div>`;
  panel.querySelectorAll('[data-retry-production]').forEach((button) => button.addEventListener('click', () => {
    const item = state.pendingProductions.get(button.dataset.retryProduction);
    if (!item) return;
    state.pendingProductions.delete(item.key);
    createProduction({ title: item.title, sku: item.sku, source: item.source, creativeProfile: item.creativeProfile || {}, delivery: item.delivery, p0Selection: item.p0Selection }).catch((error) => showToast(error.message, 'error'));
  }));
  panel.querySelectorAll('[data-open-autopilot]').forEach((button) => button.addEventListener('click', () => openDetail(button.dataset.openAutopilot)));
}

function todayScore(books, minUv = 20) {
  const transparentScores = scoreCatalogBooks(books, state.catalogDays).filter((book) => book.recommendationReady && Number(book.baseReadUnt || 0) >= minUv);
  if (transparentScores.some((book) => Number.isFinite(Number(book.recommendationScore)))) {
    return transparentScores.map((book) => ({ ...book, todayScore: book.recommendationScore }));
  }
  const eligible = (books || []).filter((book) => {
    const uv = Number(book?.baseReadUnt || 0);
    const firstRead = Number(book?.firstReadUntRate || 0);
    const retention = Number(book?.read20wRate || book?.read10wRate || 0);
    return Number.isFinite(uv) && uv >= minUv && Number.isFinite(firstRead) && firstRead > 0 && Number.isFinite(retention) && retention > 0;
  });
  const max = (key) => Math.max(1, ...eligible.map((book) => Number(book[key] || 0)));
  const uvMax = max('baseReadUnt');
  const firstMax = max('firstReadUntRate');
  const retentionMax = Math.max(1, ...eligible.map((book) => Number(book.read20wRate || book.read10wRate || 0)));
  const profitMax = max('ttProfit');
  return eligible.map((book) => {
    const uv = Number(book.baseReadUnt || 0);
    const retention = Number(book.read20wRate || book.read10wRate || 0);
    const base = uv / uvMax * 40 + Number(book.firstReadUntRate || 0) / firstMax * 25 + retention / retentionMax * 25 + Math.max(0, Number(book.ttProfit || 0)) / profitMax * 10;
    const confidence = Math.min(1, Math.log1p(uv) / Math.log1p(uvMax));
    return { ...book, todayScore: Math.round(base * (0.72 + confidence * 0.28) * 10) / 10 };
  }).sort((a, b) => b.todayScore - a.todayScore || Number(b.baseReadUnt || 0) - Number(a.baseReadUnt || 0));
}

function syncTodayRailFromLeaderboard() {
  const trusted = ['verified_metrics', 'stale_verified_metrics'].includes(String(state.leaderboardDataQuality || '').toLowerCase());
  const candidates = Array.isArray(state.leaderboard) ? state.leaderboard : [];
  if (state.leaderboardSource !== 'catalog' || !trusted || !recommendationMetricsReady(candidates)) {
    state.todayBooks = [];
    state.todayDataQuality = '';
    state.todayRecommendationDays = 0;
    return;
  }
  state.todayBooks = todayScore(candidates, 0).slice(0, 12);
  state.todayDataQuality = state.leaderboardDataQuality;
  state.todayRecommendationDays = Number(state.catalogDays || 30);
}

function historyTodayScore(books) {
  const max = (key) => Math.max(1, ...books.map((book) => Number(book[key] || 0)));
  const uv = max('pullUv');
  const income = max('d14Income');
  const quality = max('score');
  return books.map((book) => ({
    ...book,
    todayScore: Math.round((Number(book.pullUv || 0) / uv * 45 + Number(book.d14Income || 0) / income * 30 + Number(book.score || 0) / quality * 25) * 10) / 10
  })).sort((left, right) => right.todayScore - left.todayScore || Number(right.pullUv || 0) - Number(left.pullUv || 0));
}

const historyDecisionMeta = {
  reinvest: { label: '建议复投', icon: 'circle-check-big', action: '继续投：保留这本书，用小预算验证一套新素材。' },
  observe: { label: '继续观察', icon: 'clock-3', action: '先补样本：继续收数，不急着放大预算。' },
  pause: { label: '暂停扩量', icon: 'circle-pause', action: '先暂停：重做开篇钩子后，再用小预算复测。' },
  insufficient: { label: '数据不足', icon: 'circle-help', action: '暂不判断：等待更多有效拉起和收入回传。' }
};

function metricMedian(values, positiveOnly = false) {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value) && (!positiveOnly || value > 0)).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function historyReviewBooks(books) {
  const cohort = (books || []).filter((book) => Number(book.pullUv || 0) > 0);
  const medians = {
    pullUv: metricMedian(cohort.map((book) => book.pullUv)),
    firstReadRate: metricMedian(cohort.map((book) => book.firstReadRate), true),
    d14Income: metricMedian(cohort.map((book) => book.d14Income), true),
    incomePerUv: metricMedian(cohort.map((book) => book.incomePerUv), true),
    score: metricMedian(cohort.map((book) => book.score), true)
  };
  const order = { reinvest: 0, observe: 1, pause: 2, insufficient: 3 };
  return (books || []).map((book) => {
    const pullUv = Number(book.pullUv || 0);
    const firstReadRate = Number(book.firstReadRate || 0);
    const d14Income = Number(book.d14Income || 0);
    const incomePerUv = Number(book.incomePerUv || 0);
    const confidence = Number(book.confidence || 0);
    const score = Number(book.score || 0);
    const signals = {
      volume: pullUv >= medians.pullUv,
      conversion: firstReadRate > 0 && firstReadRate >= medians.firstReadRate,
      revenue: d14Income > 0 && d14Income >= medians.d14Income,
      yield: incomePerUv > 0 && incomePerUv >= medians.incomePerUv
    };
    const positives = Object.values(signals).filter(Boolean).length;
    let decision = 'insufficient';
    if (confidence >= 30 && d14Income > 0 && score >= medians.score && positives >= 2) decision = 'reinvest';
    else if (confidence >= 30 && positives <= 1) decision = 'pause';
    else if (confidence >= 15 || d14Income > 0) decision = 'observe';
    const strength = signals.volume
      ? `拉起 ${compactNumber(pullUv)} UV，高于同批中位数 ${compactNumber(medians.pullUv)}`
      : signals.revenue
        ? `D14 收入 $${d14Income.toLocaleString('en-US', { maximumFractionDigits: 2 })}，高于同批中位数`
        : signals.conversion
          ? `首读率 ${percentage(firstReadRate)}，高于同批中位数`
          : '当前没有明显高于同批的核心指标';
    const risk = confidence < 30
      ? `样本置信度 ${confidence}%，还没到 30% 判断线`
      : !signals.conversion
        ? `首读率 ${percentage(firstReadRate)}，低于同批中位数 ${percentage(medians.firstReadRate)}`
        : !signals.revenue
          ? 'D14 收入低于同批中位数，暂不适合放大'
          : '留存数据尚未回传，长期质量仍需观察';
    return {
      ...book,
      review: {
        decision,
        ...historyDecisionMeta[decision],
        confidence,
        strength,
        risk,
        basis: `近 ${state.windowDays} 天 · ${Number(book.assetCount || 0)} 个推广归因记录按书汇总 · 留存未接入，不参与判断`,
        positives
      }
    };
  }).sort((left, right) => order[left.review.decision] - order[right.review.decision] || Number(right.score || 0) - Number(left.score || 0));
}

function renderHistoryDecisionBar(books) {
  const bar = $('#historyDecisionBar');
  if (!bar) return;
  const counts = { all: books.length, reinvest: 0, observe: 0, pause: 0, insufficient: 0 };
  books.forEach((book) => { counts[book.review.decision] += 1; });
  const items = [
    ['all', '全部记录', 'list-filter'],
    ['reinvest', historyDecisionMeta.reinvest.label, historyDecisionMeta.reinvest.icon],
    ['observe', historyDecisionMeta.observe.label, historyDecisionMeta.observe.icon],
    ['pause', historyDecisionMeta.pause.label, historyDecisionMeta.pause.icon],
    ['insufficient', historyDecisionMeta.insufficient.label, historyDecisionMeta.insufficient.icon]
  ];
  bar.hidden = false;
  bar.innerHTML = `<div class="history-scope"><strong>这是你们历史 Code / 链接的书级归因</strong><span>不是单条文案、海报或视频的素材表现；留存尚未接通。</span></div><div class="history-filters">${items.map(([key, label, icon]) => `<button type="button" class="history-filter ${state.historyDecisionFilter === key ? 'active' : ''}" data-history-filter="${key}" aria-pressed="${state.historyDecisionFilter === key}" ${key !== 'all' && !counts[key] ? 'disabled' : ''}><i data-lucide="${icon}"></i><span>${label}</span><b>${counts[key]}</b></button>`).join('')}</div>`;
  bar.querySelectorAll('[data-history-filter]').forEach((button) => button.addEventListener('click', () => {
    state.historyDecisionFilter = button.dataset.historyFilter;
    renderLeaderboard();
    icons();
  }));
}

function renderTodayRail() {
  const list = $('#todayRailList');
  if (!list) return;
  const books = state.todayBooks || [];
  const rail = $('#todayRail');
  // Recommendations are secondary. Do not reserve a large blank surface
  // while the primary book picker is already usable.
  if (rail) rail.hidden = !books.length && !state.todayBooksLoading;
  const description = $('#todayRailDescription');
  const recommendationDays = Number(state.todayRecommendationDays || 0);
  if (description) description.textContent = state.todayDataQuality === 'history_verified'
    ? '新书中台暂不可用，当前展示已验证的投放复盘候选。'
    : recommendationDays
      ? `近 ${recommendationDays} 天真实中台表现，已过滤 0 UV、低样本与指标不完整书籍。`
      : '正在校验真实 UV、首读与长读留存样本。';
  if (state.todayBooksLoading && !state.todayBooks.length) { list.innerHTML = `<div class="today-skeleton"><i data-lucide="loader-circle"></i><span>正在读取近 7 天真实表现</span></div>${Array.from({ length: 3 }, () => '<div class="today-skeleton-card"><span></span><div><b></b><b></b><i></i><i></i></div></div>').join('')}`; return; }
  if (!books.length) {
    list.innerHTML = state.todayBooksError
      ? '<button id="retryTodayRail" class="today-loading today-retry" type="button"><i data-lucide="refresh-cw"></i><span>中台指标正在同步，点击重新读取今日推荐</span></button>'
      : '<div class="today-loading"><i data-lucide="sparkles"></i><span>今日推荐准备中</span></div>';
    $('#retryTodayRail')?.addEventListener('click', () => loadTodayRail());
    return;
  }
  const sourceState = state.todayBooksLoading
    ? '<div class="today-source-state refreshing"><i data-lucide="loader-circle"></i>后台刷新中，当前推荐保持可用</div>'
    : state.todayDataQuality === 'history_verified'
      ? '<button id="openTodayHistory" class="today-source-state stale" type="button"><i data-lucide="chart-no-axes-combined"></i>新书中台暂不可用 · 当前显示已验证投放候选，点击查看复盘</button>'
    : state.todayBooksError || state.todayDataQuality === 'stale_verified_metrics'
      ? '<button id="retryTodayRail" class="today-source-state stale" type="button"><i data-lucide="refresh-cw"></i>当前为最近一次已验证推荐，点击更新</button>'
      : '';
  const historical = state.todayDataQuality === 'history_verified';
  const displayedBooks = books.slice(0, 12);
  const fallbackTarget = p0DecisionTarget();
  const displayedTargets = displayedBooks.map((book) => p0TargetForBook(book, book.selectionTarget || fallbackTarget));
  list.innerHTML = `${sourceState}${displayedBooks.map((book, index) => {
    const target = displayedTargets[index];
    const active = activeRunFor(book, target);
    const pending = typeof pendingProductionFor === 'function' ? pendingProductionFor(book, target) : null;
    const usage = bookUsageMeta(book, target);
    return `<article class="today-card usage-${escapeHtml(usage.status)} ${active || pending ? 'in-progress' : ''}"><div class="today-cover" ${coverDataAttributes(book)}>${leaderboardCover(book)}</div><div class="today-card-copy"><span>${historical ? '投放候选' : `近 ${recommendationDays} 天`} #${index + 1} · 综合 ${book.todayScore} · ${escapeHtml(usage.label)}</span><h3>${escapeHtml(book.title)}</h3><p>${escapeHtml(bookGenre(book) === 'other' ? book.category || 'Romance' : bookGenre(book))} · ${historical ? `拉起 ${compactNumber(book.pullUv)} UV` : `UV ${compactNumber(book.baseReadUnt)}`}</p><div>${historical ? `<b>D14 $${Number(book.d14Income || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</b><b>复盘 ${Number(book.score || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</b>` : `<b>首读 ${percentage(book.firstReadUntRate)}</b><b>长读 ${percentage(book.read20wRate || book.read10wRate)}</b>`}</div></div><div class="today-card-actions"><button class="today-start" data-today-start="${index}" ${usage.run ? `data-today-run="${escapeHtml(usage.run.id)}"` : ''} type="button" ${pending && pending.status !== 'failed' ? 'disabled' : ''}><i data-lucide="${usage.run ? 'arrow-right' : pending ? pending.status === 'failed' ? 'rotate-ccw' : 'loader-circle' : 'file-pen-line'}"></i>${usage.run ? usage.status === 'failed' || usage.run.state === 'blocked' ? '查看处理' : '查看历史' : pending ? pending.status === 'failed' ? '重新入队' : '已入队' : videoGenerationPaused() ? '生成文案' : '一键生成'}</button>${usage.status === 'unused' && !pending ? `<button class="today-plan" data-today-book="${index}" type="button"><i data-lucide="brain-circuit"></i>先策划</button>` : ''}</div></article>`;
  }).join('')}`;
  $('#retryTodayRail')?.addEventListener('click', () => loadTodayRail());
  $('#openTodayHistory')?.addEventListener('click', openHistoryRanking);
  list.querySelectorAll('[data-today-book]').forEach((button) => button.addEventListener('click', () => { const index = Number(button.dataset.todayBook); const book = displayedBooks[index]; const target = displayedTargets[index]; if (book && target) openCreativePlanDialog({ ...book, selectionTarget: target }); }));
  list.querySelectorAll('[data-today-start]').forEach((button) => button.addEventListener('click', () => { if (button.dataset.todayRun) return openDetail(button.dataset.todayRun); const index = Number(button.dataset.todayStart); const book = displayedBooks[index]; const target = displayedTargets[index]; if (book && target) startProduction(book, target); }));
}

async function loadTodayCovers() {
  const missing = state.todayBooks.filter((book) => {
    const sku = String(book.bookSkuId || '');
    const failure = state.coverFailures.get(sku);
    return !book.cover && sku && book.title && !state.coverInFlight.has(sku) && (!failure || failure.attempts < 3 && failure.nextAttemptAt <= Date.now());
  }).slice(0, 12);
  if (!missing.length) return;
  const skus = missing.map((book) => String(book.bookSkuId));
  skus.forEach((sku) => state.coverInFlight.add(sku));
  try {
    const coverBody = await api('/api/book-covers', { method: 'POST', body: JSON.stringify({ accountId: Number(state.catalogFilters.accountId || 0), books: missing.map((book) => ({ sku: book.bookSkuId, title: book.title })) }), timeoutMs: 30000 });
    const covers = coverBody.covers || {};
    const missingSkus = new Set((coverBody.missing || []).map(String));
    const failedSkus = new Map((coverBody.failed || []).map((item) => [String(item.sku), String(item.kind || 'unknown')]));
    state.todayBooks = state.todayBooks.map((book) => covers[String(book.bookSkuId)] ? { ...book, cover: covers[String(book.bookSkuId)] } : book);
    Object.keys(covers).forEach((sku) => state.coverFailures.delete(String(sku)));
    skus.filter((sku) => !covers[sku]).forEach((sku) => recordCoverFailure(sku, missingSkus.has(sku) ? 'missing' : failedSkus.get(sku) || 'unknown'));
    saveDashboardSnapshot();
    updateCoverNodes(covers);
  } catch {
    skus.forEach((sku) => recordCoverFailure(sku));
  } finally {
    skus.forEach((sku) => state.coverInFlight.delete(sku));
    renderCoverRetryControl();
    scheduleCoverRetry();
  }
}

async function loadTodayRail() {
  if (state.todayRailRequest) return state.todayRailRequest;
  state.todayRailRequest = (async () => {
    if (!state.leaderboard.length) await loadLeaderboard({ silent: true });
    syncTodayRailFromLeaderboard();
    state.todayBooksError = '';
    renderTodayRail();
    icons();
    return state.todayBooks;
  })();
  try { return await state.todayRailRequest; }
  finally { state.todayRailRequest = null; }
}

function advanceTodayRail() {
  const list = $('#todayRailList');
  if (!list || state.todayRailPaused || list.scrollWidth <= list.clientWidth) return;
  const atEnd = list.scrollLeft + list.clientWidth >= list.scrollWidth - 12;
  list.scrollTo({ left: atEnd ? 0 : list.scrollLeft + Math.min(340, list.clientWidth * .75), behavior: 'smooth' });
}

function renderLeaderboard() {
  const grid = $('#leaderboard');
  const empty = $('#leaderboardEmpty');
  if (!grid || !empty) return;
  grid.setAttribute('aria-busy', String(state.leaderboardLoading));
  $('#refreshLeaderboard').disabled = state.leaderboardLoading;
  $('#refreshLeaderboard').classList.toggle('loading', state.leaderboardLoading);
  empty.hidden = state.leaderboard.length > 0;
  const catalog = state.leaderboardSource === 'catalog';
  const catalogTarget = p0DecisionTarget();
  grid.classList.toggle('catalog-list', catalog);
  grid.classList.toggle('history-mode', !catalog);
  if (catalog) $('#historyDecisionBar').hidden = true;
  if (!catalog) {
    $('#leaderboardSection').classList.remove('metrics-pending');
    $('#leaderboardUpdated').classList.remove('warning');
    $('#retryCovers').hidden = true;
  } else {
    renderCoverRetryControl();
  }
  $('#leaderboardEyebrow').textContent = catalog ? 'CONTENT DASHBOARD' : 'PROMOTION REVIEW';
  $('#leaderboardTitle').textContent = catalog ? '中台书籍排行' : '历史投放复盘';
  $('#leaderboardDescription').textContent = catalog
    ? '映射中台阅读排行，竖向密集展示书名、核心指标与发布历史。'
    : '把你们历史 Code / 链接的书级归因翻译成明确复投结论；不混入新推广书池，也不冒充单条素材表现。';
  if (catalog) {
    const target = catalogTarget;
    $('#leaderboardTitle').textContent = `${target.appName || target.appKey || '目标产品线'} / ${target.platform || 'platform'} 选书工作台`;
    $('#leaderboardDescription').textContent = `当前榜单只来自 ${target.appName || target.appKey || '目标产品线'} 产品线；先按阅读基数、首读率、长读留存和趋势筛选，再进入 P0 锁定。`;
  }
  $('#windowControl').hidden = catalog;
  $('#catalogWindowControl').hidden = !catalog;
  $('#catalogSort').hidden = !catalog;
  $('#catalogFilters').hidden = !catalog;
  if (state.leaderboardLoading && !state.leaderboard.length) {
    renderLeaderboardPager(0, 0);
    empty.hidden = true;
    grid.innerHTML = '<div class="leaderboard-loading"><i data-lucide="loader-circle"></i><strong>正在刷新中台排行</strong><span>正在校验书籍与可自动创建状态</span></div>';
    $('#leaderboardUpdated').textContent = '正在加载真实表现数据';
    return;
  }
  if (!state.leaderboardLoading && !state.leaderboard.length) {
    const unavailable = catalog && (state.leaderboardDataQuality === 'unavailable' || state.leaderboardError);
    grid.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = unavailable
      ? `<i data-lucide="shield-alert"></i><strong>中台真实指标暂未连通</strong><span>${escapeHtml(state.leaderboardWarning || state.leaderboardError || '没有已验证指标时，不会用普通书库伪装成排行榜。')}</span><div><button id="retryLeaderboard" class="secondary-command" type="button"><i data-lucide="refresh-cw"></i>重新连接指标</button><button id="openHistoryRanking" class="secondary-command" type="button"><i data-lucide="chart-no-axes-combined"></i>查看投放复盘候选</button></div>`
      : '<i data-lucide="cloud-off"></i><strong>当前筛选暂无书籍</strong><span>可调整时间、篇幅或题材后重试。</span>';
    $('#leaderboardUpdated').classList.toggle('warning', unavailable);
    $('#leaderboardUpdated').textContent = unavailable ? '数据源未通过验证 · 已停止榜单操作' : '当前筛选没有匹配结果';
    $('#retryLeaderboard')?.addEventListener('click', () => loadLeaderboard({ refresh: true }));
    $('#openHistoryRanking')?.addEventListener('click', openHistoryRanking);
    renderLeaderboardPager(0, 0);
    renderBatchBookBar();
    return;
  }
  if (state.leaderboardLoading) $('#leaderboardUpdated').textContent = '正在后台刷新，当前保留上一版已验证榜单';
  if (catalog) {
    const sortLabel = catalogSortLabels[state.catalogSort] || '阅读 UV';
    const visibleBooks = catalogVisibleBooks(catalogTarget);
    const promotionMinUv = Number(state.leaderboardMetrics?.promotionMinUv || state.leaderboardMetrics?.minReadUnt || 0);
    const observedTopUv = Number(state.leaderboardMetrics?.observedTopUv || 0);
    const candidateTotal = Number(state.leaderboardMetrics?.candidateTotal || state.leaderboardMetrics?.fetched || visibleBooks.length);
    const usageCounts = state.leaderboard.reduce((counts, book) => {
      const status = bookUsageMeta(book, catalogTarget).status;
      if (status === 'unused' || status === 'selected') counts.unused += 1;
      else counts.used += 1;
      return counts;
    }, { unused: 0, used: 0 });
    if (!visibleBooks.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      const sampleMessage = promotionMinUv
        ? `本时间窗没有达到推广样本门槛（阅读 UV ≥ ${compactNumber(promotionMinUv)}）的书${observedTopUv ? `；当前最高仅 ${compactNumber(observedTopUv)} UV` : ''}。低样本书只作观察，不允许进入一键生产。`
        : '真实榜单仍然有效，可调整长短篇或题材筛选。';
      empty.innerHTML = `<i data-lucide="list-filter"></i><strong>${promotionMinUv ? '当前没有可推广级候选' : '当前组合没有匹配书籍'}</strong><span>${escapeHtml(sampleMessage)}</span>`;
      $('#leaderboardSection').classList.remove('metrics-pending');
      $('#leaderboardUpdated').classList.remove('warning');
      $('#leaderboardUpdated').textContent = promotionMinUv ? `候选池 ${candidateTotal} 本 · 推广级 0 本 · UV 门槛 ${compactNumber(promotionMinUv)}` : `Top ${state.leaderboard.length} 已加载 · 当前筛选 0 本`;
      state.selectedBooks.clear();
      renderLeaderboardPager(0, 0);
      renderBatchBookBar();
      return;
    }
    empty.hidden = true;
    const health = catalogDataHealth(visibleBooks);
    const selectedMetricReady = catalogQualityAllowsRanking(visibleBooks);
    if (!selectedMetricReady && state.selectedBooks.size) state.selectedBooks.clear();
    $('#leaderboardSection').classList.toggle('metrics-pending', !selectedMetricReady);
    const totalPages = Math.max(1, Math.ceil(visibleBooks.length / 50));
    state.leaderboardPage = Math.min(Math.max(1, state.leaderboardPage), totalPages);
    const startIndex = (state.leaderboardPage - 1) * 50;
    const displayedBooks = visibleBooks.slice(startIndex, startIndex + 50);
    grid.innerHTML = displayedBooks.map((book) => {
      const index = state.leaderboard.indexOf(book);
      const target = catalogTarget;
      const selectionKey = routeProductionIdentity(book, target);
      const active = activeRunFor(book, target);
      const pending = typeof pendingProductionFor === 'function' ? pendingProductionFor(book, target) : null;
      const usage = bookUsageMeta(book, target);
      const freshReceiptReady = Boolean(book.p0Receipt);
      const rankingActionable = selectedMetricReady && freshReceiptReady && book.automationReady !== false && book.recommendationReady !== false;
      const selectable = rankingActionable && !pending && ['unused', 'selected'].includes(usage.status);
      const ready = Boolean(usage.run || pending) || rankingActionable;
      const completedStages = active ? completedHarnessStages(active) : 0;
      const liveStage = active ? currentStage(active) : null;
      const progressLabel = pending
        ? pendingProductionLabel(pending)
        : active
          ? `${liveStage?.[1]?.label || stageLabels[liveStage?.[0]] || '后台生产中'} · ${completedStages}/${HARNESS_NODE_COUNT} 节点`
          : '';
      const metric = state.catalogSort === 'recommendationScore'
          ? `${Number(book.recommendationScore || 0).toFixed(1)} / 100`
        : state.catalogSort === 'baseReadUnt'
          ? compactNumber(book.baseReadUnt)
          : state.catalogSort === 'trend7v30'
            ? (Number.isFinite(Number(book.trend7v30)) ? `${Number(book.trend7v30) >= 0 ? '+' : ''}${Math.round(Number(book.trend7v30) * 100)}%` : '—')
          : percentage(book[state.catalogSort]);
      const centralRank = book.rank;
      const routeHistory = bookRouteHistory(book);
      const routeHistoryHtml = routeHistory.length
        ? `<div class="book-route-history"><span>发过</span>${routeHistory.slice(0, 2).map((route) => `<b title="${escapeHtml(`${route.account} · ${route.platform} · ${route.date}`)}">${escapeHtml(route.account)} · ${escapeHtml(route.platform)}${route.date ? ` · ${escapeHtml(route.date)}` : ''}</b>`).join('')}${routeHistory.length > 2 ? `<i>+${routeHistory.length - 2}</i>` : ''}</div>`
        : '<div class="book-route-history unused"><span>未发过</span><b>可用</b></div>';
      const lastUsed = usage.run ? new Date(usage.run.updatedAt || usage.run.createdAt).toLocaleDateString('zh-CN') : '';
      const daily = (days) => Number.isFinite(Number(book[`readerDaily${days}d`])) ? `${compactNumber(book[`readerDaily${days}d`])}/天` : '数据不足';
      const trend = Number.isFinite(Number(book.trend7v30)) ? `${Number(book.trend7v30) >= 0 ? '+' : ''}${Math.round(Number(book.trend7v30) * 100)}%` : '数据不足';
      const selectedReaders = Number.isFinite(Number(book[`readerBase${state.catalogDays}d`])) ? Number(book[`readerBase${state.catalogDays}d`]) : Number(book.baseReadUnt || 0);
      const longReadWindow = Number(book.read20wRate || 0) > 0 ? '20w' : Number(book.read10wRate || 0) > 0 ? '10w' : '';
      const longReadValue = longReadWindow === '20w' ? book.read20wRate : longReadWindow === '10w' ? book.read10wRate : null;
      const routeMatches = String(book.selectionTarget?.accountId || target.accountId || '') === String(target.accountId || '')
        && String(book.selectionTarget?.platform || target.platform || '') === String(target.platform || '')
        && String(book.selectionTarget?.appKey || book.selectionTarget?.productLine || target.appKey || '') === String(target.appKey || target.productLine || '');
      const p0Qualified = selectedMetricReady && freshReceiptReady && routeMatches && book.automationReady !== false && book.recommendationReady !== false && ['unused', 'selected'].includes(usage.status);
      const p0Reason = !routeMatches ? '产品线/账号不匹配，已阻止进入生产' : usage.status !== 'unused' && usage.status !== 'selected' ? '已有该账号历史任务，默认阻止重复使用' : !selectedMetricReady ? '中台指标尚未通过验证' : !freshReceiptReady ? '请刷新榜单以取得本次目标账号的 P0 校验收据' : book.automationReady === false || book.recommendationReady === false ? '缺少可执行的归因或推荐指标' : '满足当前 P0 指标门槛，可锁定';
      return `<article class="leaderboard-card decision-card usage-${escapeHtml(usage.status)} ${active || pending ? 'in-progress' : ''} ${selectedMetricReady ? '' : 'metrics-disabled'} ${p0Qualified ? 'p0-qualified' : 'p0-blocked'}">
        <div class="book-rank-cell"><label class="select-book" title="${selectable ? '加入本次批量选择' : usage.status === 'unused' ? '真实指标恢复后可选择' : '该书已有历史任务，避免误重复'}"><input type="checkbox" data-select-sku="${escapeHtml(book.bookSkuId)}" data-select-key="${escapeHtml(selectionKey)}" ${state.selectedBooks.has(selectionKey) ? 'checked' : ''} ${selectable ? '' : 'disabled'}><span></span></label><span class="rank">${selectedMetricReady && centralRank ? `中台 #${centralRank}` : '待验证'}</span><span class="book-usage-badge ${escapeHtml(usage.status)}">${escapeHtml(usage.label)}</span></div>
        <div class="p0-eligibility-line ${p0Qualified ? 'qualified' : 'blocked'}"><i data-lucide="${p0Qualified ? 'shield-check' : 'shield-x'}"></i><strong>${p0Qualified ? 'P0 可锁定' : 'P0 已阻止'}</strong><span>${escapeHtml(p0Reason)}</span></div>
        <div class="leaderboard-copy"><h2 title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</h2><small class="book-product-line">${escapeHtml(target.appName || target.appKey || '目标产品线')} · SKU ${escapeHtml(book.bookSkuId || '—')}</small>${routeHistoryHtml}${progressLabel ? `<small class="book-inline-progress">${escapeHtml(progressLabel)}</small>` : ''}</div>
        <div class="book-core-metric"><span>${state.catalogDays} 天阅读用户</span><strong>${selectedMetricReady ? compactNumber(selectedReaders) : '—'}</strong><small>日均 ${daily(state.catalogDays)}</small></div>
        <div class="book-core-metric"><span>首读率</span><strong>${selectedMetricReady ? percentage(book.firstReadUntRate) : '—'}</strong><small>开篇转化</small></div>
        <div class="book-core-metric"><span>长读留存</span><strong>${selectedMetricReady && longReadValue != null ? percentage(longReadValue) : '—'}</strong><small>${longReadWindow ? `${longReadWindow} 留存` : '数据不足'}</small></div>
        <div class="book-core-metric trend ${Number(book.trend7v30) >= 0 ? 'up' : 'down'}"><span>7 天 vs 30 天</span><strong>${selectedMetricReady ? trend : '—'}</strong><small>日均趋势</small></div>
        <div class="leaderboard-metrics"><span>${escapeHtml(sortLabel)}</span><strong>${selectedMetricReady ? metric : '—'}</strong><small>推荐 ${book.recommendationScore ?? '—'}</small></div>
        ${progressLabel ? `<div class="book-live-progress"><span><i data-lucide="${pending ? pending.status === 'failed' ? 'triangle-alert' : 'loader-circle' : 'activity'}"></i>${escapeHtml(progressLabel)}</span><i style="width:${pending ? 8 : Math.max(8, Math.round(completedStages / HARNESS_NODE_COUNT * 100))}%"></i></div>` : ''}
        <div class="book-commands">${usage.status === 'unused' && !pending ? `<button class="plan-book" data-index="${index}" ${!rankingActionable ? 'disabled' : ''} title="${rankingActionable ? '先由 AI 分析原文与创意方向' : '等待真实业务指标恢复'}"><i data-lucide="brain-circuit"></i><span>先策划</span></button>` : ''}<button class="start-book ${usage.run ? 'resume' : ''}" data-index="${index}" ${usage.run ? `data-run-id="${escapeHtml(usage.run.id)}"` : ''} ${!ready || (pending && pending.status !== 'failed') || state.startingProductions.has(routeProductionIdentity(book, target)) ? 'disabled' : ''}>${usage.run ? usage.status === 'failed' || usage.run.state === 'blocked' ? '查看处理' : '查看历史' : pending ? pending.status === 'failed' ? '重新入队' : '已入队' : !rankingActionable ? '等待真实指标' : state.startingProductions.has(routeProductionIdentity(book, target)) ? '正在入队' : videoGenerationPaused() ? '生成文案' : '一键生成'}<i data-lucide="${!ready ? 'circle-off' : usage.run ? 'arrow-right' : pending ? pending.status === 'failed' ? 'rotate-ccw' : 'loader-circle' : 'zap'}"></i></button></div>
      </article>`;
    }).join('');
    const window = state.leaderboardWindow;
    $('#leaderboardUpdated').classList.toggle('warning', !selectedMetricReady);
    $('#leaderboardUpdated').textContent = selectedMetricReady
      ? (window?.throughDate ? `${window.startDate} 至 ${window.throughDate} · 中台排行 ${candidateTotal} 本 · 未发 ${usageCounts.unused} · 已发/生产 ${usageCounts.used}${state.catalogUsageFilter !== 'all' ? ` · 当前筛选 ${visibleBooks.length}` : ''}${state.leaderboardWarning ? ` · ${state.leaderboardWarning}` : ''}` : '正在加载中台业务数据')
      : `已找到 ${visibleBooks.length} 本书，但中台 ${sortLabel} 尚未通过验证 · 已禁止按榜单启动`;
    renderLeaderboardPager(displayedBooks.length, visibleBooks.length, totalPages);
    document.querySelectorAll('.start-book').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.runId) return openDetail(button.dataset.runId);
      const book = state.leaderboard[Number(button.dataset.index)];
      if (book) startProduction(book, catalogTarget);
    }));
    document.querySelectorAll('.plan-book').forEach((button) => button.addEventListener('click', () => {
      const book = state.leaderboard[Number(button.dataset.index)];
      if (book) openCreativePlanDialog({ ...book, selectionTarget: catalogTarget });
    }));
    document.querySelectorAll('[data-select-sku]').forEach((input) => input.addEventListener('change', () => {
      const selectionKey = String(input.dataset.selectKey || '');
      if (!selectionKey) return;
      if (input.checked) state.selectedBooks.add(selectionKey); else state.selectedBooks.delete(selectionKey);
      renderLeaderboard(); icons();
    }));
    renderBatchBookBar();
    return;
  }
  renderLeaderboardPager(0, 0);
  if (catalog) {
    grid.innerHTML = state.leaderboard.map((book, index) => {
      const active = activeRunFor(book, catalogTarget);
      const ready = book.automationReady !== false;
      return `<article class="leaderboard-card ${active ? 'in-progress' : ''}">
        <span class="rank">#${book.rank}</span>
        <div class="leaderboard-cover" ${coverDataAttributes(book)}>${leaderboardCover(book)}</div>
        <div class="leaderboard-copy"><h2>${escapeHtml(book.title)}</h2><p>书库排序 · ${escapeHtml(book.category || 'English fiction')}</p><div class="book-tags"><span>在架可推广</span><span>SKU ${escapeHtml(book.bookSkuId || '—')}</span></div></div>
        <div class="leaderboard-metrics"><span>书库排名</span><strong>#${book.rank}</strong><small>${escapeHtml(book.category || 'English fiction')}</small></div>
        <button class="start-book ${active ? 'resume' : ''}" data-index="${index}" ${!ready || state.startingProductions.has(routeProductionIdentity(book, catalogTarget)) ? 'disabled' : ''}>${!ready ? '暂不可用' : state.startingProductions.has(routeProductionIdentity(book, catalogTarget)) ? '正在校验' : active ? ['blocked', 'failed'].includes(active.state) ? '查看修复' : '查看任务' : '智能一键生成'}<i data-lucide="${!ready ? 'circle-off' : active ? ['blocked', 'failed'].includes(active.state) ? 'triangle-alert' : 'arrow-right' : 'zap'}"></i></button>
      </article>`;
    }).join('');
    const window = state.leaderboardWindow;
    $('#leaderboardUpdated').textContent = window?.throughDate ? `书库数据截至 ${window.throughDate}` : '正在加载书库排行';
    document.querySelectorAll('.start-book').forEach((button) => button.addEventListener('click', () => {
      const book = state.leaderboard[Number(button.dataset.index)];
      if (book) startProduction(book, catalogTarget);
    }));
    return;
  }
  const reviewedBooks = historyReviewBooks(state.leaderboard);
  renderHistoryDecisionBar(reviewedBooks);
  const visibleReviews = state.historyDecisionFilter === 'all' ? reviewedBooks : reviewedBooks.filter((book) => book.review.decision === state.historyDecisionFilter);
  grid.innerHTML = visibleReviews.length ? visibleReviews.map((book, index) => {
    const pullUv = book.pullUv;
    const firstReadRate = book.firstReadRate;
    const review = book.review;
    return `<article class="leaderboard-card history-review-card decision-${escapeHtml(review.decision)}">
      <div class="history-decision"><i data-lucide="${escapeHtml(review.icon)}"></i><div><span>系统判断</span><strong>${escapeHtml(review.label)}</strong><small>样本置信度 ${review.confidence}%</small></div></div>
      <div class="leaderboard-cover" ${coverDataAttributes(book)}>${leaderboardCover(book)}</div>
      <div class="leaderboard-copy"><h2>${escapeHtml(book.title)}</h2><p>${escapeHtml(review.strength)}</p><div class="book-tags"><span>拉起 ${compactNumber(pullUv)} UV</span><span>首读 ${percentage(firstReadRate)}</span><span>D14 $${Number(book.d14Income || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></div></div>
      <div class="leaderboard-metrics"><span>下一步</span><strong>${escapeHtml(review.action.split('：')[0])}</strong><small>${escapeHtml(review.risk)}</small></div>
      <button class="history-review-toggle" type="button" data-review-index="${index}" aria-expanded="false"><i data-lucide="list-tree"></i><span>查看判断依据</span><i data-lucide="chevron-down"></i></button>
      <div class="history-review-detail" data-review-detail="${index}" hidden><div><span>为什么这么判断</span><strong>${escapeHtml(review.strength)}</strong><p>${escapeHtml(review.risk)}</p></div><div><span>建议怎么做</span><strong>${escapeHtml(review.action)}</strong><p>${escapeHtml(review.basis)}</p></div><div class="history-metric-grid"><span><b>${compactNumber(book.pullUv)}</b>拉起 UV</span><span><b>${percentage(book.firstReadRate)}</b>首读率</span><span><b>$${Number(book.d14Income || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</b>D14 收入</span><span><b>${Number(book.score || 0).toFixed(1)}</b>历史综合分</span></div></div>
    </article>`;
  }).join('') : '<div class="history-review-empty"><i data-lucide="list-filter"></i><strong>当前分类没有记录</strong><span>选择其他判断分类继续查看。</span></div>';
  grid.querySelectorAll('[data-review-index]').forEach((button) => button.addEventListener('click', () => {
    const detail = grid.querySelector(`[data-review-detail="${button.dataset.reviewIndex}"]`);
    if (!detail) return;
    const open = detail.hidden;
    detail.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.querySelector('span').textContent = open ? '收起判断依据' : '查看判断依据';
    button.classList.toggle('open', open);
  }));
  const window = state.leaderboardWindow;
  $('#leaderboardUpdated').textContent = window?.throughDate ? `数据截至 ${window.throughDate} · 近 ${window.days} 天 · 当前显示 ${visibleReviews.length}/${reviewedBooks.length} 本` : '正在加载历史表现数据';
}

function renderLeaderboardPager(shown, available, totalPages = 1) {
  const pager = $('#leaderboardPager');
  if (!pager) return;
  const sourceTotal = Math.min(200, Number(state.leaderboardMetrics?.candidateTotal || available));
  pager.hidden = state.leaderboardSource !== 'catalog' || available === 0;
  const start = available ? (state.leaderboardPage - 1) * 50 + 1 : 0;
  const end = available ? start + shown - 1 : 0;
  $('#leaderboardCount').textContent = `第 ${state.leaderboardPage}/${totalPages} 页 · 第 ${start}-${end} 本 / ${available}${sourceTotal > available ? ` · 中台候选 ${sourceTotal}` : ''}`;
  $('#previousBooks').disabled = state.leaderboardPage <= 1;
  $('#nextBooks').disabled = state.leaderboardPage >= totalPages;
}

function tokenCount(run) {
  return Object.values(run.artifacts?.usage || {}).reduce((sum, item) => sum + Number(item?.totalTokens || 0), 0);
}

function usageModelName(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('seed') || raw.includes('doubao')) return 'Seed 2.1 Turbo';
  if (raw.includes('deepseek')) return 'DeepSeek V4 Pro';
  if (raw.includes('qwen3.7')) return 'Qwen 3.7 Max';
  if (raw.includes('qwen')) return 'Qwen';
  if (raw.includes('minimax')) return 'MiniMax M2.7';
  if (raw.includes('kimi')) return 'Kimi K2.7';
  if (raw.includes('hy3')) return 'HY3';
  return '其他模型';
}

function modelUsage() {
  const totals = new Map();
  state.runs.forEach((run) => {
    const activity = [...(run.modelActivity || []), ...(run.artifacts?.modelActivity || []), ...(run.artifacts?.creativeDraft?.usage || [])];
    if (activity.length) {
      activity.forEach((item) => {
        const model = usageModelName(item.model || item.requestedModel);
        const tokens = Math.max(0, Number(item.totalTokens || 0));
        if (tokens) totals.set(model, (totals.get(model) || 0) + tokens);
      });
      return;
    }
    Object.values(run.artifacts?.usage || {}).forEach((item) => {
      const model = usageModelName(item?.model);
      const tokens = Math.max(0, Number(item?.totalTokens || 0));
      if (tokens) totals.set(model, (totals.get(model) || 0) + tokens);
    });
  });
  return [...totals.entries()].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens);
}

function renderModelMix() {
  const usage = modelUsage();
  const total = usage.reduce((sum, item) => sum + item.tokens, 0);
  const chart = $('#modelMixChart');
  const colors = ['#087f5b', '#2563eb', '#d97706', '#64748b'];
  if (!total) {
    chart.style.background = '#e5e9eb';
    $('#modelMixPercent').textContent = '--';
    $('#modelMixTop').textContent = '暂无调用';
    $('#modelMixLegend').innerHTML = '';
    return;
  }
  let cursor = 0;
  const segments = usage.slice(0, 4).map((item, index) => {
    const start = cursor;
    cursor += item.tokens / total * 100;
    return `${colors[index]} ${start.toFixed(1)}% ${cursor.toFixed(1)}%`;
  });
  if (cursor < 100) segments.push(`#d7dde0 ${cursor.toFixed(1)}% 100%`);
  chart.style.background = `conic-gradient(${segments.join(',')})`;
  const topPercent = Math.round(usage[0].tokens / total * 100);
  $('#modelMixPercent').textContent = `${topPercent}%`;
  $('#modelMixTop').textContent = `${usage[0].model} · ${topPercent}%`;
  $('#modelMixLegend').innerHTML = usage.slice(0, 2).map((item, index) => `<span title="${escapeHtml(item.model)}"><i style="background:${colors[index]}"></i>${modelLogoHtml(item.model, { compact: true })} ${Math.round(item.tokens / total * 100)}%</span>`).join('');
}

function assetSummary(run) {
  const posts = Array.isArray(run.artifacts?.posts) ? run.artifacts.posts.filter((item) => String(item?.content || '').trim()).length : 0;
  const posters = Array.isArray(run.artifacts?.images) ? run.artifacts.images.filter((item) => item?.status === 'success' && item?.url).length : 0;
  const video = run.artifacts?.video?.videoUrls?.[0] ? 1 : 0;
  const tracking = run.artifacts?.code && run.artifacts?.shortUrl ? 1 : 0;
  return { posts, posters, video, tracking, total: posts + posters + video + tracking };
}

function runHasUsableAssets(run) {
  const assets = assetSummary(run);
  return assets.posts + assets.posters + assets.video > 0;
}

function runNeedsAttention(run) {
  if (['failed', 'blocked', 'ambiguous'].includes(String(run?.state || ''))) return true;
  return Object.values(run?.stages || {}).some((stage) => ['failed', 'blocked', 'ambiguous', 'partial'].includes(String(stage?.status || '')));
}

function matchesOverviewFilter(run) {
  if (state.overviewFilter === 'active') return ['queued', 'running'].includes(run.state);
  if (state.overviewFilter === 'assets') return runHasUsableAssets(run);
  if (state.overviewFilter === 'attention') return runNeedsAttention(run);
  return true;
}

function libraryRuns() {
  const query = state.query.toLowerCase();
  return state.runs.filter((run) => {
    const summary = assetSummary(run);
    const haystack = [run.input?.title, run.input?.sku, run.artifacts?.code].join(' ').toLowerCase();
    return summary.total > 0 && (!query || haystack.includes(query));
  });
}

function filteredRuns() {
  const query = state.query.toLowerCase();
  return state.runs.filter((run) => {
    if (state.view === 'library') return false;
    if (state.view === 'completed' && run.state !== 'completed') return false;
    if (state.view === 'attention' && !runNeedsAttention(run)) return false;
    if (state.view === 'operations' && !matchesOverviewFilter(run)) return false;
    const haystack = [run.input?.title, run.input?.sku, run.artifacts?.code].join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });
}

function stageClass(stage) {
  const status = stage?.status || 'waiting';
  if (status === 'done') return 'done';
  if (status === 'partial') return 'partial';
  if (['failed', 'ambiguous'].includes(status)) return 'failed';
  if (!['waiting'].includes(status)) return 'active';
  return '';
}

function displayStage(run, key) {
  const stage = run?.stages?.[key];
  if (stage) return stage;
  if (key === 'P0') return { status: 'done', label: '历史任务：书籍选择已锁定' };
  if (key === 'P7' && run?.state === 'completed' && run?.stages?.P6?.status === 'done') {
    return { status: 'done', label: '历史任务：审核交付已完成' };
  }
  return { status: 'waiting' };
}

function completedHarnessStages(run) {
  return pipelineOrder.filter((key) => displayStage(run, key).status === 'done').length;
}

function currentStage(run) {
  return pipelineOrder.map((key) => [key, displayStage(run, key)]).find(([, value]) => !['done', 'waiting'].includes(value.status)) || pipelineOrder.map((key) => [key, displayStage(run, key)]).find(([, value]) => value.status === 'waiting') || ['P7', { label: '全部完成' }];
}

function runOutcome(run) {
  const harnessStatus = String(run.harness?.status || '');
  const review = run.artifacts?.review || {};
  const operations = run.operations || {};
  const publicationStatus = String(review.publicationStatus || operations.publicationStatus || '');
  const externalDraftId = String(review.externalDraftId || review.socialEchoDraftId || operations.socialEchoExternalDraftId || '');
  if (harnessStatus === 'ambiguous' || publicationStatus === 'publish_ambiguous') {
    return { className: 'ambiguous', label: 'P7 需人工对账 · 禁止重复提交' };
  }
  const ambiguous = Object.entries(run.stages || {}).find(([, stage]) => stage?.status === 'ambiguous');
  if (ambiguous) {
    return { className: 'ambiguous', label: `需人工核验 · ${stageLabels[ambiguous[0]] || ambiguous[0]}` };
  }
  const partial = Object.entries(run.stages || {}).find(([, stage]) => stage?.status === 'partial');
  if (run.state === 'completed' && partial) {
    return { className: 'partial', label: `主体完成 · ${stageLabels[partial[0]] || partial[0]}部分完成` };
  }
  if (publicationStatus === 'external_draft' && externalDraftId) {
    return { className: 'completed', label: review.deliveryMode === 'scheduled' ? 'P7 SocialEcho 定时任务已确认' : 'P7 SocialEcho 草稿已确认' };
  }
  if (['ready_for_review', 'internal_draft', 'ready'].includes(publicationStatus)
    || operations.internalPublicationDraftId) {
    return { className: 'partial', label: review.deliveryMode === 'scheduled' ? 'P7 内部定时草稿待提交' : 'P7 内部草稿待存入 SocialEcho' };
  }
  if (operations.blocked) return { className: 'blocked', label: `已阻塞 · ${operations.blockedReason || '需要处理'}` };
  return { className: run.state, label: labels[run.state] || run.state };
}

function cover(run) {
  const book = {
    title: run.artifacts?.book?.title || run.input?.title || '',
    bookSkuId: run.artifacts?.book?.bookSkuId || run.input?.sku || '',
    cover: run.artifacts?.book?.cover || ''
  };
  return `<div class="book-cover resilient-cover" ${coverDataAttributes(book)}>${leaderboardCover(book, 'BOOK')}</div>`;
}

function assetImageFrame(url, alt, label = '素材') {
  if (!url) return '';
  return `<div class="asset-media-frame"><span class="asset-media-fallback">${escapeHtml(label)}加载中</span><img src="${escapeHtml(url)}" loading="lazy" decoding="async" alt="${escapeHtml(alt)}" onload="handleCoverImageLoad(this)" onerror="handleCoverImageError(this)"></div>`;
}

function videoAssetState(run) {
  const video = run.artifacts?.video || null;
  const stage = run.stages?.P4 || {};
  if (video?.videoUrls?.[0]) return { label: '视频可播放', tone: 'ready' };
  const status = String(video?.status || stage.status || 'waiting');
  if (['submitting', 'queued', 'running', 'prepared'].includes(status)) return { label: '视频生成中', tone: 'working' };
  if (status === 'ambiguous') return { label: '视频需核验', tone: 'attention' };
  if (status === 'blocked') return { label: ['daily_video_limit', 'hourly_video_limit'].includes(String(stage.blockedReason || '')) ? '视频等候额度' : '视频已暂停', tone: 'attention' };
  if (['failed', 'partial', 'completed_missing_media'].includes(status)) return { label: '视频生成失败', tone: 'failed' };
  return { label: '视频未提交', tone: 'idle' };
}

function assetLibraryFingerprint(runs) {
  return JSON.stringify({
    query: state.query,
    runs: runs.map((run) => ({
      id: run.id,
      title: run.input?.title,
      code: run.artifacts?.code,
      shortUrl: run.artifacts?.shortUrl,
      cover: run.artifacts?.book?.cover,
      posts: run.artifacts?.posts?.length || 0,
      images: (run.artifacts?.images || []).map((item) => [item.status, item.url, item.variant]),
      video: [run.artifacts?.video?.status, run.artifacts?.video?.videoUrls?.[0], run.stages?.P4?.status]
    }))
  });
}

function renderRunList() {
  if (state.view === 'library') return renderAssetLibrary();
  const runs = filteredRuns();
  $('#runListHead').hidden = false;
  $('#runList').className = `run-list ${state.density}`;
  $('#emptyRuns').hidden = runs.length > 0;
  $('#runList').innerHTML = runs.map((run) => {
    const active = currentStage(run);
    const stages = pipelineOrder.map((key) => displayStage(run, key));
    const outcome = runOutcome(run);
    const ops = run.operations || {};
    const activeKey = ops.currentStage || active[0] || '';
    const activeLabel = ops.currentStageLabel || stageLabels[activeKey] || activeKey;
    const nextAttempt = ops.nextAttemptAt ? `下次 ${ops.nextAttemptAt}` : '';
    const blocker = ops.blockedReason || '';
    const externalId = ops.socialEchoExternalDraftId || (ops.externalTaskIds?.P4 ? taskIdForUi(ops.externalTaskIds.P4) : '');
    const schedule = ops.scheduledAt ? `排期 ${ops.scheduledAt}` : '';
    return `<article class="run-row ${run.id === state.selectedId ? 'selected' : ''}" data-id="${escapeHtml(run.id)}">
      <div class="book-cell">${cover(run)}<div><div class="book-name">${escapeHtml(run.input?.title)}</div><div class="book-meta">SKU ${escapeHtml(run.input?.sku)} · ${escapeHtml(new Date(run.createdAt).toLocaleDateString('zh-CN'))}</div></div></div>
      <div class="stage-meter"><div class="stage-track">${stages.map((item) => `<i class="stage-segment ${stageClass(item)}"></i>`).join('')}</div><div class="stage-label">${escapeHtml(activeLabel)} · ${stages.filter((item) => item.status === 'done').length}/${HARNESS_NODE_COUNT}</div><small class="run-operational-meta">${escapeHtml(ops.nextActionLabel || '')}${nextAttempt ? ` · ${escapeHtml(nextAttempt)}` : ''}</small></div>
      <div class="tracking-cell"><strong>${run.artifacts?.code ? `Code ${escapeHtml(run.artifacts.code)}` : '待分配'}</strong><span>${escapeHtml(run.artifacts?.shortUrl || '短链待创建')}</span></div>
      <div><span class="status-badge ${escapeHtml(outcome.className)}">${escapeHtml(outcome.label)}</span><small class="run-operational-meta">${escapeHtml(blocker || schedule || (externalId ? `外部 ID ${externalId}` : ops.recoverable ? '可恢复' : ''))}</small></div>
    </article>`;
  }).join('');
  document.querySelectorAll('.run-row').forEach((row) => row.addEventListener('click', () => openDetail(row.dataset.id)));
  renderRunLoadMore();
}

function renderRunLoadMore() {
  const button = $('#loadMoreRuns');
  if (!button) return;
  button.hidden = state.statusScope === 'campaign' || state.statusLimit >= 50 || state.runs.length < state.statusLimit;
  button.disabled = state.statusLoading;
  button.querySelector('span').textContent = state.statusLoading && state.statusLimit >= 50 ? '正在加载更早任务' : '加载更早的任务';
  const scopeLabel = $('#runListScopeLabel');
  const campaignButton = $('#loadCampaignRuns');
  if (scopeLabel) {
    scopeLabel.textContent = state.statusScope === 'campaign'
      ? `当前显示 Campaign 全部 ${state.runs.length} 条任务`
      : `当前显示最近 ${state.runs.length} 条任务`;
  }
  if (campaignButton) {
    const canLoad = Boolean(state.dailyCampaignId) && state.statusScope !== 'campaign';
    campaignButton.hidden = !canLoad;
    campaignButton.disabled = state.statusLoading;
    campaignButton.querySelector('span').textContent = state.statusLoading && state.statusScope !== 'campaign' ? '正在加载 Campaign' : '查看本 Campaign 全部任务';
  }
}

async function copyAssetText(value, message) {
  if (!value) { showToast('当前没有可复制的成品内容', 'error'); return false; }
  try {
    const text = String(value).trim();
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Local HTTP previews do not always expose Clipboard API; preserve one-click copy there.
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      if (!copied) throw new Error('Clipboard fallback unavailable');
    }
    showToast(message);
    return true;
  } catch {
    showToast('浏览器未允许复制，请从详情页复制', 'error');
    return false;
  }
}

async function copyPostsForAsset(id) {
  const run = state.runs.find((item) => item.id === id);
  const posts = run?.artifacts?.posts || [];
  const hasFinishedCopy = !run?._summary && posts.some((post) => !['ready', 'cached'].includes(String(post?.content || '')));
  if (hasFinishedCopy) return posts;
  const body = await api(`/api/runs?id=${encodeURIComponent(id)}&asset=copy`, { timeoutMs: 12000 });
  if (!Array.isArray(body?.posts) || !body.posts.length) throw new Error('成品文案尚未返回');
  return body.posts;
}

function reportNumber(value) { return Number(value || 0).toLocaleString('zh-CN'); }

function renderWeeklyReport() {
  const content = $('#weeklyReportContent');
  const period = $('#weeklyReportPeriod');
  if (!content || !period) return;
  const report = state.weeklyReport;
  document.querySelectorAll('[data-report-days]').forEach((button) => button.classList.toggle('active', Number(button.dataset.reportDays) === state.weeklyReportDays));
  if (state.weeklyReportLoading) {
    period.textContent = '正在汇总已保存任务与真实归因';
    content.innerHTML = '<div class="weekly-report-loading"><i data-lucide="loader-circle"></i><strong>正在生成经营简报</strong><span>只读取已有任务、追踪和归因数据，不生成虚构业绩。</span></div>';
    icons();
    return;
  }
  if (!report) {
    period.textContent = '暂无简报数据';
    content.innerHTML = '<div class="weekly-report-loading"><i data-lucide="chart-no-axes-combined"></i><strong>还没有可展示的数据</strong><span>刷新后会从已保存任务生成本周汇总。</span></div>';
    icons();
    return;
  }
  period.textContent = `${report.period.label} · 真实任务口径`;
  const analytics = report.analytics || {};
  const operations = report.operations || {};
  const assets = report.assets || {};
  const tracking = report.tracking || {};
  const rate = analytics.activationRate == null ? '--' : `${analytics.activationRate}%`;
  content.innerHTML = `<section class="report-kpis"><div><span>覆盖任务</span><strong>${reportNumber(operations.total)}</strong><small>新建 ${reportNumber(operations.created)} · 完成 ${reportNumber(operations.completed)}</small></div><div><span>可用素材</span><strong>${reportNumber(assets.copy + assets.posters + assets.videos)}</strong><small>文案 ${reportNumber(assets.copy)} · 海报 ${reportNumber(assets.posters)} · 视频 ${reportNumber(assets.videos)}</small></div><div><span>追踪闭环</span><strong>${reportNumber(tracking.verified)}/${reportNumber(operations.completed)}</strong><small>完成任务已验证 Code + 短链</small></div><div><span>真实归因</span><strong>${reportNumber(analytics.pullUv)} UV</strong><small>${reportNumber(analytics.attributedRuns)} 个任务回传 · 激活率 ${rate}</small></div></section><section class="report-section"><header><div><span class="eyebrow">LEADERSHIP TAKEAWAYS</span><h3>管理层该看的结论</h3></div><span class="report-scope">只基于已回传数据</span></header><div class="report-highlights">${(report.highlights || []).map((item) => `<article class="report-highlight ${escapeHtml(item.tone || 'neutral')}"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></article>`).join('') || '<p class="report-empty">暂无可验证结论。</p>'}</div></section><section class="report-section report-performance"><header><div><span class="eyebrow">ATTRIBUTION</span><h3>实际归因，不做猜测</h3></div><span class="report-scope">${analytics.reliableRuns ? `${analytics.reliableRuns} 个样本达到可靠阈值` : '样本量不足时不下结论'}</span></header><div class="report-metrics"><div><span>拉起 UV</span><strong>${reportNumber(analytics.pullUv)}</strong></div><div><span>激活 UV</span><strong>${reportNumber(analytics.activeUv)}</strong></div><div><span>新用户</span><strong>${reportNumber(analytics.newUv)}</strong></div><div><span>D7 收入</span><strong>${reportNumber(analytics.d7Income)}</strong></div></div></section><section class="report-section report-decisions"><header><div><span class="eyebrow">DECISIONS NEEDED</span><h3>需要推进的事项</h3></div><span class="report-scope">${(report.risks || []).length ? '点击可进入对应任务' : '当前无待决任务'}</span></header><div class="report-risk-list">${(report.risks || []).length ? report.risks.map((risk) => `<button type="button" class="report-risk ${escapeHtml(risk.level || 'attention')}" data-report-run="${escapeHtml(risk.id)}"><span><i data-lucide="${risk.level === 'critical' ? 'triangle-alert' : 'circle-alert'}"></i></span><div><strong>${escapeHtml(risk.title)}</strong><small>${escapeHtml(risk.reason)}</small></div><i data-lucide="arrow-up-right"></i></button>`).join('') : '<div class="report-clear"><i data-lucide="circle-check-big"></i><span>当前没有阻塞、失败或归因缺口任务。</span></div>'}</div></section><section class="report-section report-next"><header><div><span class="eyebrow">NEXT WEEK</span><h3>建议的下一步</h3></div></header><ol>${(report.recommendations || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol></section>`;
  content.querySelectorAll('[data-report-run]').forEach((button) => button.addEventListener('click', () => {
    $('#weeklyReportDialog').close();
    openDetail(button.dataset.reportRun);
  }));
  icons();
}

async function loadWeeklyReport({ silent = false } = {}) {
  state.weeklyReportLoading = true;
  renderWeeklyReport();
  try {
    state.weeklyReport = await api(`/api/report?days=${state.weeklyReportDays}`, { timeoutMs: 45000 });
  } catch (error) {
    if (!silent) showToast(`经营简报读取失败：${error.message}`, 'error');
  } finally {
    state.weeklyReportLoading = false;
    renderWeeklyReport();
  }
}

function openWeeklyReport() {
  $('#weeklyReportDialog').showModal();
  loadWeeklyReport();
}

function renderAssetLibrary() {
  const runs = libraryRuns();
  const list = $('#runList');
  const fingerprint = assetLibraryFingerprint(runs);
  if (list.classList.contains('asset-library') && state.assetLibraryFingerprint === fingerprint) return;
  state.assetLibraryFingerprint = fingerprint;
  $('#runListHead').hidden = true;
  list.className = 'asset-library';
  $('#emptyRuns').hidden = true;
  list.innerHTML = runs.length ? runs.map((run) => {
    const assets = assetSummary(run);
    const posters = (run.artifacts?.images || []).filter((item) => item?.status === 'success' && item?.url).slice(0, 2);
    const videoUrl = run.artifacts?.video?.videoUrls?.[0] || '';
    const coverUrl = run.artifacts?.book?.cover;
    const posterPreview = posters.length ? `<div class="asset-gallery">${posters.map((item) => assetImageFrame(`/api/media?url=${encodeURIComponent(item.url)}`, `${run.input?.title} 海报`, '海报')).join('')}</div>` : '';
    const coverBook = { title: run.input?.title || '', bookSkuId: run.input?.sku || '', cover: coverUrl || '' };
    const coverPreview = coverUrl ? `<div class="asset-cover-preview resilient-cover" ${coverDataAttributes(coverBook)}>${leaderboardCover(coverBook, 'BOOK')}</div>` : '';
    const videoState = videoAssetState(run);
    const preview = `${posterPreview || coverPreview || '<div class="asset-empty">素材准备中</div>'}${videoUrl ? '<span class="asset-video-indicator"><i data-lucide="play"></i>视频可播放</span>' : ''}`;
    return `<article class="asset-card" data-asset-run="${escapeHtml(run.id)}">
      <header class="asset-card-head"><div class="asset-cover resilient-cover" ${coverDataAttributes(coverBook)}>${leaderboardCover(coverBook, 'BOOK')}</div><div><h2>${escapeHtml(run.input?.title || '')}</h2><p>${run.artifacts?.code ? `Code ${escapeHtml(run.artifacts.code)}` : '未生成推广 Code'} ${run.artifacts?.shortUrl ? '· 短链已验证' : ''}</p></div><button class="icon-button asset-open" data-open-asset="${escapeHtml(run.id)}" title="打开完整任务"><i data-lucide="arrow-up-right"></i></button></header>
      <div class="asset-preview">${preview}</div>
      <div class="asset-remove-actions">${assets.posts ? `<button data-remove-library="copy" data-run-id="${escapeHtml(run.id)}"><i data-lucide="trash-2"></i>删除文案</button>` : ''}${run.artifacts?.video ? `<button data-remove-library="video" data-run-id="${escapeHtml(run.id)}"><i data-lucide="trash-2"></i>删除视频</button>` : ''}${(run.artifacts?.images || []).length ? `<button data-remove-library="posters" data-run-id="${escapeHtml(run.id)}"><i data-lucide="trash-2"></i>删除海报</button>` : ''}</div>
      <div class="asset-counts"><span>${assets.posts} 条文案</span><span>${assets.posters} 张海报</span><span class="video-state ${videoState.tone}">${escapeHtml(videoState.label)}</span><span>${assets.tracking ? '追踪已验证' : '追踪未完成'}</span></div>
      <div class="asset-actions"><button data-copy-post="${escapeHtml(run.id)}" ${assets.posts ? '' : 'disabled'}><i data-lucide="copy"></i>文案</button><button data-copy-link="${escapeHtml(run.id)}" ${run.artifacts?.shortUrl ? '' : 'disabled'}><i data-lucide="link"></i>链接</button><button data-preview-media="${escapeHtml(run.id)}" ${videoUrl || posters[0]?.url ? '' : 'disabled'}><i data-lucide="play"></i>预览</button></div>
    </article>`;
  }).join('') : '<div class="asset-library-empty"><i data-lucide="library-big"></i><strong>还没有可直接使用的素材</strong><span>文案、视频、海报或已验证追踪完成后会自动出现在这里。</span></div>';
  list.querySelectorAll('[data-open-asset]').forEach((button) => button.addEventListener('click', () => openDetail(button.dataset.openAsset)));
  list.querySelectorAll('[data-copy-post]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const posts = await copyPostsForAsset(button.dataset.copyPost);
      await copyAssetText(posts.map((item) => item.content).join('\n\n---\n\n'), '成品文案已复制');
    } catch (error) {
      showToast(`文案读取失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }));
  list.querySelectorAll('[data-copy-link]').forEach((button) => button.addEventListener('click', () => {
    const run = state.runs.find((item) => item.id === button.dataset.copyLink);
    copyAssetText(`Search Code ${run?.artifacts?.code || ''} in NovelFlow to continue the story.\n${run?.artifacts?.shortUrl || ''}`, 'Code 与短链已复制');
  }));
  list.querySelectorAll('[data-remove-library]').forEach((button) => button.addEventListener('click', () => {
    const run = state.runs.find((item) => item.id === button.dataset.runId);
    if (run) removeRunAsset(run, button.dataset.removeLibrary);
  }));
  list.querySelectorAll('[data-preview-media]').forEach((button) => button.addEventListener('click', () => {
    const run = state.runs.find((item) => item.id === button.dataset.previewMedia);
    const url = run?.artifacts?.video?.videoUrls?.[0] || run?.artifacts?.images?.find((item) => item?.status === 'success' && item.url)?.url;
    if (url) window.open(url, '_blank', 'noopener');
  }));
  renderRunLoadMore();
}

function renderStats() {
  const active = state.runs.filter((run) => ['queued', 'running'].includes(run.state)).length;
  const complete = state.runs.filter((run) => run.state === 'completed').length;
  const attention = state.runs.filter(runNeedsAttention).length;
  $('#runningRuns').textContent = active;
  $('#readyAssets').textContent = state.runs.reduce((sum, run) => { const assets = assetSummary(run); return sum + assets.posts + assets.posters + assets.video; }, 0);
  $('#attentionRuns').textContent = attention;
  const scope = `最近 ${state.runs.length} 个任务`;
  const scopeCopy = {
    active: `${scope} · 点击查看后台持续推进的任务`,
    assets: `${scope} · 点击取用已有文案、海报或视频`,
    attention: `${scope} · 点击查看失败、阻塞、歧义或部分完成`
  };
  document.querySelectorAll('[data-overview-filter]').forEach((button) => {
    const activeFilter = button.dataset.overviewFilter === state.overviewFilter;
    button.classList.toggle('active', activeFilter);
    button.setAttribute('aria-pressed', String(activeFilter));
    const description = button.querySelector('small');
    if (description) description.textContent = scopeCopy[button.dataset.overviewFilter] || description.textContent;
  });
  const viewText = { operations: '素材、生产进度与发布后的真实表现', library: '按书籍快速取用已完成的文案、视频、海报与追踪链接', completed: '已完成的生产任务与可复用资产', attention: '需要确认、重试或核验的任务' };
  const overviewText = { active: '正在生产中的任务', assets: '已有可直接使用素材的任务', attention: '失败、阻塞、歧义或部分完成的任务' };
  $('#viewSubtitle').textContent = state.view === 'operations' && state.overviewFilter !== 'all' ? overviewText[state.overviewFilter] : (viewText[state.view] || viewText.operations);
}

function modelLedgerEntries() {
  const sectionLabels = { storyBrief: 'P2 全书梳理', posts: 'P3 六步法文案', videoPrompt: 'P3 视频剧情', posterPrompts: 'P3 海报提示词', qualityReview: 'P3 成品质检', videoPromptRewrite: '视频提示词重写', distribution: '发布建议包' };
  const runs = state.runs.flatMap((run) => (run.modelActivity || []).map((item) => ({
    runId: run.id,
    title: run.artifacts?.book?.title || run.input?.title || '未命名书籍',
    section: sectionLabels[item.section] || item.section || 'AI 任务',
    trigger: item.triggerReason || (item.fallbackFrom ? '一次备用模型接管' : '一键生产'),
    requestedModel: item.requestedModel || run.input?.creativeProfile?.modelChoice || '',
    actualModel: item.model || '',
    fallbackFrom: item.fallbackFrom || '',
    fallbackReason: item.fallbackReason || '',
    tokens: Number(item.totalTokens || 0),
    latencyMs: Number(item.latencyMs || 0),
    status: item.outputStatus || (item.error ? '未产出，等待人工决定' : item.validationStatus === 'rejected' ? '证据校验未通过' : '产物已保存'),
    error: item.error || '',
    at: item.completedAt || run.updatedAt
  })));
  const plans = state.planJobs.flatMap((job) => {
    const usage = job.artifacts?.usage;
    if (!usage?.model && !job.stages?.analysis?.error) return [];
    return [{ runId: '', planId: job.id, title: job.artifacts?.book?.title || job.input?.title || 'AI 策划', section: 'AI 策划', trigger: usage?.triggerReason || '用户发起 AI 策划', requestedModel: usage?.requestedModel || job.input?.preferredModelChoice || job.input?.modelChoice || '', actualModel: usage?.model || '', fallbackFrom: job.stages?.analysis?.fallbackFrom || '', fallbackReason: job.stages?.analysis?.fallbackReason || '', tokens: Number(usage?.totalTokens || 0), latencyMs: Number(usage?.latencyMs || 0), status: usage?.outputStatus || (job.stages?.analysis?.error ? '未产出，等待人工决定' : '策划进行中'), error: job.stages?.analysis?.error || '', at: usage?.completedAt || job.updatedAt }];
  });
  return [...runs, ...plans].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
}

function renderModelLedger() {
  const container = $('#modelLedger');
  if (!container) return;
  const entries = modelLedgerEntries().slice(0, 10);
  if (!entries.length) {
    container.innerHTML = '<header><div><span class="eyebrow">MODEL LEDGER</span><h2>模型调用账本</h2><p>模型真正开始工作后，这里会逐项显示调用原因、模型、耗时、Token 和产物状态。</p></div><span class="ledger-policy">首选充分等待 · 最多一次备用</span></header><div class="model-ledger-empty"><i data-lucide="scan-line"></i><span>当前没有已完成或待处理的模型调用。</span></div>';
    return;
  }
  const row = (entry) => {
    const fallback = entry.fallbackFrom ? `<small class="ledger-fallback" title="${escapeHtml(entry.fallbackReason || '')}">${modelLabel(entry.fallbackFrom)} → ${entry.actualModel ? modelLabel(entry.actualModel) : '未完成'} · 一次备用</small>` : '';
    const actual = entry.actualModel ? modelLogoHtml(entry.actualModel, { compact: true }) : '<span class="ledger-no-model">未完成</span>';
    const action = entry.runId ? `<button type="button" data-ledger-run="${escapeHtml(entry.runId)}" title="打开任务详情"><i data-lucide="arrow-up-right"></i></button>` : '';
    return `<article class="model-ledger-row ${entry.error ? 'failed' : ''}"><div class="ledger-book"><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.section)}</span></div><div class="ledger-trigger"><strong>${escapeHtml(entry.trigger)}</strong>${fallback}</div><div class="ledger-models"><span>请求 ${modelLogoHtml(entry.requestedModel || entry.actualModel, { compact: true })}</span><span>实际 ${actual}</span></div><div class="ledger-metrics"><span>${entry.tokens ? `${entry.tokens.toLocaleString('zh-CN')} Token` : 'Token 未返回'}</span><span>${entry.latencyMs ? `${(entry.latencyMs / 1000).toFixed(1)}s` : '耗时未返回'}</span></div><div class="ledger-output"><strong>${escapeHtml(entry.status)}</strong>${entry.error ? `<small title="${escapeHtml(entry.error)}">${escapeHtml(entry.error)}</small>` : ''}</div>${action}</article>`;
  };
  container.innerHTML = `<header><div><span class="eyebrow">MODEL LEDGER</span><h2>模型调用账本</h2><p>每一次模型调用都能对应到书籍、节点与实际产物，不再有后台不明调用。</p></div><span class="ledger-policy">首选充分等待 · 最多一次备用</span></header><div class="model-ledger-head"><span>书籍 / 节点</span><span>触发原因</span><span>请求 / 实际模型</span><span>消耗</span><span>产物状态</span></div><div class="model-ledger-rows">${entries.map(row).join('')}</div>`;
  container.querySelectorAll('[data-ledger-run]').forEach((button) => button.addEventListener('click', () => openDetail(button.dataset.ledgerRun)));
}

function renderFocusRun() {
  const section = $('#focusRun');
  const content = $('#focusRunContent');
  if (!section || !content) return;
  const run = state.runs.find((item) => item.id === state.selectedId) || state.runs[0];
  section.hidden = !run;
  if (!run) return;
  const completed = completedHarnessStages(run);
  const videoReady = Boolean(run.artifacts?.video?.videoUrls?.[0]);
  const videoProgress = videoState(run, run.artifacts?.video);
  const posterCount = (run.artifacts?.images || []).filter((item) => item.url).length;
  const copyCount = (run.artifacts?.posts || []).length;
  const shortUrl = run.artifacts?.shortUrl;
  const reviewReady = Boolean(run.artifacts?.review) || run.stages?.P6?.status === 'done';
  const outcome = runOutcome(run);
  const completion = Math.round(completed / HARNESS_NODE_COUNT * 100);
  const harness = harnessProjectionForUi(run);
  const target = harness.target || {};
  content.innerHTML = `<article class="focus-card">
    <div class="focus-book">${cover(run)}<div><div class="focus-title-row"><h2>${escapeHtml(run.input?.title)}</h2><span class="status-badge ${escapeHtml(outcome.className)}">${escapeHtml(outcome.label)}</span></div><p>SKU ${escapeHtml(run.input?.sku)} · ${completed}/${HARNESS_NODE_COUNT} 个节点完成</p><div class="focus-tracking"><span>Code <strong>${escapeHtml(run.artifacts?.code || '待分配')}</strong></span>${shortUrl ? `<a href="${escapeHtml(shortUrl)}" target="_blank" rel="noopener">打开短链 <i data-lucide="external-link"></i></a>` : '<span>短链待创建</span>'}</div></div></div>
    <div class="focus-route-lock"><i data-lucide="${target.locked ? 'lock-keyhole' : 'unlock-keyhole'}"></i><div><span>P0 目标路由</span><strong>${escapeHtml(target.appName || target.appKey || '未锁定')} / ${escapeHtml(target.platform || '—')} / ${escapeHtml(target.accountTitle || '未绑定账号')}</strong></div><small>${target.locked ? 'route locked' : 'route pending'}</small></div>
    <div class="focus-progress" aria-label="生产完成度"><div><span>生产完成度</span><strong>${completion}%</strong></div><div class="focus-progress-track"><i style="width:${completion}%"></i></div><small>${escapeHtml(videoProgress.label)}</small></div>
    <div class="focus-flow">${pipelineOrder.map((key) => `<button class="focus-step ${stageClass(displayStage(run, key))}" data-node-decision="${key}" title="查看${escapeHtml(stageLabels[key])}的决策说明"><i data-lucide="${stageIcons[key]}"></i><span>${escapeHtml(stageLabels[key])}</span></button>`).join('')}</div>
    <div class="focus-assets"><button data-detail-target="copy"><i data-lucide="message-square-text"></i><strong>${copyCount}</strong><span>成品文案</span></button><button data-detail-target="video" class="${videoReady ? 'ready' : videoProgress.kind === 'failed' || videoProgress.kind === 'blocked' ? 'failed' : ''}"><i data-lucide="video"></i><strong>${videoReady ? '已就绪' : videoProgress.kind === 'failed' || videoProgress.kind === 'blocked' ? '生成失败' : videoProgress.kind === 'running' ? '生成中' : '等待中'}</strong><span>视频</span></button><button data-detail-target="posters" class="${posterCount === 2 ? 'ready' : posterCount ? 'partial' : ''}"><i data-lucide="images"></i><strong>${posterCount}/2</strong><span>海报</span></button><button data-detail-target="review" class="${reviewReady ? 'ready' : ''}"><i data-lucide="badge-check"></i><strong>${reviewReady ? '已就绪' : '等待中'}</strong><span>审核包</span></button></div>
  </article>`;
  $('#openFocusRun').onclick = () => openDetail(run.id);
  document.querySelectorAll('[data-detail-target]').forEach((button) => button.addEventListener('click', () => openDetail(run.id, button.dataset.detailTarget)));
  document.querySelectorAll('[data-node-decision]').forEach((button) => button.addEventListener('click', () => openNodeDecision(run.id, button.dataset.nodeDecision)));
}

function pipelineNode(run, key) {
  const stage = displayStage(run, key);
  const target = run.input?.delivery;
  const artifact = { P0: target ? `${target.appName || target.appKey} · ${target.platform}` : '历史选择', P1: run.artifacts?.book?.bookSkuId, P2: run.artifacts?.evidence?.completed ? `${run.artifacts.evidence.completed} 章` : '', P5: run.artifacts?.code ? `Code ${run.artifacts.code}` : '', P3: run.artifacts?.posts?.length ? `${run.artifacts.posts.length} 套文案` : '', P4: run.artifacts?.video?.videoUrls?.[0] ? '可播放' : run.artifacts?.video?.threadId ? '生成中' : '', P3_5: run.artifacts?.images?.length ? `${run.artifacts.images.filter((item) => item.url).length}/2 海报` : '', P6: run.artifacts?.review ? '审核包就绪' : '', P7: run.artifacts?.review?.publicationStatus === 'external_draft' ? 'SocialEcho 草稿' : run.artifacts?.review?.publicationDraftId ? '内部草稿' : '' }[key] || stage.label || stage.status;
  const stageStatus = stage.status === 'done' ? '已完成' : stage.status === 'waiting' && stage.phase === 'fallback_scheduled' ? '备用模型将接管' : stage.status === 'waiting' && /repairing|recovering/.test(String(stage.phase || '')) ? 'AI 自动修复中' : stage.status === 'waiting' ? '等待上游节点' : stage.status === 'failed' ? '生成失败' : stage.status === 'blocked' ? '已阻塞' : stage.status === 'ambiguous' ? '需人工核验' : stage.status === 'partial' ? '部分完成' : stage.status === 'submitting' ? '提交中' : stage.status === 'prepared' ? '已准备' : '生成中';
  return `<button type="button" class="flow-node ${stageClass(stage)}" data-node-decision="${key}" title="查看${escapeHtml(stageLabels[key] || key)}的决策说明"><span class="flow-node-top"><i data-lucide="${stageIcons[key] || 'circle'}"></i><span>${escapeHtml(stageLabels[key] || key)}</span></span><strong>${escapeHtml(artifact)}</strong><small>${escapeHtml(stageStatus)}</small></button>`;
}

function waitDurationLabel(value) {
  const seconds = waitDurationSeconds(value);
  if (!Number.isFinite(seconds)) return '刚刚开始';
  return seconds >= 60 ? `已等待 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `已等待 ${seconds} 秒`;
}

function waitDurationSeconds(value) {
  const seconds = Math.floor((Date.now() - Date.parse(value || '')) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

function productionStatusHtml(run, active) {
  const [key, stage = {}] = active || [];
  const waiting = ['waiting', 'running', 'submitting', 'prepared'].includes(stage.status);
  if (!waiting) return '';
  const model = run.input?.creativeProfile?.modelChoice || 'hy3';
  const isCreative = ['P2', 'P3'].includes(key);
  const fallback = stage.fallbackFrom || (stage.phase === 'fallback_scheduled' ? model : '');
  const nextAt = Date.parse(stage.nextAttemptAt || '');
  const next = Number.isFinite(nextAt) ? new Date(nextAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const expectedSeconds = isCreative ? (usesLongBackground(model) ? 600 : 60) : 0;
  const overdue = expectedSeconds && !/repairing/.test(String(stage.phase || '')) && waitDurationSeconds(stage.startedAt || run.updatedAt) > expectedSeconds;
  const situation = overdue
    ? `已超过 ${Math.ceil(expectedSeconds / 60)} 分钟正常等待窗口，后台尚未收到可核实的模型结果。为避免重复消耗 Token，系统没有偷偷重发请求。`
    : /repairing/.test(String(stage.phase || ''))
    ? `${modelLabel(model)} 已收到异常格式，正在自动修复并重试；不会重复创建 Code 或提交付费媒体。`
    : stage.phase === 'fallback_scheduled'
    ? `首选 ${modelLabel(fallback || model)} 未返回可用结果，唯一备用 ${modelLabel(model)} 将从已保存证据接管。`
    : stage.phase === 'waiting_for_operator' || stage.executionMode === 'waiting_for_operator'
      ? '自动恢复已停止，不会继续消耗 Token；请在任务详情中选择重试或切换模型。'
      : isCreative
        ? `${modelLabel(model)} 正在${key === 'P2' ? '梳理全书结构' : '生成创意素材'}，任务不会因页面关闭而中断。`
        : '正在等待前置节点或外部任务返回；不会重复创建 Code、图片或视频。';
  const nextStep = overdue ? '请在“模型活动”确认是否已有产物；没有产物时再手动选择重试或切换模型，避免双重调用。' : /repairing/.test(String(stage.phase || '')) ? (next ? `${next} 前后台会自动完成修复，不需要点击。` : '后台会自动完成修复，不需要点击。') : stage.phase === 'fallback_scheduled' ? (next ? `${next} 后启动唯一备用模型。` : '备用模型将在下一次后台推进时启动。') : key === 'P3' ? '完成后会依次保存文案、视频提示词、海报提示词和成品质检。' : key === 'P2' ? '完成后将继续创建 Code 和短链，再进入创意生成。' : stage.label || '后台会在状态变化后自动推进下一节点。';
  const recoveryAction = overdue && key === 'P3' && !/repairing/.test(String(stage.phase || '')) ? `<button class="primary-command ai-wait-recovery" data-ai-wait-recovery="${escapeHtml(run.id)}" type="button"><i data-lucide="route"></i>启用唯一备用继续</button>` : '';
  return `<aside class="production-status-card ${overdue ? 'overdue' : stage.phase === 'fallback_scheduled' ? 'fallback' : ''}"><div class="production-status-icon"><i data-lucide="${overdue ? 'circle-alert' : stage.phase === 'fallback_scheduled' ? 'route' : 'loader-circle'}"></i></div><div><span>当前正在发生什么</span><strong>${escapeHtml(stageLabels[key] || key)} · ${escapeHtml(waitDurationLabel(stage.startedAt || run.updatedAt))}${overdue ? ' · 已超时' : ''}</strong><p>${escapeHtml(situation)}</p><small><b>下一步：</b>${escapeHtml(nextStep)}</small></div><div class="production-status-meta"><span>${isCreative ? modelLogoHtml(model, { compact: true }) : '自动推进'}</span><small>${overdue ? `正常窗口 ${Math.ceil(expectedSeconds / 60)} 分钟 · 未自动重发` : stage.error ? escapeHtml(stage.error) : '状态已持久化，可关闭页面'}</small>${recoveryAction}</div></aside>`;
}

async function recoverAiWait(id, button) {
  button.disabled = true;
  button.innerHTML = '<i data-lucide="loader-circle"></i>正在安排备用模型';
  icons();
  try {
    const body = await api(`/api/worker?id=${encodeURIComponent(id)}&recoverCreative=1`, { method: 'POST', timeoutMs: 180000 });
    showToast(body.recoveryScheduled ? '唯一备用模型已接管，将从已保存证据继续' : '当前节点状态已刷新，没有重复发起模型请求');
    await loadStatus({ silent: true });
    const current = state.runs.find((item) => item.id === id);
    if (current) state.runs = state.runs.map((item) => item.id === id ? { ...item, _summary: true } : item);
    state.detailFingerprint = '';
    hydrateRunDetail(id);
  } catch (error) {
    button.disabled = false;
    button.innerHTML = '<i data-lucide="route"></i>启用唯一备用继续';
    icons();
    showToast(`备用模型未能接管：${error.message}`, 'error');
  }
}

function nodeDecision(run, node) {
  const stage = displayStage(run, node);
  const evidence = run.artifacts?.evidence;
  const selectedModel = modelLabel(run.input?.creativeProfile?.modelChoice);
  const planning = run.input?.planning || {};
  const strategy = planning.strategy || {};
  const strategyEvidence = Array.isArray(strategy.evidence) ? strategy.evidence : [];
  const rationale = Object.values(strategy.rationale || {}).map(String).filter(Boolean).join('；');
  const planningTime = planning.completedAt ? new Date(planning.completedAt).toLocaleString('zh-CN', { hour12: false }) : '';
  const decisions = {
    P0: { timing: '生成前', title: '投放目标与选书快照', conclusion: run.input?.delivery ? `已锁定 ${run.input.delivery.appName || run.input.delivery.appKey} / ${run.input.delivery.platform} / ${run.input.delivery.accountTitle}，后续查书、Code 与草稿都使用同一路由。` : '历史任务没有保存完整投放路由。', why: '先锁定应用、平台和账号，再在对应产品线内按阅读基数与质量指标选书。', basis: run.input?.p0Selection?.source ? `${run.input.p0Selection.source} · ${run.input.p0Selection.windowDays || 0} 天 · 排名 ${run.input.p0Selection.sourceRank || '未记录'}` : 'Legacy selection' },
    P1: { timing: '生成前', title: '书籍身份核验', conclusion: run.artifacts?.book ? `已锁定 SKU ${run.artifacts.book.bookSkuId}，后续资产只会绑定这一条书籍记录。` : '等待精确书名与 SKU 核验。', why: '避免同名书、历史下架书或错误 SKU 进入推广链路。', basis: run.artifacts?.book?.title || 'Bookstore exact lookup' },
    P2: { timing: '生成前', title: '章节证据锁定', conclusion: evidence?.completed ? `已锁定 ${evidence.completed}/${evidence.requested} 个章节证据，覆盖开篇与后段升级。` : '等待下载章节证据。', why: '素材只能使用已锁定章节事实，避免生成后再倒推依据。', basis: evidence?.chapters?.map((item) => `Ch.${item.order}`).join(' / ') || '章节证据尚未就绪' },
    P5: { timing: '生成前', title: '追踪 Code 与短链', conclusion: run.artifacts?.shortUrl ? `Code ${run.artifacts.code} 与短链已在创意生成前完成验证。` : '等待后台自动分配并远端验证。', why: '先确保归因可用，再把已验证短链写入文案。', basis: run.artifacts?.shortUrl || 'Promotion code and link verification' },
    P3: strategy.editorialThesis ? { timing: '生成前', title: '事前创意策划', conclusion: strategy.editorialThesis, why: rationale || '该方向在任何成品文案、视频或海报生成之前，由章节样本确定并固化。', basis: `${modelLabel(planning.actualModel)} · ${planningTime || '生成前已固化'}${strategyEvidence.length ? ` · ${strategyEvidence.map((item) => `Ch.${item.chapter}`).join(' / ')}` : ''}` } : { timing: '生成前', title: '生产时创意约束', conclusion: `${selectedModel} 将根据已锁定章节证据生成文案、视频叙事和海报提示词。`, why: '此任务未经过独立智能策划入口，因此这里只展示生成前已有的人工选项，不引用成品结果。', basis: `${selectedModel} · ${evidence?.chapters?.map((item) => `Ch.${item.order}`).join(' / ') || '等待章节证据'}` },
    P4: { timing: '执行记录', title: '视频生成执行', conclusion: run.artifacts?.video?.threadId ? `AC 任务 ${run.artifacts.video.threadId} 已提交或正在回传。` : '视频将采用已验证章节的五拍叙事。', why: run.artifacts?.videoPrompt?.reversal || '在 8-11 秒给出原文支持的反转，结尾保留未解问题。', basis: (run.artifacts?.videoPrompt?.evidenceChapters || []).map((item) => `Ch.${item}`).join(' / ') || '等待视频提示词' },
    P3_5: { timing: '执行记录', title: '海报生成执行', conclusion: run.artifacts?.images?.length ? `${run.artifacts.images.filter((item) => item.url).length}/${run.artifacts.images.length} 张海报已回传。` : '两套视觉将分别覆盖电影感与编辑爱情感。', why: '每张图聚焦一个有章节依据的决定性瞬间。', basis: (run.artifacts?.posterPrompts || []).map((item) => item.variant).join(' / ') || '等待海报提示词' },
    P6: { timing: '生成后', title: '审核与归因包', conclusion: run.artifacts?.review ? '审核包已就绪，发布动作仍由人工审核。' : '等待素材汇总与归因数据查询。', why: '这是生成完成后的汇总审核，不代表事前创意决策。', basis: run.artifacts?.analytics?.summary?.pullUv != null ? `当前拉起 UV ${run.artifacts.analytics.summary.pullUv}` : 'Automatic publishing disabled' },
    P7: { timing: '交付记录', title: 'SocialEcho 定时任务与对账', conclusion: run.artifacts?.review?.publicationStatus === 'external_draft' ? 'SocialEcho status 1 + scheduled_at 定时任务已创建，绝不立即发布。' : run.artifacts?.review?.publicationStatus === 'publish_ambiguous' ? '定时任务提交结果不明确，已停止自动重试并等待对账。' : run.artifacts?.review?.publicationDraftId ? '内部定时任务草稿已持久化，等待 SocialEcho API 提交。' : '等待审核包生成可交付定时任务。', why: 'P7 只提交带未来 scheduled_at 的定时任务，不调用立即发布；任何歧义结果都必须先对账。', basis: run.artifacts?.review?.publicationDraftId || 'Publication draft not created' }
  };
  return { ...(decisions[node] || decisions.P1), status: stage.status || 'waiting' };
}

function decisionHtml(run) {
  const node = state.selectedNode || 'P3';
  const decision = nodeDecision(run, node);
  return `<section id="detail-decision" class="detail-section node-decision"><div class="section-heading"><div><h3>节点结论</h3><p>每条结论标明发生阶段；生成后的检查不会冒充生成前决策。</p></div><span class="language-tag">${escapeHtml(stageLabels[node] || node)}</span></div><div class="decision-card"><div class="decision-flags"><span class="decision-timing">${escapeHtml(decision.timing)}</span><span class="decision-status ${escapeHtml(stageClass({ status: decision.status }))}">${escapeHtml(decision.status === 'done' ? '已完成' : decision.status === 'waiting' ? '等待中' : '进行中')}</span></div><strong>${escapeHtml(decision.title)}</strong><p>${escapeHtml(decision.conclusion)}</p><div><span>${decision.timing === '生成后' ? '检查目的' : '为什么这样做'}</span><p>${escapeHtml(decision.why)}</p></div><div><span>当时依据</span><p>${escapeHtml(decision.basis)}</p></div></div></section>`;
}

function postProductionReviewHtml(run) {
  const review = run.artifacts?.qualityReview;
  if (!review) return '';
  const activity = [...(run.artifacts?.modelActivity || [])].reverse().find((item) => item.section === 'qualityReview' && item.validationStatus !== 'rejected');
  const reviewModel = modelLabel(activity?.model || run.input?.creativeProfile?.modelChoice);
  const optimization = run.artifacts?.optimization || {};
  const reviewAt = activity?.completedAt || optimization.createdAt || optimization.resolvedAt || run.stages?.P3?.completedAt;
  const outcome = optimization.status === 'auto_applied' || optimization.status === 'manual_variant_applied' ? '已根据质检生成优化版' : optimization.status === 'kept_by_operator' || optimization.status === 'kept' ? '已保留当前版本' : review.recommendation === 'refine' ? '建议优化' : '检查通过';
  return `<section id="detail-quality" class="detail-section post-review"><div class="section-heading"><div><h3>成品质检</h3><p>生成后执行，仅评估已经产出的素材，不会改写上方的事前策划快照。</p></div><span class="review-phase">生成后</span></div><div class="review-card"><header><div><span>${escapeHtml(reviewModel)} · ${reviewAt ? escapeHtml(new Date(reviewAt).toLocaleString('zh-CN', { hour12: false })) : '完成后检查'}</span><strong>${escapeHtml(outcome)}</strong></div><span>${escapeHtml(review.target || 'package')}</span></header><p>${escapeHtml(review.conclusion)}</p><div><span>质检依据</span><p>${escapeHtml(review.why)}</p></div></div></section>`;
}

function pipelineHtml(run) {
  return `<div class="flow-main">${pipelineNode(run, 'P0')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P1')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P2')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P5')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P3')}</div><div class="flow-branch"><div>${pipelineNode(run, 'P4')}</div><div>${pipelineNode(run, 'P3_5')}</div></div><div class="flow-final"><i data-lucide="git-merge"></i>${pipelineNode(run, 'P6')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P7')}</div>`;
}

function harnessProjectionForUi(run) {
  const fallbackTarget = run.input?.delivery || {};
  const fallbackP0 = run.input?.p0Selection || {};
  const fallbackStages = pipelineOrder.map((key, order) => {
    const stage = displayStage(run, key);
    const isP7 = key === 'P7';
    const publicationStatus = String(run.artifacts?.review?.publicationStatus || '');
    const externalDraftId = isP7 && publicationStatus === 'external_draft'
      ? String(run.artifacts?.review?.socialEchoDraftId || run.artifacts?.review?.externalDraftId || '')
      : '';
    return {
      key, order, label: stageLabels[key] || key, purpose: stage.label || '', status: stage.status || 'waiting',
      artifact: isP7 ? (externalDraftId ? 'SocialEcho external draft' : String(run.artifacts?.review?.publicationDraftId || '')) : '',
      recoverable: Boolean(stage.recoverable), error: stage.error || '', blockedReason: stage.blockedReason || '',
      externalTaskId: key === 'P4' ? String(run.artifacts?.video?.threadId || '') : externalDraftId,
      internalTaskId: isP7 ? String(run.artifacts?.review?.publicationDraftId || '') : '',
      externalStatus: isP7 ? publicationStatus : '',
      scheduledAt: isP7 ? String(run.artifacts?.review?.scheduledAt || run.input?.campaign?.scheduledAt || '') : ''
    };
  });
  const fallback = {
    status: runOutcome(run).className || run.state,
    completion: { completed: completedHarnessStages(run), total: HARNESS_NODE_COUNT, percent: Math.round(completedHarnessStages(run) / HARNESS_NODE_COUNT * 100) },
    target: { locked: Boolean(fallbackTarget.accountId), applicationId: fallbackTarget.applicationId || '', appKey: fallbackTarget.appKey || fallbackTarget.productLine || '', appName: fallbackTarget.appName || fallbackTarget.productLine || '', accountId: fallbackTarget.accountId || 0, accountTitle: fallbackTarget.accountTitle || '', platform: fallbackTarget.platform || '', includeLink: fallbackTarget.includeLink === true },
    p0: { locked: Boolean(fallbackTarget.accountId && (run.input?.sku || fallbackP0.sourceRank)), source: fallbackP0.source || '', windowDays: fallbackP0.windowDays || 0, sourceRank: fallbackP0.sourceRank || 0, readerBase: fallbackP0.readerBase || 0, firstReadRate: fallbackP0.firstReadRate || 0, longReadRate: fallbackP0.longReadRate || 0, trend7v30: fallbackP0.trend7v30 ?? null, filters: fallbackP0.filters || null },
    book: { title: run.input?.title || run.artifacts?.book?.title || '', sku: run.input?.sku || run.artifacts?.book?.bookSkuId || '' },
    activeStage: currentStage(run) ? { key: currentStage(run)[0], label: stageLabels[currentStage(run)[0]] || currentStage(run)[0], status: currentStage(run)[1]?.status || 'waiting' } : null,
    nextAction: { nextAction: run.operations?.nextAction || '', nextActionLabel: run.operations?.nextActionLabel || '' },
    blockers: Object.entries(run.stages || {}).filter(([, stage]) => ['failed', 'blocked', 'ambiguous', 'partial'].includes(String(stage?.status || ''))).map(([stage, value]) => ({ stage, label: stageLabels[stage] || stage, status: value.status, reason: value.error || value.blockedReason || (value.status === 'ambiguous' ? '先对账，不得重复提交' : '需要处理') })),
    stages: fallbackStages
  };
  const projected = run.harness && typeof run.harness === 'object' ? run.harness : fallback;
  // Normalize old summaries in memory. In particular, never trust a legacy
  // P7 `publicationDraftId` as an external SocialEcho ID.
  const normalizedStages = (Array.isArray(projected.stages) ? projected.stages : fallbackStages).map((stage) => {
    const next = { ...stage };
    if (next.key === 'P7') {
      const publicationStatus = String(next.externalStatus || run.artifacts?.review?.publicationStatus || '');
      next.internalTaskId = next.internalTaskId || String(run.artifacts?.review?.publicationDraftId || '');
      next.externalTaskId = publicationStatus === 'external_draft'
        ? (next.externalTaskId || String(run.artifacts?.review?.socialEchoDraftId || run.artifacts?.review?.externalDraftId || ''))
        : '';
      next.externalStatus = publicationStatus;
      next.scheduledAt = next.scheduledAt || String(run.artifacts?.review?.scheduledAt || run.input?.campaign?.scheduledAt || '');
    }
    return next;
  });
  const blockers = Array.isArray(projected.blockers) && projected.blockers.length
    ? projected.blockers
    : fallback.blockers;
  return {
    ...fallback,
    ...projected,
    stages: normalizedStages,
    blockers,
    nextAction: projected.nextAction || fallback.nextAction,
    activeStage: projected.activeStage || fallback.activeStage
  };
}

function harnessStatusLabel(status) {
  return { done: '已完成', waiting: '等待上游', running: '运行中', submitting: '提交中', prepared: '已准备', failed: '明确失败', blocked: '已阻塞', ambiguous: '需人工对账', partial: '部分完成' }[status] || status || '等待中';
}

function harnessLedgerHtml(run) {
  const harness = harnessProjectionForUi(run);
  const target = harness.target || {};
  const p0 = harness.p0 || {};
  const completion = harness.completion || {};
  const platformLabel = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' }[target.platform] || target.platform || '—';
  const blockers = Array.isArray(harness.blockers) ? harness.blockers : [];
  const stages = Array.isArray(harness.stages) ? harness.stages : [];
  const taskId = (value) => Array.isArray(value) ? value.map((item) => String(item).slice(-10)).join(', ') : String(value || '').slice(-16);
  return `<section id="detail-harness" class="detail-section harness-detail-section">
    <header class="harness-detail-head"><div><span class="eyebrow">P0-P7 HARNESS LEDGER</span><h3>可恢复、可审计的生产账本</h3><p>同一个目标路由贯穿选书、Code、媒体和 SocialEcho 草稿；外部任务 ID 先保存再轮询。</p></div><span class="harness-completion ${escapeHtml(harness.status || '')}"><strong>${Number(completion.percent || 0)}%</strong><small>${Number(completion.completed || 0)}/${Number(completion.total || HARNESS_NODE_COUNT)} 节点</small></span></header>
    <div class="harness-target-lock ${target.locked ? 'locked' : 'unlocked'}"><div><span>目标路由</span><strong>${escapeHtml(target.appName || target.appKey || '未锁定')} / ${escapeHtml(platformLabel)} / ${escapeHtml(target.accountTitle || '未绑定账号')}</strong><small>${target.applicationId ? `applicationId ${escapeHtml(String(target.applicationId).slice(-16))}` : '缺少 applicationId，禁止执行'} · accountId ${escapeHtml(String(target.accountId || '—'))}</small></div><b><i data-lucide="${target.locked ? 'lock-keyhole' : 'unlock-keyhole'}"></i>${target.locked ? 'route locked' : 'route pending'}</b></div>
    <div class="harness-p0-snapshot"><span>P0 书籍快照</span><strong>${escapeHtml(harness.book?.title || run.input?.title || '未锁定书籍')}</strong><small>SKU ${escapeHtml(harness.book?.sku || '—')} · 中台 rank ${escapeHtml(String(p0.sourceRank || '—'))} · 近 ${escapeHtml(String(p0.windowDays || '—'))} 天</small><div><b>阅读 ${compactNumber(p0.readerBase)}</b><b>首读 ${p0Percent(p0.firstReadRate)}</b><b>长读 ${p0Percent(p0.longReadRate)}</b><b>趋势 ${p0.trend7v30 == null ? '—' : p0Percent(p0.trend7v30)}</b></div></div>
    <div class="harness-ledger-list">${stages.map((stage) => { const external = stage.externalTaskId ? `外部 ID ${escapeHtml(taskId(stage.externalTaskId))}` : ''; const internal = stage.internalTaskId ? `内部 ID ${escapeHtml(taskId(stage.internalTaskId))}` : ''; const schedule = stage.scheduledAt ? `排期 ${escapeHtml(stage.scheduledAt)}` : ''; return `<article class="harness-ledger-row status-${escapeHtml(stage.status || 'waiting')}"><div class="harness-step-key"><b>${escapeHtml(stage.key)}</b><span>${escapeHtml(stage.label || stageLabels[stage.key] || stage.key)}</span></div><div><strong>${escapeHtml(stage.purpose || '等待节点执行')}</strong><small>${escapeHtml(stage.artifact || '—')}</small></div><div><span class="harness-status-chip">${escapeHtml(harnessStatusLabel(stage.status))}</span><small>${external || internal || stage.nextAttemptAt ? `${external}${external && internal ? ' · ' : ''}${internal}${(external || internal) && stage.nextAttemptAt ? ' · ' : ''}${stage.nextAttemptAt ? `下次尝试 ${escapeHtml(stage.nextAttemptAt)}` : ''}` : stage.recoverable ? '可恢复' : ''}${schedule ? `<br>${schedule}` : ''}</small></div><div class="harness-next-action">${stage.status === 'ambiguous' ? '先对账，不得重提' : stage.status === 'failed' ? '人工确认失败后再重试' : stage.status === 'blocked' ? '处理阻塞条件' : stage.status === 'done' ? '已留存产物' : '等待后台推进'}</div></article>`; }).join('')}</div>
    ${blockers.length ? `<aside class="harness-blockers"><strong><i data-lucide="triangle-alert"></i>当前阻塞</strong>${blockers.map((item) => `<span>${escapeHtml(item.stage)} · ${escapeHtml(item.reason)}</span>`).join('')}</aside>` : '<aside class="harness-clear"><i data-lucide="shield-check"></i>当前没有需要人工升级的 Harness 阻塞</aside>'}
  </section>`;
}

function idlePipelineHtml() {
  return `<div class="idle-pipeline"><span>选书</span><i data-lucide="arrow-right"></i><span>证据</span><i data-lucide="arrow-right"></i><span>Code / 短链</span><i data-lucide="arrow-right"></i><span>创意</span><i data-lucide="arrow-right"></i><span>视频 / 海报</span><i data-lucide="arrow-right"></i><span>审核包</span></div>`;
}

function removeAssetButton(asset, label) {
  return `<button class="secondary-command remove-asset" data-remove-asset="${escapeHtml(asset)}" title="从当前任务移除${escapeHtml(label)}"><i data-lucide="trash-2"></i><span>移除${escapeHtml(label)}</span></button>`;
}

function copyHtml(run) {
  const posts = run.artifacts?.posts || [];
  if (!posts.length) return '<div class="media-placeholder">文案生成后将在这里直接显示</div>';
  const paragraphs = (value, className = '') => String(value || '').split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean).map((block) => `<p${className ? ` class="${className}"` : ''}>${escapeHtml(block)}</p>`).join('');
  const footer = (value) => {
    const lines = String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const urlIndex = lines.findIndex((line) => /^https?:\/\//i.test(line));
    const tagIndex = lines.length - 1;
    const tagLine = /^(?:#[A-Za-z][A-Za-z0-9_]*\s*){5,8}$/.test(lines[tagIndex] || '') ? lines[tagIndex] : '';
    const codeIndex = urlIndex > 0 ? urlIndex - 1 : -1;
    const ctaIndex = urlIndex > 1 ? urlIndex - 2 : -1;
    const cta = ctaIndex >= 0 && /\b(?:see|read)\s+what\s+happens\s+when\b/i.test(lines[ctaIndex]) ? lines[ctaIndex] : '';
    const code = codeIndex >= 0 && /novelflow/i.test(lines[codeIndex]) ? lines[codeIndex] : '';
    const url = urlIndex >= 0 ? lines[urlIndex] : '';
    const narrativeEnd = cta ? ctaIndex : (tagLine ? tagIndex : lines.length);
    return { narrative: lines.slice(0, narrativeEnd).join('\n'), cta, code, url, tagLine };
  };
  return posts.map((post, index) => {
    const en = footer(post.content);
    const zh = post.zhContent ? footer(post.zhContent) : null;
    const footerHtml = (item) => item && (item.cta || item.code || item.url || item.tagLine) ? `<div class="copy-footer"><div class="copy-footer-main">${item.cta ? `<span class="copy-footer-label">CTA</span><strong>${escapeHtml(item.cta)}</strong>` : ''}${item.code ? `<span class="copy-footer-label">NovelFlow 引导</span><span>${escapeHtml(item.code)}</span>` : ''}${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">打开短链 <i data-lucide="external-link"></i></a>` : ''}</div>${item.tagLine ? `<div class="copy-hashtags"><span class="copy-footer-label">发布标签</span><strong>${escapeHtml(item.tagLine)}</strong></div>` : ''}</div>` : '';
    return `<article class="copy-output"><div class="copy-output-head"><span class="copy-type">${escapeHtml(post.type)}</span><div class="copy-output-actions"><button class="copy-complete-post" data-copy-post-index="${index}" data-copy-post-language="en" type="button"><i data-lucide="copy"></i>复制完整英文文案</button>${zh ? `<button class="copy-complete-post subtle" data-copy-post-index="${index}" data-copy-post-language="zh" type="button"><i data-lucide="languages"></i>复制完整中文</button>` : ''}</div></div><div class="copy-paragraphs">${paragraphs(en.narrative || post.content)}</div>${footerHtml(en)}${zh ? `<div class="copy-paragraphs translation">${paragraphs(zh.narrative || post.zhContent)}</div>${footerHtml(zh)}` : ''}</article>`;
  }).join('');
}

function optimizationHtml(run) {
  const optimization = run.artifacts?.optimization;
  if (optimization?.status !== 'awaiting_confirmation') return '';
  const review = optimization.review || {};
  const selectedModel = modelLabel(run.input?.creativeProfile?.modelChoice);
  const seconds = Math.max(0, Math.ceil((Date.parse(optimization.dueAt || '') - Date.now()) / 1000));
  return `<aside class="optimization-alert"><div><i data-lucide="sparkles"></i><strong>${escapeHtml(selectedModel)} 建议先优化再提交素材</strong><span>${escapeHtml(review.conclusion || '')}</span><small>为什么：${escapeHtml(review.why || '')}</small></div><div class="optimization-actions"><span>${seconds}s 后默认执行</span><button class="secondary-command" data-optimization="keep" type="button">保留当前</button><button class="primary-command" data-optimization="apply" type="button">使用优化版</button></div></aside>`;
}

function promptHtml(run) {
  const video = run.artifacts?.videoPrompt;
  const draft = run.artifacts?.videoPromptDraft;
  const posters = run.artifacts?.posterPrompts || [];
  if (!video && !posters.length) return '';
  const beats = video ? [
    ['钩子 0-2s', video.hook, video.zhHook], ['价值 2-5s', video.valuePromise, video.zhValuePromise], ['升级 5-8s', video.escalation, video.zhEscalation], ['反转 8-11s', video.reversal, video.zhReversal], ['悬念 11-15s', video.cliffhanger, video.zhCliffhanger]
  ].filter(([, value]) => value) : [];
  return `<section id="detail-prompts" class="detail-section"><div class="section-heading"><h3>双语生产提示词</h3><span class="language-tag">EN / 中文</span></div>
    ${video ? `<div class="video-story"><div class="video-story-head"><strong>短视频叙事脚本</strong><span>基于原文章节 ${escapeHtml((video.evidenceChapters || []).join(' / '))}</span></div>${beats.length ? `<div class="story-beats">${beats.map(([label, value, zh]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${zh ? `<small>${escapeHtml(zh)}</small>` : ''}</article>`).join('')}</div>` : ''}${Array.isArray(video.sourceEvidence) && video.sourceEvidence.length ? `<div class="source-evidence">${video.sourceEvidence.map((item) => `<span>Ch.${escapeHtml(item.chapter)} · “${escapeHtml(item.quote)}”</span>`).join('')}</div>` : ''}<div class="prompt-block"><strong>英文旁白与镜头执行</strong><pre>${escapeHtml(video.adCopy)}\n\n${escapeHtml(video.buildRequirement)}</pre>${video.zhAdCopy || video.zhBuildRequirement ? `<p class="translation">${escapeHtml(video.zhAdCopy || '')}\n\n${escapeHtml(video.zhBuildRequirement || '')}</p>` : ''}</div></div>` : ''}
    ${draft?.status === 'ready_for_review' ? `<aside class="video-rewrite-review"><header><div><span>待核对视频提示词</span><strong>${escapeHtml(modelLabel(draft.model))} 已基于原文证据重写</strong></div><span>未提交新视频</span></header><div class="story-beats">${[['钩子 0-2s', draft.hook, draft.zhHook], ['价值 2-5s', draft.valuePromise, draft.zhValuePromise], ['升级 5-8s', draft.escalation, draft.zhEscalation], ['反转 8-11s', draft.reversal, draft.zhReversal], ['悬念 11-15s', draft.cliffhanger, draft.zhCliffhanger]].map(([label, value, zh]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${zh ? `<small>${escapeHtml(zh)}</small>` : ''}</article>`).join('')}</div><div class="prompt-block"><strong>新旁白与镜头执行</strong><pre>${escapeHtml(draft.adCopy)}\n\n${escapeHtml(draft.buildRequirement)}</pre></div><footer><button class="secondary-command" data-video-prompt-action="discard" type="button">保留原提示词</button><button class="secondary-command" data-video-prompt-action="approve" type="button">仅采用新提示词</button><button class="primary-command" data-video-prompt-action="approve_and_submit" type="button"><i data-lucide="video"></i>核对无误，提交新视频</button></footer></aside>` : ''}
    ${posters.map((item) => `<div class="prompt-block"><strong>${escapeHtml(item.variant)}${item.repairCount ? ` · DeepSeek 审核修复 ${escapeHtml(item.repairCount)}/1` : ''}</strong><pre>${escapeHtml(item.prompt)}</pre>${item.zhPrompt ? `<p class="translation">${escapeHtml(item.zhPrompt)}</p>` : ''}</div>`).join('')}
  </section>`;
}

function videoState(run, video) {
  const stageDetail = run.stages?.P4 || {};
  const stage = stageDetail.status;
  if (video?.videoUrls?.[0]) return { label: '视频已生成，可播放', kind: 'ready' };
  if (video?.status === 'failed' || ['failed', 'ambiguous'].includes(stage)) return { label: `生成失败：${video?.error || run.stages?.P4?.error || '请打开任务查看处理入口'}`, kind: 'failed' };
  if (video?.status === 'running' || video?.status === 'submitting' || ['running', 'submitting'].includes(stage)) return { label: '视频生成中，后台持续反馈进度', kind: 'running' };
  if (stage === 'blocked') return { label: run.stages?.P4?.label || '视频已阻塞，等待处理', kind: 'blocked' };
  if (stage === 'prepared' && ['daily_video_limit', 'hourly_video_limit'].includes(String(stageDetail.blockedReason || ''))) {
    const retryAt = Date.parse(stageDetail.nextAttemptAt || '');
    const retryLabel = Number.isFinite(retryAt) ? new Date(retryAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    return { label: `${stageDetail.label || '本日视频额度已满，已自动排队'}${retryLabel ? ` · 预计 ${retryLabel} 后继续` : ''}`, kind: 'queued' };
  }
  if (stage === 'prepared') return { label: stageDetail.blockedReason === 'operator_video_pause' ? '视频参数已保存；新提交当前暂停' : '视频任务已准备，等待提交', kind: 'prepared' };
  return { label: '等待视频任务进入生成', kind: 'waiting' };
}

function videoControlTemplate(value) {
  return VIDEO_CONTROL_TEMPLATES.find((item) => item.value === String(value || '')) || VIDEO_CONTROL_TEMPLATES[0];
}

function videoControlLineageOptions(run) {
  const options = [{ value: '', label: '不关联上游素材', lineage: null }];
  [
    ['video', '当前成片', run.artifacts?.video],
    ['reference_video', '旧参考版本', run.artifacts?.referenceVideo],
    ['video_revision', '提示词修订版本', run.artifacts?.videoRevision]
  ].forEach(([source, label, video]) => {
    const threadId = String(video?.threadId || '').trim();
    if (threadId && String(video?.status || '').toLowerCase() === 'completed') options.push({ value: `${source}:${threadId}`, label: `${label} · ${threadId.slice(-10)}`, lineage: { source, threadId } });
  });
  return options;
}

function videoControlLineageKey(lineage) {
  if (!lineage || typeof lineage !== 'object') return '';
  const source = String(lineage.source || lineage.kind || '').trim();
  const threadId = String(lineage.threadId || lineage.parentThreadId || '').trim();
  return source && threadId ? `${source}:${threadId}` : '';
}

function normalizeVideoControl(control = {}) {
  const template = videoControlTemplate(control.template).value;
  const maxReferences = videoControlTemplate(template).maxReferences;
  const rawReferenceAssetIds = Array.isArray(control.referenceAssetIds)
    ? control.referenceAssetIds
    : Array.isArray(control.reference_asset_ids) ? control.reference_asset_ids : [];
  const referenceAssetIds = [...new Set(rawReferenceAssetIds
    .map((value) => String(value || '').trim())
    .filter(Boolean))].slice(0, maxReferences);
  const lineage = control.lineage && typeof control.lineage === 'object'
    ? { source: String(control.lineage.source || control.lineage.kind || '').trim(), threadId: String(control.lineage.threadId || control.lineage.parentThreadId || '').trim() }
    : null;
  return { template, referenceAssetIds, enableSubtitles: false, lineage: lineage?.source && lineage?.threadId ? lineage : null };
}

function videoControlForRun(run) {
  const draft = state.videoControlDrafts.get(run.id);
  const saved = state.videoControlSaved.get(run.id);
  const control = normalizeVideoControl(draft || saved || run.artifacts?.videoControl || run.input?.videoControl || {});
  const lineageKey = videoControlLineageKey(control.lineage);
  const lineageAvailable = !lineageKey || videoControlLineageOptions(run).some((item) => item.value === lineageKey);
  return lineageAvailable ? control : { ...control, lineage: null };
}

function updateVideoControlDraft(run, changes) {
  const current = videoControlForRun(run);
  const next = normalizeVideoControl({ ...current, ...changes });
  state.videoControlDrafts.set(run.id, next);
  state.videoControlPreviews.delete(run.id);
  state.detailFingerprint = '';
  renderDetail();
  icons();
}

function characterAssetId(asset) {
  return String(asset?.id || asset?.assetId || asset?.characterAssetId || '').trim();
}

function characterAssetLabel(asset, index) {
  return String(asset?.label || asset?.name || asset?.characterName || asset?.character || asset?.variant || `人物资产 ${index + 1}`).trim();
}

function characterAssetReady(asset) {
  const status = String(asset?.status || 'ready').toLowerCase();
  return asset?.approved !== false && !['queued', 'pending', 'running', 'generating', 'failed', 'error', 'preview_failed', 'submit_ambiguous'].includes(status);
}

function characterAssetPreview(asset) {
  const source = String(asset?.previewUrl || asset?.url || '').trim();
  // Meitu result CDNs can be signed per image. The asset was produced and
  // validated server-side, so render that managed URL directly instead of
  // turning the generic media proxy into an open CDN allowlist.
  return source && String(asset?.provider || '').toLowerCase() === 'meitu' ? source : source ? `/api/media?url=${encodeURIComponent(source)}` : '';
}

function videoControlPreviewHtml(run, control) {
  const preview = state.videoControlPreviews.get(run.id);
  if (!preview) return '';
  const warnings = Array.isArray(preview.warnings) ? preview.warnings.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const previewControl = normalizeVideoControl(preview.control || control);
  const fingerprint = String(preview.payloadFingerprint || preview.fingerprint || '').trim();
  const remark = String(preview.remark || '').trim();
  return `<div class="video-quality-meta"><span>模板：${escapeHtml(videoControlTemplate(previewControl.template).label)}</span><span>参考图：${previewControl.referenceAssetIds.length}</span><span>字幕：固定关闭</span>${fingerprint ? `<span>合同指纹：${escapeHtml(fingerprint.slice(-16))}</span>` : ''}${remark ? `<span>追踪标识：${escapeHtml(remark.slice(-16))}</span>` : ''}${warnings.map((warning) => `<small class="video-quality-warning">${escapeHtml(warning)}</small>`).join('')}</div>`;
}

function videoExecutionQaHtml(run, video) {
  const execution = video?.executionControls || video?.execution_controls || {};
  const qa = video?.executionQa || video?.execution_qa || video?.qa || {};
  const requestedSubtitles = typeof execution.requestedEnableSubtitles === 'boolean'
    ? execution.requestedEnableSubtitles
    : typeof execution.requested?.enableSubtitles === 'boolean' ? execution.requested.enableSubtitles : videoControlForRun(run).enableSubtitles;
  const effectiveSubtitles = typeof execution.enableSubtitles === 'boolean'
    ? execution.enableSubtitles
    : typeof execution.effective?.enableSubtitles === 'boolean' ? execution.effective.enableSubtitles : null;
  const model = String(execution.model || execution.videoModel || video?.videoModel || '').trim();
  const score = Number(qa.score ?? qa.fidelityScore);
  const result = String(qa.status || qa.decision || '').trim();
  if (effectiveSubtitles === null && !model && !result && !Number.isFinite(score)) return '';
  const mismatch = effectiveSubtitles !== null && requestedSubtitles !== effectiveSubtitles;
  return `<div class="video-quality-meta"><span>请求字幕：${requestedSubtitles ? '开启' : '关闭'}</span>${effectiveSubtitles === null ? '<span>服务端执行值：待回包</span>' : `<span>服务端字幕：${effectiveSubtitles ? '开启' : '关闭'}</span>`}${model ? `<span>实际模型：${escapeHtml(model)}</span>` : ''}${Number.isFinite(score) ? `<span>保真评分：${Math.round(score)}</span>` : ''}${result ? `<span>执行质检：${escapeHtml(result)}</span>` : ''}${mismatch ? '<small class="video-quality-warning">请求的字幕控制与服务端实际执行不一致；该成片不能自动视为通过。</small>' : ''}</div>`;
}

function videoDirectorControlHtml(run) {
  if (run._assetOnly || !run.id) return '';
  const control = videoControlForRun(run);
  const template = videoControlTemplate(control.template);
  const assets = state.videoControlAssets.get(run.id) || [];
  const loading = state.videoControlLoading.has(run.id);
  const error = state.videoControlErrors.get(run.id) || '';
  const selected = new Set(control.referenceAssetIds);
  const lineageOptions = videoControlLineageOptions(run);
  const lineageKey = videoControlLineageKey(control.lineage);
  const promptReady = Boolean(run.artifacts?.videoPrompt?.adCopy && run.artifacts?.videoPrompt?.buildRequirement);
  const saving = state.videoControlSaving.has(run.id);
  const previewing = state.videoControlPreviewing.has(run.id);
  const generating = state.characterAssetGenerating.has(run.id);
  const assetOptions = assets.length
    ? `<div class="reference-poster-options">${assets.map((asset, index) => {
      const id = characterAssetId(asset);
      const ready = Boolean(id) && characterAssetReady(asset);
      const isSelected = selected.has(id);
      const preview = characterAssetPreview(asset);
      const status = String(asset?.status || (ready ? 'ready' : 'preparing'));
      return `<button type="button" class="reference-poster-option ${isSelected ? 'selected' : ''}" data-character-asset-id="${escapeHtml(id)}" ${ready ? '' : 'disabled'}>${preview ? `<img src="${escapeHtml(preview)}" alt="${escapeHtml(characterAssetLabel(asset, index))}">` : '<i data-lucide="image"></i>'}<span><i data-lucide="${isSelected ? 'circle-dot' : 'circle'}"></i>${escapeHtml(characterAssetLabel(asset, index))} · ${escapeHtml(status)}</span></button>`;
    }).join('')}</div>`
    : `<div class="media-placeholder"><i data-lucide="images"></i>${loading ? '正在读取人物资产' : '暂无可用人物资产；可先明确生成一组角色参考图'}</div>`;
  const previewOnlyNotice = template.previewOnly ? '<small class="video-quality-warning">V4 目前仅用于合同预览和单变量验证，不会在这里出现视频提交入口。</small>' : '';
  const promptNotice = promptReady ? '' : '<small class="video-quality-warning">等待视频剧情包完成后，才可保存并预览 AC 合同。</small>';
  const characterInputs = `<div class="creative-profile"><label>角色名<input data-character-name maxlength="120" value="Lead adult"></label><label>身份<select data-character-role><option value="lead">主角</option><option value="love_interest">对手戏</option><option value="antagonist">对立角色</option><option value="supporting">配角</option></select></label><label>视觉锚点<input data-character-anchors maxlength="900" placeholder="如红发、绿眼、制服、成年"></label></div>`;
  return `<div class="reference-poster-picker video-director-control" data-video-director-control="${escapeHtml(run.id)}"><div><strong>AC 导演控制</strong><span>只保存任务配置并预览合同；不会从浏览器直连 AC 或图像服务。</span></div><div class="creative-profile"><label>模板策略<select data-video-control-template><option value="Ad_Plot_Seedance" ${template.value === 'Ad_Plot_Seedance' ? 'selected' : ''}>Seedance 生产</option><option value="Ad_Plot_Video_V4" ${template.value === 'Ad_Plot_Video_V4' ? 'selected' : ''}>V4 多参考实验（仅预览）</option></select></label><label>素材关联<select data-video-control-lineage>${lineageOptions.map((item) => `<option value="${escapeHtml(item.value)}" ${item.value === lineageKey ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select></label></div><div class="authorization-row"><i data-lucide="captions-off"></i><div><strong>字幕</strong><span>固定关闭，文字后期处理；结果页仍会显示服务端是否擅自烧录文字。</span></div><label><input type="checkbox" disabled> 固定关闭，文字后期处理</label></div><div><strong>人物参考资产</strong><span class="language-tag">已选 ${selected.size}/${template.maxReferences} · 仅可选择服务端资产库中的图片</span></div>${characterInputs}${assetOptions}<div class="video-rework-actions"><button class="secondary-command" data-video-control-save type="button" ${saving || !promptReady ? 'disabled' : ''}><i data-lucide="${saving ? 'loader-circle' : 'save'}"></i><span>${saving ? '保存中' : '保存控制'}</span></button><button class="primary-command" data-video-control-preview type="button" ${previewing || !promptReady ? 'disabled' : ''}><i data-lucide="${previewing ? 'loader-circle' : 'file-search'}"></i><span>${previewing ? '预览中' : '保存并预览合同'}</span></button><button class="secondary-command" data-character-assets-generate type="button" ${generating ? 'disabled' : ''}><i data-lucide="${generating ? 'loader-circle' : 'images'}"></i><span>${generating ? '角色图生成中' : '生成角色参考图'}</span></button></div>${error ? `<small class="video-quality-warning">${escapeHtml(error)}</small>` : ''}${previewOnlyNotice}${promptNotice}${videoControlPreviewHtml(run, control)}</div>`;
}

function rerenderVideoDirectorControl(runId) {
  if (state.detailOpen && state.selectedId === runId) {
    state.detailFingerprint = '';
    renderDetail();
    icons();
  }
}

function savedVideoControl(body) {
  return body?.control || body?.videoControl || body?.data?.control || null;
}

async function loadVideoDirectorControl(runId, { force = false } = {}) {
  if (!runId || (!force && (state.videoControlLoaded.has(runId) || state.videoControlRequests.has(runId)))) return state.videoControlRequests.get(runId);
  state.videoControlLoading.add(runId);
  state.videoControlErrors.delete(runId);
  const request = (async () => {
    const [controlResult, assetsResult] = await Promise.allSettled([
      api('/api/video-control', { method: 'POST', body: JSON.stringify({ action: 'get', runId }), timeoutMs: 20000 }),
      api('/api/character-assets', { method: 'POST', body: JSON.stringify({ action: 'list', runId }), timeoutMs: 20000 })
    ]);
    const errors = [];
    if (controlResult.status === 'fulfilled') {
      const saved = savedVideoControl(controlResult.value);
      if (saved && !state.videoControlDrafts.has(runId)) state.videoControlSaved.set(runId, normalizeVideoControl(saved));
      if (controlResult.value?.preview) state.videoControlPreviews.set(runId, controlResult.value.preview);
    } else {
      errors.push(`导演控制：${controlResult.reason?.message || '暂不可用'}`);
    }
    if (assetsResult.status === 'fulfilled') {
      const assets = Array.isArray(assetsResult.value?.assets) ? assetsResult.value.assets : [];
      state.videoControlAssets.set(runId, assets);
    } else {
      errors.push(`人物资产：${assetsResult.reason?.message || '暂不可用'}`);
    }
    if (errors.length) state.videoControlErrors.set(runId, errors.join('；'));
    state.videoControlLoaded.add(runId);
  })();
  state.videoControlRequests.set(runId, request);
  try { await request; }
  finally {
    state.videoControlRequests.delete(runId);
    state.videoControlLoading.delete(runId);
    rerenderVideoDirectorControl(runId);
  }
}

async function saveVideoDirectorControl(runId, { silent = false } = {}) {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) throw new Error('任务不存在，无法保存导演控制');
  const control = { ...videoControlForRun(run), enableSubtitles: false };
  state.videoControlSaving.add(runId);
  state.videoControlErrors.delete(runId);
  rerenderVideoDirectorControl(runId);
  try {
    const body = await api('/api/video-control', { method: 'POST', body: JSON.stringify({ action: 'set_video_control', runId, control }), timeoutMs: 25000 });
    state.videoControlSaved.set(runId, normalizeVideoControl(savedVideoControl(body) || control));
    state.videoControlDrafts.delete(runId);
    state.videoControlPreviews.delete(runId);
    state.videoControlLoaded.add(runId);
    if (!silent) showToast('AC 导演控制已保存；尚未提交视频任务');
    return body;
  } catch (error) {
    state.videoControlErrors.set(runId, error.message || '导演控制保存失败');
    throw error;
  } finally {
    state.videoControlSaving.delete(runId);
    rerenderVideoDirectorControl(runId);
  }
}

async function previewVideoDirectorControl(runId) {
  state.videoControlPreviewing.add(runId);
  state.videoControlErrors.delete(runId);
  rerenderVideoDirectorControl(runId);
  try {
    await saveVideoDirectorControl(runId, { silent: true });
    const body = await api('/api/video-control', { method: 'POST', body: JSON.stringify({ action: 'preview_video_contract', runId }), timeoutMs: 25000 });
    if (!body?.preview) throw new Error('服务端没有返回可审查的 AC 合同预览');
    state.videoControlPreviews.set(runId, body.preview);
    showToast('AC 合同预览已生成；未提交任何视频任务');
  } catch (error) {
    state.videoControlErrors.set(runId, error.message || 'AC 合同预览失败');
    showToast(error.message, 'error');
  } finally {
    state.videoControlPreviewing.delete(runId);
    rerenderVideoDirectorControl(runId);
  }
}

async function generateCharacterAssets(runId, character = {}) {
  state.characterAssetGenerating.add(runId);
  state.videoControlErrors.delete(runId);
  rerenderVideoDirectorControl(runId);
  try {
    const body = await api('/api/character-assets', { method: 'POST', body: JSON.stringify({ runId, action: 'generate', character }), timeoutMs: 25000 });
    if (Array.isArray(body?.assets)) {
      state.videoControlAssets.set(runId, body.assets);
      state.videoControlLoaded.add(runId);
    } else {
      state.videoControlLoaded.delete(runId);
      await loadVideoDirectorControl(runId, { force: true });
    }
    showToast(body?.status === 'submit_ambiguous' ? '角色图请求状态不明，已停止自动重试；请先核验外部结果' : body?.status === 'submitting' ? '角色参考图已进入后端生成队列' : body?.status === 'ready' ? '角色参考图已就绪，可选择后保存并预览合同' : '角色参考图请求已提交；未提交 AC 视频');
  } catch (error) {
    state.videoControlErrors.set(runId, error.message || '角色参考图生成失败');
    showToast(error.message, 'error');
  } finally {
    state.characterAssetGenerating.delete(runId);
    rerenderVideoDirectorControl(runId);
  }
}

function bindVideoDirectorControls(run, panel) {
  const controlPanel = panel.querySelector(`[data-video-director-control="${run.id}"]`);
  if (!controlPanel) return;
  controlPanel.querySelector('[data-video-control-template]')?.addEventListener('change', (event) => {
    const template = videoControlTemplate(event.currentTarget.value);
    const control = videoControlForRun(run);
    updateVideoControlDraft(run, { template: template.value, referenceAssetIds: control.referenceAssetIds.slice(0, template.maxReferences) });
  });
  controlPanel.querySelector('[data-video-control-lineage]')?.addEventListener('change', (event) => {
    const selected = videoControlLineageOptions(run).find((item) => item.value === event.currentTarget.value);
    updateVideoControlDraft(run, { lineage: selected?.lineage || null });
  });
  controlPanel.querySelectorAll('[data-character-asset-id]').forEach((button) => button.addEventListener('click', () => {
    const id = String(button.dataset.characterAssetId || '').trim();
    if (!id) return;
    const control = videoControlForRun(run);
    const template = videoControlTemplate(control.template);
    const next = control.referenceAssetIds.filter((value) => value !== id);
    if (next.length === control.referenceAssetIds.length) {
      if (next.length >= template.maxReferences) {
        if (template.maxReferences === 1) next.splice(0, next.length, id);
        else { showToast(`当前模板最多选择 ${template.maxReferences} 张参考图`); return; }
      } else next.push(id);
    }
    updateVideoControlDraft(run, { referenceAssetIds: next });
  }));
  controlPanel.querySelector('[data-video-control-save]')?.addEventListener('click', () => saveVideoDirectorControl(run.id).catch((error) => showToast(error.message, 'error')));
  controlPanel.querySelector('[data-video-control-preview]')?.addEventListener('click', () => previewVideoDirectorControl(run.id));
  controlPanel.querySelector('[data-character-assets-generate]')?.addEventListener('click', () => {
    const character = {
      name: String(controlPanel.querySelector('[data-character-name]')?.value || '').trim(),
      role: String(controlPanel.querySelector('[data-character-role]')?.value || '').trim(),
      visualAnchors: String(controlPanel.querySelector('[data-character-anchors]')?.value || '').trim()
    };
    openConfirmation('character_assets', run.id, { character });
  });
  if (!state.videoControlLoaded.has(run.id) && !state.videoControlLoading.has(run.id)) loadVideoDirectorControl(run.id).catch(() => {});
}

function videoHtml(run) {
  const original = run.artifacts?.video;
  const reference = run.artifacts?.referenceVideo;
  const revision = run.artifacts?.videoRevision;
  const qualityMeta = (video) => {
    if (!video) return '';
    const model = String(video.videoModel || '').trim();
    const isMini = /mini/i.test(model);
    const modelLabel = model ? (isMini ? `mini 路由：${model}` : `完整版路由：${model}`) : '模型信息待 AC 返回';
    const controlLabel = video.isUserAdCopy === true ? '已接收用户剧情提示词' : video.isUserAdCopy === false ? 'AC 自动剧情，需重点核对原文' : '剧情接管状态待返回';
    const warning = isMini || video.isUserAdCopy === false ? '<small class="video-quality-warning">建议重点核对人物、事件顺序和是否出现通用壁咚/亲吻桥段。</small>' : '<small class="video-quality-note">已接入 AC 模型回传；仍需人工检查字幕、台词和关键节拍。</small>';
    return `<div class="video-quality-meta"><span>${escapeHtml(modelLabel)}</span><span>${escapeHtml(controlLabel)}</span>${warning}</div>`;
  };
  const asset = (video, title, referenceVersion = false) => {
    const url = video?.videoUrls?.[0];
    if (url) return `<article class="video-asset"><div class="video-asset-head"><strong>${escapeHtml(title)}</strong>${referenceVersion ? '<span>额外版本</span>' : ''}</div>${qualityMeta(video)}${videoExecutionQaHtml(run, video)}<div class="video-shell"><video ${referenceVersion ? '' : 'id="resultVideo"'} controls preload="metadata" playsinline poster="${escapeHtml(video.coverImageUrl || '')}"><source src="${escapeHtml(url)}"></video></div></article>`;
    const state = videoState(run, video);
    return `<article class="video-asset ${state.kind}"><div class="video-asset-head"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(state.kind === 'failed' ? '需处理' : state.kind === 'running' ? '后台生成中' : state.kind === 'queued' ? '已自动排队' : '')}</span></div><div class="media-placeholder"><i data-lucide="${state.kind === 'failed' ? 'circle-alert' : state.kind === 'running' ? 'loader-circle' : state.kind === 'queued' ? 'clock-3' : 'video'}"></i>${escapeHtml(state.label)}</div></article>`;
  };
  const referencePosters = (run.artifacts?.images || []).filter((item) => ['luminous_cinema', 'editorial_romance'].includes(item.variant) && item.url);
  const selectedReferencePoster = state.referencePosterChoice[run.id] || referencePosters[0]?.variant || '';
  const mediaPaused = videoGenerationPaused();
  const canCreateReference = Boolean(!mediaPaused && referencePosters.length && !reference);
  const canRewrite = Boolean(!mediaPaused && run.artifacts?.videoPrompt && run.artifacts?.evidence?.chapters?.length);
  const selectedDirectorTemplate = videoControlTemplate(videoControlForRun(run).template);
  const canSubmitRevision = !selectedDirectorTemplate.previewOnly && !mediaPaused && run.artifacts?.videoPromptDraft?.status === 'approved' && !revision;
  const directorControl = videoDirectorControlHtml(run);
  const assets = [asset(original, '原始成片')];
  if (revision) assets.push(asset(revision, '重写提示词版', true));
  if (reference) assets.push(asset(reference, '人物参考版', true));
  const posterPicker = !directorControl && canCreateReference ? `<div class="reference-poster-picker"><div><strong>选择参考海报</strong><span>可选海报 1 或海报 2，提交前会再次确认</span></div><div class="reference-poster-options">${referencePosters.map((poster) => `<button type="button" class="reference-poster-option ${selectedReferencePoster === poster.variant ? 'selected' : ''}" data-reference-poster="${escapeHtml(poster.variant)}"><img src="${escapeHtml(`/api/media?url=${encodeURIComponent(poster.url)}`)}" alt="${escapeHtml(poster.variant)}"><span><i data-lucide="${selectedReferencePoster === poster.variant ? 'circle-dot' : 'circle'}"></i>海报 ${poster.variant === 'luminous_cinema' ? '1' : '2'}</span></button>`).join('')}</div><button id="createReferenceVideo" class="secondary-command reference-video-command" data-poster-variant="${escapeHtml(selectedReferencePoster)}"><i data-lucide="clapperboard"></i><span>用选中的海报制作 AC 视频</span></button></div>` : '';
  const rewriteReady = run.artifacts?.videoPromptDraft?.status === 'ready_for_review';
  return `${mediaPaused ? '<aside class="video-rewrite-ready"><i data-lucide="pause-circle"></i><div><strong>服务端未开放新视频提交</strong><span>已提交的 threadId 继续回收结果；prepared 任务不会越过服务端门禁。</span></div></aside>' : ''}${directorControl}<div class="video-assets">${assets.join('')}</div><div class="video-rework-actions">${canRewrite ? '<button id="rewriteVideoPrompt" class="secondary-command"><i data-lucide="sparkles"></i><span>重写提示词并重做视频</span></button>' : ''}${canSubmitRevision ? '<button id="createVideoRevision" class="primary-command"><i data-lucide="video"></i><span>提交核对后的新视频</span></button>' : ''}</div>${rewriteReady && !mediaPaused ? '<aside class="video-rewrite-ready"><i data-lucide="sparkles"></i><div><strong>新视频提示词已写好</strong><span>先核对剧情与镜头，再确认提交一条新的 AC 视频。</span></div><button id="reviewRewrittenVideo" class="primary-command" type="button">核对并提交新视频</button></aside>' : ''}${posterPicker}`;
}

function imagesHtml(run) {
  const images = run.artifacts?.images || [];
  const concepts = run.artifacts?.posterPrompts || [];
  if (!images.length && concepts.length) return `<div class="media-grid">${concepts.map((item) => `<article class="poster-concept"><div><i data-lucide="sparkles"></i><strong>${escapeHtml(item.variant)}</strong><span>视觉概念已就绪，等待图像任务提交</span></div><p>${escapeHtml(item.zhPrompt || item.prompt)}</p></article>`).join('')}</div>`;
  if (!images.length) return '<div class="media-placeholder">两张推广海报将在这里显示</div>';
  return `<div class="media-grid">${images.map((item) => { const previewable = item.status === 'success' && item.url; const mediaUrl = previewable ? `/api/media?url=${encodeURIComponent(item.url)}` : ''; const referenceHint = item.variant === 'luminous_cinema' && previewable ? '<span class="poster-reference-hint"><i data-lucide="clapperboard"></i>可作为 AC 参考视频</span>' : ''; const unavailable = item.status === 'preview_failed'; return `<article class="poster-item ${previewable ? 'ready' : ''} ${unavailable ? 'failed' : ''}">${previewable ? `<button class="open-image-preview" type="button" data-image-url="${escapeHtml(mediaUrl)}" data-image-label="${escapeHtml(item.variant)}"><img src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(item.variant)}" onerror="this.closest('.poster-item').classList.add('failed');this.closest('button').disabled=true"><span class="poster-expand"><i data-lucide="maximize-2"></i> 预览海报</span></button>` : `<div class="poster-live"><i data-lucide="${unavailable ? 'image-off' : 'image'}"></i><strong>${escapeHtml(item.variant)}</strong><span>${escapeHtml(unavailable ? '供应商链接失效，未重复扣费提交' : (item.status || '等待生成'))}${item.progress != null ? ` · ${escapeHtml(item.progress)}%` : ''}</span>${unavailable && item.error ? `<small>${escapeHtml(item.error)}</small>` : ''}</div>`}<span>${escapeHtml(item.variant)} · ${escapeHtml(item.status)}</span>${referenceHint}</article>`; }).join('')}</div>`;
}

function openImageViewer(url, label) {
  $('#imageViewerTitle').textContent = label || '推广海报预览';
  $('#imageViewerImage').src = url;
  $('#imageViewerImage').alt = label || '推广海报预览';
  $('#imageViewer').showModal();
}

function analyticsHtml(run) {
  const analytics = run.artifacts?.analytics;
  if (!analytics) return `<div class="analytics-empty"><span>数据尚未同步，生产完成后后台会自动跟进。</span><button class="secondary-command" data-refresh-analytics="${escapeHtml(run.id)}">立即同步</button></div>`;
  const summary = analytics.summary || {};
  const value = (number) => Number(number || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const stream = analytics.streams || {};
  const streamCard = (label, item) => `<article class="analytics-stream"><header><strong>${label}</strong><span>${item?.rowCount ? `${item.rowCount} 行` : '暂无行'}</span></header><div><span>拉起 UV</span><b>${value(item?.pullUv)}</b></div><div><span>激活</span><b>${value(item?.activeUv)}</b></div><div><span>D7 收入</span><b>${value(item?.d7Income)}</b></div><small>激活率 ${item?.activationRate == null ? '—' : `${value(item.activationRate)}%`}</small></article>`;
  const last = analytics.lastSuccessfulAt || analytics.refreshedAt;
  const status = analytics.stale ? '上次数据仍有效，本次同步会自动重试' : analytics.status === 'ready' ? '数据已验证' : analytics.status === 'pending' ? '后台同步中' : '等待首次同步';
  return `<div class="analytics-toolbar"><div><strong>${escapeHtml(status)}</strong><small>来源 ${escapeHtml(analytics.source || '待连接')} · 窗口 ${escapeHtml(analytics.window?.from || '--')} 至 ${escapeHtml(analytics.window?.to || '--')} · 上次成功 ${last ? escapeHtml(new Date(last).toLocaleString('zh-CN')) : '--'}</small></div><select data-analytics-days="${escapeHtml(run.id)}" aria-label="数据窗口"><option value="7">近 7 天</option><option value="30" selected>近 30 天</option><option value="90">近 90 天</option></select><button class="secondary-command" data-refresh-analytics="${escapeHtml(run.id)}"><i data-lucide="refresh-cw"></i>立即同步</button></div><div class="analytics-grid"><div class="metric"><span>主流拉起 UV</span><strong>${value(summary.pullUv)}</strong></div><div class="metric"><span>主流激活 UV</span><strong>${value(summary.activeUv)}</strong></div><div class="metric"><span>主流激活率</span><strong>${summary.activationRate == null ? '—' : `${value(summary.activationRate)}%`}</strong></div><div class="metric"><span>D7 收入</span><strong>${value(summary.d7Income)}</strong></div><div class="metric"><span>D30 收入</span><strong>${value(summary.d30Income)}</strong></div></div><div class="analytics-streams">${streamCard('Promotion Code', stream.code)}${streamCard('Verified Link', stream.link)}</div>${analytics.warning ? `<p class="analytics-warning">${escapeHtml(analytics.warning)}</p>` : ''}<ul class="findings">${(analytics.findings || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function eventsHtml(run) {
  return [...(run.events || [])].reverse().slice(0, 15).map((event) => `<div class="event"><time>${escapeHtml(new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}</time><span>${escapeHtml(event.message)}</span></div>`).join('');
}

const creativeSectionNames = { posts: '六步法文案', videoPrompt: '视频剧情', posterPrompts: '海报提示词', qualityReview: '质量审查', distribution: '发布建议包' };

function distributionHtml(run) {
  const plan = run.artifacts?.distribution;
  if (!plan) return `<section id="detail-distribution" class="detail-section distribution-pending"><div class="section-heading"><div><h3>发布建议包</h3><p>素材完成后，AI 会在审核阶段生成适合的频道与通用短钩子。</p></div><button class="secondary-command" data-generate-distribution="${escapeHtml(run.id)}"><i data-lucide="send"></i>生成发布建议</button></div></section>`;
  const channelFor = (asset) => (plan.channels || []).filter((channel) => channel.bestFor?.includes(asset)).map((channel) => `<span title="${escapeHtml(channel.reason || '')}">${escapeHtml(channel.name)}</span>`).join('') || '<span>待人工判断</span>';
  return `<section id="detail-distribution" class="detail-section distribution-plan"><div class="section-heading"><div><h3>发布建议包</h3><p>仅供你手动选择频道和发布，不会自动分享到 Facebook。</p></div><span class="language-tag">${escapeHtml(plan.model || plan.status === 'fallback' ? '建议就绪' : 'AI 推荐')}</span></div><div class="distribution-hook"><div><span>通用短钩子</span><strong>${escapeHtml(plan.universalHook || '')}</strong>${plan.zhUniversalHook ? `<small>${escapeHtml(plan.zhUniversalHook)}</small>` : ''}</div><button class="secondary-command" data-copy-distribution-hook="${escapeHtml(run.id)}"><i data-lucide="copy"></i>复制钩子</button></div><div class="distribution-assets"><div><span>文案适合发往</span><p>${channelFor('copy')}</p></div><div><span>视频适合发往</span><p>${channelFor('video')}</p></div><div><span>海报适合发往</span><p>${channelFor('poster')}</p></div></div><div class="distribution-channels">${(plan.channels || []).map((channel) => `<article><strong>${escapeHtml(channel.name)}</strong><span>${escapeHtml((channel.bestFor || []).map((asset) => ({ copy: '文案', video: '视频', poster: '海报' })[asset] || asset).join(' / '))}</span><p>${escapeHtml(channel.reason || '')}</p></article>`).join('')}</div></section>`;
}

function modelActivityHtml(run) {
  const completed = [...(run.modelActivity || []), ...(run.artifacts?.modelActivity || []), ...(run.artifacts?.creativeDraft?.usage || [])];
  const failures = Object.entries(run.artifacts?.creativeDraft?.failures || {}).map(([section, item]) => ({ section, ...item, recovering: true }));
  const validationUnverified = run.stages?.P3?.phase === 'validation_unverified' || run.artifacts?.qualityReview?.status === 'unverified';
  const rows = [...completed.map((item) => ({ ...item, recovering: false })), ...failures]
    .sort((a, b) => Date.parse(b.completedAt || b.at || 0) - Date.parse(a.completedAt || a.at || 0))
    .slice(0, 12);
  if (!rows.length) return '<div class="model-activity-empty"><i data-lucide="activity"></i><span>创意生成开始后，这里会显示实际模型、耗时、Token 和自动切换记录。</span></div>';
  return `<div class="model-activity-list">${rows.map((item) => {
    const rejected = item.validationStatus === 'rejected';
    const requestedModel = item.requestedModel || run.input?.creativeProfile?.modelChoice || 'hy3';
    const actualModel = item.model || item.requestedModel;
    const requested = modelLabel(requestedModel);
    const actual = item.recovering ? '等待自动路由' : modelLabel(actualModel);
    const switched = !item.recovering && item.fallbackFrom && modelLabel(item.fallbackFrom) !== actual;
    const retryAt = Date.parse(item.nextAttemptAt || '');
    const retryText = Number.isFinite(retryAt) ? new Date(retryAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '即将';
    const tokens = Number(item.totalTokens || 0);
    const latency = Number(item.latencyMs || 0);
    const actualBadge = item.recovering ? '<span class="model-logo model-logo-generic compact"><b>...</b><em>自动路由</em></span>' : modelLogoHtml(actualModel, { compact: true });
    const requestedBadge = modelLogoHtml(requestedModel, { compact: true });
    const outcome = item.recovering
      ? `第 ${item.attempt || 1} 次自动修复已排队，${retryText} 后继续`
      : rejected && validationUnverified
        ? `${actual} 的成品已保留，质检待复核，不阻塞后续素材`
        : rejected
          ? `${actual} 已返回，证据校验正在后台自动修复`
          : switched
            ? `${requested} 未及时返回，${actual} 已接管`
            : `${actual} 已返回`;
    return `<article class="model-activity-row ${item.recovering ? 'recovering' : rejected ? 'rejected' : 'ready'}"><span class="model-activity-state"><i data-lucide="${item.recovering ? 'loader-circle' : rejected ? 'triangle-alert' : 'circle-check-big'}"></i></span><div class="model-activity-main"><div><strong>${escapeHtml(creativeSectionNames[item.section] || item.section || '创意')}</strong>${actualBadge}<span>${escapeHtml(outcome)}</span></div><small>请求 ${requestedBadge} · 实际 ${actualBadge}</small></div><div class="model-activity-metrics">${latency ? `<span>${(latency / 1000).toFixed(1)}s</span>` : ''}${tokens ? `<span>${tokens.toLocaleString('zh-CN')} tokens</span>` : ''}${item.responseId ? `<span title="${escapeHtml(item.responseId)}">ID ${escapeHtml(String(item.responseId).slice(-8))}</span>` : ''}</div></article>`;
  }).join('')}</div>`;
}

function renderDetail() {
  const run = state.runs.find((item) => item.id === state.selectedId);
  const panel = $('#detailPanel');
  const scrim = $('#detailScrim');
  panel.classList.toggle('open', state.detailOpen && Boolean(run));
  scrim.classList.toggle('open', state.detailOpen && Boolean(run));
  panel.setAttribute('aria-hidden', String(!(state.detailOpen && run)));
  scrim.setAttribute('aria-hidden', String(!(state.detailOpen && run)));
  // Polling must not rebuild the heavy asset detail while the drawer is closed.
  if (!state.detailOpen) return;
  if (!run) { panel.innerHTML = `<div class="detail-empty"><i data-lucide="panel-right-open"></i><strong>完整生产链路</strong><span>从历史表现榜选择一本书后，节点会实时显示产物与进度。</span>${idlePipelineHtml()}</div>`; return; }
  if (run._summary) {
    const active = currentStage(run);
    const assets = assetSummary(run);
    const syncing = state.detailHydrating === run.id;
    const detailMessage = state.detailError || (syncing ? '正在加载可预览的完整素材；这不会阻塞当前任务。' : '任务已可操作。完整文案、视频和海报会在后台轻量同步。');
    panel.innerHTML = `<header class="detail-header"><div class="detail-title-row"><div class="detail-title"><h2>${escapeHtml(run.input?.title || run.artifacts?.book?.title || '任务')}</h2><p>SKU ${escapeHtml(run.input?.sku || run.artifacts?.book?.bookSkuId || '--')} · Run ${escapeHtml(run.id.slice(-10))}</p></div><button id="closeDetail" class="icon-button" title="关闭详情"><i data-lucide="x"></i></button></div><div class="tracking-strip"><div><span>Promotion Code</span><strong>${escapeHtml(run.artifacts?.code || '待分配')}</strong></div><div><span>Verified short link</span>${run.artifacts?.shortUrl ? `<a class="tracking-link" href="${escapeHtml(run.artifacts.shortUrl)}" target="_blank" rel="noopener">${escapeHtml(run.artifacts.shortUrl)} <i data-lucide="external-link"></i></a>` : '<strong>待创建</strong>'}</div></div></header><section class="pipeline"><div class="section-heading"><div><h3>P0-P7 可审计链路</h3><p>已完成节点、当前卡点和可用追踪信息即时展示。</p></div><span class="status-badge ${escapeHtml(run.state)}">${escapeHtml(labels[run.state] || run.state)}</span></div><div class="production-flow">${pipelineHtml(run)}</div>${productionStatusHtml(run, active)}<div class="detail-sync-state ${syncing ? 'is-syncing' : ''}"><i data-lucide="${syncing ? 'loader-circle' : state.detailError ? 'circle-alert' : 'database-zap'}"></i><div><strong>${syncing ? '正在同步完整素材' : state.detailError ? '完整素材稍后可用' : '任务摘要已就绪'}</strong><span>${escapeHtml(detailMessage)}</span></div><button id="retryDetail" class="secondary-command" type="button" ${syncing ? 'disabled' : ''}><i data-lucide="refresh-cw"></i>${syncing ? '同步中' : '加载完整素材'}</button></div></section><section class="detail-section"><div class="section-heading"><h3>已可用产物</h3><span class="language-tag">无需等待</span></div><div class="asset-summary"><div><strong>${assets.posts}</strong><span>文案</span></div><div><strong>${assets.video}</strong><span>视频</span></div><div><strong>${assets.posters}</strong><span>海报</span></div><div><strong>${assets.tracking}</strong><span>追踪链接</span></div></div></section><section class="detail-section"><div class="section-heading"><h3>模型活动</h3><span class="language-tag">摘要记录</span></div>${modelActivityHtml(run)}</section>`;
    panel.insertAdjacentHTML('beforeend', harnessLedgerHtml(run));
    $('#closeDetail')?.addEventListener('click', closeDetail);
    $('#retryDetail')?.addEventListener('click', () => retryRunDetail(run.id));
    state.detailFingerprint = `${run.id}:${run.updatedAt}:${run.state}:${syncing}:${state.detailError}`;
    icons();
    return;
  }
  const fingerprint = `${run.id}:${run.updatedAt}:${run.state}:${state.creativeVariantRunId}`;
  if (state.detailFingerprint === fingerprint) return;
  const oldVideo = $('#resultVideo');
  const playback = oldVideo ? { time: oldVideo.currentTime, paused: oldVideo.paused } : null;
  const active = currentStage(run);
  const selectedModel = modelLabel(run.input?.creativeProfile?.modelChoice);
  const p4BlockedReason = String(run.stages?.P4?.blockedReason || '');
  const p5BlockedReason = String(run.stages?.P5?.blockedReason || '');
  const attributionBlocked = ['attribution_write_ambiguous', 'attribution_provider_unavailable'].includes(p5BlockedReason);
  const videoLimitBlocked = ['daily_video_limit', 'hourly_video_limit', 'ac_points_budget', 'ac_configuration_wait', 'ac_capacity_wait'].includes(p4BlockedReason);
  const posterPartial = run.stages?.P3_5?.status === 'partial';
  const variantPending = state.creativeVariantRunId === run.id;
  const retryLabel = attributionBlocked ? '核对归因后继续' : posterPartial ? '单独重试失败海报' : videoLimitBlocked
    ? (p4BlockedReason === 'ac_points_budget' ? '积分额度恢复后重试视频' : p4BlockedReason === 'ac_configuration_wait' ? 'AC 配置恢复后重试视频' : p4BlockedReason === 'ac_capacity_wait' ? 'AC 容量恢复后重试视频' : `次日重试视频${run.stages.P4.nextWindow ? `（当前额度至 ${run.stages.P4.nextWindow}）` : ''}`)
    : '重试失败节点';
  const canRetry = run.state === 'failed' || videoLimitBlocked || posterPartial || attributionBlocked;
  if (run._assetOnly) {
    // Asset snapshots deliberately exclude source chapters and provider payloads.
    // They are for immediate review and reuse, not for silently triggering a
    // second creative or paid-media submission from an old task.
    const assetRun = { ...run, artifacts: { ...run.artifacts, images: [], videoPromptDraft: null } };
    panel.innerHTML = `<header class="detail-header"><div class="detail-title-row"><div class="detail-title"><h2>${escapeHtml(run.input?.title || run.artifacts?.book?.title || '任务')}</h2><p>SKU ${escapeHtml(run.input?.sku || run.artifacts?.book?.bookSkuId || '--')} · Run ${escapeHtml(run.id.slice(-10))}</p></div><button id="closeDetail" class="icon-button" title="关闭详情"><i data-lucide="x"></i></button></div><nav class="detail-tabs" aria-label="成品模块"><button data-scroll-target="detail-overview">概览</button><button data-scroll-target="detail-copy">文案</button><button data-scroll-target="detail-video">视频</button><button data-scroll-target="detail-posters">海报</button><button data-scroll-target="detail-prompts">提示词</button><button data-scroll-target="detail-data">数据</button></nav><div class="tracking-strip"><div><span>Promotion Code</span><strong>${escapeHtml(run.artifacts?.code || '待分配')}</strong></div><div><span>Verified short link</span>${run.artifacts?.shortUrl ? `<a class="tracking-link" href="${escapeHtml(run.artifacts.shortUrl)}" target="_blank" rel="noopener">${escapeHtml(run.artifacts.shortUrl)} <i data-lucide="external-link"></i></a>` : '<strong>待创建</strong>'}</div></div></header>
      <section id="detail-overview" class="pipeline"><div class="section-heading"><div><h3>已生成素材</h3><p>这里直接展示已保存的成品，不等待章节全文或模型诊断。</p></div><span class="status-badge ${escapeHtml(run.state)}">${escapeHtml(labels[run.state] || run.state)}</span></div><div class="production-flow">${pipelineHtml(run)}</div>${productionStatusHtml(run, active)}</section>
      <section id="detail-copy" class="detail-section"><div class="section-heading"><h3>六步法成品文案</h3><span class="language-tag">EN / 中文</span></div>${copyHtml(run)}</section>
      <section id="detail-video" class="detail-section"><div class="section-heading"><h3>AC 视频预览</h3><span class="language-tag">已保存版本</span></div>${videoHtml(assetRun)}</section>
      <section id="detail-posters" class="detail-section"><div class="section-heading"><h3>推广海报</h3><span class="language-tag">已保存版本</span></div>${imagesHtml(run)}</section>
      ${promptHtml(assetRun)}
      <section id="detail-data" class="detail-section"><div class="section-heading"><h3>实际数据反馈</h3><span class="language-tag">Code + Link</span></div>${analyticsHtml(run)}</section>
      <section id="detail-review" class="detail-section"><h3>运行记录</h3><div class="event-list">${eventsHtml(run)}</div></section>`;
    $('#closeDetail')?.addEventListener('click', closeDetail);
    panel.querySelectorAll('[data-copy-post-index]').forEach((button) => button.addEventListener('click', () => {
      const post = run.artifacts?.posts?.[Number(button.dataset.copyPostIndex)];
      const chinese = button.dataset.copyPostLanguage === 'zh';
      copyAssetText(chinese ? post?.zhContent : post?.content, chinese ? '完整中文文案已复制（含 CTA 与标签）' : '完整英文发布文案已复制（含 CTA、链接与标签）');
    }));
    panel.querySelectorAll('.open-image-preview').forEach((button) => button.addEventListener('click', () => openImageViewer(button.dataset.imageUrl, button.dataset.imageLabel)));
    panel.querySelector('[data-refresh-analytics]')?.addEventListener('click', () => refreshRunAnalytics(run.id));
    panel.querySelectorAll('[data-node-decision]').forEach((button) => button.addEventListener('click', () => { state.selectedNode = button.dataset.nodeDecision; showToast(`${stageLabels[state.selectedNode] || state.selectedNode} 的已保存状态已显示在概览中`); }));
    panel.querySelectorAll('[data-scroll-target]').forEach((button) => button.addEventListener('click', () => panel.querySelector(`#${button.dataset.scrollTarget}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
    panel.insertAdjacentHTML('beforeend', harnessLedgerHtml(run));
    state.detailFingerprint = `${run.id}:${run.updatedAt}:assets`;
    icons();
    return;
  }
  if (run._detailPartial) {
    panel.innerHTML = `<header class="detail-header"><div class="detail-title-row"><div class="detail-title"><h2>${escapeHtml(run.input?.title)}</h2><p>SKU ${escapeHtml(run.input?.sku)} · Run ${escapeHtml(run.id.slice(-10))}</p></div><button id="closeDetail" class="icon-button" title="关闭详情"><i data-lucide="x"></i></button></div><div class="tracking-strip"><div><span>Promotion Code</span><strong>${escapeHtml(run.artifacts?.code || '待分配')}</strong></div><div><span>Verified short link</span>${run.artifacts?.shortUrl ? `<a class="tracking-link" href="${escapeHtml(run.artifacts.shortUrl)}" target="_blank" rel="noopener">${escapeHtml(run.artifacts.shortUrl)} <i data-lucide="external-link"></i></a>` : '<strong>待创建</strong>'}</div></div></header><section class="pipeline"><div class="section-heading"><div><h3>P0-P7 可审计链路</h3><p>节点和恢复状态可立即查看，文案与媒体详情正在后台建立轻量快照。</p></div><span class="status-badge ${escapeHtml(run.state)}">${escapeHtml(labels[run.state] || run.state)}</span></div><div class="production-flow">${pipelineHtml(run)}</div>${productionStatusHtml(run, active)}<div class="detail-sync-state"><i data-lucide="database-zap"></i><div><strong>正在补齐素材详情</strong><span>${escapeHtml(state.detailError || '后台只整理已有任务数据，不会调用模型，也不会提交付费图片或视频。')}</span></div><button id="retryDetail" class="secondary-command" type="button"><i data-lucide="refresh-cw"></i>立即检查</button></div></section><section class="detail-section"><div class="section-heading"><h3>模型活动</h3><span class="language-tag">摘要记录</span></div>${modelActivityHtml(run)}</section>`;
    $('#closeDetail')?.addEventListener('click', closeDetail);
    $('#retryDetail')?.addEventListener('click', () => hydrateRunDetail(run.id));
    panel.querySelector('[data-ai-wait-recovery]')?.addEventListener('click', (event) => recoverAiWait(run.id, event.currentTarget));
    state.detailFingerprint = fingerprint;
    panel.insertAdjacentHTML('beforeend', harnessLedgerHtml(run));
    requestDetailHydration(run.id);
    icons();
    return;
  }
  panel.innerHTML = `<header class="detail-header"><div class="detail-title-row"><div class="detail-title"><h2>${escapeHtml(run.input?.title)}</h2><p>SKU ${escapeHtml(run.input?.sku)} · Run ${escapeHtml(run.id.slice(-10))}</p></div><div class="detail-actions">${canRetry ? `<button id="retryRun" class="secondary-command"><i data-lucide="rotate-ccw"></i><span>${escapeHtml(retryLabel)}</span></button>` : ''}<button id="closeDetail" class="icon-button" title="关闭详情"><i data-lucide="x"></i></button></div></div><nav class="detail-tabs" aria-label="成果模块"><button data-scroll-target="detail-overview">概览</button><button data-scroll-target="detail-decision">事前策划</button><button data-scroll-target="detail-quality">成品质检</button><button data-scroll-target="detail-copy">文案</button><button data-scroll-target="detail-video">视频</button><button data-scroll-target="detail-posters">海报</button><button data-scroll-target="detail-prompts">提示词</button><button data-scroll-target="detail-data">数据</button></nav><div class="tracking-strip"><div><span>Promotion Code</span><strong>${escapeHtml(run.artifacts?.code || '待分配')}</strong></div><div><span>Verified short link</span>${run.artifacts?.shortUrl ? `<a class="tracking-link" href="${escapeHtml(run.artifacts.shortUrl)}" target="_blank" rel="noopener">${escapeHtml(run.artifacts.shortUrl)} <i data-lucide="external-link"></i></a>` : '<strong>待创建</strong>'}</div></div></header>
    <section id="detail-overview" class="pipeline"><div class="section-heading"><div><h3>P0-P7 可审计链路</h3><p>先锁定应用、平台、账号与选书快照，再推进证据、追踪、创意、媒体、审核包和 SocialEcho 草稿。</p></div><span class="status-badge ${escapeHtml(run.state)}">${escapeHtml(labels[run.state] || run.state)}</span></div>${productionModelRouteHtml(run)}<div class="creative-strategy">${creativeProfileHtml(run.input?.creativeProfile || {})}</div><div class="production-flow">${pipelineHtml(run)}</div>${productionStatusHtml(run, active)}<div class="current-stage">${escapeHtml(active[1]?.label || labels[run.state] || run.state)}${active[1]?.error ? `：${escapeHtml(active[1].error)}` : ''}</div></section>
    ${decisionHtml(run)}
    ${postProductionReviewHtml(run)}
    <section id="detail-copy" class="detail-section"><div class="section-heading"><h3>六步法成品文案</h3><div class="section-actions"><span class="language-tag">EN / 中文</span><button class="secondary-command create-variant" data-variant="creative" ${variantPending ? 'disabled' : ''}><i data-lucide="${variantPending ? 'loader-circle' : 'sparkles'}"></i><span>${variantPending ? `${escapeHtml(selectedModel)} 生成中` : `${escapeHtml(selectedModel)} 再来一版`}</span></button>${run.artifacts?.posts?.length ? removeAssetButton('copy', '文案') : ''}</div></div>${variantPending ? '<div class="optimization-alert"><div><i data-lucide="loader-circle"></i><strong>AI 正在重写创意包</strong><span>正在基于当前版本与已锁定章节证据生成双语文案、视频脚本和海报提示词。</span></div></div>' : ''}${optimizationHtml(run)}${copyHtml(run)}</section>
    <section id="detail-video" class="detail-section"><div class="section-heading"><h3>AC 视频预览</h3><div class="section-actions"><span class="language-tag">1 条</span>${run.artifacts?.video ? removeAssetButton('video', '视频') : ''}${run.artifacts?.referenceVideo ? removeAssetButton('reference_video', '参考视频') : ''}</div></div>${videoHtml(run)}</section>
    <section id="detail-posters" class="detail-section"><div class="section-heading"><h3>推广海报</h3><div class="section-actions"><span class="language-tag">2 张</span>${run.artifacts?.images?.length ? removeAssetButton('posters', '海报') : ''}</div></div>${imagesHtml(run)}</section>
    ${promptHtml(run)}
    ${distributionHtml(run)}
    <section id="detail-data" class="detail-section"><div class="section-heading"><h3>实际数据反馈</h3><span class="language-tag">Code + Link</span></div>${analyticsHtml(run)}</section>
    <section id="detail-models" class="detail-section"><div class="section-heading"><h3>模型活动</h3><span class="language-tag">真实调用记录</span></div>${modelActivityHtml(run)}</section>
    <section id="detail-review" class="detail-section"><h3>运行记录</h3><div class="event-list">${eventsHtml(run)}</div></section>`;
  state.detailFingerprint = fingerprint;
  panel.insertAdjacentHTML('beforeend', harnessLedgerHtml(run));
  panel.querySelector('#detail-overview')?.after(panel.querySelector('#detail-harness'));
  const newVideo = $('#resultVideo');
  if (newVideo && playback?.time) newVideo.addEventListener('loadedmetadata', () => { newVideo.currentTime = Math.min(playback.time, newVideo.duration || playback.time); if (!playback.paused) newVideo.play().catch(() => {}); }, { once: true });
  $('#retryRun')?.addEventListener('click', () => attributionBlocked ? reconcileAttribution(run.id) : retryRun(run.id));
  $('#closeDetail')?.addEventListener('click', closeDetail);
  bindVideoDirectorControls(run, panel);
  panel.querySelectorAll('[data-reference-poster]').forEach((button) => button.addEventListener('click', () => {
    state.referencePosterChoice[run.id] = button.dataset.referencePoster;
    state.detailFingerprint = '';
    renderDetail(); icons();
  }));
  $('#createReferenceVideo')?.addEventListener('click', (event) => openConfirmation('reference_video', run.id, { posterVariant: event.currentTarget.dataset.posterVariant }));
  $('#rewriteVideoPrompt')?.addEventListener('click', () => rewriteVideoPrompt(run.id));
  $('#createVideoRevision')?.addEventListener('click', () => openConfirmation('video_revision', run.id));
  $('#reviewRewrittenVideo')?.addEventListener('click', () => panel.querySelector('#detail-prompts')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  panel.querySelectorAll('[data-video-prompt-action]').forEach((button) => button.addEventListener('click', () => decideVideoPrompt(run.id, button.dataset.videoPromptAction)));
  panel.querySelector('.create-variant')?.addEventListener('click', () => openConfirmation('creative', run.id));
  panel.querySelectorAll('.remove-asset').forEach((button) => button.addEventListener('click', () => removeRunAsset(run, button.dataset.removeAsset)));
  panel.querySelector('[data-ai-wait-recovery]')?.addEventListener('click', (event) => recoverAiWait(run.id, event.currentTarget));
  panel.querySelector('[data-refresh-analytics]')?.addEventListener('click', () => refreshRunAnalytics(run.id));
  panel.querySelectorAll('[data-copy-post-index]').forEach((button) => button.addEventListener('click', () => {
    const post = run.artifacts?.posts?.[Number(button.dataset.copyPostIndex)];
    const language = button.dataset.copyPostLanguage;
    const content = language === 'zh' ? post?.zhContent : post?.content;
    copyAssetText(content, language === 'zh' ? '完整中文文案已复制（含 CTA 与标签）' : '完整英文发布文案已复制（含 CTA、链接与标签）');
  }));
  panel.querySelector('[data-copy-distribution-hook]')?.addEventListener('click', () => copyAssetText(run.artifacts?.distribution?.universalHook, '通用短钩子已复制'));
  panel.querySelector('[data-generate-distribution]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader-circle"></i>AI 生成中';
    icons();
    try {
      const body = await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id: run.id, action: 'distribution_plan' }), timeoutMs: 65000 });
      state.runs = state.runs.map((item) => item.id === body.run.id ? body.run : item);
      state.detailFingerprint = '';
      render();
      showToast('发布建议包已生成，可复制短钩子并手动选择频道');
    } catch (error) {
      button.disabled = false;
      button.innerHTML = '<i data-lucide="send"></i>重新生成发布建议';
      icons();
      showToast(error.message, 'error');
    }
  });
  panel.querySelectorAll('[data-optimization]').forEach((button) => button.addEventListener('click', () => decideOptimization(run, button.dataset.optimization)));
  panel.querySelectorAll('[data-node-decision]').forEach((button) => button.addEventListener('click', () => { state.selectedNode = button.dataset.nodeDecision; state.detailFingerprint = ''; renderDetail(); }));
  panel.querySelectorAll('.open-image-preview').forEach((button) => button.addEventListener('click', () => openImageViewer(button.dataset.imageUrl, button.dataset.imageLabel)));
  document.querySelectorAll('[data-scroll-target]').forEach((button) => button.addEventListener('click', () => panel.querySelector(`#${button.dataset.scrollTarget}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  if (state.detailOpen && state.detailTarget) {
    const targets = { copy: 'detail-copy', video: 'detail-video', posters: 'detail-posters', review: 'detail-review', decision: 'detail-decision' };
    panel.querySelector(`#${targets[state.detailTarget] || 'detail-overview'}`)?.scrollIntoView({ block: 'start' });
    state.detailTarget = '';
  }
}

function render() {
  renderCapabilities(); renderDailyCampaign(); renderStats(); renderP0DecisionRail(); renderHarnessStageStrip(); renderTodayRail(); renderOneClickStatus(); renderPublicationWorkbench(); renderFocusRun(); renderLeaderboard(); renderRunList(); renderDetail(); renderCreativePlanQueue(); renderModelBadges(); icons();
}

function statusPayloadFingerprint(body) {
  return JSON.stringify({
    // A provider can advance a stage or expose an external ID without
    // changing the legacy `updatedAt` copied into an old summary. Include the
    // compact operational projection so the UI redraws on every meaningful
    // P0-P7 transition.
    runs: (body.runs || []).map((run) => [run.id, run.state, run.updatedAt,
      run.operations?.currentStage, run.operations?.nextAction,
      run.operations?.blockedReason, run.operations?.nextAttemptAt,
      run.operations?.socialEchoExternalDraftId,
      run.operations?.scheduledAt,
      run.harness?.status,
      (run.harness?.stages || []).map((stage) => [stage.key, stage.status, stage.phase, stage.error, stage.externalTaskId, stage.nextAttemptAt])]),
    capabilities: body.capabilities || {},
    videoLimit: body.videoLimit || null,
    pointsBudget: body.pointsBudget || null,
    runLimit: Number(body.runLimit || state.statusLimit),
    scope: body.scope || null,
    totalRunCount: Number(body.totalRunCount || 0)
  });
}

function activeRunBookFingerprint(runs = state.runs) {
  return runs.filter(runProtectsBook).map((run) => `${Number(run.input?.delivery?.accountId || 0)}:${run.input?.sku || ''}:${String(run.input?.title || '').trim().toLowerCase()}`).sort().join('|');
}

function reconcilePendingProductions() {
  for (const [key, pending] of state.pendingProductions.entries()) {
    const earliestCreatedAt = Number(pending.startedAt || 0) - 5000;
    const run = pending.runId
      ? state.runs.find((candidate) => candidate.id === pending.runId && runMatchesBook(candidate, pending) && runMatchesTargetAccount(candidate, pending.delivery))
      : state.runs.find((candidate) => runProtectsBook(candidate)
        && runMatchesBook(candidate, pending)
        && runMatchesTargetAccount(candidate, pending.delivery)
        && Date.parse(candidate.createdAt || '') >= earliestCreatedAt);
    if (!run) continue;
    pending.runId = run.id;
    pending.status = 'accepted';
    state.pendingProductions.delete(key);
  }
}

function renderStatusViews({ rankingChanged = false } = {}) {
  renderCapabilities();
  renderDailyCampaign();
  renderStats();
  renderP0DecisionRail();
  renderHarnessStageStrip();
  renderOneClickStatus();
  renderPublicationWorkbench();
  renderFocusRun();
  renderRunList();
  renderDetail();
  if (rankingChanged) renderLeaderboard();
  icons();
}

async function loadStatus({ silent = false } = {}) {
  if (state.statusLoading) return state.statusRequest;
  state.statusLoading = true;
  const campaignId = String(state.statusCampaignId || '').trim();
  const endpoint = campaignId
    ? `/api/status?campaignId=${encodeURIComponent(campaignId)}`
    : `/api/status?limit=${state.statusLimit}`;
  const request = api(endpoint);
  state.statusRequest = request;
  try {
    const body = await request;
    const fingerprint = statusPayloadFingerprint(body);
    const changed = fingerprint !== state.statusFingerprint;
    const previousActiveBooks = activeRunBookFingerprint();
    const existing = new Map(state.runs.map((run) => [run.id, run]));
    state.runs = (body.runs || []).map((summary) => {
      const previous = existing.get(summary.id);
      return previous && !previous._summary && previous.updatedAt === summary.updatedAt ? previous : summary;
    });
    reconcilePendingProductions();
    state.capabilities = body.capabilities || {};
    state.videoLimit = body.videoLimit || null;
    state.pointsBudget = body.pointsBudget || null;
    state.statusScope = body.scope?.type || (campaignId ? 'campaign' : 'recent');
    if (body.scope?.campaignId) state.statusCampaignId = String(body.scope.campaignId);
    if (!campaignId) state.statusLimit = Math.max(12, Math.min(50, Number(body.runLimit || state.statusLimit)));
    if (!state.selectedId || !state.runs.some((run) => run.id === state.selectedId)) state.selectedId = state.runs[0]?.id || '';
    state.statusFingerprint = fingerprint;
    if (changed) saveDashboardSnapshot();
    showApp();
    if (changed) renderStatusViews({ rankingChanged: previousActiveBooks !== activeRunBookFingerprint() });
    warmReadyAssetSnapshots();
    // Polling refreshes only the compact progress projection. Rehydrating the
    // full task on every poll made a slow detail record starve the whole UI.
  } catch (error) {
    if (error.status === 401) showLogin();
    else if (!silent) showToast(error.message, 'error');
  } finally {
    state.statusLoading = false;
    state.statusRequest = null;
    renderRunLoadMore();
  }
}

async function loadLeaderboard({ refresh = false, silent = false } = {}) {
  const requestId = ++state.leaderboardRequestId;
  const requestSource = state.leaderboardSource;
  const requestDays = requestSource === 'catalog' ? state.catalogDays : state.windowDays;
  const requestCatalogQuery = requestSource === 'catalog' ? catalogRequestQuery() : '';
  const requestKey = leaderboardQueryKey(requestSource);
  state.leaderboardController?.abort();
  const controller = new AbortController();
  state.leaderboardController = controller;
  if (state.leaderboardDataKey && state.leaderboardDataKey !== requestKey) {
    state.leaderboard = [];
    state.leaderboardWindow = null;
    state.leaderboardMetrics = null;
    state.leaderboardWarning = '';
    state.leaderboardDataQuality = '';
    state.leaderboardCredentialStatus = '';
    state.leaderboardError = '';
    state.leaderboardPage = 1;
    state.leaderboardCoverKey = '';
  }
  state.leaderboardLoading = true;
  if (!state.leaderboard.length) {
    renderLeaderboard(); icons();
  } else {
    $('#leaderboard')?.setAttribute('aria-busy', 'true');
    $('#refreshLeaderboard').disabled = true;
    $('#refreshLeaderboard').classList.add('loading');
    $('#leaderboardUpdated').textContent = '正在后台刷新，当前保留上一版已验证榜单';
  }
  let shouldLoadCovers = false;
  try {
    const body = await api(`/api/leaderboard?source=${requestSource}&days=${requestDays}${requestCatalogQuery}${refresh ? '&refresh=1' : ''}`, { timeoutMs: refresh ? 75000 : 45000, signal: controller.signal });
    if (requestId !== state.leaderboardRequestId) return;
    if (requestSource === 'catalog') {
      state.catalogTargetOptions = Array.isArray(body.targetOptions) && body.targetOptions.length ? body.targetOptions : state.catalogTargetOptions;
      state.catalogTarget = body.target || state.catalogTarget;
      if (body.target) {
        state.catalogFilters.line = body.target.appKey || body.target.productLine || state.catalogFilters.line;
        state.catalogFilters.platform = body.target.platform || state.catalogFilters.platform;
        state.catalogFilters.accountId = String(body.target.accountId || state.catalogFilters.accountId);
      }
      syncCatalogTargetControls();
    }
    const incomingBooks = (body.books || []).map((book) => ({ ...book, ...(body.target ? { selectionTarget: body.target } : {}) }));
    const incomingEligible = requestSource !== 'catalog' || responseAllowsCatalogRanking(body, incomingBooks);
    const keepVerifiedMetrics = requestSource === 'catalog'
      && state.leaderboardDataKey === requestKey
      && catalogQualityAllowsRanking(state.leaderboard)
      && !incomingEligible;
    if (!keepVerifiedMetrics) {
      // A bounded cover worker owns image requests. Letting provider cover
      // URLs through here makes a cold dashboard start fifty image downloads
      // before the primary controls become responsive.
      state.leaderboard = incomingEligible ? scoreCatalogBooks(incomingBooks.map(({ cover, ...book }) => book), requestDays) : [];
      state.leaderboardUpdated = body.generatedAt || '';
      state.leaderboardWindow = body.window || null;
      state.leaderboardMetrics = body.metrics || null;
    }
    state.leaderboardDataQuality = keepVerifiedMetrics
      ? 'stale_verified_metrics'
      : (body.dataQuality || (incomingEligible ? 'verified_metrics' : 'unavailable'));
    state.leaderboardCredentialStatus = body.credentialStatus || body.sourceHealth?.credentialStatus || '';
    state.leaderboardError = '';
    state.leaderboardWarning = keepVerifiedMetrics
      ? '最新同步未返回有效指标，继续展示上一版已验证数据'
      : (body.refreshWarning || '');
    state.leaderboardDataKey = requestKey;
    state.leaderboardPage = 1;
    state.leaderboardCoverKey = '';
    syncTodayRailFromLeaderboard();
    saveDashboardSnapshot();
    shouldLoadCovers = state.leaderboard.length > 0;
  } catch (error) {
    if (requestId !== state.leaderboardRequestId) return;
    const hasPrevious = requestSource === 'catalog' ? catalogQualityAllowsRanking(state.leaderboard) : state.leaderboard.length > 0;
    const fallbackActivated = !hasPrevious && requestSource === 'catalog'
      && activateHistoricalLeaderboardFallback('可继续策划或生成文案');
    if (!fallbackActivated) {
      if (!hasPrevious) state.leaderboard = [];
      state.leaderboardDataQuality = hasPrevious && requestSource === 'catalog' ? 'stale_verified_metrics' : (error.details?.dataQuality || 'unavailable');
      state.leaderboardCredentialStatus = error.details?.credentialStatus || error.details?.sourceHealth?.credentialStatus || state.leaderboardCredentialStatus;
      state.leaderboardError = error.message || '榜单数据源暂不可用';
      state.leaderboardWarning = hasPrevious
        ? '实时数据源暂不可用，继续展示最近一次已验证榜单'
        : (error.details?.refreshWarning || state.leaderboardError);
      state.leaderboardDataKey = requestKey;
      shouldLoadCovers = hasPrevious;
      const retryAt = requestSource === 'catalog' ? Date.parse(error.details?.sourceHealth?.retryAfter || '') : NaN;
      if (!hasPrevious && Number.isFinite(retryAt) && retryAt > Date.now()) {
        const delay = Math.min(180000, Math.max(5000, retryAt - Date.now() + 250));
        clearTimeout(state.leaderboardRetryTimer);
        state.leaderboardRetryTimer = setTimeout(() => {
          state.leaderboardRetryTimer = null;
          loadLeaderboard({ silent: true });
        }, delay);
        state.leaderboardWarning = `中台正在恢复，系统会在 ${Math.ceil(delay / 1000)} 秒后自动重试当前产品线`;
      }
    } else {
      shouldLoadCovers = true;
      // Replace the compact rail fallback with the complete reviewed ranking
      // in the background. The current cards remain immediately actionable.
      setTimeout(() => loadLeaderboard({ silent: true }), 0);
    }
    if (!silent) showToast(hasPrevious ? '榜单刷新失败，已保留上一版可用数据' : fallbackActivated ? '新书中台暂不可用，已自动打开投放复盘候选' : error.message, hasPrevious || fallbackActivated ? '' : 'error');
  } finally {
    if (requestId === state.leaderboardRequestId) {
      if (state.leaderboardController === controller) state.leaderboardController = null;
      state.leaderboardLoading = false;
      renderP0DecisionRail(); renderHarnessStageStrip(); renderLeaderboard(); renderTodayRail(); icons();
      // Covers are decorative and load only after the ranking interaction is ready.
      if (shouldLoadCovers) loadVisibleCovers();
    }
  }
}

async function loadVisibleCovers() {
  if (state.leaderboardSource !== 'catalog') return;
  const nearViewportSkus = new Set([...document.querySelectorAll('#leaderboard .leaderboard-cover[data-cover-sku]')]
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom >= -160 && rect.top <= window.innerHeight + 720;
    })
    .map((node) => String(node.dataset.coverSku || '')));
  const visiblePage = catalogVisibleBooks()
    .slice((state.leaderboardPage - 1) * 50, state.leaderboardPage * 50)
    .filter((book) => nearViewportSkus.has(String(book.bookSkuId || '')))
    .slice(0, 12);
  const now = Date.now();
  const pageBooks = visiblePage.filter((book) => {
    const sku = String(book.bookSkuId || '');
    const failure = state.coverFailures.get(sku);
    return !book.cover && sku && book.title && !state.coverInFlight.has(sku) && (!failure || failure.attempts < 3 && failure.nextAttemptAt <= now);
  });
  if (!pageBooks.length) return;
  state.leaderboardCoverKey = `${state.leaderboardPage}:${pageBooks.map((book) => book.bookSkuId).join(',')}`;
  const batches = [];
  for (let index = 0; index < pageBooks.length; index += 8) batches.push(pageBooks.slice(index, index + 8));

  const loadBatch = async (batch) => {
    const skus = batch.map((book) => String(book.bookSkuId));
    skus.forEach((sku) => state.coverInFlight.add(sku));
    try {
      const body = await api('/api/book-covers', { method: 'POST', body: JSON.stringify({ accountId: Number(state.catalogFilters.accountId || 0), books: batch.map((book) => ({ sku: book.bookSkuId, title: book.title })) }), timeoutMs: 30000 });
      const covers = body.covers || {};
      const missingSkus = new Set((body.missing || []).map(String));
      const failedSkus = new Map((body.failed || []).map((item) => [String(item.sku), String(item.kind || 'unknown')]));
      if (Object.keys(covers).length) {
        state.leaderboard = state.leaderboard.map((book) => covers[String(book.bookSkuId)] ? { ...book, cover: covers[String(book.bookSkuId)] } : book);
        state.todayBooks = state.todayBooks.map((book) => covers[String(book.bookSkuId)] ? { ...book, cover: covers[String(book.bookSkuId)] } : book);
        Object.keys(covers).forEach((sku) => state.coverFailures.delete(String(sku)));
        saveDashboardSnapshot(); updateCoverNodes(covers);
      }
      skus.filter((sku) => !covers[sku]).forEach((sku) => recordCoverFailure(sku, missingSkus.has(sku) ? 'missing' : failedSkus.get(sku) || 'unknown'));
    } catch {
      skus.forEach((sku) => recordCoverFailure(sku));
    } finally {
      skus.forEach((sku) => state.coverInFlight.delete(sku));
      renderCoverRetryControl();
    }
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      await loadBatch(batch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
  scheduleCoverRetry();
}

function recordCoverFailure(sku, kind = 'unknown') {
  const previous = state.coverFailures.get(String(sku)) || { attempts: 0 };
  const attempts = kind === 'missing' ? 3 : previous.attempts + 1;
  state.coverFailures.set(String(sku), { attempts, kind, nextAttemptAt: kind === 'missing' ? Number.POSITIVE_INFINITY : Date.now() + Math.min(45000, 4000 * (2 ** (attempts - 1))) });
  updateCoverFailureNodes(sku, attempts, kind);
}

function scheduleCoverRetry() {
  clearTimeout(state.coverRetryTimer);
  const retryable = [...state.coverFailures.values()].filter((item) => item.attempts < 3);
  if (!retryable.length) return;
  const delay = Math.max(500, Math.min(...retryable.map((item) => item.nextAttemptAt)) - Date.now());
  state.coverRetryTimer = setTimeout(() => {
    state.coverRetryTimer = null;
    if (!document.hidden) {
      loadVisibleCovers();
      loadTodayCovers();
    }
  }, delay);
}

async function loadCreativePlans({ silent = false } = {}) {
  try {
    const body = await api('/api/creative-plan', { timeoutMs: 10000 });
    state.planJobs = body.jobs || [];
    for (const pending of state.pendingProductions?.values?.() || []) {
      if (pending.status !== 'planning') continue;
      const job = state.planJobs.find((item) => pendingMatchesCreativePlanJob(pending, item));
      if (job?.state === 'failed') {
        pending.status = 'failed';
        pending.error = job.stages?.analysis?.error || 'AI 策划未完成';
      }
    }
    renderCreativePlanQueue(); icons();
    renderOneClickStatus();
    return body;
  } catch (error) {
    if (!silent) showToast(error.message, 'error');
    return null;
  }
}

function queueCreativePlanJob(job, selectedModel, planningSession = null) {
  if (!job) return false;
  const pending = pendingProductionForCreativePlanJob(job);
  if (pending) {
    pending.status = 'planning';
    pending.error = '';
    pending.planId = job.id;
  }
  state.planJobs = [job, ...state.planJobs.filter((item) => item.id !== job.id)];
  renderOneClickStatus();
  renderCreativePlanQueue(); icons();
  dispatchWorkerOnce(`plan:${job.id}`, { planId: job.id });
  if (planningSession == null || planningSession === state.planningSession) $('#creativePlanDialog').close();
  showToast(`${selectedModel} 已转入后台策划，可继续操作；完成后在顶部查看方案`);
  return true;
}

async function recoverCreativePlanRequest(requestId, selectedModel, planningSession = null) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const body = await api(`/api/creative-plan?requestId=${encodeURIComponent(requestId)}`, { timeoutMs: 9000 });
      if (body.job) return queueCreativePlanJob(body.job, selectedModel, planningSession);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return false;
}

function dispatchesForRun(run) {
  const draft = run.artifacts?.creativeDraft;
  if (run?.stages?.P1?.status === 'done' && run?.stages?.P2?.status === 'done' && run?.stages?.P5?.status === 'done' && run?.stages?.P3?.status !== 'done' && Object.keys(draft?.inFlight || {}).some((section) => draft.inFlight[section])) return [];
  const videoRetryAt = Date.parse(run.stages?.P4?.nextAttemptAt || '');
  const waitingForVideoCapacity = run.stages?.P4?.status === 'prepared'
    && ['daily_video_limit', 'hourly_video_limit'].includes(String(run.stages?.P4?.blockedReason || ''))
    && Number.isFinite(videoRetryAt)
    && videoRetryAt > Date.now();
  const posterFinished = ['done', 'partial', 'ambiguous'].includes(String(run.stages?.P3_5?.status || ''));
  if (waitingForVideoCapacity && posterFinished) return [];
  const modelChoice = run.input?.creativeProfile?.modelChoice || 'hy3';
  return [{ key: `run:${run.id}`, payload: { id: run.id }, modelChoice, longTask: usesLongBackground(modelChoice) }];
}

function hasAutomaticCreativeRecovery(run) {
  const stage = run?.stages?.P3 || {};
  const recoverablePhase = ['waiting_for_operator', 'validation_waiting_for_operator', 'model_output_repairing'].includes(String(stage.phase || ''));
  const structuredFailure = /invalid structured output|invalid json|incomplete creative|missing required/i.test(String(stage.error || ''));
  return run?.state === 'failed' && stage.status === 'failed' && recoverablePhase && structuredFailure
    && Boolean(run.artifacts?.book && run.artifacts?.evidence?.chapters?.length && run.artifacts?.code && run.artifacts?.shortUrl);
}

function dispatchesForPlan(job) {
  const modelChoice = job.input?.modelChoice || 'hy3';
  return [{ key: `plan:${job.id}`, payload: { planId: job.id }, modelChoice, longTask: usesLongBackground(modelChoice) }];
}

async function kickWorker() {
  if (state.kickPromise) return state.kickPromise;
  const plans = state.planJobs.filter((job) => ['queued', 'running'].includes(job.state));
  const runs = state.runs.filter((run) => ['queued', 'running'].includes(run.state) || hasAutomaticCreativeRecovery(run));
  if (!plans.length && !runs.length) { state.longKickKey = ''; return 0; }
  state.kicking = true;
  state.kickPromise = (async () => {
    // The service owns provider concurrency, but this page should not amplify
    // a shared-model 429 by waking every active campaign item on each poll.
    const targets = [...plans.flatMap(dispatchesForPlan), ...runs.flatMap(dispatchesForRun)].slice(0, 1);
    let dispatched = 0;
    for (const target of targets) {
      // Older open tabs may still have a section request in flight. Do not
      // overlap it with the single task-wide worker route.
      if (target.key.startsWith('run:')) {
        const runId = target.key.slice(4);
        const hasSectionLease = ['posts', 'videoPrompt', 'posterPrompts', 'qualityReview'].some((section) => workerDispatchBusy(`${runId}:${section}`));
        if (hasSectionLease) continue;
      }
      if (!dispatchWorkerOnce(target.key, target.payload, { cooldownMs: WORKER_DISPATCH_COOLDOWN_MS })) continue;
      dispatched += 1;
    }
    if (dispatched) {
      renderOneClickStatus();
      // Reconcile the cheap durable summary shortly after dispatch. The
      // provider request itself remains outside the click's critical path.
      setTimeout(() => loadStatus({ silent: true }), 450);
    }
    return dispatched;
  })();
  try { return await state.kickPromise; }
  catch (error) { showToast(error.message, 'error'); return 0; }
  finally { state.kickPromise = null; state.kicking = false; }
}

async function retryRun(id) {
  try { await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id, action: 'retry' }) }); state.detailFingerprint = ''; await loadStatus(); await kickWorker(); }
  catch (error) { showToast(error.message, 'error'); }
}

async function reconcileAttribution(id) {
  try {
    await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id, action: 'reconcile_attribution' }) });
    state.detailFingerprint = '';
    await loadStatus();
    await kickWorker();
  } catch (error) { showToast(error.message, 'error'); }
}

async function removeRunAsset(run, asset) {
  const labels = { copy: '文案', video: '视频', reference_video: '参考海报版视频', posters: '海报' };
  if (!window.confirm(`从当前任务中移除${labels[asset] || '该素材'}？这不会删除已在外部平台创建的 Code、短链或付费任务。`)) return;
  try {
    await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id: run.id, action: 'delete_asset', asset }) });
    state.detailFingerprint = '';
    await loadStatus();
    showToast(`${labels[asset] || '素材'}已从当前任务移除`);
  } catch (error) { showToast(error.message, 'error'); }
}

async function decideOptimization(run, decision) {
  try {
    await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id: run.id, action: 'optimization_decision', decision }) });
    state.detailFingerprint = '';
    await loadStatus();
    if (decision === 'apply') { showToast(`${modelLabel(run.input?.creativeProfile?.modelChoice)} 正在生成优化版本`); await kickWorker(); }
    else showToast('已保留当前创意包');
  } catch (error) { showToast(error.message, 'error'); }
}

async function startReferenceVideo(runId, posterVariant) {
  const button = $('#createReferenceVideo');
  if (button) button.disabled = true;
  try {
    const body = await api('/api/reference-video', { method: 'POST', body: JSON.stringify({ runId, posterVariant }) });
    showToast(body.video?.status === 'running' ? '海报参考版 AC 视频已提交' : '海报参考版视频状态已更新');
    state.detailFingerprint = '';
    await loadStatus();
  } catch (error) { showToast(error.message, 'error'); }
  finally { if (button) button.disabled = false; }
}

async function rewriteVideoPrompt(runId) {
  try {
    showToast('正在基于原文证据重写视频提示词，完成后请在提示词区核对。');
    const body = await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id: runId, action: 'rewrite_video_prompt' }), timeoutMs: 650000 });
    state.runs = state.runs.map((item) => item.id === body.run.id ? body.run : item);
    state.detailFingerprint = ''; render();
    panel.querySelector('#detail-prompts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(`${modelLabel(body.run.artifacts?.videoPromptDraft?.model)} 已生成待核对的视频提示词，尚未提交付费视频。`);
  } catch (error) { showToast(error.message, 'error'); }
}

async function decideVideoPrompt(runId, action) {
  try {
    if (action === 'approve_and_submit') {
      const body = await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id: runId, action: 'approve_video_prompt' }) });
      state.runs = state.runs.map((item) => item.id === body.run.id ? body.run : item);
      state.detailFingerprint = ''; render();
      showToast('新视频提示词已采用。请在确认框中确认本次付费视频提交。');
      openConfirmation('video_revision', runId);
      return;
    }
    const body = await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id: runId, action: action === 'approve' ? 'approve_video_prompt' : 'discard_video_prompt' }) });
    state.runs = state.runs.map((item) => item.id === body.run.id ? body.run : item);
    state.detailFingerprint = ''; render();
    showToast(action === 'approve' ? '新视频提示词已采用。点击“用核对后的提示词生成视频”才会提交付费任务。' : '已保留原视频提示词。');
  } catch (error) { showToast(error.message, 'error'); }
}

async function startVideoRevision(runId) {
  try {
    const body = await api('/api/video-revision', { method: 'POST', body: JSON.stringify({ runId }) });
    showToast(body.video?.status === 'running' ? '重写提示词版 AC 视频已提交' : '重写提示词版视频状态已更新');
    state.detailFingerprint = ''; await loadStatus();
  } catch (error) { showToast(error.message, 'error'); }
}

function openConfirmation(kind, runId, options = {}) {
  state.confirmation = { kind, runId, ...options };
  const dialog = $('#confirmationDialog');
  const reference = kind === 'reference_video';
  const revision = kind === 'video_revision';
  const characterAssets = kind === 'character_assets';
  const run = state.runs.find((item) => item.id === runId);
  const selectedModel = modelLabel(run?.input?.creativeProfile?.modelChoice);
  const posterNumber = state.confirmation.posterVariant === 'luminous_cinema' ? '1' : '2';
  $('#confirmationTitle').textContent = characterAssets ? '生成角色一致性参考图？' : reference ? `提交海报 ${posterNumber} 参考 AC 视频？` : revision ? '提交重写提示词版 AC 视频？' : `让 ${selectedModel} 再创作一版？`;
  $('#confirmationDescription').textContent = reference
    ? `将使用已完成的海报 ${posterNumber} 作为参考图，额外提交一条付费 AC 视频。原视频不会被替换，并受本日 40 条上限控制。`
    : revision ? '将使用你刚刚核对并采用的新视频提示词，额外提交一条付费 AC 视频。原视频不会被替换，并受本日 40 条上限控制。'
      : characterAssets ? '将由后端根据当前任务的已锁定书籍和章节证据创建人物参考资产。此操作不会提交 AC 视频；生成完成后仍需在导演控制区手动选择、保存和预览。'
    : `${selectedModel} 会基于当前文案、原著证据、Code 和链接，生成明显不同的双语文案、视频脚本与海报提示词。不会自动提交付费视频或图片。`;
  $('#confirmAction').textContent = characterAssets ? '确认生成角色图' : reference || revision ? '确认提交视频' : '确认生成新创意';
  dialog.showModal();
}

async function confirmAction() {
  const request = state.confirmation;
  if (!request) return;
  const button = $('#confirmAction');
  button.disabled = true;
  try {
    if (request.kind === 'reference_video') await startReferenceVideo(request.runId, request.posterVariant);
    else if (request.kind === 'video_revision') await startVideoRevision(request.runId);
    else if (request.kind === 'character_assets') await generateCharacterAssets(request.runId, request.character);
    else {
      state.creativeVariantRunId = request.runId;
      state.detailFingerprint = '';
      $('#confirmationDialog').close();
      state.confirmation = null;
      renderDetail();
      showToast('AI 正在基于原文证据重写创意包，可继续查看其他内容。');
      await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id: request.runId, action: 'creative_variant' }), timeoutMs: 70000 });
      state.detailFingerprint = '';
      await loadStatus();
      const run = state.runs.find((item) => item.id === request.runId);
      showToast(`${modelLabel(run?.input?.creativeProfile?.modelChoice)} 已生成新的创意版本`);
    }
    if ($('#confirmationDialog').open) $('#confirmationDialog').close();
    state.confirmation = null;
  } catch (error) { showToast(error.message, 'error'); }
  finally {
    state.creativeVariantRunId = '';
    state.detailFingerprint = '';
    renderDetail();
    button.disabled = false;
  }
}

async function pollReferenceVideos() {
  if (document.hidden || state.referencePollRunning) return;
  state.referencePollRunning = true;
  try {
  const run = state.runs.find((item) => item.artifacts?.referenceVideo?.status === 'running');
  if (run) {
    try {
      await api('/api/reference-video', { method: 'POST', body: JSON.stringify({ runId: run.id, referenceAssetId: run.artifacts.referenceVideo.referenceAssetId }) });
      state.detailFingerprint = '';
      await loadStatus({ silent: true });
    } catch {}
  }
  const revision = state.runs.find((item) => item.artifacts?.videoRevision?.status === 'running');
  if (revision) {
    try {
      await api('/api/video-revision', { method: 'POST', body: JSON.stringify({ runId: revision.id }) });
      state.detailFingerprint = ''; await loadStatus({ silent: true });
    } catch {}
  }
  } finally {
    state.referencePollRunning = false;
  }
}

function openRunDialog() {
  $('#runFormError').textContent = '';
  syncCatalogTargetControls();
  $('#runDialog').showModal();
  setTimeout(() => $('#manualTitle').focus(), 0);
}

function closeRunDialog() { $('#runDialog').close(); }

function upsertRun(run) {
  if (!run?.id) return;
  const index = state.runs.findIndex((item) => item.id === run.id);
  if (index < 0) state.runs.unshift(run);
  else state.runs[index] = run;
}

function markPendingProduction({ title, sku = '', source = 'manual', creativeProfile = {}, delivery = null, p0Selection = null }) {
  const key = routeProductionIdentity({ title, sku }, delivery);
  const existing = state.pendingProductions.get(key);
  if (existing && existing.status !== 'failed') return existing;
  const pending = { key, title: String(title || ''), sku: String(sku || ''), source, creativeProfile, delivery, p0Selection, status: 'submitting', startedAt: Date.now(), error: '' };
  state.pendingProductions.set(key, pending);
  renderOneClickStatus();
  renderLeaderboard();
  icons();
  return pending;
}

async function createProduction({ title, sku = '', source = 'manual', creativeProfile = {}, planning = null, delivery = null, p0Selection = null, kick = true, notify = true }) {
  const accountId = Number(delivery?.accountId || state.catalogFilters.accountId || 0);
  if (!accountId) throw new Error('请先选择一个已核验的目标账号');
  const key = routeProductionIdentity({ title, sku }, { accountId });
  const previousRequest = state.productionRequests.get(key);
  if (previousRequest) return previousRequest;
  const previousPending = state.pendingProductions.get(key);
  if (previousPending && previousPending.status !== 'failed') {
    if (previousPending.runId) openDetail(previousPending.runId);
    return null;
  }
  const pending = markPendingProduction({ title, sku, source, creativeProfile, delivery: { ...(delivery || {}), accountId }, p0Selection });
  const request = (async () => {
    try {
      const body = await api('/api/runs', { method: 'POST', body: JSON.stringify({ title, sku, promoter: 'xujt', paidAuthorized: true, fullBookEvidence: true, source, creativeProfile, planning, accountId, p0Selection }) });
      if (!body?.run?.id) throw new Error('后台没有返回可追踪的任务 ID，请稍后重试');
      pending.status = 'accepted';
      pending.runId = body.run.id;
      body.run._creationDuplicate = body.duplicate === true;
      state.pendingProductions.delete(key);
      state.selectedId = body.run.id;
      state.detailOpen = true;
      state.detailFingerprint = '';
      upsertRun(body.run);
      render();
      // Do not make the click wait for a model/provider request. The worker
      // lease and the next status poll continue the same durable run.
      if (kick && (!body.duplicate || ['queued', 'running'].includes(body.run.state))) kickWorker().catch((error) => showToast(error.message, 'error'));
      if (notify) showToast(body.duplicate
        ? `《${body.run.input.title}》已有任务，已为你打开${['blocked', 'failed'].includes(body.run.state) ? '修复状态' : '当前进度'}`
        : `已为《${body.run.input.title}》入队，后台正在自动推进`);
      return body.run;
    } catch (error) {
      pending.status = 'failed';
      pending.error = error.message || '任务提交失败';
      pending.finishedAt = Date.now();
      renderOneClickStatus();
      renderLeaderboard();
      icons();
      throw error;
    }
  })();
  state.productionRequests.set(key, request);
  try { return await request; }
  finally { if (state.productionRequests.get(key) === request) state.productionRequests.delete(key); }
}

async function startProduction(book, explicitTarget = null) {
  const target = p0TargetForBook(book, explicitTarget);
  if (!target) { showToast('当前榜单没有锁定目标账号', 'error'); return; }
  const pending = pendingProductionFor(book, target);
  if (pending) {
    if (pending.status === 'failed') {
      state.pendingProductions.delete(pending.key);
      renderOneClickStatus();
      return startProduction(book, target);
    }
    if (pending.runId) openDetail(pending.runId);
    else showToast(`《${book.title}》已经入队，后台正在连接，不需要重复点击`);
    return;
  }
  const existing = activeRunFor(book, target);
  if (existing) {
    openDetail(existing.id);
    return;
  }
  const key = routeProductionIdentity(book, target);
  if (state.productionRequests.has(key)) {
    showToast(`《${book.title}》正在入队，请在上方状态卡查看`);
    return;
  }
  const startingKey = routeProductionIdentity(book, target);
  state.startingProductions.add(startingKey);
  renderLeaderboard();
  renderOneClickStatus();
  icons();
  try {
    await createProduction({ title: book.title, sku: book.bookSkuId || '', source: `catalog_${target.appKey || state.catalogFilters.line}_${target.platform}_${state.catalogDays}d`, delivery: target, p0Selection: p0SelectionForBook(book, target) });
  } catch (error) {
    showToast(`《${book.title}》入队失败：${error.message}`, 'error');
  } finally {
    state.startingProductions.delete(startingKey);
    renderLeaderboard();
    renderOneClickStatus();
    icons();
  }
}

async function startSelectedProductions() {
  if (state.batchStarting) return;
  const target = p0TargetForBook({}, p0DecisionTarget());
  if (!target) { showToast('当前榜单没有锁定目标账号', 'error'); return; }
  const books = state.leaderboard.filter((book) => state.selectedBooks.has(routeProductionIdentity(book, target))
    && !activeRunFor(book, target)
    && !pendingProductionFor(book, target));
  if (!books.length) { showToast('请先勾选至少一本有真实指标的书'); return; }
  state.batchStarting = true;
  state.batchProgress = { total: books.length, completed: 0, failed: 0 };
  renderBatchBookBar();
  icons();
  let accepted = 0;
  let existing = 0;
  for (const book of books) {
    try {
      const run = await createProduction({ title: book.title, sku: book.bookSkuId || '', source: `catalog_${target.appKey || state.catalogFilters.line}_${target.platform}_${state.catalogDays}d_batch`, delivery: target, p0Selection: p0SelectionForBook(book, target), kick: false, notify: false });
      if (run?._creationDuplicate) existing += 1; else accepted += 1;
    } catch {
      state.batchProgress.failed += 1;
    }
    state.batchProgress.completed += 1;
    renderBatchBookBar();
    renderOneClickStatus();
    icons();
  }
  state.selectedBooks.clear();
  state.batchStarting = false;
  const progress = state.batchProgress;
  state.batchProgress = null;
  renderBatchBookBar();
  await kickWorker();
  showToast(`已入队 ${accepted}/${books.length} 本，后台将按任务独立推进${existing ? `；${existing} 本已有任务，未重复创建` : ''}${progress.failed ? `；${progress.failed} 本需重试` : ''}`);
  renderOneClickStatus();
  icons();
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#loginError').textContent = '';
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); $('#password').value = ''; await loadStatus(); await loadPublications({ silent: true }); }
  catch (error) { $('#loginError').textContent = error.message; }
});
$('#togglePassword').addEventListener('click', () => { const input = $('#password'); input.type = input.type === 'password' ? 'text' : 'password'; });
$('#refreshButton').addEventListener('click', () => loadStatus());
$('#videoCapacity').addEventListener('click', () => {
  const video = state.videoLimit || { used: 0, limit: 40, remaining: 40, scope: 'day', timeZone: 'Asia/Shanghai' };
  const reset = Date.parse(video.resetAt || '');
  const resetLabel = Number.isFinite(reset) ? new Date(reset).toLocaleString('zh-CN', { timeZone: video.timeZone || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '次日 00:00';
  showToast(`本日剩余 ${video.remaining}/${video.limit} 条视频额度，已使用 ${video.used} 条；北京时间 ${resetLabel} 自动重置。`);
});
$('#pointsCapacity').addEventListener('click', () => {
  const points = state.pointsBudget || { used: 0, limit: 1000, remaining: 1000, timeZone: 'Asia/Shanghai' };
  const used = Number.isFinite(Number(points.used)) ? Number(points.used) : 0;
  const limit = Number.isFinite(Number(points.limit)) ? Number(points.limit) : 1000;
  const remaining = Math.max(0, Number.isFinite(Number(points.remaining)) ? Number(points.remaining) : limit - used);
  const reset = Date.parse(points.resetAt || '');
  const resetLabel = Number.isFinite(reset) ? new Date(reset).toLocaleString('zh-CN', { timeZone: points.timeZone || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '次日 00:00';
  showToast(`每日受控积分上限 ${limit}；已计入 ${used}，剩余 ${remaining}。轮询、上传和创建 SocialEcho 草稿不计入；北京时间 ${resetLabel} 自动重置。`);
});
function openCatalogRanking() {
  const changed = state.leaderboardSource !== 'catalog';
  state.leaderboardSource = 'catalog';
  document.querySelectorAll('#leaderboardSource button').forEach((button) => button.classList.toggle('active', button.dataset.source === 'catalog'));
  if (changed) loadLeaderboard();
  $('#leaderboardSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openHistoryRanking() {
  const changed = state.leaderboardSource !== 'history';
  state.leaderboardSource = 'history';
  document.querySelectorAll('#leaderboardSource button').forEach((button) => button.classList.toggle('active', button.dataset.source === 'history'));
  if (changed) loadLeaderboard();
  $('#leaderboardSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setOverviewFilter(filter) {
  const next = state.overviewFilter === filter ? 'all' : filter;
  state.overviewFilter = next;
  state.view = 'operations';
  $('#adCampaignWorkspace').hidden = true;
  $('#adPerformanceWorkspace').hidden = true;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'operations'));
  renderStats(); renderRunList(); icons();
  $('#controlBand').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const labels = { all: '全部生产任务', active: '正在生产中的任务', assets: '已有可用素材的任务', attention: '需要人工处理的任务' };
  showToast(`已显示：${labels[next]}`);
}

function switchView(view) {
  state.view = view;
  state.overviewFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  if (view === 'ads') {
    $('#adCampaignWorkspace').hidden = false;
    $('#adPerformanceWorkspace').hidden = true;
    renderAdCampaignWorkspace();
    loadAdCampaign({ silent: true });
    $('#adCampaignWorkspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (view === 'ad-performance') {
    $('#adCampaignWorkspace').hidden = true;
    $('#adPerformanceWorkspace').hidden = false;
    renderAdPerformance();
    loadAdPerformance({ silent: true });
    $('#adPerformanceWorkspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  $('#adCampaignWorkspace').hidden = true;
  $('#adPerformanceWorkspace').hidden = true;
  renderStats(); renderRunList(); icons();
  const labels = { operations: '全部生产任务', library: '已生成素材', completed: '已完成任务', attention: '需要处理的任务' };
  $('#controlBand').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast(`已显示：${labels[view] || '任务列表'}`);
}

function openAssistant() {
  $('#assistantDialog').showModal();
  icons();
  renderCopilotThread();
  runAssistant('operations');
}

$('#leaderboardButton').addEventListener('click', openCatalogRanking);
$('#deckLeaderboard').addEventListener('click', openCatalogRanking);
$('#deckAdCampaign').addEventListener('click', () => switchView('ads'));
$('#previewDailyCampaign').addEventListener('click', previewDailyCampaign);
$('#refreshDailyCampaign').addEventListener('click', () => loadDailyCampaign());
$('#retryDailyCampaignCreative').addEventListener('click', retryDailyCampaignCreative);
$('#dailyCampaignPaidConfirm').addEventListener('change', renderDailyCampaign);
$('#createDailyCampaign').addEventListener('click', createDailyCampaign);
$('#showAdvancedFlow').addEventListener('click', () => { $('#controlBand').scrollIntoView({ behavior: 'smooth', block: 'start' }); showToast('打开任一任务即可查看完整 P0–P7 节点与产物'); });
$('#createRunButton').addEventListener('click', openRunDialog);
$('#deckCreateRun').addEventListener('click', openRunDialog);
$('#deckCreativePlan').addEventListener('click', () => openCreativePlanDialog());
$('#weeklyReportButton').addEventListener('click', openWeeklyReport);
$('#dataQueryButton').addEventListener('click', () => { $('#dataQueryDialog').showModal(); $('#dataQueryInput').focus(); });
$('#closeDataQuery').addEventListener('click', () => $('#dataQueryDialog').close());
$('#dataQueryForm').addEventListener('submit', (event) => { event.preventDefault(); runDataQuery(); });
$('#refreshAdCampaign').addEventListener('click', () => loadAdCampaign({ refreshList: true }));
$('#adCampaignSelect').addEventListener('change', (event) => { state.adCampaignId = event.target.value; state.adCampaign = null; loadAdCampaign(); });
$('#refreshAdPerformance').addEventListener('click', () => loadAdPerformance({ force: true }));
$('#adPerformanceFrom').addEventListener('change', () => loadAdPerformance());
$('#adPerformanceTo').addEventListener('change', () => loadAdPerformance());
$('#openAdRegistry').addEventListener('click', () => openAdRegistry());
$('#closeAdRegistry').addEventListener('click', () => $('#adRegistryDialog').close());
$('#cancelAdRegistry').addEventListener('click', () => $('#adRegistryDialog').close());
$('#adRegistryForm').addEventListener('submit', saveAdRegistry);
$('#closeRunDialog').addEventListener('click', closeRunDialog);
$('#closeCreativePlan').addEventListener('click', () => {
  state.planningSession = Number(state.planningSession || 0) + 1;
  state.planning = false;
  $('#creativePlanDialog').close();
});
$('#creativePlanQueueButton').addEventListener('click', () => { $('#planQueueDialog').showModal(); renderCreativePlanQueue(); icons(); });
$('#closePlanQueue').addEventListener('click', () => $('#planQueueDialog').close());
$('#closeImageViewer').addEventListener('click', () => $('#imageViewer').close());
$('#closeWeeklyReport').addEventListener('click', () => $('#weeklyReportDialog').close());
$('#refreshWeeklyReport').addEventListener('click', () => loadWeeklyReport());
$('#copyWeeklyReport').addEventListener('click', () => copyAssetText(state.weeklyReport?.reportText, '周报已复制，可直接粘贴到汇报材料'));
document.querySelectorAll('[data-report-days]').forEach((button) => button.addEventListener('click', () => {
  state.weeklyReportDays = Number(button.dataset.reportDays);
  loadWeeklyReport();
}));
$('#deepseekAssistant')?.addEventListener('click', openAssistant);
$('#closeAssistant')?.addEventListener('click', () => $('#assistantDialog')?.close());
document.querySelectorAll('[data-assistant-mode]').forEach((button) => button.addEventListener('click', () => runAssistant(button.dataset.assistantMode)));
$('#copilotForm')?.addEventListener('submit', (event) => { event.preventDefault(); sendCopilot($('#copilotInput')?.value || ''); });
$('#modelChoice').addEventListener('change', renderModelBadges);
$('#assistantModelChoice')?.addEventListener('change', renderModelBadges);
$('#todayRailPrev').addEventListener('click', () => $('#todayRailList').scrollBy({ left: -620, behavior: 'smooth' }));
$('#todayRailNext').addEventListener('click', () => $('#todayRailList').scrollBy({ left: 620, behavior: 'smooth' }));
$('#todayRailList').addEventListener('mouseenter', () => { state.todayRailPaused = true; });
$('#todayRailList').addEventListener('mouseleave', () => { state.todayRailPaused = false; });
$('#closeConfirmation').addEventListener('click', () => $('#confirmationDialog').close());
$('#confirmAction').addEventListener('click', confirmAction);
$('#runForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = $('#manualTitle').value.trim();
  const sku = $('#manualSku').value.trim();
  const accountId = Number($('#manualAccount').value || 0);
  const delivery = catalogTargetRoutes().find((route) => Number(route.accountId) === accountId) || { accountId };
  const creativeProfile = creativeProfileForForm();
  const button = $('#submitRun');
  $('#runFormError').textContent = '';
  button.disabled = true;
  try {
    await createProduction({ title, sku, source: 'manual', creativeProfile, delivery, p0Selection: { ...p0SelectionForBook({}), source: 'manual' } });
    closeRunDialog();
    $('#runForm').reset();
    syncCatalogTargetControls();
  }
  catch (error) { $('#runFormError').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#creativePlanForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.planning) { showToast('这次策划请求正在确认，完成后会进入后台队列'); return; }
  await analyzeCreativePlan($('#planTitle').value.trim(), $('#planSku').value.trim());
});
$('#detailScrim').addEventListener('click', closeDetail);
['#creativeStyle', '#ctaStyle', '#videoStyle', '#posterStyle'].forEach((selector) => $(selector).addEventListener('change', renderCreativeProfilePreview));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.detailOpen) closeDetail(); });
$('#refreshLeaderboard').addEventListener('click', () => loadLeaderboard({ refresh: true }));
$('#retryCovers').addEventListener('click', () => {
  state.coverFailures.clear();
  document.querySelectorAll('[data-cover-sku]').forEach((node) => {
    node.classList.remove('cover-unavailable');
    const label = node.querySelector('.cover-fallback small');
    if (label && !node.querySelector('[data-cover-image]')) label.textContent = '封面同步中';
  });
  renderCoverRetryControl();
  loadVisibleCovers();
  loadTodayCovers();
  showToast('未加载封面已重新排队，不影响其他操作。');
});
document.querySelectorAll('#windowControl button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#windowControl button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.windowDays = Number(button.dataset.days); loadLeaderboard(); }));
document.querySelectorAll('#catalogWindowControl button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#catalogWindowControl button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.catalogDays = Number(button.dataset.days); loadLeaderboard(); }));
$('#catalogSort').addEventListener('change', (event) => { state.catalogSort = event.target.value; loadLeaderboard(); });
$('#catalogUsageFilter').addEventListener('change', (event) => { state.catalogUsageFilter = event.target.value; state.leaderboardPage = 1; renderLeaderboard(); icons(); });
document.querySelectorAll('[data-catalog-filter]').forEach((input) => input.addEventListener('change', (event) => {
  const key = event.target.dataset.catalogFilter;
  state.catalogFilters[key] = event.target.value;
  if (key === 'line') {
    syncCatalogTargetControls({ resetAccount: true });
    state.catalogTarget = null;
    state.selectedBooks.clear();
    state.coverFailures.clear();
    state.coverInFlight.clear();
  }
  loadLeaderboard();
}));
$('#catalogPlatform').addEventListener('change', (event) => {
  state.catalogFilters.platform = event.target.value;
  syncCatalogTargetControls({ resetAccount: true });
  state.catalogTarget = null;
  state.selectedBooks.clear();
  loadLeaderboard();
});
$('#catalogAccount').addEventListener('change', (event) => {
  state.catalogFilters.accountId = event.target.value;
  state.catalogTarget = null;
  state.selectedBooks.clear();
  syncCatalogTargetControls();
  loadLeaderboard();
});
$('#clearBookSelection').addEventListener('click', () => { state.selectedBooks.clear(); renderLeaderboard(); icons(); });
$('#startSelectedBooks').addEventListener('click', startSelectedProductions);
$('#previousBooks').addEventListener('click', () => { if (state.leaderboardPage <= 1) return; state.leaderboardPage -= 1; state.leaderboardCoverKey = ''; renderLeaderboard(); loadVisibleCovers(); $('#leaderboardSection').scrollIntoView({ behavior: 'smooth', block: 'start' }); icons(); });
$('#nextBooks').addEventListener('click', () => { const pages = Math.ceil(catalogVisibleBooks().length / 50); if (state.leaderboardPage >= pages) return; state.leaderboardPage += 1; state.leaderboardCoverKey = ''; renderLeaderboard(); loadVisibleCovers(); $('#leaderboardSection').scrollIntoView({ behavior: 'smooth', block: 'start' }); icons(); });
document.querySelectorAll('#leaderboardSource button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#leaderboardSource button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.leaderboardSource = button.dataset.source; loadLeaderboard(); }));
$('#runSearch').addEventListener('input', (event) => { state.query = event.target.value; renderRunList(); });
$('#loadMoreRuns').addEventListener('click', async () => {
  if (state.statusLimit >= 50 || state.statusLoading) return;
  showToast('正在加载更早的任务，当前列表保持可用');
  state.statusLimit = 50;
  renderRunLoadMore();
  await loadStatus({ silent: true });
});
$('#loadCampaignRuns')?.addEventListener('click', async () => {
  if (!state.dailyCampaignId || state.statusLoading) return;
  state.statusCampaignId = String(state.dailyCampaignId);
  state.statusScope = 'campaign';
  state.selectedId = '';
  renderRunLoadMore();
  showToast('正在读取本 Campaign 的全部任务，不受最近 12/50 条窗口限制');
  await loadStatus({ silent: true });
});
document.querySelectorAll('[data-overview-filter]').forEach((button) => button.addEventListener('click', () => setOverviewFilter(button.dataset.overviewFilter)));
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
document.querySelectorAll('#densityControl button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#densityControl button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.density = button.dataset.density; renderRunList(); icons(); }));

renderCreativeProfilePreview();
syncCatalogTargetControls();
icons();
// Render the most recent verified state immediately, then reconcile it in the background.
const restoredDashboard = restoreDashboardSnapshot();
if (restoredDashboard) {
  render();
}
loadStatus().then(() => { loadPublications({ silent: true }); if (hasLiveBackgroundWork()) kickWorker(); });
  // Slim console: daily batch is paused and loaded only from an explicit
  // future advanced mode, never during startup.
loadLeaderboard({ silent: true });
const loadSecondaryStartup = () => { if (restoredDashboard) loadVisibleCovers(); };
if ('requestIdleCallback' in window) window.requestIdleCallback(loadSecondaryStartup, { timeout: 800 });
else setTimeout(loadSecondaryStartup, 120);
let idlePlanPolls = 0;
function hasLiveBackgroundWork() {
  return state.runs.some((run) => ['queued', 'running'].includes(run.state) || hasAutomaticCreativeRecovery(run)) || state.planJobs.some((job) => ['queued', 'running'].includes(job.state));
}
async function pollDashboard() {
  let active = hasLiveBackgroundWork();
  if (!document.hidden) {
    await loadStatus({ silent: true });
    // Daily campaign polling is intentionally disabled in slim mode.
    active = hasLiveBackgroundWork();
    if (active) {
      idlePlanPolls = 0;
      kickWorker();
    }
  }
  setTimeout(pollDashboard, active && !document.hidden ? 8000 : 30000);
}
setTimeout(pollDashboard, 8000);
setInterval(() => { if (!document.hidden) loadLeaderboard({ silent: true }); }, 5 * 60 * 1000);
setInterval(pollReferenceVideos, 15000);
setInterval(() => { if (!document.hidden) advanceTodayRail(); }, 4200);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  scheduleCoverRetry();
  if (hasLiveBackgroundWork()) loadStatus({ silent: true });
});
let coverScrollTimer = null;
window.addEventListener('scroll', () => {
  if (coverScrollTimer || state.leaderboardSource !== 'catalog') return;
  coverScrollTimer = setTimeout(() => { coverScrollTimer = null; loadVisibleCovers(); }, 180);
}, { passive: true });
