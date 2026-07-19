const { saveRun, addEvent, setStage } = require('./store');
const providers = require('./providers');

const now = () => new Date().toISOString();
const terminal = (status) => ['done', 'failed', 'ambiguous'].includes(status);

function cleanError(error) {
  return String(error?.message || error || 'Unknown worker failure').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').slice(0, 500);
}

function selectedChapters(chapters, payPoint) {
  const sorted = [...chapters].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const freePool = payPoint > 0 ? sorted.filter((item) => Number(item.order || 0) < payPoint) : sorted;
  const free = (freePool.length ? freePool : sorted).slice(0, 6);
  const late = [];
  for (const ratio of [0.55, 0.7, 0.85, 0.95, 1]) {
    const item = sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
    if (item && !free.some((value) => String(value.id) === String(item.id)) && !late.some((value) => String(value.id) === String(item.id))) late.push(item);
    if (late.length >= 4) break;
  }
  return [...free, ...late].map((item, index) => ({ id: String(item.id), order: Number(item.order || 0), title: String(item.title || ''), source: index < free.length ? 'opening' : 'escalation' }));
}

function normalizeCreative(result, run) {
  const source = result.creative || {};
  if (!Array.isArray(source.posts) || source.posts.length !== 2) throw new providers.ProviderError('Creative model did not return exactly two posts');
  const expectedTypes = ['hook', 'escalation'];
  const posts = source.posts.map((post, index) => {
    const six = post.sixSteps || {};
    for (const key of ['hook', 'pain', 'sensory', 'contrast', 'deepDesire', 'emotionalCta']) if (!String(six[key] || '').trim()) throw new providers.ProviderError(`Creative model omitted ${key}`);
    const evidence = Array.isArray(post.evidence) ? post.evidence : [];
    if (evidence.length < 2) throw new providers.ProviderError('Each post must cite at least two chapter excerpts');
    const type = expectedTypes[index];
    let content = String(post.content || Object.values(six).join('\n\n')).trim();
    if (!content.includes(String(run.artifacts.code))) content += `\n\nRead it on NovelFlow with Code ${run.artifacts.code}.`;
    if (run.artifacts.shortUrl && !content.includes(run.artifacts.shortUrl)) content += `\n${run.artifacts.shortUrl}`;
    return { type, sixSteps: six, content, zhContent: String(post.zhContent || '').trim(), evidence };
  });
  const videoPrompt = source.videoPrompt || {};
  if (!String(videoPrompt.adCopy || '').trim() || !String(videoPrompt.buildRequirement || '').trim()) throw new providers.ProviderError('Creative model returned an empty video prompt');
  const posterPrompts = Array.isArray(source.posterPrompts) ? source.posterPrompts : [];
  const byVariant = new Map(posterPrompts.map((item) => [String(item.variant || ''), item]));
  for (const variant of ['luminous_cinema', 'editorial_romance']) {
    const item = byVariant.get(variant);
    if (!item || String(item.prompt || '').trim().length < 100) throw new providers.ProviderError(`Creative model returned an invalid ${variant} image prompt`);
  }
  return { posts, videoPrompt, posterPrompts: ['luminous_cinema', 'editorial_romance'].map((variant) => ({ variant, prompt: String(byVariant.get(variant).prompt), zhPrompt: String(byVariant.get(variant).zhPrompt || '') })) };
}

async function p1(redis, run) {
  setStage(run, 'P1', 'running', { label: '正在核验书名与 SKU' });
  await saveRun(redis, run);
  const book = await providers.findExactBook(run.input.title, run.input.sku);
  run.artifacts.book = book;
  setStage(run, 'P1', 'done', { label: '书籍身份已核验', bookSkuId: book.bookSkuId });
  addEvent(run, 'book_verified', `${book.title} identity verified`);
  await saveRun(redis, run);
}

