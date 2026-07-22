const storedRecommendationHistory = (() => { try { return JSON.parse(localStorage.getItem('nf_social:recommendation_history') || '[]'); } catch { return []; } })();
const state = { runs: [], planJobs: [], capabilities: {}, videoLimit: null, leaderboard: [], leaderboardUpdated: '', leaderboardWindow: null, leaderboardMetrics: null, leaderboardPage: 1, leaderboardCoverKey: '', leaderboardLoading: false, leaderboardSource: 'catalog', catalogDays: 30, catalogSort: 'baseReadUnt', catalogFilters: { line: 'novelflow', language: 'EN', complete: '已完结', status: '上架', length: 'all', genre: 'all' }, selectedBooks: new Set(), windowDays: 7, selectedId: '', view: 'operations', density: 'comfortable', query: '', detailFingerprint: '', detailOpen: false, detailTarget: '', selectedNode: '', kicking: false, longKickKey: '', startingSku: '', planning: false, assistantRunning: false, creativePlan: null, confirmation: null, creativeVariantRunId: '', recommendationCycle: 0, recommendationHistory: Array.isArray(storedRecommendationHistory) ? storedRecommendationHistory.slice(-9) : [], weeklyReport: null, weeklyReportDays: 7, weeklyReportLoading: false };
state.detailHydrating = '';
state.todayBooks = [];
state.todayBooksLoading = false;
state.copilotMessages = (() => { try { return JSON.parse(localStorage.getItem('nf_social:copilot_messages') || '[]').slice(-14); } catch { return []; } })();
state.copilotBusy = false;
state.referencePosterChoice = {};
state.todayRailPaused = false;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const labels = { queued: '排队中', running: '生产中', completed: '已完成', failed: '失败', blocked: '已暂停', partial: '部分完成', ambiguous: '需人工核验' };
const stageLabels = { P1: '选书', P2: '证据', P3: '创意', P3_5: '海报', P4: '视频', P5: 'Code', P6: '审核' };
const stageIcons = { P1: 'book-open-check', P2: 'library', P3: 'message-square-text', P3_5: 'images', P4: 'video', P5: 'link-2', P6: 'badge-check' };
const pipelineOrder = ['P1', 'P2', 'P5', 'P3', 'P4', 'P3_5', 'P6'];
const catalogSortLabels = { baseReadUnt: '阅读 UV', firstReadUntRate: '首读率', read10wRate: '10 万字留存', read20wRate: '20 万字留存', ttProfit: '利润' };

function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } }); }

const creativeProfileOptions = {
  copyStyle: { label: '文案', values: { system_best: '系统推荐：从原文选择最有张力的冲突', revenge_comeback: '复仇反杀：只在原文支持时突出夺回主动权', forbidden_tension: '禁忌拉扯：只在原文支持时突出欲望与边界', dark_redemption: '暗黑救赎：只在原文支持时突出危险与重获掌控' } },
  ctaStyle: { label: 'CTA', values: { story_cliffhanger: '系统推荐：用具体未解的情节问题收尾', identity_reveal: '身份反转：以已铺垫的秘密或认出为钩子', romantic_tension: '暧昧拉扯：以有证据的欲望、目光或边界收尾', revenge_payoff: '反击爽点：以有证据的清算或反转承诺收尾' } },
  videoStyle: { label: '视频剧情', values: { five_beat: '系统推荐：钩子、价值、升级、反转、悬念五拍', reversal: '强反转：把真实反转放在 8-11 秒', slow_burn: '慢热张力：用克制靠近和最终选择递进', revenge: '复仇兑现：只使用原文已有的反击或翻盘' } },
  posterStyle: { label: '海报', values: { system_best: '系统推荐：一张电影感，一张时尚情绪感', luminous_cinema: '电影氛围：强调高戏剧性的关键瞬间', editorial_romance: '时尚爱情：强调克制、情绪与留白' } },
  modelChoice: { label: '生产模型', values: { hy3: 'HY3：默认快速模型', deepseek: 'DeepSeek V4 Pro：深度创意', 'seed-2.1-turbo': 'Seed 2.1 Turbo：备用生成', 'qwen3.7-max': 'Qwen 3.7 Max：深度策划', 'minimax-m2.7': 'MiniMax M2.7：表达与润色', 'kimi-k2.7-code': 'Kimi K2.7 Code：结构分析' } }
};

