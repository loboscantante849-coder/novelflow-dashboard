const state = { runs: [], capabilities: {}, selectedId: '', view: 'operations', density: 'comfortable', query: '', detailFingerprint: '', kicking: false };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const labels = { queued: '排队中', running: '生产中', completed: '已完成', failed: '失败', blocked: '已暂停' };
const stageLabels = { P1: '选书', P2: '证据', P3: '创意', P3_5: '海报', P4: '视频', P5: 'Code', P6: '审核' };
const stageIcons = { P1: 'book-open-check', P2: 'library', P3: 'message-square-text', P3_5: 'images', P4: 'video', P5: 'link-2', P6: 'badge-check' };

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
  $('#loginView').hidden = false;
  $('#appView').hidden = true;
  setTimeout(() => $('#password').focus(), 50);
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
  return Object.entries(run.stages || {}).find(([, value]) => !['done', 'waiting'].includes(value.status)) || Object.entries(run.stages || {}).find(([, value]) => value.status === 'waiting') || ['P6', { label: '全部完成' }];
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

function pipelineHtml(run) {
  return Object.entries(run.stages || {}).map(([key, stage]) => `<div class="node ${stageClass(stage)}" title="${escapeHtml(stage.label || stage.status)}"><div class="node-icon"><i data-lucide="${stageIcons[key] || 'circle'}"></i></div><span>${escapeHtml(stageLabels[key] || key)}</span></div>`).join('');
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
  if (!run) { $('#detailPanel').innerHTML = '<div class="detail-empty"><i data-lucide="panel-right-open"></i><span>选择一本书查看完整生产链路</span></div>'; return; }
  const fingerprint = `${run.id}:${run.updatedAt}:${run.state}`;
  if (state.detailFingerprint === fingerprint) return;
  const oldVideo = $('#resultVideo');
  const playback = oldVideo ? { time: oldVideo.currentTime, paused: oldVideo.paused } : null;
  const active = currentStage(run);
  $('#detailPanel').innerHTML = `<header class="detail-header"><div class="detail-title-row"><div class="detail-title"><h2>${escapeHtml(run.input?.title)}</h2><p>SKU ${escapeHtml(run.input?.sku)} · Run ${escapeHtml(run.id.slice(-10))}</p></div><div class="detail-actions">${run.state === 'failed' ? '<button id="retryRun" class="secondary-command"><i data-lucide="rotate-ccw"></i><span>重试失败节点</span></button>' : ''}</div></div><div class="tracking-strip"><div><span>Promotion Code</span><strong>${escapeHtml(run.artifacts?.code || '待分配')}</strong></div><div><span>Verified short link</span><strong>${escapeHtml(run.artifacts?.shortUrl || '待创建')}</strong></div></div></header>
    <section class="pipeline"><h3>P1-P6 生产链路</h3><div class="node-flow">${pipelineHtml(run)}</div><div class="current-stage">${escapeHtml(active[1]?.label || labels[run.state] || run.state)}${active[1]?.error ? `：${escapeHtml(active[1].error)}` : ''}</div></section>
    <section class="detail-section"><div class="section-heading"><h3>六步法成品文案</h3><span class="language-tag">EN / 中文</span></div>${copyHtml(run)}</section>
    ${promptHtml(run)}
    <section class="detail-section"><div class="section-heading"><h3>AC 视频预览</h3><span class="language-tag">1 条</span></div>${videoHtml(run)}</section>
    <section class="detail-section"><div class="section-heading"><h3>推广海报</h3><span class="language-tag">2 张</span></div>${imagesHtml(run)}</section>
    <section class="detail-section"><div class="section-heading"><h3>实际数据反馈</h3><span class="language-tag">Code + Link</span></div>${analyticsHtml(run)}</section>
    <section class="detail-section"><h3>运行记录</h3><div class="event-list">${eventsHtml(run)}</div></section>`;
  state.detailFingerprint = fingerprint;
  const newVideo = $('#resultVideo');
  if (newVideo && playback?.time) newVideo.addEventListener('loadedmetadata', () => { newVideo.currentTime = Math.min(playback.time, newVideo.duration || playback.time); if (!playback.paused) newVideo.play().catch(() => {}); }, { once: true });
  $('#retryRun')?.addEventListener('click', () => retryRun(run.id));
}

function render() {
  renderCapabilities(); renderStats(); renderRunList(); renderDetail(); icons();
}

async function loadStatus({ silent = false } = {}) {
  try {
    const body = await api('/api/status');
    state.runs = body.runs || [];
    state.capabilities = body.capabilities || {};
    if (!state.selectedId || !state.runs.some((run) => run.id === state.selectedId)) state.selectedId = state.runs[0]?.id || '';
    showApp(); render();
  } catch (error) {
    if (error.status === 401) showLogin();
    else if (!silent) $('#systemState').textContent = error.message;
  }
}

async function kickWorker() {
  if (state.kicking) return;
  const active = state.runs.find((run) => ['queued', 'running'].includes(run.state));
  if (!active) return;
  state.kicking = true;
  try { await api('/api/worker', { method: 'POST', body: JSON.stringify({ id: active.id }) }); await loadStatus({ silent: true }); }
  catch (error) { if (error.status === 401) showLogin(); }
  finally { state.kicking = false; }
}

async function retryRun(id) {
  try { await api('/api/runs', { method: 'PATCH', body: JSON.stringify({ id, action: 'retry' }) }); state.detailFingerprint = ''; await loadStatus(); await kickWorker(); }
  catch (error) { alert(error.message); }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#loginError').textContent = '';
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); $('#password').value = ''; await loadStatus(); }
  catch (error) { $('#loginError').textContent = error.message; }
});
$('#togglePassword').addEventListener('click', () => { const input = $('#password'); input.type = input.type === 'password' ? 'text' : 'password'; });
$('#logoutButton').addEventListener('click', async () => { await api('/api/login', { method: 'DELETE' }).catch(() => {}); showLogin(); });
$('#refreshButton').addEventListener('click', () => loadStatus());
$('#newRunButton').addEventListener('click', () => $('#newRunDialog').showModal());
$('#closeDialog').addEventListener('click', () => $('#newRunDialog').close());
$('#cancelDialog').addEventListener('click', () => $('#newRunDialog').close());
$('#newRunForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#createError').textContent = '';
  const form = new FormData(event.currentTarget);
  try {
    const body = await api('/api/runs', { method: 'POST', body: JSON.stringify({ title: form.get('title'), sku: form.get('sku'), promoter: form.get('promoter'), paidAuthorized: true, fullBookEvidence: false }) });
    state.selectedId = body.run.id; state.detailFingerprint = ''; $('#newRunDialog').close(); event.currentTarget.reset(); event.currentTarget.elements.promoter.value = 'xujt'; await loadStatus(); await kickWorker();
  } catch (error) { $('#createError').textContent = error.message; }
});
$('#runSearch').addEventListener('input', (event) => { state.query = event.target.value; renderRunList(); });
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.view = button.dataset.view; renderRunList(); }));
document.querySelectorAll('#densityControl button').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('#densityControl button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.density = button.dataset.density; renderRunList(); icons(); }));

icons();
loadStatus();
setInterval(() => loadStatus({ silent: true }), 6000);
setInterval(kickWorker, 3500);