async function p2(redis, run) {
  const stage = run.stages.P2;
  if (stage.status === 'waiting') {
    setStage(run, 'P2', 'running', { label: '正在建立章节证据', cursor: 0 });
    await saveRun(redis, run);
    const chapters = await providers.listChapters(run.artifacts.book.cityBookId);
    if (!chapters.length) throw new providers.ProviderError('No chapters were returned for this book');
    const refs = selectedChapters(chapters, run.artifacts.book.payPoint);
    run.artifacts.evidence = { mode: 'opening_and_escalation', chapterListCount: chapters.length, requested: refs.length, completed: 0, refs, chapters: [] };
    run.artifacts.book.chapterCount = chapters.length;
    setStage(run, 'P2', 'running', { label: `正在下载证据 0/${refs.length}`, cursor: 0, total: refs.length });
    await saveRun(redis, run);
    return;
  }
  const evidence = run.artifacts.evidence;
  const cursor = Number(stage.cursor || 0);
  const batch = evidence.refs.slice(cursor, cursor + 2);
  if (batch.length) {
    const downloaded = await Promise.all(batch.map(async (ref) => ({ ...ref, content: await providers.chapterContent(ref.id) })));
    evidence.chapters.push(...downloaded);
    evidence.completed = evidence.chapters.length;
    const next = cursor + batch.length;
    setStage(run, 'P2', 'running', { label: `正在下载证据 ${next}/${evidence.requested}`, cursor: next, total: evidence.requested });
    await saveRun(redis, run);
    return;
  }
  if (evidence.completed !== evidence.requested) throw new providers.ProviderError('Chapter evidence download is incomplete');
  setStage(run, 'P2', 'done', { label: `${evidence.completed} 个章节证据已锁定`, completeness: 100 });
  addEvent(run, 'evidence_ready', `${evidence.completed} chapter evidence records ready`);
  await saveRun(redis, run);
}

async function nextCode(redis) {
  // The scoped storage bridge only persists strings, while Redis INCR still
  // accepts the stored decimal value and returns the next numeric code.
  await redis.set('nf_social:next_code', '44443', { nx: true });
  return String(await redis.incr('nf_social:next_code'));
}

function codeOwned(record, run) {
  const ids = [record?.bookId, record?.bookSkuId].map(String);
  return ids.includes(String(run.input.sku)) && String(record?.channel || '') === (process.env.NOVELFLOW_CHANNEL_CODE || 'FB');
}

async function p5(redis, run) {
  const stage = run.stages.P5;
  if (stage.status === 'waiting') {
    const candidate = await nextCode(redis);
    run.artifacts.code = candidate;
    setStage(run, 'P5', 'running', { label: `正在核验 Code ${candidate}`, phase: 'code' });
    await saveRun(redis, run);
    return;
  }
  if (stage.phase === 'code') {
    const existing = await providers.keywordRecord(run.artifacts.code);
    if (existing && !codeOwned(existing, run)) {
      const previous = run.artifacts.code;
      run.artifacts.code = await nextCode(redis);
      setStage(run, 'P5', 'running', { label: `Code ${previous} 已占用，顺延到 ${run.artifacts.code}`, phase: 'code' });
      addEvent(run, 'code_advanced', `Code ${previous} was occupied; advanced to ${run.artifacts.code}`);
      await saveRun(redis, run);
      return;
    }
    if (!existing) {
      await providers.createKeyword(run.input.sku, run.artifacts.code);
      const verified = await providers.keywordRecord(run.artifacts.code);
      if (!verified || !codeOwned(verified, run) || !providers.enabled(verified.isEnable)) throw new providers.ProviderError('Created promotion code could not be verified remotely');
      run.artifacts.keywordId = String(verified.id || '');
    } else {
      if (!providers.enabled(existing.isEnable)) throw new providers.ProviderError(`Promotion Code ${run.artifacts.code} exists but is disabled`);
      run.artifacts.keywordId = String(existing.id || '');
    }
    setStage(run, 'P5', 'running', { label: 'Code 已验证，正在创建短链', phase: 'link' });
    await saveRun(redis, run);
    return;
  }
  if (stage.phase === 'link') {
    let link = await providers.findLink(run.input.sku, run.input.promoter, run.artifacts.code);
    if (!link) {
      const created = await providers.createLink(run.artifacts.book, run.input.promoter, run.artifacts.code);
      link = created.id ? await providers.findLink(run.input.sku, run.input.promoter, run.artifacts.code) : null;
    }
    if (!link?.shortUrl) throw new providers.ProviderError('Short link was not readable after creation');
    run.artifacts.shortUrl = providers.absoluteUrl(link.shortUrl);
    run.artifacts.linkId = String(link.id || '');
    setStage(run, 'P5', 'done', { label: `Code ${run.artifacts.code} 与短链已验证`, code: run.artifacts.code, linkId: run.artifacts.linkId });
    addEvent(run, 'tracking_ready', `Verified Code ${run.artifacts.code} and short link`);
    await saveRun(redis, run);
  }
}