const modelLabels = { deepseek: 'DeepSeek V4 Pro', 'deepseek-chat': 'DeepSeek', 'deepseek-v4-pro': 'DeepSeek V4 Pro', 'seed-2.1-turbo': 'Seed 2.1 Turbo', 'doubao-seed-2-1-turbo-260628': 'Seed 2.1 Turbo', 'qwen3.7-max': 'Qwen 3.7 Max', 'minimax-m2.7': 'MiniMax M2.7', hy3: 'HY3', 'kimi-k2.7-code': 'Kimi K2.7 Code', 'qwen3.5-flash': 'Qwen 3.5 Flash', 'glm-4.5-air': 'GLM 4.5 Air', 'kimi-k2.5': 'Kimi K2.5', 'minimax-m2.5': 'MiniMax M2.5', 'metrics-fallback': '中台指标兜底', 'glm-5.2': 'GLM 5.2', 'kimi-k3': 'Kimi K3', 'minimax-m3': 'MiniMax M3' };
function modelLabel(value) { return modelLabels[String(value || '').toLowerCase()] || String(value || 'AI'); }
function modelBrand(value) {
  const key = String(value || '').toLowerCase();
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
const longBackgroundModels = new Set(['deepseek', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'kimi-k2.7-code']);
const usesLongBackground = (choice) => longBackgroundModels.has(String(choice || '').toLowerCase());

function creativeProfileForForm() {
  return { copyStyle: $('#creativeStyle').value, ctaStyle: $('#ctaStyle').value, videoStyle: $('#videoStyle').value, posterStyle: $('#posterStyle').value, modelChoice: $('#modelChoice')?.value || 'hy3' };
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
  if (!planning?.actualModel) return '';
  const preferred = planning.preferredModel || planning.actualModel;
  const actual = planning.actualModel;
  const production = run.input?.creativeProfile?.modelChoice || planning.actualModel;
  const strategy = planning.fallbackUsed && modelLabel(preferred) !== modelLabel(actual)
    ? `${modelLogoHtml(preferred, { compact: true })}<i data-lucide="arrow-right"></i>${modelLogoHtml(actual, { compact: true })}`
    : modelLogoHtml(actual, { compact: true });
  return `<div class="production-model-route"><i data-lucide="route"></i><div><span>模型分工</span><strong><b>策划</b>${strategy}<b>生产</b>${modelLogoHtml(production, { compact: true })}</strong></div></div>`;
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
  return `<header><div><span class="dialog-kicker">RECOMMENDED DIRECTION</span><h3>${escapeHtml(result.book.title)}</h3><p>已分析全书 ${escapeHtml(result.evidenceScope.chapterCount)} 章结构，使用第 ${escapeHtml((result.evidenceScope.sampledChapters || []).join(' / '))} 章作为关键证据样本。</p></div><span class="plan-model">${modelLogoHtml(actualModel, { compact: true })}</span></header><div class="plan-model-route"><i data-lucide="route"></i><div><strong>策划路由</strong><span>${escapeHtml(routeText)}；本次实际完成模型：${modelLogoHtml(actualModel, { compact: true })}</span></div></div>
    <div class="plan-thesis"><strong>核心推广判断</strong><p>${escapeHtml(plan.editorialThesis)}</p></div>
    <div class="plan-profile">${Object.keys(creativeProfileOptions).map((key) => profileSelect(key, profile[key] || Object.keys(creativeProfileOptions[key].values)[0])).join('')}</div>
    <div class="plan-rationale">${Object.entries(creativeProfileOptions).map(([key, definition]) => `<article><span>${escapeHtml(definition.label)}</span><strong>${escapeHtml(rationale[key] || '以章节证据为准')}</strong></article>`).join('')}</div>
    <div class="plan-blueprints"><article><span>文案蓝图</span><strong>${escapeHtml(copy.hook || '')}</strong><p>${escapeHtml(copy.emotionalArc || copy.zhSummary || '')}</p><small>CTA：${escapeHtml(copy.cta || '')}</small></article><article><span>视频剧情</span><strong>${escapeHtml(video.opening || video.arc || '')}</strong><p>${escapeHtml(video.reversal || video.zhSummary || '')}</p><small>悬念：${escapeHtml(video.cliffhanger || '')}</small></article><article><span>海报方向</span><strong>${escapeHtml(poster.moment || '')}</strong><p>${escapeHtml(poster.mood || poster.zhSummary || '')}</p></article></div>
    ${evidence.length ? `<div class="plan-evidence">${evidence.map((item) => `<article><span>Ch.${escapeHtml(item.chapter)}</span><strong>“${escapeHtml(item.quote)}”</strong><p>${escapeHtml(item.why || '')}</p></article>`).join('')}</div>` : ''}
    <footer><button id="confirmCreativePlan" class="primary-command" type="button"><i data-lucide="zap"></i><span>采用方案并开始生产</span></button><button id="replanCreativePlan" class="secondary-command" type="button"><i data-lucide="refresh-cw"></i><span>重新分析</span></button></footer>`;
}

function planJobResult(job) {
  return { id: job.id, book: job.artifacts?.book || { title: job.input?.title || '', sku: job.input?.sku || '' }, plan: job.artifacts?.plan || {}, evidenceScope: job.artifacts?.evidenceScope || { chapterCount: 0, sampledChapters: [] }, usage: job.artifacts?.usage || {}, modelChoice: job.input?.modelChoice || 'hy3', preferredModelChoice: job.input?.preferredModelChoice || job.input?.modelChoice || 'hy3', fallbackUsed: Boolean(job.input?.fallbackUsed), modelHistory: job.input?.modelHistory || [] };
}

function renderCreativePlanQueue() {
  const queue = $('#creativePlanQueue');
  const launcher = $('#creativePlanQueueButton');
  const count = $('#creativePlanQueueCount');
  const list = $('#planQueueList');
  const jobs = state.planJobs.filter((job) => ['queued', 'running', 'completed', 'failed'].includes(job.state)).slice(0, 5);
  if (queue) queue.hidden = true;
  if (launcher) launcher.hidden = !jobs.length;
  if (count) count.textContent = String(jobs.length);
  const jobHtml = jobs.map((job) => {
    const stage = Object.values(job.stages || {}).find((item) => item.status === 'running') || Object.values(job.stages || {}).find((item) => item.status === 'waiting') || job.stages?.analysis || {};
    const icon = job.state === 'completed' ? 'circle-check-big' : job.state === 'failed' ? 'circle-alert' : 'loader-circle';
    const status = job.state === 'completed' ? '策划完成，点击查看方案' : job.state === 'failed' ? '策划中断，点击从已保存证据恢复' : (stage.label || '后台策划中，可继续使用控制台');
    return `<button class="creative-plan-job ${job.state === 'completed' ? 'done' : job.state === 'failed' ? 'failed' : ''}" type="button" data-plan-job="${escapeHtml(job.id)}"><span><strong>${escapeHtml(job.artifacts?.book?.title || job.input?.title || 'AI 智能策划')}</strong><span>${escapeHtml(status)}</span></span><i data-lucide="${icon}"></i></button>`;
  }).join('');
  if (list) {
    list.innerHTML = jobHtml || '<div class="plan-queue-empty"><i data-lucide="brain-circuit"></i><span>暂无后台策划任务</span></div>';
    list.querySelectorAll('[data-plan-job]').forEach((button) => button.addEventListener('click', () => showPlanJob(button.dataset.planJob)));
  }
}

async function showPlanJob(id) {
  const job = state.planJobs.find((item) => item.id === id);
  if (!job) return;
  if (job.state === 'failed') { retryCreativePlanJob(job.id); return; }
  if (job.state !== 'completed') { showToast(job.stages?.analysis?.error || '该策划仍在后台推进，完成后这里会变为可查看方案'); return; }
  if (job._summary || !job.artifacts?.plan) {
    try {
      const body = await api(`/api/creative-plan?id=${encodeURIComponent(id)}`, { timeoutMs: 45000 });
      state.planJobs = state.planJobs.map((item) => item.id === id ? body.job : item);
      return showPlanJob(id);
    } catch (error) {
      showToast(`策划详情加载失败：${error.message}`, 'error');
      return;
    }
  }
  const result = planJobResult(job);
  state.creativePlan = result;
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

async function retryCreativePlanJob(id) {
  try {
    await api('/api/creative-plan', { method: 'PATCH', body: JSON.stringify({ id, action: 'retry' }), timeoutMs: 10000 });
    showToast('已从锁定的章节证据恢复策划，首选模型会再次尝试');
    await loadCreativePlans({ silent: true });
    await kickWorker();
  } catch (error) { showToast(error.message, 'error'); }
}

function bindCreativePlanActions(result) {
  $('#confirmCreativePlan').addEventListener('click', async () => {
    const button = $('#confirmCreativePlan');
    button.disabled = true;
    try {
      const creativeProfile = creativePlanProfile();
      const actualPlanningModel = result.usage?.model || result.modelChoice || creativeProfile.modelChoice;
      await createProduction({ title: result.book.title, sku: result.book.bookSkuId || result.book.sku, source: 'ai_plan', creativeProfile, planning: { planId: result.id || '', preferredModel: result.preferredModelChoice || actualPlanningModel, actualModel: actualPlanningModel, fallbackUsed: Boolean(result.fallbackUsed) } });
      $('#creativePlanDialog').close();
      showToast(`策划由 ${modelLabel(actualPlanningModel)} 完成；生产使用 ${modelLabel(creativeProfile.modelChoice)}`);
    } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
  });
  $('#replanCreativePlan').addEventListener('click', () => openCreativePlanDialog({ title: result.book.title, bookSkuId: result.book.bookSkuId || result.book.sku }));
}

function openCreativePlanDialog(book = {}) {
  state.creativePlan = null;
  $('#creativePlanForm').hidden = false;
  $('#creativePlanLoading').hidden = true;
  $('#creativePlanResult').hidden = true;
  $('#creativePlanResult').innerHTML = '';
  $('#creativePlanError').textContent = '';
  if (!$('#planningRequestModel')) $('#creativePlanInput').insertAdjacentHTML('beforeend', '<label class="plan-model-choice">首选策划模型<select id="planningRequestModel"><option value="hy3">HY3（默认，实测最快）</option><option value="deepseek">DeepSeek V4 Pro（深度）</option><option value="seed-2.1-turbo">Seed 2.1 Turbo（备用）</option><option value="qwen3.7-max">Qwen 3.7 Max（深度）</option><option value="minimax-m2.7">MiniMax M2.7（润色）</option><option value="kimi-k2.7-code">Kimi K2.7 Code（结构）</option></select></label>');
  $('#planTitle').value = book.title || '';
  $('#planSku').value = book.bookSkuId || '';
  $('#creativePlanDialog').showModal();
  setTimeout(() => $('#planTitle').focus(), 0);
}

async function analyzeCreativePlan(title, sku) {
  state.planning = true;
  const modelChoice = $('#planningRequestModel')?.value || 'hy3';
  const selectedModel = modelLabel(modelChoice);
  const requestId = crypto.randomUUID();
  $('#creativePlanForm').hidden = true;
  $('#creativePlanLoading').hidden = false;
  $('#creativePlanResult').hidden = true;
  $('#creativePlanLoading strong').textContent = `${selectedModel} 正在转入后台策划`;
  try {
    const body = await api('/api/creative-plan', { method: 'POST', body: JSON.stringify({ title, sku, modelChoice, requestId }), timeoutMs: 30000 });
    queueCreativePlanJob(body.job, selectedModel);
  } catch (error) {
    if (/请求超过|AbortError/i.test(String(error.message || error))) {
      $('#creativePlanLoading strong').textContent = '正在确认后台任务状态';
      if (await recoverCreativePlanRequest(requestId, selectedModel)) return;
    }
    const result = $('#creativePlanResult');
    result.hidden = false;
    result.innerHTML = `<div class="ai-failure"><i data-lucide="circle-alert"></i><strong>后台任务尚未确认</strong><p>${escapeHtml(error.message)}</p><div><button id="retryCreativePlan" class="primary-command" type="button">继续确认任务</button><button id="changeCreativePlanModel" class="secondary-command" type="button">换模型新建</button><button id="editCreativePlan" class="secondary-command" type="button">返回修改</button></div></div>`;
    $('#retryCreativePlan').addEventListener('click', async () => { if (!(await recoverCreativePlanRequest(requestId, selectedModel))) showToast('后台仍未确认该请求，请稍后再确认；不要重复提交。'); });
    $('#changeCreativePlanModel').addEventListener('click', () => { result.hidden = true; $('#creativePlanForm').hidden = false; $('#planningRequestModel').focus(); });
    $('#editCreativePlan').addEventListener('click', () => { result.hidden = true; $('#creativePlanForm').hidden = false; $('#planTitle').focus(); });
    icons();
  } finally {
    state.planning = false;
    $('#creativePlanLoading').hidden = true;
  }
}

async function api(url, options = {}) {
  const { timeoutMs = 45000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...fetchOptions, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) } });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止等待；可直接重试或切换模型`);
    throw error;
  } finally { clearTimeout(timer); }
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
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
  return `&sort=${encodeURIComponent(state.catalogSort)}&line=${encodeURIComponent(state.catalogFilters.line)}&language=${encodeURIComponent(state.catalogFilters.language)}&complete=${encodeURIComponent(state.catalogFilters.complete)}&status=${encodeURIComponent(state.catalogFilters.status)}&isShort=${catalogShortChoice()}`;
}

async function assistantSnapshot(mode) {
  const activeRuns = state.runs.filter((run) => ['queued', 'running', 'blocked', 'failed'].includes(run.state)).slice(0, 8).map((run) => ({
    id: run.id, title: run.input?.title, state: run.state, code: run.artifacts?.code || '', completedStages: Object.values(run.stages || {}).filter((stage) => stage.status === 'done').length,
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
    else actions.push({ priority: 'low', title: `${run.title}：继续生产`, reason: `已完成 ${run.completedStages || 0}/7 个节点，可打开查看当前产物。`, runId: run.id });
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
    const body = await api('/api/assistant', { method: 'POST', body: JSON.stringify({ mode, modelChoice, snapshot }), timeoutMs: 32000 });
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
    const body = await api('/api/copilot', { method: 'POST', body: JSON.stringify({ messages: state.copilotMessages, context: copilotContext(), modelChoice }), timeoutMs: 45000 });
    const reply = { role: 'assistant', content: body.message?.content || '', toolCalls: body.message?.toolCalls || [] };
    state.copilotMessages.push(reply); renderCopilotThread();
    if (reply.toolCalls.length) {
      for (const call of reply.toolCalls) state.copilotMessages.push({ role: 'tool', toolCallId: call.id, content: await executeCopilotTool(call) });
      const final = await api('/api/copilot', { method: 'POST', body: JSON.stringify({ messages: state.copilotMessages, context: copilotContext(), modelChoice }), timeoutMs: 45000 });
      state.copilotMessages.push({ role: 'assistant', content: final.message?.content || '页面动作已完成。' });
    }
    persistCopilot(); renderCopilotThread(); icons();
  } catch (error) {
    state.copilotMessages.push({ role: 'assistant', content: `我暂时没有拿到模型回复：${error.message}。你仍可以使用上方的巡检与推荐入口。` });
    persistCopilot(); renderCopilotThread();
  } finally { state.copilotBusy = false; button.disabled = false; input.focus(); }
}

function showLogin() {
  showApp();
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
}

function capabilityName(key) {
  return { storage: '任务存储', pipeline: '书库与短链', llm: 'AI 创意模型', video: 'AC 视频', image: '海报生成', report: '归因数据' }[key] || key;
}

function renderCapabilities() {
  $('#capabilities').innerHTML = Object.entries(state.capabilities).map(([key, ok]) => `<div class="cap-row ${ok ? 'ok' : ''}"><span>${escapeHtml(capabilityName(key))}</span><i></i></div>`).join('');
  const values = Object.values(state.capabilities);
  const readyCount = values.filter(Boolean).length;
  const allReady = values.length > 0 && readyCount === values.length;
  $('#systemState').classList.toggle('online', allReady);
  $('#systemState').innerHTML = `<span class="pulse-dot"></span>生产配置 ${readyCount}/${values.length || 6}`;
  const video = state.videoLimit || { used: 0, limit: 5, remaining: 5 };
  const capacity = $('#videoCapacity');
  capacity.classList.toggle('at-limit', Number(video.remaining) === 0);
  const reset = new Date(); reset.setMinutes(0, 0, 0); reset.setHours(reset.getHours() + 1);
  const resetLabel = reset.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  capacity.title = `本网站每小时最多提交 ${video.limit} 条付费视频；已用 ${video.used} 条，${resetLabel} 重置。`;
  capacity.innerHTML = `<i data-lucide="video"></i><strong>视频额度 ${video.remaining}/${video.limit}</strong><small>${video.used} 已用 · ${resetLabel} 重置</small>`;
}

function showToast(message, kind = '') {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 4600);
}

function openDetail(id, target = '') {
  state.selectedId = id;
  state.detailOpen = true;
  state.detailTarget = target;
  state.detailFingerprint = '';
  render();
  hydrateRunDetail(id);
}

async function hydrateRunDetail(id) {
  const run = state.runs.find((item) => item.id === id);
  if (!run?._summary || state.detailHydrating === id) return;
  state.detailHydrating = id;
  state.detailFingerprint = '';
  renderDetail();
  try {
    const body = await api(`/api/runs?id=${encodeURIComponent(id)}`, { timeoutMs: 45000 });
    state.runs = state.runs.map((item) => item.id === id ? body.run : item);
    state.detailFingerprint = '';
    render();
  } catch (error) {
    showToast(`任务详情加载失败：${error.message}`, 'error');
  } finally {
    if (state.detailHydrating === id) state.detailHydrating = '';
  }
}

function closeDetail() {
  state.detailOpen = false;
  state.detailTarget = '';
  $('#detailPanel').setAttribute('aria-hidden', 'true');
  $('#detailScrim').setAttribute('aria-hidden', 'true');
  $('#detailPanel').classList.remove('open');
  $('#detailScrim').classList.remove('open');
}

function openNodeDecision(id, node) {
  state.selectedNode = node;
  openDetail(id, 'decision');
}

function compactNumber(value) {
  return Number(value || 0).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

function percentage(value) { return value == null ? '待接入' : `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`; }

function leaderboardCover(book) {
  const fallback = state.leaderboardSource === 'history' ? 'HISTORY' : 'RANK';
  return book.cover
    ? `<img src="${escapeHtml(book.cover)}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="cover-fallback" hidden><small>${fallback}</small><strong>${escapeHtml(String(book.title || 'N').slice(0, 1))}</strong></span>`
    : `<span class="cover-fallback"><small>${fallback}</small><strong>${escapeHtml(String(book.title || 'N').slice(0, 1))}</strong></span>`;
}

