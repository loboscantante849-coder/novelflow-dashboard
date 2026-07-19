const state = { runs: [], capabilities: {}, videoLimit: null, leaderboard: [], leaderboardUpdated: '', leaderboardWindow: null, windowDays: 7, selectedId: '', view: 'operations', density: 'comfortable', query: '', detailFingerprint: '', kicking: false, startingSku: '' };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const labels = { queued: '排队中', running: '生产中', completed: '已完成', failed: '失败', blocked: '已暂停' };
const stageLabels = { P1: '选书', P2: '证据', P3: '创意', P3_5: '海报', P4: '视频', P5: 'Code', P6: '审核' };
const stageIcons = { P1: 'book-open-check', P2: 'library', P3: 'message-square-text', P3_5: 'images', P4: 'video', P5: 'link-2', P6: 'badge-check' };
const pipelineOrder = ['P1', 'P2', 'P5', 'P3', 'P4', 'P3_5', 'P6'];

function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } }); }

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function showLogin() {
  showApp();
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
}

function capabilityName(key) {
  return { storage: '任务存储', pipeline: '书库与短链', llm: 'DeepSeek 创意', video: 'AC 视频', image: '海报生成', report: '归因数据' }[key] || key;
}

function renderCapabilities() {
  $('#capabilities').innerHTML = Object.entries(state.capabilities).map(([key, ok]) => `<div class="cap-row ${ok ? 'ok' : ''}"><span>${escapeHtml(capabilityName(key))}</span><i></i></div>`).join('');
  const allReady = Object.values(state.capabilities).every(Boolean);
  $('#systemState').classList.toggle('online', allReady);
  $('#systemState').innerHTML = `<span class="pulse-dot"></span>${allReady ? '全部服务在线' : '部分服务未连接'}`;
  const video = state.videoLimit || { used: 0, limit: 5, remaining: 5 };
  const capacity = $('#videoCapacity');
  capacity.classList.toggle('at-limit', Number(video.remaining) === 0);
  capacity.innerHTML = `<i data-lucide="video"></i><strong>视频 ${video.used}/${video.limit}</strong><small>本小时</small>`;
}

function showToast(message, kind = '') {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 4600);
}