async function p3(redis, run) {
  setStage(run, 'P3', 'running', { label: 'DeepSeek 正在生成双语创意包' });
  await saveRun(redis, run);
  const result = await providers.generateCreative(run.artifacts.book, run.artifacts.evidence.chapters, run.artifacts.code, run.artifacts.shortUrl);
  const creative = normalizeCreative(result, run);
  run.artifacts.posts = creative.posts;
  run.artifacts.translations = { language: 'zh-CN', posts: creative.posts.map((item) => item.zhContent) };
  run.artifacts.videoPrompt = creative.videoPrompt;
  run.artifacts.posterPrompts = creative.posterPrompts;
  run.artifacts.usage.creative = { model: result.model, responseId: result.responseId, ...result.usage };
  setStage(run, 'P3', 'done', { label: '六步法文案、翻译与提示词已生成', model: result.model });
  addEvent(run, 'creative_ready', 'Bilingual copy, video prompt and poster prompts generated');
  await saveRun(redis, run);
}

function videoPayload(run) {
  const chapters = run.artifacts.videoPrompt.evidenceChapters || run.artifacts.evidence.chapters.map((item) => item.order);
  const numeric = chapters.map(Number).filter(Number.isFinite);
  const start = Math.min(...numeric);
  const end = Math.max(...numeric);
  const remark = `nf_${providers.sha(`${run.id}:${run.input.sku}:seedance`).slice(0, 24)}`;
  return {
    remark,
    payload: {
      template: 'Ad_Plot_Seedance', relatedBook: { book_id: run.input.sku }, num: 1, language: 'English', country: 'US', ad_platform: 'Facebook',
      start_chapter: String(start || 1), end_chapter: String(end || start || 1), tts_audio_voice: 'Female_cur1', aspect_ratio: '9:16',
      is_generate_img: 'true', copy_type: '原创', build_requirement: String(run.artifacts.videoPrompt.buildRequirement), ad_copy: String(run.artifacts.videoPrompt.adCopy),
      word_count: '200词', reference_picture_list: run.artifacts.book.cover ? [run.artifacts.book.cover] : [], remark
    }
  };
}

function threadId(value) {
  return String(value?.thread_id || value?.threadId || value?.base_info?.thread_id || value?.id || '');
}

async function p4(redis, run) {
  const stage = run.stages.P4;
  if (stage.status === 'waiting') {
    const prepared = videoPayload(run);
    run.artifacts.video = { status: 'prepared', remark: prepared.remark, payload: prepared.payload, threadId: '', videoUrls: [] };
    setStage(run, 'P4', 'prepared', { label: '视频任务已就绪，等待提交' });
    await saveRun(redis, run);
    return;
  }
  const video = run.artifacts.video;
  if (stage.status === 'prepared') {
    const reconciled = await providers.findAcTask(video.remark);
    if (reconciled) {
      video.threadId = threadId(reconciled);
      video.status = 'running';
      setStage(run, 'P4', 'running', { label: '已找回视频任务，正在生成', threadId: video.threadId });
      await saveRun(redis, run);
      return;
    }
    video.status = 'submitting';
    video.submitAttemptedAt = now();
    setStage(run, 'P4', 'submitting', { label: '正在提交 1 条付费视频' });
    await saveRun(redis, run);
    try {
      const response = await providers.submitAc(video.payload);
      video.threadId = threadId(response);
      if (!video.threadId) throw new providers.ProviderError('AC accepted the request without a thread ID', { ambiguous: true });
      video.status = 'running';
      video.submittedAt = now();
      setStage(run, 'P4', 'running', { label: '视频已提交，正在生成', threadId: video.threadId });
      addEvent(run, 'video_submitted', 'One paid AC video submitted', { threadId: video.threadId });
      await saveRun(redis, run);
      return;
    } catch (error) {
      error.ambiguous = true;
      throw error;
    }
  }
  if (stage.status === 'submitting') {
    const reconciled = await providers.findAcTask(video.remark);
    if (!reconciled) throw new providers.ProviderError('Video submission outcome is ambiguous; automatic retry is disabled', { ambiguous: true });
    video.threadId = threadId(reconciled);
    video.status = 'running';
    setStage(run, 'P4', 'running', { label: '已找回视频任务，正在生成', threadId: video.threadId });
    await saveRun(redis, run);
    return;
  }
  if (stage.status === 'running') {
    const result = await providers.acResult(video.threadId);
    Object.assign(video, result, { lastCheckedAt: now() });
    if (result.status === 'completed') {
      video.mediaValidation = await providers.validateVideo(result.videoUrls[0]);
      setStage(run, 'P4', 'done', { label: '视频已生成并通过媒体校验', threadId: video.threadId });
      addEvent(run, 'video_ready', 'AC video completed and media URL verified');
    } else if (['failed', 'partial', 'completed_missing_media'].includes(result.status)) {
      throw new providers.ProviderError(result.error || `AC video ended with ${result.status}`);
    } else {
      setStage(run, 'P4', 'running', { label: '视频生成中，已收到状态反馈', threadId: video.threadId });
    }
    await saveRun(redis, run);
  }
}