function activeRunFor(book) {
  return state.runs.find((run) => (book.bookSkuId && String(run.input?.sku) === String(book.bookSkuId) || String(run.input?.title || '').trim().toLowerCase() === String(book.title || '').trim().toLowerCase()) && ['queued', 'running'].includes(run.state));
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

function catalogVisibleBooks() {
  return state.leaderboard.filter((book) => {
    const { length, genre } = state.catalogFilters;
    const lengthMatches = length === 'all' || (length === 'short' ? bookIsShort(book) : !bookIsShort(book));
    return lengthMatches && (genre === 'all' || bookGenre(book) === genre);
  });
}

function renderBatchBookBar() {
  const bar = $('#batchBookBar');
  const count = state.selectedBooks.size;
  bar.hidden = count === 0;
  $('#batchBookCount').textContent = `已选 ${count} 本`;
}

function todayScore(books) {
  const max = (key) => Math.max(1, ...books.map((book) => Number(book[key] || 0)));
  const uv = max('baseReadUnt'); const first = max('firstReadUntRate'); const retention = max('read20wRate');
  return books.map((book) => ({ ...book, todayScore: Math.round((Number(book.baseReadUnt || 0) / uv * 45 + Number(book.firstReadUntRate || 0) / first * 30 + Number(book.read20wRate || book.read10wRate || 0) / retention * 25) * 10) / 10 })).sort((a, b) => b.todayScore - a.todayScore);
}

function renderTodayRail() {
  const list = $('#todayRailList');
  if (!list) return;
  if (state.todayBooksLoading) { list.innerHTML = `<div class="today-skeleton"><i data-lucide="loader-circle"></i><span>正在读取近 7 天真实表现</span></div>${Array.from({ length: 3 }, () => '<div class="today-skeleton-card"><span></span><div><b></b><b></b><i></i><i></i></div></div>').join('')}`; return; }
  const books = state.todayBooks || [];
  if (!books.length) { list.innerHTML = '<div class="today-loading"><i data-lucide="sparkles"></i><span>今日推荐准备中</span></div>'; return; }
  list.innerHTML = books.slice(0, 12).map((book, index) => `<article class="today-card"><div class="today-cover">${leaderboardCover(book)}</div><div class="today-card-copy"><span>今日 #${index + 1} · 综合 ${book.todayScore}</span><h3>${escapeHtml(book.title)}</h3><p>${escapeHtml(bookGenre(book) === 'other' ? book.category || 'Romance' : bookGenre(book))} · UV ${compactNumber(book.baseReadUnt)}</p><div><b>首读 ${percentage(book.firstReadUntRate)}</b><b>长读 ${percentage(book.read20wRate || book.read10wRate)}</b></div></div><button class="today-plan" data-today-book="${index}" type="button"><i data-lucide="brain-circuit"></i>策划</button></article>`).join('');
  list.querySelectorAll('[data-today-book]').forEach((button) => button.addEventListener('click', () => { const book = books[Number(button.dataset.todayBook)]; if (book) openCreativePlanDialog(book); }));
}

async function loadTodayRail() {
  state.todayBooksLoading = true; renderTodayRail(); icons();
  try {
    const body = await api('/api/leaderboard?source=catalog&days=7&sort=baseReadUnt&line=novelflow&language=EN&complete=%E5%B7%B2%E5%AE%8C%E7%BB%93&status=%E4%B8%8A%E6%9E%B6&isShort=all', { timeoutMs: 50000 });
    state.todayBooks = todayScore((body.books || []).filter((book) => !activeRunFor(book))).slice(0, 12);
    const missing = state.todayBooks.filter((book) => !book.cover).slice(0, 12);
    if (missing.length) {
      api('/api/book-covers', { method: 'POST', body: JSON.stringify({ books: missing.map((book) => ({ sku: book.bookSkuId, title: book.title })) }), timeoutMs: 55000 }).then((coverBody) => {
        const covers = coverBody.covers || {};
        state.todayBooks = state.todayBooks.map((book) => covers[String(book.bookSkuId)] ? { ...book, cover: covers[String(book.bookSkuId)] } : book);
        renderTodayRail(); icons();
      }).catch(() => {});
    }
  } catch { state.todayBooks = []; }
  finally { state.todayBooksLoading = false; renderTodayRail(); icons(); }
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
  empty.hidden = state.leaderboard.length > 0;
  const catalog = state.leaderboardSource === 'catalog';
  $('#leaderboardEyebrow').textContent = catalog ? 'CONTENT DASHBOARD' : 'PROMOTION REVIEW';
  $('#leaderboardTitle').textContent = catalog ? '新推广表现选书' : '投放复盘 / 复投候选';
  $('#leaderboardDescription').textContent = catalog
    ? '来自中台数据看板：novelflow、英语、已完结、上架。短篇/常规长篇直接对应后台“是否短篇=是/否”；按近 7/30/90 天窗口和真实业务指标排序。'
    : '按历史归因表现复盘，仅供查看与复投判断，不混入新推广书池。';
  $('#windowControl').hidden = catalog;
  $('#catalogWindowControl').hidden = !catalog;
  $('#catalogSort').hidden = !catalog;
  $('#catalogFilters').hidden = !catalog;
  if (state.leaderboardLoading) {
    renderLeaderboardPager(0, 0);
    empty.hidden = true;
    grid.innerHTML = '<div class="leaderboard-loading"><i data-lucide="loader-circle"></i><strong>正在刷新中台排行</strong><span>正在校验书籍与可自动创建状态</span></div>';
    $('#leaderboardUpdated').textContent = '正在加载真实表现数据';
    return;
  }
  if (catalog) {
    const sortLabel = catalogSortLabels[state.catalogSort] || '阅读 UV';
    const visibleBooks = catalogVisibleBooks();
    const totalPages = Math.max(1, Math.ceil(visibleBooks.length / 50));
    state.leaderboardPage = Math.min(Math.max(1, state.leaderboardPage), totalPages);
    const startIndex = (state.leaderboardPage - 1) * 50;
    const displayedBooks = visibleBooks.slice(startIndex, startIndex + 50);
    grid.innerHTML = displayedBooks.map((book) => {
      const index = state.leaderboard.indexOf(book);
      const active = activeRunFor(book);
      const ready = book.automationReady !== false;
      const metric = state.catalogSort === 'ttProfit'
        ? `$${Number(book.ttProfit || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
        : state.catalogSort === 'baseReadUnt'
          ? compactNumber(book.baseReadUnt)
          : percentage(book[state.catalogSort]);
      return `<article class="leaderboard-card ${active ? 'in-progress' : ''}">
        <span class="rank">#${book.rank}</span><label class="select-book" title="加入批量选择"><input type="checkbox" data-select-sku="${escapeHtml(book.bookSkuId)}" ${state.selectedBooks.has(String(book.bookSkuId)) ? 'checked' : ''}><span></span></label>
        <div class="leaderboard-cover">${leaderboardCover(book)}</div>
        <div class="leaderboard-copy"><h2>${escapeHtml(book.title)}</h2><p>阅读 ${compactNumber(book.baseReadUnt)} UV · 首读 ${percentage(book.firstReadUntRate)}</p><div class="book-tags"><span>10w 留存 ${percentage(book.read10wRate)}</span><span>20w 留存 ${percentage(book.read20wRate)}</span></div></div>
        <div class="leaderboard-metrics"><span>${escapeHtml(sortLabel)}</span><strong>${metric}</strong><small>${escapeHtml(book.productLine || 'astranovel')}</small></div>
        <div class="book-commands">${!active ? `<button class="plan-book" data-index="${index}" ${!ready ? 'disabled' : ''}><i data-lucide="brain-circuit"></i><span>智能策划</span></button>` : ''}<button class="start-book ${active ? 'resume' : ''}" data-index="${index}" ${!ready || state.startingSku === String(book.title) ? 'disabled' : ''}>${!ready ? '暂不可用' : state.startingSku === String(book.title) ? '正在校验' : active ? '查看任务' : '智能一键生成'}<i data-lucide="${!ready ? 'circle-off' : active ? 'arrow-right' : 'zap'}"></i></button></div>
      </article>`;
    }).join('');
    const window = state.leaderboardWindow;
    $('#leaderboardUpdated').textContent = window?.throughDate ? `${window.startDate} 至 ${window.throughDate} · ${sortLabel} · Top ${visibleBooks.length}` : '正在加载中台业务数据';
    renderLeaderboardPager(displayedBooks.length, visibleBooks.length, totalPages);
    document.querySelectorAll('.start-book').forEach((button) => button.addEventListener('click', () => {
      const book = state.leaderboard[Number(button.dataset.index)];
      if (book) startProduction(book);
    }));
    document.querySelectorAll('.plan-book').forEach((button) => button.addEventListener('click', () => {
      const book = state.leaderboard[Number(button.dataset.index)];
      if (book) openCreativePlanDialog(book);
    }));
    document.querySelectorAll('[data-select-sku]').forEach((input) => input.addEventListener('change', () => {
      const sku = String(input.dataset.selectSku);
      if (input.checked) state.selectedBooks.add(sku); else state.selectedBooks.delete(sku);
      renderBatchBookBar();
    }));
    renderBatchBookBar();
    return;
  }
  renderLeaderboardPager(0, 0);
  if (catalog) {
    grid.innerHTML = state.leaderboard.map((book, index) => {
      const active = activeRunFor(book);
      const ready = book.automationReady !== false;
      return `<article class="leaderboard-card ${active ? 'in-progress' : ''}">
        <span class="rank">#${book.rank}</span>
        <div class="leaderboard-cover">${leaderboardCover(book)}</div>
        <div class="leaderboard-copy"><h2>${escapeHtml(book.title)}</h2><p>书库排序 · ${escapeHtml(book.category || 'English fiction')}</p><div class="book-tags"><span>在架可推广</span><span>SKU ${escapeHtml(book.bookSkuId || '—')}</span></div></div>
        <div class="leaderboard-metrics"><span>书库排名</span><strong>#${book.rank}</strong><small>${escapeHtml(book.category || 'English fiction')}</small></div>
        <button class="start-book ${active ? 'resume' : ''}" data-index="${index}" ${!ready || state.startingSku === String(book.title) ? 'disabled' : ''}>${!ready ? '暂不可用' : state.startingSku === String(book.title) ? '正在校验' : active ? '查看任务' : '智能一键生成'}<i data-lucide="${!ready ? 'circle-off' : active ? 'arrow-right' : 'zap'}"></i></button>
      </article>`;
    }).join('');
    const window = state.leaderboardWindow;
    $('#leaderboardUpdated').textContent = window?.throughDate ? `书库数据截至 ${window.throughDate}` : '正在加载书库排行';
    document.querySelectorAll('.start-book').forEach((button) => button.addEventListener('click', () => {
      const book = state.leaderboard[Number(button.dataset.index)];
      if (book) startProduction(book);
    }));
    return;
  }
  grid.innerHTML = state.leaderboard.map((book, index) => {
    const active = activeRunFor(book);
    const ready = book.automationReady !== false;
    return `<article class="leaderboard-card ${active ? 'in-progress' : ''}">
      <span class="rank">#${book.rank}</span>
      <div class="leaderboard-cover">${leaderboardCover(book)}</div>
      <div class="leaderboard-copy"><h2>${escapeHtml(book.title)}</h2><p>样本 ${compactNumber(book.pullUv)} UV · ${book.assetCount} 个素材</p><div class="book-tags"><span>首读/新增 ${percentage(book.firstReadRate)}</span><span>D14 $${Number(book.d14Income || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></div></div>
      <div class="leaderboard-metrics"><span>综合评分</span><strong>${Number(book.score || 0).toFixed(1)}</strong><small>置信度 ${book.confidence}%</small></div>
      <button class="start-book ${active ? 'resume' : ''}" data-index="${index}" ${!ready || state.startingSku === String(book.title) ? 'disabled' : ''}>${!ready ? '书库已下架' : state.startingSku === String(book.title) ? '正在校验' : active ? '查看任务' : '智能一键生成'}<i data-lucide="${!ready ? 'circle-off' : active ? 'arrow-right' : 'zap'}"></i></button>
    </article>`;
  }).join('');
  grid.querySelectorAll('.start-book').forEach((button) => {
    button.outerHTML = '<span class="history-only"><i data-lucide="chart-no-axes-combined"></i>Review data</span>';
  });
  const window = state.leaderboardWindow;
  $('#leaderboardUpdated').textContent = window?.throughDate ? `数据截至 ${window.throughDate} · 近 ${window.days} 天` : '正在加载历史表现数据';
  document.querySelectorAll('.start-book').forEach((button) => button.addEventListener('click', () => {
    const book = state.leaderboard[Number(button.dataset.index)];
    if (book) startProduction(book);
  }));
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
    if (state.view === 'attention' && !['failed', 'blocked'].includes(run.state)) return false;
    if (state.view === 'operations' && false) return false;
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

function currentStage(run) {
  return pipelineOrder.map((key) => [key, run.stages?.[key] || {}]).find(([, value]) => !['done', 'waiting'].includes(value.status)) || pipelineOrder.map((key) => [key, run.stages?.[key] || {}]).find(([, value]) => value.status === 'waiting') || ['P6', { label: '全部完成' }];
}

function cover(run) {
  const url = run.artifacts?.book?.cover;
  return url ? `<img class="book-cover" src="${escapeHtml(url)}" alt="">` : `<div class="book-cover fallback">${escapeHtml(String(run.input?.title || 'N').slice(0, 1))}</div>`;
}

function renderRunList() {
  if (state.view === 'library') return renderAssetLibrary();
  const runs = filteredRuns();
  $('#runListHead').hidden = false;
  $('#runList').className = `run-list ${state.density}`;
  $('#emptyRuns').hidden = runs.length > 0;
  $('#runList').innerHTML = runs.map((run) => {
    const active = currentStage(run);
    const stages = Object.values(run.stages || {});
    return `<article class="run-row ${run.id === state.selectedId ? 'selected' : ''}" data-id="${escapeHtml(run.id)}">
      <div class="book-cell">${cover(run)}<div><div class="book-name">${escapeHtml(run.input?.title)}</div><div class="book-meta">SKU ${escapeHtml(run.input?.sku)} · ${escapeHtml(new Date(run.createdAt).toLocaleDateString('zh-CN'))}</div></div></div>
      <div class="stage-meter"><div class="stage-track">${stages.map((item) => `<i class="stage-segment ${stageClass(item)}"></i>`).join('')}</div><div class="stage-label">${escapeHtml(stageLabels[active[0]] || active[0])} · ${stages.filter((item) => item.status === 'done').length}/7</div></div>
      <div class="tracking-cell"><strong>${run.artifacts?.code ? `Code ${escapeHtml(run.artifacts.code)}` : '待分配'}</strong><span>${escapeHtml(run.artifacts?.shortUrl || '短链待创建')}</span></div>
      <div><span class="status-badge ${escapeHtml(run.state)}">${escapeHtml(labels[run.state] || run.state)}</span></div>
    </article>`;
  }).join('');
  document.querySelectorAll('.run-row').forEach((row) => row.addEventListener('click', () => openDetail(row.dataset.id)));
}

function copyAssetText(value, message) {
  if (!value) return;
  navigator.clipboard?.writeText(value).then(() => showToast(message)).catch(() => showToast('浏览器未允许复制，请从详情页复制', 'error'));
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
  $('#runListHead').hidden = true;
  list.className = 'asset-library';
  $('#emptyRuns').hidden = true;
  list.innerHTML = runs.length ? runs.map((run) => {
    const assets = assetSummary(run);
    const posters = (run.artifacts?.images || []).filter((item) => item?.status === 'success' && item?.url).slice(0, 2);
    const videoUrl = run.artifacts?.video?.videoUrls?.[0] || '';
    const coverUrl = run.artifacts?.book?.cover;
    const posterPreview = posters.length ? `<div class="asset-gallery">${posters.map((item) => `<img src="${escapeHtml(`/api/media?url=${encodeURIComponent(item.url)}`)}" loading="lazy" decoding="async" alt="${escapeHtml(run.input?.title)} 海报">`).join('')}</div>` : '';
    const coverPreview = coverUrl ? `<img class="asset-cover-preview" src="${escapeHtml(coverUrl)}" loading="lazy" decoding="async" alt="${escapeHtml(run.input?.title)} 封面">` : '';
    const preview = `${posterPreview || coverPreview || '<div class="asset-empty">素材准备中</div>'}${videoUrl ? '<span class="asset-video-indicator"><i data-lucide="play"></i>视频可播放</span>' : ''}`;
    return `<article class="asset-card" data-asset-run="${escapeHtml(run.id)}">
      <header class="asset-card-head">${coverUrl ? `<img src="${escapeHtml(coverUrl)}" alt="">` : `<div class="asset-cover">${escapeHtml(String(run.input?.title || 'N').slice(0, 1))}</div>`}<div><h2>${escapeHtml(run.input?.title || '')}</h2><p>${run.artifacts?.code ? `Code ${escapeHtml(run.artifacts.code)}` : '未生成推广 Code'} ${run.artifacts?.shortUrl ? '· 短链已验证' : ''}</p></div><button class="icon-button asset-open" data-open-asset="${escapeHtml(run.id)}" title="打开完整任务"><i data-lucide="arrow-up-right"></i></button></header>
      <div class="asset-preview">${preview}</div>
      <div class="asset-remove-actions">${assets.posts ? `<button data-remove-library="copy" data-run-id="${escapeHtml(run.id)}"><i data-lucide="trash-2"></i>删除文案</button>` : ''}${run.artifacts?.video ? `<button data-remove-library="video" data-run-id="${escapeHtml(run.id)}"><i data-lucide="trash-2"></i>删除视频</button>` : ''}${(run.artifacts?.images || []).length ? `<button data-remove-library="posters" data-run-id="${escapeHtml(run.id)}"><i data-lucide="trash-2"></i>删除海报</button>` : ''}</div>
      <div class="asset-counts"><span>${assets.posts} 条文案</span><span>${assets.posters} 张海报</span><span>${assets.video ? '视频可播放' : '视频未就绪'}</span><span>${assets.tracking ? '追踪已验证' : '追踪未完成'}</span></div>
      <div class="asset-actions"><button data-copy-post="${escapeHtml(run.id)}" ${assets.posts ? '' : 'disabled'}><i data-lucide="copy"></i>文案</button><button data-copy-link="${escapeHtml(run.id)}" ${run.artifacts?.shortUrl ? '' : 'disabled'}><i data-lucide="link"></i>链接</button><button data-preview-media="${escapeHtml(run.id)}" ${videoUrl || posters[0]?.url ? '' : 'disabled'}><i data-lucide="play"></i>预览</button></div>
    </article>`;
  }).join('') : '<div class="asset-library-empty"><i data-lucide="library-big"></i><strong>还没有可直接使用的素材</strong><span>文案、视频、海报或已验证追踪完成后会自动出现在这里。</span></div>';
  list.querySelectorAll('[data-open-asset]').forEach((button) => button.addEventListener('click', () => openDetail(button.dataset.openAsset)));
  list.querySelectorAll('[data-copy-post]').forEach((button) => button.addEventListener('click', () => {
    const run = state.runs.find((item) => item.id === button.dataset.copyPost);
    copyAssetText((run?.artifacts?.posts || []).map((item) => item.content).join('\n\n---\n\n'), '成品文案已复制');
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
}

function renderStats() {
  const active = state.runs.filter((run) => ['queued', 'running'].includes(run.state)).length;
  const complete = state.runs.filter((run) => run.state === 'completed').length;
  const attention = state.runs.filter((run) => ['failed', 'blocked'].includes(run.state)).length;
  $('#runningRuns').textContent = active;
  $('#readyAssets').textContent = state.runs.reduce((sum, run) => { const assets = assetSummary(run); return sum + assets.posts + assets.posters + assets.video; }, 0);
  $('#attentionRuns').textContent = attention;
  renderModelMix();
  const viewText = { operations: '所有小说的素材、进度与归因表现', library: '按书籍快速取用已完成的文案、视频、海报与追踪链接', completed: '已完成的生产任务与可复用资产', attention: '需要确认、重试或核验的任务' };
  $('#viewSubtitle').textContent = viewText[state.view] || viewText.operations;
}

function renderFocusRun() {
  const section = $('#focusRun');
  const content = $('#focusRunContent');
  if (!section || !content) return;
  const run = state.runs.find((item) => item.id === state.selectedId) || state.runs[0];
  section.hidden = !run;
  if (!run) return;
  const completed = Object.values(run.stages || {}).filter((stage) => stage.status === 'done').length;
  const videoReady = Boolean(run.artifacts?.video?.videoUrls?.[0]);
  const posterCount = (run.artifacts?.images || []).filter((item) => item.url).length;
  const copyCount = (run.artifacts?.posts || []).length;
  const shortUrl = run.artifacts?.shortUrl;
  content.innerHTML = `<article class="focus-card">
    <div class="focus-book">${cover(run)}<div><div class="focus-title-row"><h2>${escapeHtml(run.input?.title)}</h2><span class="status-badge ${escapeHtml(run.state)}">${escapeHtml(labels[run.state] || run.state)}</span></div><p>SKU ${escapeHtml(run.input?.sku)} · ${completed}/7 个节点完成</p><div class="focus-tracking"><span>Code <strong>${escapeHtml(run.artifacts?.code || '待分配')}</strong></span>${shortUrl ? `<a href="${escapeHtml(shortUrl)}" target="_blank" rel="noopener">打开短链 <i data-lucide="external-link"></i></a>` : '<span>短链待创建</span>'}</div></div></div>
    <div class="focus-flow">${pipelineOrder.map((key) => `<button class="focus-step ${stageClass(run.stages?.[key])}" data-node-decision="${key}" title="查看${escapeHtml(stageLabels[key])}的决策说明"><i data-lucide="${stageIcons[key]}"></i><span>${escapeHtml(stageLabels[key])}</span></button>`).join('')}</div>
    <div class="focus-assets"><button data-detail-target="copy"><i data-lucide="message-square-text"></i><strong>${copyCount}</strong><span>成品文案</span></button><button data-detail-target="video" class="${videoReady ? 'ready' : ''}"><i data-lucide="video"></i><strong>${videoReady ? '已就绪' : '等待中'}</strong><span>视频</span></button><button data-detail-target="posters" class="${posterCount === 2 ? 'ready' : ''}"><i data-lucide="images"></i><strong>${posterCount}/2</strong><span>海报</span></button><button data-detail-target="review" class="${run.artifacts?.review ? 'ready' : ''}"><i data-lucide="badge-check"></i><strong>${run.artifacts?.review ? '已就绪' : '等待中'}</strong><span>审核包</span></button></div>
  </article>`;
  $('#openFocusRun').onclick = () => openDetail(run.id);
  document.querySelectorAll('[data-detail-target]').forEach((button) => button.addEventListener('click', () => openDetail(run.id, button.dataset.detailTarget)));
  document.querySelectorAll('[data-node-decision]').forEach((button) => button.addEventListener('click', () => openNodeDecision(run.id, button.dataset.nodeDecision)));
}

function pipelineNode(run, key) {
  const stage = run.stages?.[key] || { status: 'waiting' };
  const artifact = { P1: run.artifacts?.book?.bookSkuId, P2: run.artifacts?.evidence?.completed ? `${run.artifacts.evidence.completed} 章` : '', P5: run.artifacts?.code ? `Code ${run.artifacts.code}` : '', P3: run.artifacts?.posts?.length ? `${run.artifacts.posts.length} 套文案` : '', P4: run.artifacts?.video?.videoUrls?.[0] ? '可播放' : run.artifacts?.video?.threadId ? '生成中' : '', P3_5: run.artifacts?.images?.length ? `${run.artifacts.images.filter((item) => item.url).length}/2 海报` : '', P6: run.artifacts?.review ? '审核包就绪' : '' }[key] || stage.label || stage.status;
  const stageStatus = stage.status === 'done' ? '已完成' : stage.status === 'waiting' ? '等待中' : stage.status === 'ambiguous' ? '需人工核验' : stage.status === 'partial' ? '部分完成' : '进行中';
  return `<button type="button" class="flow-node ${stageClass(stage)}" data-node-decision="${key}" title="查看${escapeHtml(stageLabels[key] || key)}的决策说明"><span class="flow-node-top"><i data-lucide="${stageIcons[key] || 'circle'}"></i><span>${escapeHtml(stageLabels[key] || key)}</span></span><strong>${escapeHtml(artifact)}</strong><small>${escapeHtml(stageStatus)}</small></button>`;
}

function nodeDecision(run, node) {
  const stage = run.stages?.[node] || {};
  const evidence = run.artifacts?.evidence;
  const selectedModel = modelLabel(run.input?.creativeProfile?.modelChoice);
  const planning = run.input?.planning || {};
  const strategy = planning.strategy || {};
  const strategyEvidence = Array.isArray(strategy.evidence) ? strategy.evidence : [];
  const rationale = Object.values(strategy.rationale || {}).map(String).filter(Boolean).join('；');
  const planningTime = planning.completedAt ? new Date(planning.completedAt).toLocaleString('zh-CN', { hour12: false }) : '';
  const decisions = {
    P1: { timing: '生成前', title: '书籍身份核验', conclusion: run.artifacts?.book ? `已锁定 SKU ${run.artifacts.book.bookSkuId}，后续资产只会绑定这一条书籍记录。` : '等待精确书名与 SKU 核验。', why: '避免同名书、历史下架书或错误 SKU 进入推广链路。', basis: run.artifacts?.book?.title || 'Bookstore exact lookup' },
    P2: { timing: '生成前', title: '章节证据锁定', conclusion: evidence?.completed ? `已锁定 ${evidence.completed}/${evidence.requested} 个章节证据，覆盖开篇与后段升级。` : '等待下载章节证据。', why: '素材只能使用已锁定章节事实，避免生成后再倒推依据。', basis: evidence?.chapters?.map((item) => `Ch.${item.order}`).join(' / ') || '章节证据尚未就绪' },
    P5: { timing: '生成前', title: '追踪 Code 与短链', conclusion: run.artifacts?.shortUrl ? `Code ${run.artifacts.code} 与短链已在创意生成前完成验证。` : '等待后台自动分配并远端验证。', why: '先确保归因可用，再把已验证短链写入文案。', basis: run.artifacts?.shortUrl || 'Promotion code and link verification' },
    P3: strategy.editorialThesis ? { timing: '生成前', title: '事前创意策划', conclusion: strategy.editorialThesis, why: rationale || '该方向在任何成品文案、视频或海报生成之前，由章节样本确定并固化。', basis: `${modelLabel(planning.actualModel)} · ${planningTime || '生成前已固化'}${strategyEvidence.length ? ` · ${strategyEvidence.map((item) => `Ch.${item.chapter}`).join(' / ')}` : ''}` } : { timing: '生成前', title: '生产时创意约束', conclusion: `${selectedModel} 将根据已锁定章节证据生成文案、视频叙事和海报提示词。`, why: '此任务未经过独立智能策划入口，因此这里只展示生成前已有的人工选项，不引用成品结果。', basis: `${selectedModel} · ${evidence?.chapters?.map((item) => `Ch.${item.order}`).join(' / ') || '等待章节证据'}` },
    P4: { timing: '执行记录', title: '视频生成执行', conclusion: run.artifacts?.video?.threadId ? `AC 任务 ${run.artifacts.video.threadId} 已提交或正在回传。` : '视频将采用已验证章节的五拍叙事。', why: run.artifacts?.videoPrompt?.reversal || '在 8-11 秒给出原文支持的反转，结尾保留未解问题。', basis: (run.artifacts?.videoPrompt?.evidenceChapters || []).map((item) => `Ch.${item}`).join(' / ') || '等待视频提示词' },
    P3_5: { timing: '执行记录', title: '海报生成执行', conclusion: run.artifacts?.images?.length ? `${run.artifacts.images.filter((item) => item.url).length}/${run.artifacts.images.length} 张海报已回传。` : '两套视觉将分别覆盖电影感与编辑爱情感。', why: '每张图聚焦一个有章节依据的决定性瞬间。', basis: (run.artifacts?.posterPrompts || []).map((item) => item.variant).join(' / ') || '等待海报提示词' },
    P6: { timing: '生成后', title: '审核与归因包', conclusion: run.artifacts?.review ? '审核包已就绪，Facebook 保持手动发布。' : '等待素材汇总与归因数据查询。', why: '这是生成完成后的汇总审核，不代表事前创意决策。', basis: run.artifacts?.analytics?.summary?.pullUv != null ? `当前拉起 UV ${run.artifacts.analytics.summary.pullUv}` : 'Facebook automatic publishing disabled' }
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
  return `<div class="flow-main">${pipelineNode(run, 'P1')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P2')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P5')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P3')}</div><div class="flow-branch"><div>${pipelineNode(run, 'P4')}</div><div>${pipelineNode(run, 'P3_5')}</div></div><div class="flow-final"><i data-lucide="git-merge"></i>${pipelineNode(run, 'P6')}</div>`;
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
  return posts.map((post) => `<article class="copy-output"><span class="copy-type">${escapeHtml(post.type)}</span><div class="copy-paragraphs">${paragraphs(post.content)}</div>${post.zhContent ? `<div class="copy-paragraphs translation">${paragraphs(post.zhContent)}</div>` : ''}</article>`).join('');
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
    ${draft?.status === 'ready_for_review' ? `<aside class="video-rewrite-review"><header><div><span>待核对视频提示词</span><strong>${escapeHtml(modelLabel(draft.model))} 已基于原文证据重写</strong></div><span>未提交视频</span></header><div class="story-beats">${[['钩子 0-2s', draft.hook, draft.zhHook], ['价值 2-5s', draft.valuePromise, draft.zhValuePromise], ['升级 5-8s', draft.escalation, draft.zhEscalation], ['反转 8-11s', draft.reversal, draft.zhReversal], ['悬念 11-15s', draft.cliffhanger, draft.zhCliffhanger]].map(([label, value, zh]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${zh ? `<small>${escapeHtml(zh)}</small>` : ''}</article>`).join('')}</div><div class="prompt-block"><strong>新旁白与镜头执行</strong><pre>${escapeHtml(draft.adCopy)}\n\n${escapeHtml(draft.buildRequirement)}</pre></div><footer><button class="secondary-command" data-video-prompt-action="discard" type="button">保留原提示词</button><button class="primary-command" data-video-prompt-action="approve" type="button">核对无误，采用新提示词</button></footer></aside>` : ''}
    ${posters.map((item) => `<div class="prompt-block"><strong>${escapeHtml(item.variant)}${item.repairCount ? ` · DeepSeek 审核修复 ${escapeHtml(item.repairCount)}/1` : ''}</strong><pre>${escapeHtml(item.prompt)}</pre>${item.zhPrompt ? `<p class="translation">${escapeHtml(item.zhPrompt)}</p>` : ''}</div>`).join('')}
  </section>`;
}

function videoHtml(run) {
  const original = run.artifacts?.video;
  const reference = run.artifacts?.referenceVideo;
  const revision = run.artifacts?.videoRevision;
  const asset = (video, title, referenceVersion = false) => {
    const url = video?.videoUrls?.[0];
    if (url) return `<article class="video-asset"><div class="video-asset-head"><strong>${escapeHtml(title)}</strong>${referenceVersion ? '<span>额外版本</span>' : ''}</div><div class="video-shell"><video ${referenceVersion ? '' : 'id="resultVideo"'} controls preload="metadata" playsinline poster="${escapeHtml(video.coverImageUrl || '')}"><source src="${escapeHtml(url)}"></video></div></article>`;
    const label = video?.status === 'running' || video?.status === 'submitting' ? '视频正在生成，后台会持续反馈进度' : video?.status === 'failed' ? `生成失败：${video.error || '请检查任务'}` : '等待提交';
    return `<article class="video-asset"><div class="video-asset-head"><strong>${escapeHtml(title)}</strong>${referenceVersion ? '<span>额外版本</span>' : ''}</div><div class="media-placeholder">${escapeHtml(label)}</div></article>`;
  };
  const referencePosters = (run.artifacts?.images || []).filter((item) => ['luminous_cinema', 'editorial_romance'].includes(item.variant) && item.url);
  const selectedReferencePoster = state.referencePosterChoice[run.id] || referencePosters[0]?.variant || '';
  const canCreateReference = Boolean(referencePosters.length && !reference);
  const canRewrite = Boolean(run.artifacts?.videoPrompt && run.artifacts?.evidence?.chapters?.length);
  const canSubmitRevision = run.artifacts?.videoPromptDraft?.status === 'approved' && !revision;
  const assets = [asset(original, '原始成片')];
  if (revision) assets.push(asset(revision, '重写提示词版', true));
  if (reference) assets.push(asset(reference, '参考海报版', true));
  const posterPicker = canCreateReference ? `<div class="reference-poster-picker"><div><strong>选择参考海报</strong><span>可选海报 1 或海报 2，提交前会再次确认</span></div><div class="reference-poster-options">${referencePosters.map((poster) => `<button type="button" class="reference-poster-option ${selectedReferencePoster === poster.variant ? 'selected' : ''}" data-reference-poster="${escapeHtml(poster.variant)}"><img src="${escapeHtml(`/api/media?url=${encodeURIComponent(poster.url)}`)}" alt="${escapeHtml(poster.variant)}"><span><i data-lucide="${selectedReferencePoster === poster.variant ? 'circle-dot' : 'circle'}"></i>海报 ${poster.variant === 'luminous_cinema' ? '1' : '2'}</span></button>`).join('')}</div><button id="createReferenceVideo" class="secondary-command reference-video-command" data-poster-variant="${escapeHtml(selectedReferencePoster)}"><i data-lucide="clapperboard"></i><span>用选中的海报制作 AC 视频</span></button></div>` : '';
  return `<div class="video-assets">${assets.join('')}</div><div class="video-rework-actions">${canRewrite ? '<button id="rewriteVideoPrompt" class="secondary-command"><i data-lucide="sparkles"></i><span>重写视频提示词</span></button>' : ''}${canSubmitRevision ? '<button id="createVideoRevision" class="primary-command"><i data-lucide="video"></i><span>用核对后的提示词生成视频</span></button>' : ''}</div>${posterPicker}`;
}

function imagesHtml(run) {
  const images = run.artifacts?.images || [];
  const concepts = run.artifacts?.posterPrompts || [];
  if (!images.length && concepts.length) return `<div class="media-grid">${concepts.map((item) => `<article class="poster-concept"><div><i data-lucide="sparkles"></i><strong>${escapeHtml(item.variant)}</strong><span>视觉概念已就绪，等待图像任务提交</span></div><p>${escapeHtml(item.zhPrompt || item.prompt)}</p></article>`).join('')}</div>`;
  if (!images.length) return '<div class="media-placeholder">两张推广海报将在这里显示</div>';
  return `<div class="media-grid">${images.map((item) => { const mediaUrl = item.url ? `/api/media?url=${encodeURIComponent(item.url)}` : ''; const referenceHint = item.variant === 'luminous_cinema' && item.url ? '<span class="poster-reference-hint"><i data-lucide="clapperboard"></i>可作为 AC 参考视频</span>' : ''; return `<article class="poster-item ${item.url ? 'ready' : ''}">${item.url ? `<button class="open-image-preview" type="button" data-image-url="${escapeHtml(mediaUrl)}" data-image-label="${escapeHtml(item.variant)}"><img src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(item.variant)}"><span class="poster-expand"><i data-lucide="maximize-2"></i> 预览海报</span></button>` : `<div class="poster-live"><i data-lucide="image"></i><strong>${escapeHtml(item.variant)}</strong><span>${escapeHtml(item.status || '等待生成')}${item.progress != null ? ` · ${escapeHtml(item.progress)}%` : ''}</span></div>`}<span>${escapeHtml(item.variant)} · ${escapeHtml(item.status)}</span>${referenceHint}</article>`; }).join('')}</div>`;
}

function openImageViewer(url, label) {
  $('#imageViewerTitle').textContent = label || '推广海报预览';
  $('#imageViewerImage').src = url;
  $('#imageViewerImage').alt = label || '推广海报预览';
  $('#imageViewer').showModal();
}

function analyticsHtml(run) {
  const analytics = run.artifacts?.analytics;
  if (!analytics) return '<div class="media-placeholder">完成后自动查询 Code 与 Link 数据</div>';
  const summary = analytics.summary || {};
  const value = (number) => Number(number || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return `<div class="analytics-grid"><div class="metric"><span>拉起 UV</span><strong>${value(summary.pullUv)}</strong></div><div class="metric"><span>激活 UV</span><strong>${value(summary.activeUv)}</strong></div><div class="metric"><span>激活率</span><strong>${summary.activationRate == null ? '—' : `${value(summary.activationRate)}%`}</strong></div><div class="metric"><span>D7 收入</span><strong>${value(summary.d7Income)}</strong></div></div><ul class="findings">${(analytics.findings || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
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
  const completed = [...(run.artifacts?.modelActivity || []), ...(run.artifacts?.creativeDraft?.usage || [])];
  const failures = Object.entries(run.artifacts?.creativeDraft?.failures || {}).map(([section, item]) => ({ section, ...item, recovering: true }));
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
    return `<article class="model-activity-row ${item.recovering ? 'recovering' : rejected ? 'rejected' : 'ready'}"><span class="model-activity-state"><i data-lucide="${item.recovering ? 'loader-circle' : rejected ? 'triangle-alert' : 'circle-check-big'}"></i></span><div class="model-activity-main"><div><strong>${escapeHtml(creativeSectionNames[item.section] || item.section || '创意')}</strong>${actualBadge}<span>${escapeHtml(item.recovering ? `第 ${item.attempt || 1} 次通道暂缓，${retryText} 后继续` : rejected ? `${actual} 已返回，但证据校验未通过，正在自动重做` : switched ? `${requested} 未及时返回，${actual} 已接管` : `${actual} 已返回`)}</span></div><small>请求 ${requestedBadge} · 实际 ${actualBadge}</small></div><div class="model-activity-metrics">${latency ? `<span>${(latency / 1000).toFixed(1)}s</span>` : ''}${tokens ? `<span>${tokens.toLocaleString('zh-CN')} tokens</span>` : ''}${item.responseId ? `<span title="${escapeHtml(item.responseId)}">ID ${escapeHtml(String(item.responseId).slice(-8))}</span>` : ''}</div></article>`;
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
  if (!run) { panel.innerHTML = `<div class="detail-empty"><i data-lucide="panel-right-open"></i><strong>完整生产链路</strong><span>从历史表现榜选择一本书后，节点会实时显示产物与进度。</span>${idlePipelineHtml()}</div>`; return; }
  if (run._summary) {
    panel.innerHTML = `<div class="detail-empty"><i data-lucide="loader-circle"></i><strong>正在加载完整生产记录</strong><span>${escapeHtml(run.artifacts?.book?.title || run.input?.title || '该任务')} 的文案、原文证据与素材将按需载入。</span></div>`;
    return;
  }
  const fingerprint = `${run.id}:${run.updatedAt}:${run.state}:${state.creativeVariantRunId}`;
  if (state.detailFingerprint === fingerprint) return;
  const oldVideo = $('#resultVideo');
  const playback = oldVideo ? { time: oldVideo.currentTime, paused: oldVideo.paused } : null;
  const active = currentStage(run);
  const selectedModel = modelLabel(run.input?.creativeProfile?.modelChoice);
  const videoLimitBlocked = run.stages?.P4?.blockedReason === 'hourly_video_limit';
  const posterPartial = run.stages?.P3_5?.status === 'partial';
  const variantPending = state.creativeVariantRunId === run.id;
  const retryLabel = posterPartial ? '单独重试失败海报' : videoLimitBlocked ? `下小时重试视频${run.stages.P4.nextWindow ? `（当前额度至 ${run.stages.P4.nextWindow}）` : ''}` : '重试失败节点';
  const canRetry = run.state === 'failed' || videoLimitBlocked || posterPartial;
  panel.innerHTML = `<header class="detail-header"><div class="detail-title-row"><div class="detail-title"><h2>${escapeHtml(run.input?.title)}</h2><p>SKU ${escapeHtml(run.input?.sku)} · Run ${escapeHtml(run.id.slice(-10))}</p></div><div class="detail-actions">${canRetry ? `<button id="retryRun" class="secondary-command"><i data-lucide="rotate-ccw"></i><span>${escapeHtml(retryLabel)}</span></button>` : ''}<button id="closeDetail" class="icon-button" title="关闭详情"><i data-lucide="x"></i></button></div></div><nav class="detail-tabs" aria-label="成果模块"><button data-scroll-target="detail-overview">概览</button><button data-scroll-target="detail-decision">事前策划</button><button data-scroll-target="detail-quality">成品质检</button><button data-scroll-target="detail-copy">文案</button><button data-scroll-target="detail-video">视频</button><button data-scroll-target="detail-posters">海报</button><button data-scroll-target="detail-prompts">提示词</button><button data-scroll-target="detail-data">数据</button></nav><div class="tracking-strip"><div><span>Promotion Code</span><strong>${escapeHtml(run.artifacts?.code || '待分配')}</strong></div><div><span>Verified short link</span>${run.artifacts?.shortUrl ? `<a class="tracking-link" href="${escapeHtml(run.artifacts.shortUrl)}" target="_blank" rel="noopener">${escapeHtml(run.artifacts.shortUrl)} <i data-lucide="external-link"></i></a>` : '<strong>待创建</strong>'}</div></div></header>
    <section id="detail-overview" class="pipeline"><div class="section-heading"><div><h3>P1-P6 生产链路</h3><p>书籍核验与证据锁定后，自动完成追踪、创意、视频、海报与审核包。</p></div><span class="status-badge ${escapeHtml(run.state)}">${escapeHtml(labels[run.state] || run.state)}</span></div>${productionModelRouteHtml(run)}<div class="creative-strategy">${creativeProfileHtml(run.input?.creativeProfile || {})}</div><div class="production-flow">${pipelineHtml(run)}</div><div class="current-stage">${escapeHtml(active[1]?.label || labels[run.state] || run.state)}${active[1]?.error ? `：${escapeHtml(active[1].error)}` : ''}</div></section>
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
  const newVideo = $('#resultVideo');
  if (newVideo && playback?.time) newVideo.addEventListener('loadedmetadata', () => { newVideo.currentTime = Math.min(playback.time, newVideo.duration || playback.time); if (!playback.paused) newVideo.play().catch(() => {}); }, { once: true });
  $('#retryRun')?.addEventListener('click', () => retryRun(run.id));
  $('#closeDetail')?.addEventListener('click', closeDetail);
  panel.querySelectorAll('[data-reference-poster]').forEach((button) => button.addEventListener('click', () => {
    state.referencePosterChoice[run.id] = button.dataset.referencePoster;
    state.detailFingerprint = '';
    renderDetail(); icons();
  }));
  $('#createReferenceVideo')?.addEventListener('click', (event) => openConfirmation('reference_video', run.id, { posterVariant: event.currentTarget.dataset.posterVariant }));
  $('#rewriteVideoPrompt')?.addEventListener('click', () => rewriteVideoPrompt(run.id));
  $('#createVideoRevision')?.addEventListener('click', () => openConfirmation('video_revision', run.id));
  panel.querySelectorAll('[data-video-prompt-action]').forEach((button) => button.addEventListener('click', () => decideVideoPrompt(run.id, button.dataset.videoPromptAction)));
  panel.querySelector('.create-variant')?.addEventListener('click', () => openConfirmation('creative', run.id));
  panel.querySelectorAll('.remove-asset').forEach((button) => button.addEventListener('click', () => removeRunAsset(run, button.dataset.removeAsset)));
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
  renderCapabilities(); renderStats(); renderTodayRail(); renderFocusRun(); renderLeaderboard(); renderRunList(); renderDetail(); renderCreativePlanQueue(); renderModelBadges(); icons();
}

async function loadStatus({ silent = false } = {}) {
  try {
    const body = await api('/api/status');
    const existing = new Map(state.runs.map((run) => [run.id, run]));
    state.runs = (body.runs || []).map((summary) => {
      const previous = existing.get(summary.id);
      return previous && !previous._summary && previous.updatedAt === summary.updatedAt ? previous : summary;
    });
    state.capabilities = body.capabilities || {};
    state.videoLimit = body.videoLimit || null;
    if (!state.selectedId || !state.runs.some((run) => run.id === state.selectedId)) state.selectedId = state.runs[0]?.id || '';
    showApp(); render();
    if (state.detailOpen && state.selectedId) hydrateRunDetail(state.selectedId);
  } catch (error) {
    if (!silent) showToast(error.message, 'error');
  }
}

async function loadLeaderboard({ refresh = false, silent = false } = {}) {
  state.leaderboardLoading = true;
  renderLeaderboard(); icons();
  try {
    const days = state.leaderboardSource === 'catalog' ? state.catalogDays : state.windowDays;
    const catalogQuery = state.leaderboardSource === 'catalog'
      ? catalogRequestQuery()
      : '';
    const body = await api(`/api/leaderboard?source=${state.leaderboardSource}&days=${days}${catalogQuery}${refresh ? '&refresh=1' : ''}`);
    state.leaderboard = body.books || [];
    state.leaderboardUpdated = body.generatedAt || '';
    state.leaderboardWindow = body.window || null;
    state.leaderboardMetrics = body.metrics || null;
    state.leaderboardPage = 1;
    renderLeaderboard(); icons();
    loadVisibleCovers();
  } catch (error) {
    state.leaderboard = [];
    renderLeaderboard();
    if (!silent) showToast(error.message, 'error');
  } finally {
    state.leaderboardLoading = false;
    renderLeaderboard(); icons();
  }
}

async function loadVisibleCovers() {
  if (state.leaderboardSource !== 'catalog') return;
  const pageBooks = catalogVisibleBooks().slice((state.leaderboardPage - 1) * 50, state.leaderboardPage * 50).filter((book) => !book.cover && book.bookSkuId && book.title);
  if (!pageBooks.length) return;
  const key = pageBooks.map((book) => book.bookSkuId).join(',');
  if (state.leaderboardCoverKey === key) return;
  state.leaderboardCoverKey = key;
  try {
    const body = await api('/api/book-covers', { method: 'POST', body: JSON.stringify({ books: pageBooks.map((book) => ({ sku: book.bookSkuId, title: book.title })) }), timeoutMs: 55000 });
    const covers = body.covers || {};
    if (!Object.keys(covers).length) return;
    state.leaderboard = state.leaderboard.map((book) => covers[String(book.bookSkuId)] ? { ...book, cover: covers[String(book.bookSkuId)] } : book);
    renderLeaderboard(); icons();
  } catch {
    // Covers are visual enrichment only; rankings and creation remain usable.
  }
}

async function loadCreativePlans({ silent = false } = {}) {
  try {
    const body = await api('/api/creative-plan', { timeoutMs: 10000 });
    state.planJobs = body.jobs || [];
    renderCreativePlanQueue(); icons();
    return body;
  } catch (error) {
    if (!silent) showToast(error.message, 'error');
    return null;
  }
}

function queueCreativePlanJob(job, selectedModel) {
  if (!job) return false;
  state.planJobs = [job, ...state.planJobs.filter((item) => item.id !== job.id)];
  renderCreativePlanQueue(); icons();
  fetch('/api/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: job.id }) }).catch(() => {});
  $('#creativePlanDialog').close();
  showToast(`${selectedModel} 已转入后台策划，可继续操作；完成后在顶部查看方案`);
  return true;
}

async function recoverCreativePlanRequest(requestId, selectedModel) {
  try {
    const body = await api(`/api/creative-plan?requestId=${encodeURIComponent(requestId)}`, { timeoutMs: 15000 });
    return queueCreativePlanJob(body.job, selectedModel);
  } catch { return false; }
}

async function kickWorker() {
  if (state.kicking) return;
  const activePlan = state.planJobs.find((job) => ['queued', 'running'].includes(job.state));
  const active = state.runs.find((run) => ['queued', 'running'].includes(run.state));
  if (!activePlan && !active) { state.longKickKey = ''; return; }
  state.kicking = true;
  try {
    if (!activePlan && active?.stages?.P1?.status === 'done' && active?.stages?.P2?.status === 'done' && active?.stages?.P5?.status === 'done' && active?.stages?.P3?.status !== 'done') {
      const draft = active.artifacts?.creativeDraft || { parts: {}, inFlight: {} };
      const retryReady = (section) => {
        const retryAt = Date.parse(draft.failures?.[section]?.nextAttemptAt || '');
        return !Number.isFinite(retryAt) || retryAt <= Date.now();
      };
      const core = ['posts', 'videoPrompt', 'posterPrompts'].filter((section) => !draft.parts?.[section] && !draft.inFlight?.[section] && retryReady(section));
      const longTask = usesLongBackground(active.input?.creativeProfile?.modelChoice);
      const sections = core.length ? (longTask ? core.slice(0, 1) : core) : (!draft.parts?.qualityReview && !draft.inFlight?.qualityReview && retryReady('qualityReview') && draft.parts?.posts && draft.parts?.videoPrompt && draft.parts?.posterPrompts ? ['qualityReview'] : []);
      if (sections.length) {
        if (longTask) {
          const creativeSection = sections[0];
          fetch('/api/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: active.id, creativeSection }) }).catch(() => {});
          const key = `${active.id}:${creativeSection}`;
          if (state.longKickKey !== key) showToast(`${modelLabel(active.input?.creativeProfile?.modelChoice)} 已转入后台长任务，可继续使用控制台`);
          state.longKickKey = key;
          return;
        }
        await Promise.all(sections.map((creativeSection) => api('/api/worker', { method: 'POST', body: JSON.stringify({ id: active.id, creativeSection }), timeoutMs: 55000 }).catch(() => null)));
        await Promise.all([loadStatus({ silent: true }), loadCreativePlans({ silent: true })]);
        return;
      }
    }
    const longTask = activePlan ? usesLongBackground(activePlan.input?.modelChoice) : usesLongBackground(active?.input?.creativeProfile?.modelChoice);
    if (longTask) {
      fetch('/api/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(activePlan ? { planId: activePlan.id } : { id: active.id }) }).catch(() => {});
      const key = activePlan ? `plan:${activePlan.id}` : `run:${active?.id}`;
      if (state.longKickKey !== key) showToast(`${modelLabel(activePlan?.input?.modelChoice || active?.input?.creativeProfile?.modelChoice)} 已转入后台长任务，可继续使用控制台`);
      state.longKickKey = key;
      return;
    }
    await api('/api/worker', { method: 'POST', body: JSON.stringify(activePlan ? { planId: activePlan.id } : { id: active.id }), timeoutMs: 55000 });
    await Promise.all([loadStatus({ silent: true }), loadCreativePlans({ silent: true })]);
  }
  catch (error) { showToast(error.message, 'error'); }
  finally { state.kicking = false; }
}

async function retryRun(id) {
  try { await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id, action: 'retry' }) }); state.detailFingerprint = ''; await loadStatus(); await kickWorker(); }
  catch (error) { showToast(error.message, 'error'); }
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
    showToast(`${modelLabel(body.run.artifacts?.videoPromptDraft?.model)} 已生成待核对的视频提示词，尚未提交付费视频。`);
  } catch (error) { showToast(error.message, 'error'); }
}

async function decideVideoPrompt(runId, action) {
  try {
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
  const run = state.runs.find((item) => item.id === runId);
  const selectedModel = modelLabel(run?.input?.creativeProfile?.modelChoice);
  const posterNumber = state.confirmation.posterVariant === 'luminous_cinema' ? '1' : '2';
  $('#confirmationTitle').textContent = reference ? `提交海报 ${posterNumber} 参考 AC 视频？` : revision ? '提交重写提示词版 AC 视频？' : `让 ${selectedModel} 再创作一版？`;
  $('#confirmationDescription').textContent = reference
    ? `将使用已完成的海报 ${posterNumber} 作为参考图，额外提交一条付费 AC 视频。原视频不会被替换，并受本小时 5 条上限控制。`
    : revision ? '将使用你刚刚核对并采用的新视频提示词，额外提交一条付费 AC 视频。原视频不会被替换，并受本小时 5 条上限控制。'
    : `${selectedModel} 会基于当前文案、原著证据、Code 和链接，生成明显不同的双语文案、视频脚本与海报提示词。不会自动提交付费视频或图片。`;
  $('#confirmAction').textContent = reference || revision ? '确认提交视频' : '确认生成新创意';
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
  const run = state.runs.find((item) => item.artifacts?.referenceVideo?.status === 'running');
  if (run) {
    try {
      await api('/api/reference-video', { method: 'POST', body: JSON.stringify({ runId: run.id, posterVariant: run.artifacts.referenceVideo.posterVariant }) });
      state.detailFingerprint = '';
      await loadStatus({ silent: true });
    } catch {}
  }
  const revision = state.runs.find((item) => item.artifacts?.videoRevision?.status === 'running');
  if (!revision) return;
  try {
    await api('/api/video-revision', { method: 'POST', body: JSON.stringify({ runId: revision.id }) });
    state.detailFingerprint = ''; await loadStatus({ silent: true });
  } catch {}
}

function openRunDialog() {
  $('#runFormError').textContent = '';
  $('#runDialog').showModal();
  setTimeout(() => $('#manualTitle').focus(), 0);
}

function closeRunDialog() { $('#runDialog').close(); }

async function createProduction({ title, sku = '', source = 'manual', creativeProfile = {}, planning = null }) {
  const body = await api('/api/runs', { method: 'POST', body: JSON.stringify({ title, sku, promoter: 'xujt', paidAuthorized: true, fullBookEvidence: false, source, creativeProfile, planning }) });
  state.selectedId = body.run.id;
  state.detailOpen = true;
  state.detailFingerprint = '';
  state.runs.unshift(body.run);
  render();
  await kickWorker();
  showToast(`已为《${body.run.input.title}》启动智能生产`);
  return body.run;
}

async function startProduction(book) {
  const existing = activeRunFor(book);
  if (existing) {
    openDetail(existing.id);
    return;
  }
  if (state.startingSku) return;
  state.startingSku = String(book.title);
  renderLeaderboard(); icons();
  try {
    await createProduction({ title: book.title, sku: book.bookSkuId || '', source: `catalog_${state.catalogDays}d` });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.startingSku = '';
    renderLeaderboard(); icons();
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#loginError').textContent = '';
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); $('#password').value = ''; await loadStatus(); }
  catch (error) { $('#loginError').textContent = error.message; }
});
$('#togglePassword').addEventListener('click', () => { const input = $('#password'); input.type = input.type === 'password' ? 'text' : 'password'; });
$('#refreshButton').addEventListener('click', () => loadStatus());
$('#videoCapacity').addEventListener('click', () => {
  const video = state.videoLimit || { used: 0, limit: 5, remaining: 5 };
  const reset = new Date(); reset.setMinutes(0, 0, 0); reset.setHours(reset.getHours() + 1);
  showToast(`本小时剩余 ${video.remaining}/${video.limit} 条视频额度，已使用 ${video.used} 条；${reset.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 自动重置。`);
});
function openCatalogRanking() {
  const changed = state.leaderboardSource !== 'catalog';
  state.leaderboardSource = 'catalog';
  document.querySelectorAll('#leaderboardSource button').forEach((button) => button.classList.toggle('active', button.dataset.source === 'catalog'));
  if (changed) loadLeaderboard();
  $('#leaderboardSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
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
$('#createRunButton').addEventListener('click', openRunDialog);
$('#deckCreateRun').addEventListener('click', openRunDialog);
$('#deckCreativePlan').addEventListener('click', () => openCreativePlanDialog());
$('#weeklyReportButton').addEventListener('click', openWeeklyReport);
$('#closeRunDialog').addEventListener('click', closeRunDialog);
$('#closeCreativePlan').addEventListener('click', () => $('#creativePlanDialog').close());
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
$('#deepseekAssistant').addEventListener('click', openAssistant);
$('#closeAssistant').addEventListener('click', () => $('#assistantDialog').close());
document.querySelectorAll('[data-assistant-mode]').forEach((button) => button.addEventListener('click', () => runAssistant(button.dataset.assistantMode)));
$('#copilotForm').addEventListener('submit', (event) => { event.preventDefault(); sendCopilot($('#copilotInput').value); });
$('#modelChoice').addEventListener('change', renderModelBadges);
$('#assistantModelChoice').addEventListener('change', renderModelBadges);
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
  const creativeProfile = creativeProfileForForm();
  const button = $('#submitRun');
  $('#runFormError').textContent = '';
  button.disabled = true;
  try { await createProduction({ title, sku, source: 'manual', creativeProfile }); closeRunDialog(); $('#runForm').reset(); }
  catch (error) { $('#runFormError').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#creativePlanForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.planning) return;
  await analyzeCreativePlan($('#planTitle').value.trim(), $('#planSku').value.trim());
});
$('#detailScrim').addEventListener('click', closeDetail);
['#creativeStyle', '#ctaStyle', '#videoStyle', '#posterStyle'].forEach((selector) => $(selector).addEventListener('change', renderCreativeProfilePreview));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.detailOpen) closeDetail(); });
$('#refreshLeaderboard').addEventListener('click', () => loadLeaderboard({ refresh: true }));
document.querySelectorAll('#windowControl button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#windowControl button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.windowDays = Number(button.dataset.days); loadLeaderboard(); }));
document.querySelectorAll('#catalogWindowControl button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#catalogWindowControl button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.catalogDays = Number(button.dataset.days); loadLeaderboard(); }));
$('#catalogSort').addEventListener('change', (event) => { state.catalogSort = event.target.value; loadLeaderboard(); });
document.querySelectorAll('[data-catalog-filter]').forEach((input) => input.addEventListener('change', (event) => { state.catalogFilters[event.target.dataset.catalogFilter] = event.target.value; loadLeaderboard(); }));
$('#clearBookSelection').addEventListener('click', () => { state.selectedBooks.clear(); renderLeaderboard(); icons(); });
$('#previousBooks').addEventListener('click', () => { if (state.leaderboardPage <= 1) return; state.leaderboardPage -= 1; state.leaderboardCoverKey = ''; renderLeaderboard(); loadVisibleCovers(); $('#leaderboardSection').scrollIntoView({ behavior: 'smooth', block: 'start' }); icons(); });
$('#nextBooks').addEventListener('click', () => { const pages = Math.ceil(catalogVisibleBooks().length / 50); if (state.leaderboardPage >= pages) return; state.leaderboardPage += 1; state.leaderboardCoverKey = ''; renderLeaderboard(); loadVisibleCovers(); $('#leaderboardSection').scrollIntoView({ behavior: 'smooth', block: 'start' }); icons(); });
document.querySelectorAll('#leaderboardSource button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#leaderboardSource button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.leaderboardSource = button.dataset.source; loadLeaderboard(); }));
$('#runSearch').addEventListener('input', (event) => { state.query = event.target.value; renderRunList(); });
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
document.querySelectorAll('#densityControl button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#densityControl button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.density = button.dataset.density; renderRunList(); icons(); }));

renderCreativeProfilePreview();
icons();
loadStatus();
loadCreativePlans({ silent: true });
loadLeaderboard({ silent: true });
loadTodayRail();
setInterval(() => loadStatus({ silent: true }), 6000);
setInterval(() => loadCreativePlans({ silent: true }), 6000);
setInterval(() => loadLeaderboard({ silent: true }), 5 * 60 * 1000);
setInterval(kickWorker, 3500);
setInterval(pollReferenceVideos, 15000);
setInterval(advanceTodayRail, 4200);