function compactNumber(value) {
  return Number(value || 0).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

function percentage(value) { return value == null ? '待接入' : `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`; }

function leaderboardCover(book) {
  return book.cover ? `<img src="${escapeHtml(book.cover)}" alt="">` : `<span>${escapeHtml(String(book.title || 'N').slice(0, 1))}</span>`;
}

function activeRunFor(book) {
  return state.runs.find((run) => String(run.input?.title || '').trim().toLowerCase() === String(book.title || '').trim().toLowerCase() && ['queued', 'running'].includes(run.state));
}

function renderLeaderboard() {
  const grid = $('#leaderboard');
  const empty = $('#leaderboardEmpty');
  if (!grid || !empty) return;
  empty.hidden = state.leaderboard.length > 0;
  grid.innerHTML = state.leaderboard.map((book) => {
    const active = activeRunFor(book);
    return `<article class="leaderboard-card ${active ? 'in-progress' : ''}">
      <span class="rank">#${book.rank}</span>
      <div class="leaderboard-cover">${leaderboardCover(book)}</div>
      <div class="leaderboard-copy"><h2>${escapeHtml(book.title)}</h2><p>样本 ${compactNumber(book.pullUv)} UV · ${book.assetCount} 个素材</p><div class="book-tags"><span>首读/新增 ${percentage(book.firstReadRate)}</span><span>D14 $${Number(book.d14Income || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></div></div>
      <div class="leaderboard-metrics"><span>综合评分</span><strong>${Number(book.score || 0).toFixed(1)}</strong><small>置信度 ${book.confidence}%</small></div>
      <button class="start-book ${active ? 'resume' : ''}" data-title="${escapeHtml(book.title)}" ${state.startingSku === String(book.title) ? 'disabled' : ''}>${state.startingSku === String(book.title) ? '正在校验' : active ? '查看任务' : '智能完整生成'}<i data-lucide="${active ? 'arrow-right' : 'zap'}"></i></button>
    </article>`;
  }).join('');
  const window = state.leaderboardWindow;
  $('#leaderboardUpdated').textContent = window?.throughDate ? `数据截至 ${window.throughDate} · 近 ${window.days} 天` : '正在加载历史表现数据';
  document.querySelectorAll('.start-book').forEach((button) => button.addEventListener('click', () => {
    const book = state.leaderboard.find((item) => String(item.title) === button.dataset.title);
    if (book) startProduction(book);
  }));
}

function tokenCount(run) {
  return Object.values(run.artifacts?.usage || {}).reduce((sum, item) => sum + Number(item?.totalTokens || 0), 0);
}

function filteredRuns() {
  const query = state.query.toLowerCase();
  return state.runs.filter((run) => {
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
  const runs = filteredRuns();
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
  document.querySelectorAll('.run-row').forEach((row) => row.addEventListener('click', () => { state.selectedId = row.dataset.id; state.detailFingerprint = ''; render(); }));
}

function renderStats() {
  const active = state.runs.filter((run) => ['queued', 'running'].includes(run.state)).length;
  const complete = state.runs.filter((run) => run.state === 'completed').length;
  const attention = state.runs.filter((run) => ['failed', 'blocked'].includes(run.state)).length;
  $('#totalRuns').textContent = state.runs.length;
  $('#runningRuns').textContent = active;
  $('#completedRuns').textContent = complete;
  $('#totalTokens').textContent = state.runs.reduce((sum, run) => sum + tokenCount(run), 0).toLocaleString('zh-CN');
  $('#activeCount').textContent = active;
  $('#completeCount').textContent = complete;
  $('#attentionCount').textContent = attention;
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
    <div class="focus-flow">${pipelineOrder.map((key) => `<div class="focus-step ${stageClass(run.stages?.[key])}"><i data-lucide="${stageIcons[key]}"></i><span>${escapeHtml(stageLabels[key])}</span></div>`).join('')}</div>
    <div class="focus-assets"><div><i data-lucide="message-square-text"></i><strong>${copyCount}</strong><span>成品文案</span></div><div class="${videoReady ? 'ready' : ''}"><i data-lucide="video"></i><strong>${videoReady ? '已就绪' : '等待中'}</strong><span>视频</span></div><div class="${posterCount === 2 ? 'ready' : ''}"><i data-lucide="images"></i><strong>${posterCount}/2</strong><span>海报</span></div><div class="${run.artifacts?.review ? 'ready' : ''}"><i data-lucide="badge-check"></i><strong>${run.artifacts?.review ? '已就绪' : '等待中'}</strong><span>审核包</span></div></div>
  </article>`;
  $('#openFocusRun').onclick = () => {
    state.selectedId = run.id;
    state.detailFingerprint = '';
    render();
    document.querySelector('.operations-layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

function pipelineNode(run, key) {
  const stage = run.stages?.[key] || { status: 'waiting' };
  const artifact = { P1: run.artifacts?.book?.bookSkuId, P2: run.artifacts?.evidence?.completed ? `${run.artifacts.evidence.completed} 章` : '', P5: run.artifacts?.code ? `Code ${run.artifacts.code}` : '', P3: run.artifacts?.posts?.length ? `${run.artifacts.posts.length} 套文案` : '', P4: run.artifacts?.video?.videoUrls?.[0] ? '可播放' : run.artifacts?.video?.threadId ? '生成中' : '', P3_5: run.artifacts?.images?.length ? `${run.artifacts.images.filter((item) => item.url).length}/2 海报` : '', P6: run.artifacts?.review ? '审核包就绪' : '' }[key] || stage.label || stage.status;
  return `<div class="flow-node ${stageClass(stage)}"><div class="flow-node-top"><i data-lucide="${stageIcons[key] || 'circle'}"></i><span>${escapeHtml(stageLabels[key] || key)}</span></div><strong>${escapeHtml(artifact)}</strong><small>${escapeHtml(stage.status === 'done' ? '已完成' : stage.status === 'waiting' ? '等待中' : stage.status === 'ambiguous' ? '需人工处理' : '进行中')}</small></div>`;
}

function pipelineHtml(run) {
  return `<div class="flow-main">${pipelineNode(run, 'P1')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P2')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P5')}<i class="flow-arrow" data-lucide="arrow-right"></i>${pipelineNode(run, 'P3')}</div><div class="flow-branch"><div>${pipelineNode(run, 'P4')}</div><div>${pipelineNode(run, 'P3_5')}</div></div><div class="flow-final"><i data-lucide="git-merge"></i>${pipelineNode(run, 'P6')}</div>`;
}

function idlePipelineHtml() {
  return `<div class="idle-pipeline"><span>选书</span><i data-lucide="arrow-right"></i><span>证据</span><i data-lucide="arrow-right"></i><span>Code / 短链</span><i data-lucide="arrow-right"></i><span>创意</span><i data-lucide="arrow-right"></i><span>视频 / 海报</span><i data-lucide="arrow-right"></i><span>审核包</span></div>`;
}

function copyHtml(run) {
  const posts = run.artifacts?.posts || [];
  if (!posts.length) return '<div class="media-placeholder">文案生成后将在这里直接显示</div>';
  return posts.map((post) => `<article class="copy-output"><span class="copy-type">${escapeHtml(post.type)}</span><p>${escapeHtml(post.content)}</p>${post.zhContent ? `<p class="translation">${escapeHtml(post.zhContent)}</p>` : ''}</article>`).join('');
}

function promptHtml(run) {
  const video = run.artifacts?.videoPrompt;
  const posters = run.artifacts?.posterPrompts || [];
  if (!video && !posters.length) return '';
  return `<section class="detail-section"><div class="section-heading"><h3>双语生产提示词</h3><span class="language-tag">EN / 中文</span></div>
    ${video ? `<div class="prompt-block"><strong>视频故事与镜头</strong><pre>${escapeHtml(video.adCopy)}\n\n${escapeHtml(video.buildRequirement)}</pre>${video.zhAdCopy || video.zhBuildRequirement ? `<p class="translation">${escapeHtml(video.zhAdCopy || '')}\n\n${escapeHtml(video.zhBuildRequirement || '')}</p>` : ''}</div>` : ''}
    ${posters.map((item) => `<div class="prompt-block"><strong>${escapeHtml(item.variant)}</strong><pre>${escapeHtml(item.prompt)}</pre>${item.zhPrompt ? `<p class="translation">${escapeHtml(item.zhPrompt)}</p>` : ''}</div>`).join('')}
  </section>`;
}

function videoHtml(run) {
  const video = run.artifacts?.video;
  const url = video?.videoUrls?.[0];
  if (url) return `<div class="video-shell"><video id="resultVideo" controls preload="metadata" playsinline poster="${escapeHtml(video.coverImageUrl || '')}"><source src="${escapeHtml(url)}"></video></div>`;
  const label = video?.status === 'running' || video?.status === 'submitting' ? '视频正在生成，后台会持续反馈进度' : '视频提交后可在这里直接播放';
  return `<div class="media-placeholder">${escapeHtml(label)}</div>`;
}

function imagesHtml(run) {
  const images = run.artifacts?.images || [];
  if (!images.length) return '<div class="media-placeholder">两张推广海报将在这里显示</div>';
  return `<div class="media-grid">${images.map((item) => `<div class="poster-item">${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.variant)}"></a>` : `<div class="media-placeholder">${escapeHtml(item.status || '等待生成')}</div>`}<span>${escapeHtml(item.variant)} · ${escapeHtml(item.status)}</span></div>`).join('')}</div>`;
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

function renderDetail() {
  const run = state.runs.find((item) => item.id === state.selectedId);
  if (!run) { $('#detailPanel').innerHTML = `<div class="detail-empty"><i data-lucide="panel-right-open"></i><strong>完整生产链路</strong><span>从今日榜单选择一本书后，节点会实时显示产物与进度。</span>${idlePipelineHtml()}</div>`; return; }
  const fingerprint = `${run.id}:${run.updatedAt}:${run.state}`;
  if (state.detailFingerprint === fingerprint) return;
  const oldVideo = $('#resultVideo');
  const playback = oldVideo ? { time: oldVideo.currentTime, paused: oldVideo.paused } : null;
  const active = currentStage(run);
  $('#detailPanel').innerHTML = `<header class="detail-header"><div class="detail-title-row"><div class="detail-title"><h2>${escapeHtml(run.input?.title)}</h2><p>SKU ${escapeHtml(run.input?.sku)} · Run ${escapeHtml(run.id.slice(-10))}</p></div><div class="detail-actions">${run.state === 'failed' ? '<button id="retryRun" class="secondary-command"><i data-lucide="rotate-ccw"></i><span>重试失败节点</span></button>' : ''}</div></div><div class="tracking-strip"><div><span>Promotion Code</span><strong>${escapeHtml(run.artifacts?.code || '待分配')}</strong></div><div><span>Verified short link</span>${run.artifacts?.shortUrl ? `<a class="tracking-link" href="${escapeHtml(run.artifacts.shortUrl)}" target="_blank" rel="noopener">${escapeHtml(run.artifacts.shortUrl)} <i data-lucide="external-link"></i></a>` : '<strong>待创建</strong>'}</div></div></header>
    <section class="pipeline"><div class="section-heading"><div><h3>P1-P6 生产链路</h3><p>书籍核验与证据锁定后，自动完成追踪、创意、视频、海报与审核包。</p></div><span class="status-badge ${escapeHtml(run.state)}">${escapeHtml(labels[run.state] || run.state)}</span></div><div class="production-flow">${pipelineHtml(run)}</div><div class="current-stage">${escapeHtml(active[1]?.label || labels[run.state] || run.state)}${active[1]?.error ? `：${escapeHtml(active[1].error)}` : ''}</div></section>
    <section class="detail-section"><div class="section-heading"><h3>六步法成品文案</h3><span class="language-tag">EN / 中文</span></div>${copyHtml(run)}</section>
    <section class="detail-section"><div class="section-heading"><h3>AC 视频预览</h3><span class="language-tag">1 条</span></div>${videoHtml(run)}</section>
    <section class="detail-section"><div class="section-heading"><h3>推广海报</h3><span class="language-tag">2 张</span></div>${imagesHtml(run)}</section>
    ${promptHtml(run)}
    <section class="detail-section"><div class="section-heading"><h3>实际数据反馈</h3><span class="language-tag">Code + Link</span></div>${analyticsHtml(run)}</section>
    <section class="detail-section"><h3>运行记录</h3><div class="event-list">${eventsHtml(run)}</div></section>`;
  state.detailFingerprint = fingerprint;
  const newVideo = $('#resultVideo');
  if (newVideo && playback?.time) newVideo.addEventListener('loadedmetadata', () => { newVideo.currentTime = Math.min(playback.time, newVideo.duration || playback.time); if (!playback.paused) newVideo.play().catch(() => {}); }, { once: true });
  $('#retryRun')?.addEventListener('click', () => retryRun(run.id));
}

function render() {
  renderCapabilities(); renderStats(); renderFocusRun(); renderLeaderboard(); renderRunList(); renderDetail(); icons();
}

async function loadStatus({ silent = false } = {}) {
  try {
    const body = await api('/api/status');
    state.runs = body.runs || [];
    state.capabilities = body.capabilities || {};
    state.videoLimit = body.videoLimit || null;
    if (!state.selectedId || !state.runs.some((run) => run.id === state.selectedId)) state.selectedId = state.runs[0]?.id || '';
    showApp(); render();
  } catch (error) {
    if (!silent) showToast(error.message, 'error');
  }
}

async function loadLeaderboard({ refresh = false, silent = false } = {}) {
  try {
    const body = await api(`/api/leaderboard?days=${state.windowDays}${refresh ? '&refresh=1' : ''}`);
    state.leaderboard = body.books || [];
    state.leaderboardUpdated = body.generatedAt || '';
    state.leaderboardWindow = body.window || null;
    renderLeaderboard(); icons();
  } catch (error) {
    state.leaderboard = [];
    renderLeaderboard();
    if (!silent) showToast(error.message, 'error');
  }
}

async function kickWorker() {
  if (state.kicking) return;
  const active = state.runs.find((run) => ['queued', 'running'].includes(run.state));
  if (!active) return;
  state.kicking = true;
  try { await api('/api/worker', { method: 'POST', body: JSON.stringify({ id: active.id }) }); await loadStatus({ silent: true }); }
  catch (error) { showToast(error.message, 'error'); }
  finally { state.kicking = false; }
}

async function retryRun(id) {
  try { await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id, action: 'retry' }) }); state.detailFingerprint = ''; await loadStatus(); await kickWorker(); }
  catch (error) { showToast(error.message, 'error'); }
}