function preparedImages(run) {
  return run.artifacts.posterPrompts.map((prompt) => ({
    variant: prompt.variant, prompt: prompt.prompt, zhPrompt: prompt.zhPrompt,
    idempotencyKey: providers.sha(`${run.id}:${prompt.variant}:${prompt.prompt}`),
    status: 'prepared', taskId: '', url: ''
  }));
}

async function p35(redis, run) {
  const stage = run.stages.P3_5;
  if (stage.status === 'waiting') {
    run.artifacts.images = preparedImages(run);
    setStage(run, 'P3_5', 'prepared', { label: '两张海报任务已就绪' });
    await saveRun(redis, run);
    return;
  }
  const prepared = run.artifacts.images.find((item) => item.status === 'prepared');
  if (prepared) {
    prepared.status = 'submitting';
    prepared.submitAttemptedAt = now();
    setStage(run, 'P3_5', 'running', { label: `正在提交 ${prepared.variant} 海报` });
    await saveRun(redis, run);
    try {
      const result = await providers.submitImage(prepared);
      prepared.taskId = String(result.id || result.task_id || '');
      if (!prepared.taskId) throw new providers.ProviderError('Image provider accepted the request without a task ID', { ambiguous: true });
      prepared.status = String(result.status || 'queued');
      prepared.submittedAt = now();
      addEvent(run, 'image_submitted', `${prepared.variant} paid image submitted`, { taskId: prepared.taskId });
      setStage(run, 'P3_5', 'running', { label: `${run.artifacts.images.filter((item) => item.taskId).length}/2 张海报已提交` });
      await saveRun(redis, run);
      return;
    } catch (error) {
      error.ambiguous = true;
      throw error;
    }
  }
  const ambiguous = run.artifacts.images.find((item) => item.status === 'submitting' && !item.taskId);
  if (ambiguous) throw new providers.ProviderError(`${ambiguous.variant} image submission is ambiguous; automatic retry is disabled`, { ambiguous: true });
  const pending = run.artifacts.images.filter((item) => item.taskId && !['success', 'failed', 'expired'].includes(item.status));
  if (pending.length) {
    for (const asset of pending) {
      const result = await providers.imageResult(asset.taskId);
      const output = result.result || {};
      asset.status = String(result.status || asset.status || 'running');
      asset.progress = result.progress;
      asset.url = String(output.url || asset.url || '');
      asset.error = String(result.error_msg || '').slice(0, 500);
      asset.lastCheckedAt = now();
    }
  }
  const successes = run.artifacts.images.filter((item) => item.status === 'success' && item.url);
  const failures = run.artifacts.images.filter((item) => ['failed', 'expired'].includes(item.status));
  if (successes.length === 2) {
    setStage(run, 'P3_5', 'done', { label: '2 张推广海报已生成' });
    addEvent(run, 'images_ready', 'Two poster images completed');
  } else if (failures.length) {
    throw new providers.ProviderError(`${failures[0].variant} image failed: ${failures[0].error || failures[0].status}`);
  } else {
    setStage(run, 'P3_5', 'running', { label: `海报生成中 ${successes.length}/2` });
  }
  await saveRun(redis, run);
}

function summarizeAnalytics(rows, code, linkId, window) {
  const normalized = rows.filter((row) => [String(code), String(linkId)].includes(String(row.adId || '')));
  const number = (value) => Number(value || 0);
  const sum = (key) => normalized.reduce((total, row) => total + number(row[key]), 0);
  const pullUv = sum('pullUv');
  const activeUv = sum('activeUv');
  const newUv = sum('newUv');
  const d7Income = sum('d7Income');
  const rate = (a, b) => b > 0 ? Math.round(a / b * 10000) / 100 : null;
  const sampleState = pullUv <= 0 ? 'no_data' : pullUv < 50 || activeUv < 10 ? 'insufficient' : pullUv < 200 || activeUv < 30 ? 'directional' : 'reliable';
  const findings = [];
  if (sampleState === 'no_data') findings.push('当前 Code 和 Link 尚无归因数据。');
  if (sampleState === 'insufficient') findings.push('样本量不足，暂不建议据此淘汰创意。');
  const activationRate = rate(activeUv, pullUv);
  if (activationRate !== null && activationRate < 15 && pullUv >= 50) findings.push('拉起后激活偏低，优先检查创意承诺与落地页匹配。');
  if (activationRate !== null && activationRate >= 35) findings.push('拉起后的激活表现较好，可继续放大当前创意方向。');
  return { status: normalized.length ? 'ready' : 'no_data', refreshedAt: now(), window, summary: { pullUv, activeUv, newUv, d7Income, activationRate, newUserRate: rate(newUv, activeUv), sampleState, rowCount: normalized.length }, findings, rows: normalized.slice(0, 500) };
}

async function p6(redis, run) {
  setStage(run, 'P6', 'running', { label: '正在组装审核包与数据面板' });
  await saveRun(redis, run);
  run.artifacts.review = {
    status: 'ready_for_manual_review', facebook: { status: 'paused', automaticPublishing: false },
    book: run.artifacts.book, code: run.artifacts.code, shortUrl: run.artifacts.shortUrl,
    posts: run.artifacts.posts, video: run.artifacts.video, images: run.artifacts.images,
    createdAt: now()
  };
  try {
    const report = await providers.reportRows(run.artifacts.code, run.artifacts.linkId, 90);
    run.artifacts.analytics = summarizeAnalytics(report.rows, run.artifacts.code, run.artifacts.linkId, { from: report.from, to: report.to });
  } catch (error) {
    run.artifacts.analytics = { status: 'unavailable', refreshedAt: now(), error: cleanError(error), summary: {}, findings: ['数据接口暂时不可用，不影响创意资产完成。'] };
  }
  setStage(run, 'P6', 'done', { label: '审核包已完成，Facebook 保持手动' });
  run.state = 'completed';
  addEvent(run, 'run_completed', 'Full production completed; Facebook remains manual');
  await saveRun(redis, run);
}

async function processRun(redis, run) {
  if (run.state === 'queued') {
    run.state = 'running';
    addEvent(run, 'worker_started', 'One-click production started');
    await saveRun(redis, run);
  }
  if (['completed', 'failed', 'blocked'].includes(run.state)) return run;
  let activeStage = 'P1';
  try {
    if (run.stages.P1.status !== 'done') { activeStage = 'P1'; await p1(redis, run); return run; }
    if (run.stages.P2.status !== 'done') { activeStage = 'P2'; await p2(redis, run); return run; }
    if (run.stages.P5.status !== 'done') { activeStage = 'P5'; await p5(redis, run); return run; }
    if (run.stages.P3.status !== 'done') { activeStage = 'P3'; await p3(redis, run); return run; }
    if (!terminal(run.stages.P4.status) && !['running'].includes(run.stages.P4.status)) { activeStage = 'P4'; await p4(redis, run); return run; }
    if (!terminal(run.stages.P3_5.status) && (run.stages.P3_5.status !== 'running' || run.artifacts.images.some((item) => ['prepared', 'submitting'].includes(item.status)))) { activeStage = 'P3_5'; await p35(redis, run); return run; }
    if (run.stages.P4.status === 'running') { activeStage = 'P4'; await p4(redis, run); return run; }
    if (run.stages.P3_5.status !== 'done') { activeStage = 'P3_5'; await p35(redis, run); return run; }
    if (run.stages.P4.status !== 'done') throw new providers.ProviderError('Video stage did not complete');
    if (run.stages.P6.status !== 'done') { activeStage = 'P6'; await p6(redis, run); return run; }
    return run;
  } catch (error) {
    const message = cleanError(error);
    const ambiguous = Boolean(error?.ambiguous);
    setStage(run, activeStage, ambiguous ? 'ambiguous' : 'failed', { label: ambiguous ? '结果不明确，已停止自动重试' : '节点失败', error: message });
    run.state = ambiguous ? 'blocked' : 'failed';
    addEvent(run, ambiguous ? 'paid_submission_ambiguous' : 'stage_failed', `${activeStage}: ${message}`);
    await saveRun(redis, run);
    return run;
  }
}

module.exports = { processRun, selectedChapters, normalizeCreative, summarizeAnalytics, cleanError };