async function startProduction(book) {
  const existing = activeRunFor(book);
  if (existing) {
    state.selectedId = existing.id;
    state.detailFingerprint = '';
    render();
    document.querySelector('.operations-layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (state.startingSku) return;
  state.startingSku = String(book.title);
  renderLeaderboard(); icons();
  try {
    const body = await api('/api/runs', { method: 'POST', body: JSON.stringify({ title: book.title, promoter: 'xujt', paidAuthorized: true, fullBookEvidence: false, source: `performance_${state.windowDays}d` }) });
    state.selectedId = body.run.id;
    state.detailFingerprint = '';
    state.runs.unshift(body.run);
    render();
    await kickWorker();
    showToast(`已为《${book.title}》启动完整生产`);
    document.querySelector('.operations-layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
$('#leaderboardButton').addEventListener('click', () => $('#leaderboardSection').scrollIntoView({ behavior: 'smooth', block: 'start' }));
$('#refreshLeaderboard').addEventListener('click', () => loadLeaderboard({ refresh: true }));
document.querySelectorAll('#windowControl button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#windowControl button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.windowDays = Number(button.dataset.days); loadLeaderboard(); }));
$('#runSearch').addEventListener('input', (event) => { state.query = event.target.value; renderRunList(); });
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.view = button.dataset.view; renderRunList(); }));
document.querySelectorAll('#densityControl button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#densityControl button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.density = button.dataset.density; renderRunList(); icons(); }));

icons();
loadStatus();
loadLeaderboard({ silent: true });
setInterval(() => loadStatus({ silent: true }), 6000);
setInterval(() => loadLeaderboard({ silent: true }), 5 * 60 * 1000);
setInterval(kickWorker, 3500);
