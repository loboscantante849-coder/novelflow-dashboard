const { getRun, saveRun, addEvent, setStage, reserveVideoSlot } = require('./store');
const providers = require('./providers');

const now = () => new Date().toISOString();
const terminal = (status) => ['done', 'failed', 'ambiguous', 'partial'].includes(status);
const posterTerminal = (status) => ['done', 'ambiguous', 'partial'].includes(status);

function creativeModelLabel(run) {
  return ({
    deepseek: 'DeepSeek',
    'seed-2.1-turbo': 'Seed 2.1 Turbo',
    'qwen3.7-max': 'Qwen 3.7 Max',
    'minimax-m2.7': 'MiniMax M2.7',
    hy3: 'HY3',
    'kimi-k2.7-code': 'Kimi K2.7 Code',
    'qwen3.5-flash': 'Qwen 3.5 Flash',
    'glm-4.5-air': 'GLM 4.5 Air',
    'kimi-k2.5': 'Kimi K2.5',
    'minimax-m2.5': 'MiniMax M2.5',
    'qwen3.7-max': 'Qwen 3.7 Max',
    'glm-5.2': 'GLM 5.2',
    'kimi-k3': 'Kimi K3',
    'minimax-m3': 'MiniMax M3'
  })[run.input?.creativeProfile?.modelChoice] || 'AI';
}

function ensureModelRoute(run) {
  run.artifacts = run.artifacts || {};
  const selected = String(run.input?.creativeProfile?.modelChoice || 'hy3');
  const existing = run.artifacts.modelRoute || {};
  run.artifacts.modelRoute = {
    preferredModel: String(existing.preferredModel || selected),
    activeModel: String(existing.activeModel || selected),
    fallbackModel: String(existing.fallbackModel || ''),
    fallbackUsed: existing.fallbackUsed === true,
    switchedAt: existing.switchedAt || '',
    switchReason: existing.switchReason || ''
  };
  if (run.input?.creativeProfile && run.input.creativeProfile.modelChoice !== run.artifacts.modelRoute.activeModel) {
    run.input.creativeProfile.modelChoice = run.artifacts.modelRoute.activeModel;
  }
  return run.artifacts.modelRoute;
}

function cleanError(error) {
  return String(error?.message || error || 'Unknown worker failure').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').slice(0, 500);
}

function recoverableModelError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || '').toLowerCase();
  if ([400, 401, 403].includes(status)) return false;
  if (/not configured|api key|credential|unauthorized|forbidden|invalid key|missing token/.test(message)) return false;
  return true;
}

// A malformed model response is safe to repair in the background. It is not
// the same as a credential/configuration error and must never strand the paid
// media branches in a failed run. Keep this list deliberately narrow so real
// source or provider failures still remain visible.
function structuredModelError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /invalid structured output|invalid json|incomplete (?:creative|story|operations|creative strategy)|did not return a usable|missing required/.test(message);
}

function autoRecoverableCreativeFailure(run) {
  const stage = run?.stages?.P3 || {};
  if (run?.state !== 'failed' || stage.status !== 'failed') return false;
  if (!['waiting_for_operator', 'validation_waiting_for_operator', 'model_output_repairing'].includes(String(stage.phase || ''))) return false;
  return structuredModelError(stage.error) && run?.artifacts?.book && run?.artifacts?.evidence?.chapters?.length && run?.artifacts?.code && run?.artifacts?.shortUrl;
}

function autoRecoverableStoryFailure(run) {
  const stage = run?.stages?.P2 || {};
  if (run?.state !== 'failed' || stage.status !== 'failed') return false;
  if (!['story_intelligence_waiting_for_operator', 'story_intelligence_repairing'].includes(String(stage.phase || ''))) return false;
  return structuredModelError(stage.error) && run?.artifacts?.book && run?.artifacts?.evidence?.chapters?.length;
}

function sourceGroundedPlan(run) {
  const book = run.artifacts?.book || {};
  const evidence = (run.artifacts?.evidence?.chapters || []).slice(0, 4);
  const quotes = evidence.map((chapter) => {
    const text = String(chapter.content || '').replace(/\s+/g, ' ').trim();
    const quote = (text.match(/[A-Za-z][^.!?]{24,140}[.!?]/) || [text.slice(0, 120)])[0].trim();
    return { chapter: Number(chapter.order || 0), quote, why: '来自已锁定章节证据，仅用于让生产继续，不替代模型分析。' };
  }).filter((item) => item.chapter > 0 && item.quote);
  return {
    editorialThesis: `先围绕《${String(book.title || '本书').slice(0, 80)}》中已锁定的具体冲突推进，不补写未被证据支持的反转。`,
    storySignals: quotes.map((item) => `Ch.${item.chapter}：${item.quote.slice(0, 90)}`),
    recommendedProfile: { copyStyle: 'system_best', ctaStyle: 'story_cliffhanger', videoStyle: 'five_beat', posterStyle: 'system_best' },
    rationale: { copyStyle: '证据覆盖不足时先使用中性、可验证的情绪冲突。', ctaStyle: '用未解决的具体选择收尾，避免机械指令。', videoStyle: '按钩子、价值、升级、反转、悬念推进。', posterStyle: '分别保留电影感与编辑感两套视觉。' },
    copyBlueprint: { hook: '从已锁定开篇冲突切入。', emotionalArc: '让一个具体选择逐步变得无法回避。', cta: 'See what happens when the unresolved choice becomes unavoidable.', zhSummary: '基于已保存证据继续生产。' },
    videoBlueprint: { arc: 'A source-grounded five-beat escalation built from saved chapter evidence.', opening: 'Open on the documented disruption.', reversal: 'Show only the supported power or expectation shift.', cliffhanger: 'Hold on the choice the story has not resolved.', zhSummary: '按已锁定证据组织五拍剧情。' },
    posterBlueprint: { moment: 'One decisive source-grounded emotional moment.', mood: 'Cinematic and editorial variants with adult, fully clothed characters.', zhSummary: '两套视觉都只使用已锁定冲突。' },
    evidence: quotes
  };
}

function recoverablePollingError(error) {
  if (error?.nonRecoverable) return false;
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || '').toLowerCase();
  if (status >= 400 && status < 500 && ![408, 429].includes(status)) return false;
  return !status || [408, 429].includes(status) || status >= 500 || /timed out|timeout|temporar|network|invalid json|definitive response/.test(message);
}

function definitiveSubmissionError(error) {
  const status = Number(error?.status || 0);
  return status >= 400 && status < 500;
}

function syncRun(target, source) {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  Object.assign(target, source);
  return target;
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

function normalizedSourceText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceMatchesSource(evidence, chapters) {
  const byChapter = new Map((chapters || []).map((chapter) => [Number(chapter.order), normalizedSourceText(chapter.content)]));
  return evidence.every((item) => {
    const quote = normalizedSourceText(item?.quote);
    return Number(item?.chapter) > 0 && quote.length >= 8 && byChapter.get(Number(item.chapter))?.includes(quote);
  });
}

function normalizeCreative(result, run) {
  const source = result.creative || {};
  const sourceChapters = run.artifacts?.evidence?.chapters || [];
  if (!Array.isArray(source.posts) || source.posts.length !== 2) throw new providers.ProviderError('Creative model did not return exactly two posts');
  const expectedTypes = ['hook', 'escalation'];
  const posts = source.posts.map((post, index) => {
    const six = post.sixSteps || {};
    for (const key of ['hook', 'pain', 'sensory', 'contrast', 'deepDesire', 'emotionalCta']) if (!String(six[key] || '').trim()) throw new providers.ProviderError(`Creative model omitted ${key}`);
    const evidence = Array.isArray(post.evidence) ? post.evidence : [];
    if (evidence.length < 2) throw new providers.ProviderError('Each post must cite at least two chapter excerpts');
    if (!evidenceMatchesSource(evidence, sourceChapters)) throw new providers.ProviderError('Creative post evidence must be exact text from its cited chapter');
    const type = expectedTypes[index];
    let content = String(post.content || Object.values(six).join('\n\n')).trim();
    if (run.artifacts.shortUrl && !content.includes(run.artifacts.shortUrl)) content += `\n${run.artifacts.shortUrl}`;
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const hashtags = content.match(/#[A-Za-z][A-Za-z0-9_]*/g) || [];
    if (hashtags.length < 5 || hashtags.length > 8) throw new providers.ProviderError('Creative post must end with 5-8 relevant hashtags');
    const shortUrlIndex = run.artifacts.shortUrl ? lines.findIndex((line) => line === run.artifacts.shortUrl) : -1;
    if (run.artifacts.shortUrl && shortUrlIndex < 2) throw new providers.ProviderError('Creative post must put the verified short URL after its CTA and NovelFlow Code guidance');
    const ctaLine = shortUrlIndex >= 2 ? lines[shortUrlIndex - 2] : String(six.emotionalCta || '').trim();
    if (!/\b(?:see|read)\s+what\s+happens\s+when\b/i.test(ctaLine)) throw new providers.ProviderError('Creative post CTA must use a story-specific “See/Read what happens when...” invitation');
    const codeLine = shortUrlIndex >= 1 ? lines[shortUrlIndex - 1] : '';
    if (!/novelflow/i.test(codeLine) || !new RegExp(`\\b${String(run.artifacts.code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(codeLine)) throw new providers.ProviderError('Creative post must include a NovelFlow Code search line before its short URL');
    const tagLine = shortUrlIndex >= 0 ? lines[shortUrlIndex + 1] : '';
    const tagsOnFinalLine = tagLine.match(/#[A-Za-z][A-Za-z0-9_]*/g) || [];
    if (!tagLine || tagsOnFinalLine.length !== hashtags.length || shortUrlIndex !== lines.length - 2) throw new providers.ProviderError('Creative post must end with its short URL and one hashtag-only line');
    const narrative = lines.slice(0, Math.max(0, shortUrlIndex - 2)).join('\n');
    if (/\b(?:read it now|click here|start reading|read the explosive beginning|use\s+(?:code|promo(?:tion)?\s*code)|code\s*[:#-]?\s*\d+)/i.test(narrative)) throw new providers.ProviderError('Creative post used a mechanical CTA or promotion-code wording in its narrative');
    if (content.split(/\r?\n\s*\r?\n/).length < 3) throw new providers.ProviderError('Creative post must use readable short paragraphs');
    const narrativeLines = narrative.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const normalizedLines = narrativeLines.map(normalizedSourceText).filter((line) => line.length >= 24);
    if (new Set(normalizedLines).size !== normalizedLines.length) throw new providers.ProviderError('Creative post repeats a visible narrative line instead of advancing the story');
    if ((narrative.match(/[\u{2600}-\u{27BF}\u{1F300}-\u{1FAFF}]/gu) || []).length < 2) throw new providers.ProviderError('Creative post needs 2-4 fitting emoji in its narrative');
    if ((narrative.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length < 70) throw new providers.ProviderError('Creative post needs enough story-specific narrative detail');
    return { type, sixSteps: six, content, zhContent: String(post.zhContent || '').trim(), evidence };
  });
  if (!posts.some((post) => /^\s*["“][^\n"”]{3,180}["”]/.test(post.content))) throw new providers.ProviderError('One creative version must open with a grounded quoted character line');
  const videoPrompt = source.videoPrompt || {};
  if (!String(videoPrompt.adCopy || '').trim() || !String(videoPrompt.buildRequirement || '').trim()) throw new providers.ProviderError('Creative model returned an empty video prompt');
  for (const key of ['hook', 'valuePromise', 'escalation', 'reversal', 'cliffhanger']) if (String(videoPrompt[key] || '').trim().length < 12) throw new providers.ProviderError(`Creative model omitted video ${key}`);
  const videoEvidence = Array.isArray(videoPrompt.sourceEvidence) ? videoPrompt.sourceEvidence : [];
  if (videoEvidence.length < 3 || videoEvidence.some((item) => !Number(item?.chapter) || String(item?.quote || '').trim().length < 8)) throw new providers.ProviderError('Video prompt must cite three grounded story beats');
  if (!evidenceMatchesSource(videoEvidence, sourceChapters)) throw new providers.ProviderError('Video prompt evidence must be exact text from its cited chapter');
  const posterPrompts = Array.isArray(source.posterPrompts) ? source.posterPrompts : [];
  const byVariant = new Map(posterPrompts.map((item) => [String(item.variant || ''), item]));
  for (const variant of ['luminous_cinema', 'editorial_romance']) {
    const item = byVariant.get(variant);
    if (!item || String(item.prompt || '').trim().length < 100) throw new providers.ProviderError(`Creative model returned an invalid ${variant} image prompt`);
  }
  const review = source.qualityReview || {};
  const recommendation = String(review.recommendation || 'keep').toLowerCase() === 'refine' ? 'refine' : 'keep';
  return {
    posts,
    videoPrompt: {
      ...videoPrompt,
      hook: String(videoPrompt.hook), valuePromise: String(videoPrompt.valuePromise), escalation: String(videoPrompt.escalation), reversal: String(videoPrompt.reversal), cliffhanger: String(videoPrompt.cliffhanger),
      sourceEvidence: videoEvidence.map((item) => ({ chapter: Number(item.chapter), quote: String(item.quote).trim() })),
      evidenceChapters: Array.isArray(videoPrompt.evidenceChapters) && videoPrompt.evidenceChapters.length ? videoPrompt.evidenceChapters : videoEvidence.map((item) => Number(item.chapter))
    },
    posterPrompts: ['luminous_cinema', 'editorial_romance'].map((variant) => ({ variant, prompt: String(byVariant.get(variant).prompt), zhPrompt: String(byVariant.get(variant).zhPrompt || '') })),
    qualityReview: { recommendation, status: String(review.status || 'verified') === 'unverified' ? 'unverified' : 'verified', conclusion: String(review.conclusion || '当前创意已满足章节证据与平台格式要求。').trim().slice(0, 260), why: String(review.why || '已核验文案、视频剧情和海报提示词均来自已锁定章节证据。').trim().slice(0, 360), target: ['copy', 'video', 'poster', 'package'].includes(String(review.target || '')) ? String(review.target) : 'package' }
  };
}

async function p1(redis, run) {
  setStage(run, 'P1', 'running', { label: '正在核验书名与 SKU' });
  await saveRun(redis, run);
  const book = await providers.findExactBook(run.input.title, run.input.sku);
  run.input.title = book.title;
  run.input.sku = book.bookSkuId;
  run.artifacts.book = book;
  setStage(run, 'P1', 'done', { label: '书籍身份已核验', bookSkuId: book.bookSkuId });
  addEvent(run, 'book_verified', `${book.title} identity verified`);
  await saveRun(redis, run);
}

async function p2(redis, run) {
  const stage = run.stages.P2;
  // Evidence initialization must happen once. Later `waiting` states are
  // reserved for recoverable story-intelligence retries.
  if (!run.artifacts.evidence) {
    setStage(run, 'P2', 'running', { label: '正在建立章节证据', cursor: 0 });
    await saveRun(redis, run);
    const chapters = await providers.listChapters(run.artifacts.book.cityBookId);
    if (!chapters.length) throw new providers.ProviderError('No chapters were returned for this book');
    const refs = selectedChapters(chapters, run.artifacts.book.payPoint);
    run.artifacts.evidence = {
      mode: 'opening_and_escalation', chapterListCount: chapters.length, requested: refs.length, completed: 0, refs, chapters: [],
      // Titles across the entire book let the LLM map acts and reversals without
      // downloading every chapter body. Literal claims still require evidence.
      chapterStructure: chapters.map((item) => ({ order: Number(item.order || 0), title: String(item.title || '') }))
    };
    run.artifacts.book.chapterCount = chapters.length;
    setStage(run, 'P2', 'running', { label: `正在下载证据 0/${refs.length}`, cursor: 0, total: refs.length });
    await saveRun(redis, run);
    return;
  }
  const evidence = run.artifacts.evidence;
  const cursor = Number(stage.cursor || 0);
  const batch = evidence.refs.slice(cursor, cursor + 2);
  if (batch.length) {
    const downloaded = await Promise.all(batch.map(async (ref) => ({ ...ref, content: String(await providers.chapterContent(ref.id)).slice(0, 16000) })));
    evidence.chapters.push(...downloaded);
    evidence.completed = evidence.chapters.length;
    const next = cursor + batch.length;
    setStage(run, 'P2', 'running', { label: `正在下载证据 ${next}/${evidence.requested}`, cursor: next, total: evidence.requested });
    await saveRun(redis, run);
    return;
  }
  if (evidence.completed !== evidence.requested) throw new providers.ProviderError('Chapter evidence download is incomplete');
  const story = evidence.storyBrief || {};
  const retryAt = Date.parse(story.nextAttemptAt || '');
  if (story.status !== 'ready') {
    if (Number.isFinite(retryAt) && retryAt > Date.now()) return;
    const route = ensureModelRoute(run);
    const preferred = String(route.preferredModel || run.input?.creativeProfile?.modelChoice || 'hy3');
    const current = String(story.modelChoice || route.activeModel || preferred);
    setStage(run, 'P2', 'running', { label: `${creativeModelLabel(run)} 正在梳理全书故事结构`, phase: 'story_intelligence', error: '', nextAttemptAt: '' });
    await saveRun(redis, run);
    try {
      const result = await providers.analyzeCreativePlan(run.artifacts.book, evidence.chapters, evidence.chapterStructure, current, story.repairInstruction || '');
      evidence.storyBrief = { status: 'ready', model: result.model, responseId: result.responseId, createdAt: now(), plan: result.plan, usage: result.usage };
      run.artifacts.storyBrief = evidence.storyBrief;
      run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), { section: 'storyBrief', requestedModel: current, model: result.model, responseId: result.responseId, completedAt: now(), triggerReason: story.fallbackUsed ? '一次备用模型接管' : '一键生产：全书故事梳理', outputStatus: '全书故事蓝图已保存', ...result.usage }].slice(-24);
      addEvent(run, 'story_intelligence_ready', 'Full-book structure map and chapter-grounded creative brief saved');
    } catch (error) {
      if (!recoverableModelError(error)) {
        const message = cleanError(error);
        evidence.storyBrief = { status: 'failed', modelChoice: current, error: message };
        run.state = 'failed';
        setStage(run, 'P2', 'failed', { label: '模型配置不可用，请修复配置后重试', phase: 'story_intelligence_configuration_error', recoverable: false, nextAttemptAt: '', error: message });
        addEvent(run, 'story_intelligence_failed', 'Story intelligence stopped because the selected model configuration requires operator action', { error: message });
        await saveRun(redis, run);
        return;
      }
      const attempt = Number(story.attempt || 0) + 1;
      // Structured output errors are repairable without changing the task's
      // model route. Give the selected reserve model two short repair passes
      // before using the already-saved chapter evidence to keep the pipeline
      // moving. This never touches Code or paid media.
      if (story.fallbackUsed && structuredModelError(error) && Number(story.repairAttempts || 0) < 2) {
        const repairAttempts = Number(story.repairAttempts || 0) + 1;
        const nextAttemptAt = new Date(Date.now() + 1500).toISOString();
        evidence.storyBrief = { ...story, status: 'recovering', repairAttempts, attempt, modelChoice: current, nextAttemptAt, error: cleanError(error), repairInstruction: 'Return only the required compact JSON object; preserve every supplied chapter quote.' };
        run.state = 'running';
        setStage(run, 'P2', 'waiting', { label: `${creativeModelLabel(run)} 正在修复故事分析格式（第 ${repairAttempts} 次）`, phase: 'story_intelligence_repairing', recoverable: true, nextAttemptAt, error: cleanError(error), attempt });
        addEvent(run, 'story_intelligence_repair_scheduled', 'The active model will retry the saved full-book analysis with a stricter JSON-only instruction', { current, repairAttempts, nextAttemptAt });
        await saveRun(redis, run);
        return;
      }
      if (story.fallbackUsed && structuredModelError(error)) {
        const plan = sourceGroundedPlan(run);
        evidence.storyBrief = { status: 'ready', model: 'evidence-continuation', responseId: '', createdAt: now(), plan, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, fallbackReason: cleanError(error) };
        run.artifacts.storyBrief = evidence.storyBrief;
        run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), { section: 'storyBrief', requestedModel: current, model: 'evidence-continuation', fallbackFrom: current, completedAt: now(), triggerReason: '模型结构修复已耗尽，使用已锁定章节继续', outputStatus: '已保存证据继续生产', error: cleanError(error) }].slice(-24);
        run.state = 'running';
        setStage(run, 'P2', 'done', { label: `${evidence.completed} 个章节证据已锁定；模型格式异常，已用保存证据继续`, completeness: 100, phase: 'evidence_continuation', recoverable: true, error: cleanError(error) });
        addEvent(run, 'story_intelligence_evidence_continuation', 'The model returned malformed structure twice; production continued from the exact saved chapter evidence without inventing plot facts', { current, error: cleanError(error) });
        await saveRun(redis, run);
        return;
      }
      if (story.fallbackUsed) {
        const message = cleanError(error);
        evidence.storyBrief = { status: 'waiting_for_operator', attempt, modelChoice: current, fallbackUsed: true, error: message };
        run.state = 'failed';
        setStage(run, 'P2', 'failed', { label: '首选与唯一备用模型均未完成，请选择重试或切换模型', phase: 'story_intelligence_waiting_for_operator', recoverable: false, nextAttemptAt: '', error: message });
        addEvent(run, 'story_intelligence_waiting_for_operator', 'Story intelligence stopped after the single permitted reserve model failed', { attempt, current, error: message });
        await saveRun(redis, run);
        return;
      }
      const next = providers.reserveModelFor(current);
      const nextAttemptAt = new Date(Date.now() + 1000).toISOString();
      evidence.storyBrief = { status: 'recovering', attempt, modelChoice: next, fallbackUsed: true, nextAttemptAt, error: cleanError(error), fallbackFrom: current };
      route.activeModel = next;
      route.fallbackModel = next;
      route.fallbackUsed = true;
      route.switchedAt = now();
      route.switchReason = '全书故事梳理的首选模型未返回可用结果；本任务统一切换一次备用模型';
      run.input.creativeProfile = { ...(run.input.creativeProfile || {}), modelChoice: next };
      setStage(run, 'P2', 'waiting', { label: `全书故事梳理暂缓，${next} 将作为唯一备用模型接管`, phase: 'story_intelligence_recovering', recoverable: true, nextAttemptAt, error: cleanError(error), fallbackFrom: current });
      addEvent(run, 'story_intelligence_fallback_scheduled', 'Story intelligence will use the one permitted reserve model from saved chapter structure and evidence', { attempt, next, fallbackFrom: current, nextAttemptAt });
      await saveRun(redis, run);
      return;
    }
  }
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

function codeConflict(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return Number(error?.status) === 409 || /already\s*exists|duplicate|conflict|occupied|已存在|重复|占用/.test(message);
}

async function advanceCode(redis, run, stage, reason) {
  const previous = run.artifacts.code;
  run.artifacts.code = await nextCode(redis);
  const attempts = Number(stage.codeAttempts || 0) + 1;
  if (attempts > 100) throw new providers.ProviderError('Could not allocate a free promotion code after 100 attempts');
  setStage(run, 'P5', 'running', { label: `Code ${previous} ${reason}，顺延到 ${run.artifacts.code}`, phase: 'code', codeAttempts: attempts });
  addEvent(run, 'code_advanced', `Code ${previous} ${reason}; advanced to ${run.artifacts.code}`);
  await saveRun(redis, run);
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
      await advanceCode(redis, run, stage, '已占用');
      return;
    }
    if (!existing) {
      try { await providers.createKeyword(run.input.sku, run.artifacts.code); }
      catch (error) {
        if (codeConflict(error)) { await advanceCode(redis, run, stage, '创建冲突'); return; }
        throw error;
      }
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

function nextCreativeAttempt(stage) {
  return Math.min(2, Number(stage.attempt || 0) + 1);
}

const creativeSectionOrder = ['posts', 'videoPrompt', 'posterPrompts', 'qualityReview'];
const creativeSectionLabels = { posts: '双语六步法文案', videoPrompt: '视频剧情包', posterPrompts: '海报提示词', qualityReview: '质量审查' };
const longCreativeModels = new Set(['deepseek', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'kimi-k2.7-code']);

async function withCreativeMergeLock(redis, runId, work) {
  const key = `nf_social:creative_merge:${runId}`;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const locked = await redis.set(key, String(Date.now()), { nx: true, ex: 20 });
    if (locked) {
      try { return await work(); } finally { await redis.del(key); }
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new providers.ProviderError('Creative result merge was busy; the completed section can be safely retried');
}

function draftFor(run, suppressOptimizationReview) {
  const route = ensureModelRoute(run);
  const draft = run.artifacts.creativeDraft || { parts: {}, usage: [], startedAt: now(), modelRoute: { ...route }, suppressOptimizationReview: Boolean(suppressOptimizationReview) };
  draft.modelRoute = { ...route, ...(draft.modelRoute || {}), activeModel: route.activeModel, preferredModel: route.preferredModel };
  if (suppressOptimizationReview) draft.suppressOptimizationReview = true;
  return draft;
}

function pendingCreativeSections(draft) {
  const core = ['posts', 'videoPrompt', 'posterPrompts'].filter((key) => !draft.parts[key]);
  if (core.length) return core;
  return draft.parts.qualityReview ? [] : ['qualityReview'];
}

function groundedVideoFallback(run, draft) {
  const post = draft.parts?.posts?.[0];
  const six = post?.sixSteps || {};
  if (!post || !six.hook || !six.contrast || !six.emotionalCta) return null;
  const evidence = [];
  for (const item of [...(post.evidence || []), ...((draft.parts?.posts?.[1]?.evidence) || [])]) {
    if (!Number(item?.chapter) || !String(item?.quote || '').trim()) continue;
    if (!evidence.some((value) => value.chapter === Number(item.chapter) && value.quote === String(item.quote).trim())) evidence.push({ chapter: Number(item.chapter), quote: String(item.quote).trim() });
  }
  for (const chapter of run.artifacts?.evidence?.chapters || []) {
    if (evidence.length >= 3) break;
    const quote = (String(chapter.content || '').match(/[A-Za-z][^.!?]{24,140}[.!?]/) || [])[0]?.trim();
    if (quote && !evidence.some((value) => value.chapter === Number(chapter.order) && value.quote === quote)) evidence.push({ chapter: Number(chapter.order), quote });
  }
  if (evidence.length < 3) return null;
  const hook = String(six.hook).trim();
  const valuePromise = String(six.deepDesire || six.pain).trim();
  const escalation = String(six.pain || six.sensory).trim();
  const reversal = String(six.contrast).trim();
  const cliffhanger = String(six.emotionalCta).trim();
  return {
    hook, valuePromise, escalation, reversal, cliffhanger,
    sourceEvidence: evidence.slice(0, 3), evidenceChapters: evidence.slice(0, 3).map((item) => item.chapter),
    adCopy: [hook, escalation, reversal, cliffhanger].join(' '),
    buildRequirement: '0-2s: immediate close-up of the source-grounded disruption. 2-5s: show the protagonist\'s personal stake through one concrete action. 5-8s: tighten framing as pressure rises. 8-11s: reveal the documented power reversal. 11-15s: hold on the unresolved choice. Vertical 9:16, adult characters, consistent appearance and wardrobe, cinematic continuity, no subtitles, readable text, logos, CTA cards, or identity drift.',
    zhHook: `钩子：${hook}`, zhValuePromise: `价值：${valuePromise}`, zhEscalation: `升级：${escalation}`, zhReversal: `反转：${reversal}`, zhCliffhanger: `悬念：${cliffhanger}`,
    zhAdCopy: '旁白严格复用已保存的六步法文案冲突，不新增剧情事实。',
    zhBuildRequirement: '0-2秒冲突特写；2-5秒个人代价；5-8秒压力升级；8-11秒权力反转；11-15秒停在未决选择。竖屏9:16，角色外观一致，无字幕、可读文字、Logo或CTA卡片。',
    fallbackStatus: 'derived_from_ai_copy_and_source_evidence'
  };
}

async function finalizeCreativeDraft(redis, run) {
  const draft = run.artifacts.creativeDraft;
  if (!draft || pendingCreativeSections(draft).length) return run;
  const result = {
    creative: {
      posts: draft.parts.posts,
      videoPrompt: draft.parts.videoPrompt,
      posterPrompts: draft.parts.posterPrompts,
      qualityReview: draft.parts.qualityReview
    },
    model: draft.usage.map((item) => item.model).filter(Boolean).join(' / '),
    responseId: draft.usage.map((item) => item.responseId).filter(Boolean).join(','),
    usage: draft.usage.reduce((total, item) => ({ inputTokens: total.inputTokens + Number(item.inputTokens || 0), outputTokens: total.outputTokens + Number(item.outputTokens || 0), totalTokens: total.totalTokens + Number(item.totalTokens || 0) }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  };
  let creative;
  try {
    creative = normalizeCreative(result, run);
  } catch (error) {
    const coreReady = draft.parts?.posts && draft.parts?.videoPrompt && draft.parts?.posterPrompts;
    const repairAttempts = Number(draft.validationRepairAttempts || 0);
    if (structuredModelError(error) && repairAttempts < 2) {
      draft.validationRepairAttempts = repairAttempts + 1;
      draft.parts = {};
      draft.usage = [];
      draft.recoveryRevision = { instruction: 'The previous package was not parseable. Return one compact JSON object with every required field and no prose outside it.', validationError: cleanError(error) };
      draft.failures = Object.fromEntries(['posts', 'videoPrompt', 'posterPrompts'].map((section) => [section, { attempt: repairAttempts + 1, at: now(), error: cleanError(error), recoverable: true }]));
      run.artifacts.creativeDraft = draft;
      run.state = 'running';
      setStage(run, 'P3', 'waiting', { label: `模型输出格式正在自动修复（第 ${repairAttempts + 1} 次）`, phase: 'model_output_repairing', attempt: repairAttempts + 1, nextAttemptAt: new Date(Date.now() + 1500).toISOString(), error: cleanError(error), recoverable: true });
      addEvent(run, 'creative_validation_repair_scheduled', 'Malformed creative package will be regenerated from the saved chapter evidence before any paid media is touched', { repairAttempts: repairAttempts + 1, error: cleanError(error) });
      await saveRun(redis, run);
      return run;
    }
    if (draft.validationFallbackUsed && coreReady) {
      const message = cleanError(error);
      run.artifacts.posts = draft.parts.posts;
      run.artifacts.translations = { language: 'zh-CN', posts: (draft.parts.posts || []).map((item) => item.zhContent) };
      run.artifacts.videoPrompt = draft.parts.videoPrompt;
      run.artifacts.posterPrompts = draft.parts.posterPrompts;
      run.artifacts.qualityReview = { recommendation: 'keep', status: 'unverified', phase: 'validation_unverified', reviewedAt: now(), conclusion: '核心创意已保存；自动证据校验有一项未通过，已保留产物并提示人工复核。', why: message, target: 'package' };
      run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), ...draft.usage.map((item) => ({ ...item, validationStatus: 'rejected', validationError: message, outputStatus: '产物保留，待人工复核' }))].slice(-24);
      delete run.artifacts.creativeDraft;
      run.artifacts.optimization = { status: 'validation_unverified', review: run.artifacts.qualityReview, resolvedAt: now() };
      run.state = 'running';
      setStage(run, 'P3', 'done', { label: '核心创意已保存，自动校验待人工复核，继续后续素材', phase: 'validation_unverified', error: message, recoverable: false });
      addEvent(run, 'creative_validation_nonblocking', 'Core creative outputs were retained after a second validation failure; downstream media may continue with an operator review flag');
      await saveRun(redis, run);
      return run;
    }
    const attempt = Number(draft.validationAttempts || 0) + 1;
    const route = ensureModelRoute(run);
    const previousModel = String(route.activeModel || run.input?.creativeProfile?.modelChoice || 'hy3');
    if (draft.validationFallbackUsed) {
      const message = cleanError(error);
      run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), ...draft.usage.map((item) => ({ ...item, validationStatus: 'rejected', validationError: message, outputStatus: '证据校验未通过' }))].slice(-24);
      run.state = 'failed';
      setStage(run, 'P3', 'failed', { label: '首选与唯一备用模型均未通过证据校验，请人工决定下一步', phase: 'validation_waiting_for_operator', attempt, nextAttemptAt: '', error: message, recoverable: false });
      addEvent(run, 'creative_validation_waiting_for_operator', 'Creative validation stopped after the single permitted reserve model was exhausted', { attempt, previousModel, error: message });
      await saveRun(redis, run);
      return run;
    }
    const nextAttemptAt = new Date(Date.now() + 1000).toISOString();
    const nextModel = providers.reserveModelFor(previousModel);
    run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), ...draft.usage.map((item) => ({ ...item, validationStatus: 'rejected', validationError: cleanError(error) }))].slice(-24);
    draft.parts = {};
    draft.usage = [];
    draft.validationAttempts = attempt;
    draft.validationFallbackUsed = true;
    draft.recoveryRevision = { instruction: 'Regenerate every creative section from the saved exact chapter evidence. Correct the prior validation failure and do not reuse unsupported quotes.', validationError: cleanError(error) };
    draft.failures = Object.fromEntries(['posts', 'videoPrompt', 'posterPrompts'].map((section) => [section, { attempt, at: now(), error: cleanError(error), nextAttemptAt }]));
    route.activeModel = nextModel;
    route.fallbackModel = nextModel;
    route.fallbackUsed = true;
    route.switchedAt = now();
    route.switchReason = `${previousModel} 的创意结果未通过证据校验；本任务统一切换一次备用模型`;
    draft.modelRoute = { ...route, fallbackFrom: previousModel, reason: route.switchReason };
    run.input.creativeProfile = { ...(run.input.creativeProfile || {}), modelChoice: nextModel };
    run.state = 'running';
    setStage(run, 'P3', 'waiting', { label: `上一版未通过证据校验，${nextModel} 将作为唯一备用模型重新生成`, phase: 'validation_recovering', attempt, nextAttemptAt, error: cleanError(error), recoverable: true, fallbackFrom: previousModel });
    addEvent(run, 'creative_validation_fallback_scheduled', 'Invalid creative draft was discarded; the one permitted reserve model will regenerate from saved chapter evidence', { attempt, previousModel, nextModel, nextAttemptAt, error: cleanError(error) });
    await saveRun(redis, run);
    return run;
  }
  run.artifacts.posts = creative.posts;
  run.artifacts.translations = { language: 'zh-CN', posts: creative.posts.map((item) => item.zhContent) };
  run.artifacts.videoPrompt = creative.videoPrompt;
  run.artifacts.posterPrompts = creative.posterPrompts;
  run.artifacts.qualityReview = creative.qualityReview;
  run.artifacts.qualityReview.phase = 'post_generation';
  run.artifacts.qualityReview.reviewedAt = now();
  run.artifacts.usage.creative = { model: result.model, responseId: result.responseId, ...result.usage };
  run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), ...draft.usage].slice(-24);
  delete run.artifacts.creativeDraft;
  if (creative.qualityReview.recommendation === 'refine' && !draft.suppressOptimizationReview) {
    run.artifacts.optimization = { status: 'awaiting_confirmation', dueAt: new Date(Date.now() + 60000).toISOString(), review: creative.qualityReview, createdAt: now() };
    setStage(run, 'P3', 'done', { label: `创意已生成，${creativeModelLabel(run)} 建议优化，等待确认`, model: result.model, phase: 'optimization_waiting' });
    addEvent(run, 'creative_optimization_suggested', `${creativeModelLabel(run)} suggested a source-grounded creative refinement; it will apply after one minute unless kept.`);
  } else {
    run.artifacts.optimization = { status: draft.suppressOptimizationReview ? 'auto_applied' : 'kept', review: creative.qualityReview, resolvedAt: now() };
    setStage(run, 'P3', 'done', { label: '六步法文案、翻译与提示词已生成', model: result.model, phase: 'ready' });
  }
  addEvent(run, 'creative_ready', 'Bilingual copy, video prompt and poster prompts generated');
  await saveRun(redis, run);
  return run;
}

async function p3(redis, run, revision = null, suppressOptimizationReview = false, requestedSection = '') {
  const originalRun = run;
  let stage = run.stages.P3;
  let modelLabel = creativeModelLabel(run);
  let draft = draftFor(run, suppressOptimizationReview);
  run.artifacts.creativeDraft = draft;
  const pending = pendingCreativeSections(draft);
  const pendingSection = requestedSection && pending.includes(requestedSection) ? requestedSection : pending[0];
  if (pendingSection) {
    const prepared = await withCreativeMergeLock(redis, run.id, async () => {
      const latest = await getRun(redis, run.id) || run;
      const latestDraft = draftFor(latest, suppressOptimizationReview);
      latest.artifacts.creativeDraft = latestDraft;
      // The worker owns a per-section lock. Do not let a stale inFlight flag
      // suppress a legitimate result after a serverless interruption.
      if (latestDraft.parts[pendingSection]) return null;
      latestDraft.inFlight = { ...(latestDraft.inFlight || {}), [pendingSection]: now() };
      const longTask = longCreativeModels.has(String(latest.input?.creativeProfile?.modelChoice || '').toLowerCase()) && pendingSection !== 'qualityReview';
      setStage(latest, 'P3', 'running', { label: longTask ? `${creativeModelLabel(latest)} 正在后台长任务生成${creativeSectionLabels[pendingSection]}（可持续数分钟）` : `${creativeModelLabel(latest)} 正在并行生成${creativeSectionLabels[pendingSection]}`, phase: pendingSection, executionMode: longTask ? 'background_long' : 'realtime', error: '', nextAttemptAt: '' });
      addEvent(latest, 'creative_section_started', `${creativeModelLabel(latest)} started ${pendingSection}`);
      addEvent(latest, 'creative_request_started', `${creativeModelLabel(latest)} creative request started for ${pendingSection}`);
      await saveRun(redis, latest);
      return latest;
    });
    if (!prepared) return run;
    run = prepared;
    stage = run.stages.P3;
    modelLabel = creativeModelLabel(run);
    draft = run.artifacts.creativeDraft;
    let sectionResult;
    try {
      const reviewInput = pendingSection === 'qualityReview' ? { posts: draft.parts.posts, videoPrompt: draft.parts.videoPrompt, posterPrompts: draft.parts.posterPrompts } : (revision || draft.recoveryRevision || null);
      const route = ensureModelRoute(run);
      sectionResult = await providers.generateCreative(run.artifacts.book, run.artifacts.evidence.chapters, run.artifacts.code, run.artifacts.shortUrl, reviewInput, { ...(run.input.creativeProfile || {}), modelChoice: route.activeModel, storyBrief: run.artifacts.storyBrief?.plan || null }, pendingSection);
    } catch (error) {
      return withCreativeMergeLock(redis, run.id, async () => {
        const latest = await getRun(redis, run.id) || run;
        const latestDraft = draftFor(latest, suppressOptimizationReview);
        delete latestDraft.inFlight?.[pendingSection];
        latestDraft.failures = { ...(latestDraft.failures || {}) };
        const attempt = Number(latestDraft.failures[pendingSection]?.attempt || 0) + 1;
        if (!recoverableModelError(error)) {
          const message = cleanError(error);
          latestDraft.failures[pendingSection] = { attempt, at: now(), error: message, nextAttemptAt: '', recoverable: false };
          latest.artifacts.creativeDraft = latestDraft;
          latest.state = 'failed';
          setStage(latest, 'P3', 'failed', { label: `${creativeSectionLabels[pendingSection]}模型配置不可用，请修复后重试`, phase: 'configuration_error', attempt, nextAttemptAt: '', error: message, recoverable: false });
          addEvent(latest, 'creative_section_failed', `${pendingSection} stopped because its model configuration requires operator action`, { error: message });
          await saveRun(redis, latest);
          return syncRun(originalRun, latest);
        }
        const route = ensureModelRoute(latest);
        const preferredModel = String(route.preferredModel || latest.input?.creativeProfile?.modelChoice || 'hy3');
        const alreadyUsedReserve = latestDraft.modelRoute?.fallbackUsed === true || Boolean(error?.fallbackModel);
        if (alreadyUsedReserve) {
          const message = cleanError(error);
          const repairAttempts = Number(latestDraft.repairAttempts?.[pendingSection] || 0);
          if (pendingSection !== 'qualityReview' && pendingSection !== 'videoPrompt' && structuredModelError(error) && repairAttempts < 2) {
            latestDraft.repairAttempts = { ...(latestDraft.repairAttempts || {}), [pendingSection]: repairAttempts + 1 };
            latestDraft.recoveryRevision = { instruction: 'Previous response was not parseable. Return only the requested compact JSON object, include every required field, and keep all evidence quotes exact.', validationError: message, section: pendingSection };
            latestDraft.failures[pendingSection] = { attempt, at: now(), error: message, nextAttemptAt: new Date(Date.now() + 1500).toISOString(), recoverable: true, repairAttempts: repairAttempts + 1 };
            latest.artifacts.creativeDraft = latestDraft;
            latest.state = 'running';
            setStage(latest, 'P3', 'waiting', { label: `${creativeSectionLabels[pendingSection]} 正在自动修复模型格式（第 ${repairAttempts + 1} 次）`, phase: 'model_output_repairing', attempt, nextAttemptAt: latestDraft.failures[pendingSection].nextAttemptAt, error: message, recoverable: true });
            addEvent(latest, 'creative_output_repair_scheduled', 'The active model will retry the malformed creative section with a stricter JSON-only instruction', { pendingSection, repairAttempts: repairAttempts + 1, model: route.activeModel });
            await saveRun(redis, latest);
            return syncRun(originalRun, latest);
          }
          if (pendingSection === 'videoPrompt') {
            const fallbackVideo = groundedVideoFallback(latest, latestDraft);
            if (fallbackVideo) {
              latestDraft.parts.videoPrompt = fallbackVideo;
              delete latestDraft.failures[pendingSection];
              latest.artifacts.modelActivity = [...(latest.artifacts.modelActivity || []), { section: pendingSection, requestedModel: preferredModel, model: 'evidence-fallback', fallbackFrom: error?.fallbackFrom || preferredModel, fallbackModel: error?.fallbackModel || '', fallbackReason: '首选与唯一备用模型均未返回可解析结构，使用已保存 AI 文案与原文证据重组', completedAt: now(), triggerReason: '证据化脚本兜底', outputStatus: '视频剧情包已保存，未新增剧情', error: message }].slice(-24);
              latest.artifacts.creativeDraft = latestDraft;
              latest.state = 'running';
              setStage(latest, 'P3', 'waiting', { label: '视频剧情已从 AI 文案与原文证据重组，继续剩余创意节点', phase: 'video_evidence_fallback', error: message, recoverable: false });
              addEvent(latest, 'creative_video_evidence_fallback', 'Video package was derived from saved AI copy and exact chapter evidence after the single model reserve failed');
              await saveRun(redis, latest);
              const finalized = await finalizeCreativeDraft(redis, latest);
              return syncRun(originalRun, finalized);
            }
          }
          if (pendingSection === 'qualityReview') {
            latestDraft.parts.qualityReview = { recommendation: 'keep', conclusion: 'AI 质检未返回可解析结果；已保留文案、视频提示词和海报提示词，未伪造“质检通过”。', why: `首选与唯一备用模型均未完成质检：${message}`, target: 'package', status: 'unverified' };
            delete latestDraft.failures[pendingSection];
            latest.artifacts.modelActivity = [...(latest.artifacts.modelActivity || []), { section: pendingSection, requestedModel: preferredModel, model: '', fallbackFrom: error?.fallbackFrom || preferredModel, fallbackModel: error?.fallbackModel || '', fallbackReason: error?.fallbackReason || '首选与唯一备用模型均未返回可用结果', completedAt: now(), triggerReason: '自动成品质检', outputStatus: '质检未完成，创意产物继续', error: message }].slice(-24);
            latest.artifacts.creativeDraft = latestDraft;
            latest.state = 'running';
            setStage(latest, 'P3', 'waiting', { label: 'AI 质检未完成，已保存创意产物并继续后续节点', phase: 'quality_unverified', attempt, nextAttemptAt: '', error: message, recoverable: false });
            addEvent(latest, 'creative_quality_nonblocking', 'Quality review was unavailable after the single reserve; saved creative outputs continue without a false pass');
            await saveRun(redis, latest);
            const finalized = await finalizeCreativeDraft(redis, latest);
            return syncRun(originalRun, finalized);
          }
          latestDraft.failures[pendingSection] = { attempt, at: now(), error: message, nextAttemptAt: '', recoverable: false, fallbackFrom: error?.fallbackFrom || preferredModel, fallbackModel: error?.fallbackModel || '' };
          latest.artifacts.modelActivity = [...(latest.artifacts.modelActivity || []), { section: pendingSection, requestedModel: preferredModel, model: '', fallbackFrom: error?.fallbackFrom || preferredModel, fallbackModel: error?.fallbackModel || '', fallbackReason: error?.fallbackReason || '首选与唯一备用模型均未返回可用结果', completedAt: now(), triggerReason: '后台生产恢复', outputStatus: '未产出，等待人工决定', error: message }].slice(-24);
          latest.artifacts.creativeDraft = latestDraft;
          latest.state = 'failed';
          setStage(latest, 'P3', 'failed', { label: `${creativeSectionLabels[pendingSection]}的首选与唯一备用模型均未完成，请人工决定`, phase: 'waiting_for_operator', attempt, nextAttemptAt: '', error: message, recoverable: false });
          addEvent(latest, 'creative_section_waiting_for_operator', `${pendingSection} stopped after the single permitted reserve model was exhausted`, { attempt, error: message });
          await saveRun(redis, latest);
          return syncRun(originalRun, latest);
        }
        const activeModel = String(route.activeModel || preferredModel);
        const reserveModel = providers.reserveModelFor(activeModel);
        const nextAttemptAt = new Date(Date.now() + 1000).toISOString();
        route.activeModel = reserveModel;
        route.fallbackModel = reserveModel;
        route.fallbackUsed = true;
        route.switchedAt = now();
        route.switchReason = `${activeModel} 未返回可用结果；本任务统一切换一次备用模型`;
        latestDraft.modelRoute = { ...route, fallbackFrom: activeModel, reason: route.switchReason };
        latestDraft.failures[pendingSection] = { attempt, at: now(), error: cleanError(error), nextAttemptAt, recoverable: true, fallbackFrom: activeModel, fallbackModel: reserveModel };
        latest.artifacts.creativeDraft = latestDraft;
        latest.input.creativeProfile = { ...(latest.input.creativeProfile || {}), modelChoice: reserveModel };
        latest.state = 'running';
        setStage(latest, 'P3', 'waiting', { label: `${creativeSectionLabels[pendingSection]}暂缓；本任务已统一切换到 ${reserveModel}`, phase: 'fallback_scheduled', attempt, nextAttemptAt, error: cleanError(error), recoverable: true, fallbackFrom: activeModel });
        addEvent(latest, 'creative_task_model_switched', `${pendingSection} caused one task-wide model switch; all remaining creative nodes now use ${reserveModel}`, { attempt, preferredModel, activeModel, reserveModel, nextAttemptAt });
        // Keep the legacy event name for existing operational timelines; the
        // task-wide switch event above is the authoritative routing record.
        addEvent(latest, 'creative_section_fallback_scheduled', `${pendingSection} scheduled the task-wide reserve route`, { attempt, preferredModel, activeModel, reserveModel, nextAttemptAt });
        await saveRun(redis, latest);
        return syncRun(originalRun, latest);
      });
    }
    return withCreativeMergeLock(redis, run.id, async () => {
      const latest = await getRun(redis, run.id) || run;
      const latestDraft = draftFor(latest, suppressOptimizationReview);
      delete latestDraft.inFlight?.[pendingSection];
      if (!latestDraft.parts[pendingSection]) {
        latestDraft.parts[pendingSection] = sectionResult.creative[pendingSection] || (pendingSection === 'qualityReview' ? {} : null);
        const fallbackFrom = sectionResult.fallbackFrom || '';
        latestDraft.usage.push({ section: pendingSection, requestedModel: sectionResult.requestedModel || modelLabel, model: sectionResult.model, fallbackFrom, responseId: sectionResult.responseId, latencyMs: Number(sectionResult.latencyMs || 0), completedAt: now(), triggerReason: fallbackFrom ? '一次备用模型接管' : pendingSection === 'qualityReview' ? '自动成品质检' : '一键生产：创意包', outputStatus: `${creativeSectionLabels[pendingSection]}已保存`, ...sectionResult.usage });
      }
      if (latestDraft.failures) delete latestDraft.failures[pendingSection];
      latest.artifacts.creativeDraft = latestDraft;
      // A completed section is authoritative even if an older concurrent
      // request wrote a failed run state just before this merge.
      latest.state = 'running';
      const waitingOn = pendingCreativeSections(latestDraft);
      setStage(latest, 'P3', 'waiting', { label: waitingOn.length ? `${creativeSectionLabels[pendingSection]}已保存，${waitingOn.length} 项创意并行中` : '全部创意已保存，准备质量校验', phase: 'section_saved', error: '', nextAttemptAt: '' });
      addEvent(latest, 'creative_section_ready', `${pendingSection} saved; independent creative sections may continue in parallel`);
      await saveRun(redis, latest);
      const finalized = await finalizeCreativeDraft(redis, latest);
      return syncRun(originalRun, finalized);
    });
  }
  return finalizeCreativeDraft(redis, run);
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

function referenceVideoPayload(run, posterUrl) {
  const prepared = videoPayload(run);
  const remark = `nf_ref_${providers.sha(`${run.id}:${posterUrl}:seedance`).slice(0, 20)}`;
  prepared.remark = remark;
  prepared.payload.remark = remark;
  prepared.payload.reference_picture_list = [posterUrl];
  return prepared;
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
  const pollRetryAt = Date.parse(stage.nextAttemptAt || '');
  if (stage.status === 'running' && Number.isFinite(pollRetryAt) && pollRetryAt > Date.now()) return;
  if (stage.status === 'prepared') {
    const reconciled = await providers.findAcTask(video.remark);
    if (reconciled) {
      video.threadId = threadId(reconciled);
      video.status = 'running';
      setStage(run, 'P4', 'running', { label: '已找回视频任务，正在生成', threadId: video.threadId });
      await saveRun(redis, run);
      return;
    }
    const slot = await reserveVideoSlot(redis);
    if (!slot.granted) {
      setStage(run, 'P4', 'blocked', { label: `本小时视频额度已满（${slot.limit}/${slot.limit}），下小时可重试`, blockedReason: 'hourly_video_limit', nextWindow: slot.label });
      run.state = 'blocked';
      addEvent(run, 'video_hour_limit', `Video submission blocked: ${slot.limit}/${slot.limit} slots already reserved this hour`);
      await saveRun(redis, run);
      return;
    }
    video.slot = { key: slot.key, hour: slot.label, reservedAt: now(), position: slot.used, limit: slot.limit };
    video.status = 'submitting';
    video.submitAttemptedAt = now();
    setStage(run, 'P4', 'submitting', { label: `正在提交付费视频（本小时 ${slot.used}/${slot.limit}）` });
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
      if (!definitiveSubmissionError(error)) error.ambiguous = true;
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
    try {
      const result = await providers.acResult(video.threadId);
      Object.assign(video, result, { lastCheckedAt: now(), lastPollError: '' });
      if (result.status === 'completed') {
        try {
          video.mediaValidation = await providers.validateVideo(result.videoUrls[0]);
        } catch (error) {
          const validationError = error instanceof Error ? error : new providers.ProviderError(String(error));
          validationError.nonRecoverable = true;
          throw validationError;
        }
        setStage(run, 'P4', 'done', { label: '视频已生成并通过媒体校验', threadId: video.threadId, pollFailures: 0, recoverable: false, nextAttemptAt: '', error: '' });
        addEvent(run, 'video_ready', 'AC video completed and media URL verified');
      } else if (['failed', 'partial', 'completed_missing_media'].includes(result.status)) {
        const terminalError = new providers.ProviderError(result.error || `AC video ended with ${result.status}`);
        terminalError.nonRecoverable = true;
        throw terminalError;
      } else {
        setStage(run, 'P4', 'running', { label: '视频生成中，已收到状态反馈', threadId: video.threadId, pollFailures: 0, recoverable: false, nextAttemptAt: '', error: '' });
      }
      await saveRun(redis, run);
    } catch (error) {
      if (!video.threadId || !recoverablePollingError(error)) throw error;
      const attempt = Number(stage.pollFailures || 0) + 1;
      const nextAttemptAt = new Date(Date.now() + Math.min(5 * 60 * 1000, 30000 * attempt)).toISOString();
      video.status = 'running';
      video.lastPollError = cleanError(error);
      setStage(run, 'P4', 'running', { label: `视频仍在外部生成，状态查询暂缓，后台将自动重试（${attempt}）`, threadId: video.threadId, pollFailures: attempt, recoverable: true, nextAttemptAt, error: cleanError(error) });
      addEvent(run, 'video_poll_recovering', 'Video result polling will retry using the existing external thread ID', { threadId: video.threadId, attempt, nextAttemptAt, error: cleanError(error) });
      await saveRun(redis, run);
    }
  }
}

function preparedImages(run) {
  return run.artifacts.posterPrompts.map((prompt) => ({
    variant: prompt.variant, prompt: prompt.prompt, zhPrompt: prompt.zhPrompt,
    idempotencyKey: providers.sha(`${run.id}:${prompt.variant}:${prompt.prompt}`),
    status: 'prepared', taskId: '', url: ''
  }));
}

async function repairFailedPoster(redis, run, asset) {
  asset.repairCount = Number(asset.repairCount || 0) + 1;
  asset.repairStartedAt = now();
  setStage(run, 'P3_5', 'running', { label: `DeepSeek 正在修复 ${asset.variant} 提示词` });
  addEvent(run, 'image_prompt_repair_started', `${asset.variant} failed definitively; DeepSeek repair started`, { taskId: asset.taskId, error: asset.error });
  await saveRun(redis, run);
  const repaired = await providers.rewritePosterPrompt(run.artifacts.book, run.artifacts.evidence?.chapters || [], asset, asset.error, ensureModelRoute(run).activeModel);
  const priorTaskId = asset.taskId;
  asset.repairHistory = [...(asset.repairHistory || []), { at: now(), taskId: priorTaskId, reason: asset.error, prompt: asset.prompt }].slice(-2);
  asset.prompt = repaired.prompt;
  asset.zhPrompt = repaired.zhPrompt;
  asset.idempotencyKey = providers.sha(`${run.id}:${asset.variant}:${asset.prompt}:repair:${asset.repairCount}`);
  asset.taskId = '';
  asset.status = 'prepared';
  asset.progress = null;
  asset.error = '';
  asset.repairedAt = now();
  const sourcePrompt = run.artifacts.posterPrompts.find((item) => item.variant === asset.variant);
  if (sourcePrompt) { sourcePrompt.prompt = asset.prompt; sourcePrompt.zhPrompt = asset.zhPrompt; sourcePrompt.repairCount = asset.repairCount; }
  run.artifacts.usage = run.artifacts.usage || {};
  run.artifacts.usage[`posterRepair:${asset.variant}`] = repaired.usage;
  addEvent(run, 'image_prompt_repaired', `${asset.variant} prompt repaired by DeepSeek; one replacement image will be submitted`, { priorTaskId, responseId: repaired.responseId, model: repaired.model });
  setStage(run, 'P3_5', 'running', { label: `${asset.variant} 提示词已修复，等待受控重提` });
  await saveRun(redis, run);
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
    } catch (error) { throw error; }
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
      if (asset.status === 'success' && !asset.url) {
        asset.status = 'failed';
        asset.error = asset.error || 'Image provider reported success without a media URL';
      }
      if (asset.status === 'success' && asset.url) {
        try {
          asset.mediaValidation = await providers.validateImage(asset.url);
          asset.url = asset.mediaValidation.resolvedUrl || asset.url;
        } catch (error) {
          // The paid provider task is terminal.  Do not submit another paid
          // poster automatically merely because its delivered link is bad.
          asset.status = 'preview_failed';
          asset.error = `Poster completed but cannot be previewed: ${cleanError(error)}`;
          addEvent(run, 'image_preview_failed', `${asset.variant} returned a terminal task but its image URL could not be verified`, { taskId: asset.taskId, error: asset.error });
        }
      }
    }
  }
  const successes = run.artifacts.images.filter((item) => item.status === 'success' && item.url);
  const failures = run.artifacts.images.filter((item) => ['failed', 'expired'].includes(item.status));
  const previewFailures = run.artifacts.images.filter((item) => item.status === 'preview_failed');
  if (successes.length === 2) {
    setStage(run, 'P3_5', 'done', { label: '2 张推广海报已生成' });
    addEvent(run, 'images_ready', 'Two poster images completed');
  } else if (failures.length) {
    const repairable = failures.find((item) => item.status === 'failed' && item.taskId && Number(item.repairCount || 0) < 1);
    if (repairable) {
      await repairFailedPoster(redis, run, repairable);
      return;
    }
    throw new providers.ProviderError(`${failures[0].variant} image failed: ${failures[0].error || failures[0].status}`);
  } else if (previewFailures.length) {
    setStage(run, 'P3_5', 'partial', { label: `${successes.length}/2 张海报可预览；${previewFailures[0].variant} 的供应商链接失效`, error: previewFailures[0].error, recoverable: false });
    addEvent(run, 'images_partial_preview_failure', 'Poster generation ended with a non-retryable preview failure; no duplicate paid request was submitted');
  } else {
    setStage(run, 'P3_5', 'running', { label: `海报生成中 ${successes.length}/2` });
  }
  await saveRun(redis, run);
}

function summarizeAnalytics(rows, code, linkId, window, source = 'social_funnel_realtime') {
  const identifiers = { code: String(code || ''), linkId: String(linkId || '') };
  const validIdentifiers = Object.values(identifiers).filter(Boolean);
  const normalized = (Array.isArray(rows) ? rows : []).filter((row) => validIdentifiers.includes(String(row.adId || '')));
  const number = (value) => Number(value || 0);
  const sum = (items, key) => items.reduce((total, row) => total + number(row[key]), 0);
  const summarizeStream = (items) => {
    const pullUv = sum(items, 'pullUv');
    const activeUv = sum(items, 'activeUv');
    const newUv = sum(items, 'newUv');
    const rate = (a, b) => b > 0 ? Math.round(a / b * 10000) / 100 : null;
    return {
      pullUv, activeUv, newUv,
      attActiveUv: sum(items, 'attActiveUv'), attNewUv: sum(items, 'attNewUv'),
      d0Income: sum(items, 'd0Income'), d7Income: sum(items, 'd7Income'),
      d14Income: sum(items, 'd14Income'), d30Income: sum(items, 'd30Income'), d90Income: sum(items, 'd90Income'),
      totalIncome: sum(items, 'totalIncome'), visits: sum(items, 'visits'),
      activationRate: rate(activeUv, pullUv), newUserRate: rate(newUv, activeUv),
      attributionRate: rate(sum(items, 'attActiveUv'), activeUv), rowCount: items.length
    };
  };
  const codeRows = identifiers.code ? normalized.filter((row) => String(row.adId || '') === identifiers.code) : [];
  const linkRows = identifiers.linkId ? normalized.filter((row) => String(row.adId || '') === identifiers.linkId) : [];
  const totals = summarizeStream(normalized);
  const stream = { code: summarizeStream(codeRows), link: summarizeStream(linkRows) };
  // A row from Code and a row from Link can refer to the same visitor. Keep
  // the streams separate and use the primary stream for headline numbers.
  const primaryIdentifier = linkRows.length ? 'link' : codeRows.length ? 'code' : null;
  const primary = primaryIdentifier ? stream[primaryIdentifier] : totals;
  const pullUv = primary.pullUv;
  const activeUv = primary.activeUv;
  const newUv = primary.newUv;
  const d7Income = primary.d7Income;
  const rate = (a, b) => b > 0 ? Math.round(a / b * 10000) / 100 : null;
  const sampleState = pullUv <= 0 ? 'no_data' : pullUv < 50 || activeUv < 10 ? 'insufficient' : pullUv < 200 || activeUv < 30 ? 'directional' : 'reliable';
  const findings = [];
  if (sampleState === 'no_data') findings.push('当前 Code 和 Link 尚无归因数据。');
  if (sampleState === 'insufficient') findings.push('样本量不足，暂不建议据此淘汰创意。');
  const activationRate = rate(activeUv, pullUv);
  if (activationRate !== null && activationRate < 15 && pullUv >= 50) findings.push('拉起后激活偏低，优先检查创意承诺与落地页匹配。');
  if (activationRate !== null && activationRate >= 35) findings.push('拉起后的激活表现较好，可继续放大当前创意方向。');
  return { status: normalized.length ? 'ready' : 'no_data', refreshedAt: now(), source, window, identifiers, primaryIdentifier, quality: { overlapWarning: Boolean(codeRows.length && linkRows.length), streamCount: [codeRows, linkRows].filter((items) => items.length).length }, streams: stream, summary: { pullUv, activeUv, newUv, d7Income, activationRate, newUserRate: rate(newUv, activeUv), sampleState, rowCount: normalized.length }, findings, rows: normalized.slice(0, 500) };
}

async function refreshAnalytics(run, days = 90) {
  const previous = run.artifacts?.analytics && typeof run.artifacts.analytics === 'object' ? run.artifacts.analytics : null;
  const attemptedAt = now();
  try {
    const report = await providers.reportRows(run.artifacts.code, run.artifacts.linkId, days);
    const next = summarizeAnalytics(report.rows, run.artifacts.code, run.artifacts.linkId, { from: report.from, to: report.to }, report.source);
    const usable = next.status === 'ready' || !previous || previous.status !== 'ready';
    // Empty/zero responses are common while a report window is settling. Do
    // not erase the last verified snapshot; expose the stale state instead.
    if (!usable && previous?.summary?.pullUv > 0 && next.summary.pullUv === 0) {
      run.artifacts.analytics = { ...previous, lastAttemptAt: attemptedAt, stale: true, warning: '本次报表返回空值，已保留上次有效数据', error: '' };
    } else {
      run.artifacts.analytics = { ...next, lastSuccessfulAt: attemptedAt, lastAttemptAt: attemptedAt, stale: false, error: '' };
    }
  } catch (error) {
    if (previous?.status === 'ready') {
      run.artifacts.analytics = { ...previous, lastAttemptAt: attemptedAt, stale: true, error: cleanError(error) };
    } else {
      run.artifacts.analytics = { status: 'unavailable', refreshedAt: attemptedAt, lastAttemptAt: attemptedAt, stale: true, error: cleanError(error), summary: {}, findings: ['数据接口暂时不可用，后续会自动重试。'] };
    }
  }
  run.artifacts.analytics.nextRefreshAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  return run.artifacts.analytics;
}

async function p6(redis, run) {
  setStage(run, 'P6', 'running', { label: '正在组装审核包与数据面板' });
  await saveRun(redis, run);
  try {
    const result = await providers.generateDistributionPlan(run.artifacts.book, {
      posts: run.artifacts.posts, videoPrompt: run.artifacts.videoPrompt, posterPrompts: run.artifacts.posterPrompts,
      storyBrief: run.artifacts.storyBrief?.plan || null
    }, ensureModelRoute(run).activeModel);
    run.artifacts.distribution = { ...result.plan, status: 'ready', generatedAt: now(), model: result.model };
    run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), { section: 'distribution', requestedModel: ensureModelRoute(run).activeModel, model: result.model, responseId: result.responseId, completedAt: now(), ...result.usage }].slice(-24);
    addEvent(run, 'distribution_ready', 'Manual channel recommendations and reusable hook are ready');
  } catch (error) {
    // A recommendation must never hold up a completed review package. Keep a
    // transparent, conservative fallback instead of claiming model output.
    const category = [run.artifacts.book?.category, ...(run.artifacts.book?.tags || [])].join(' ').toLowerCase();
    const channels = [{ name: 'NovelFlow推书', reason: '通用 NovelFlow 小说素材入口。', bestFor: ['copy', 'video', 'poster'] }];
    if (/mafia|mob|underworld/.test(category)) channels.push({ name: 'MafiaRomance', reason: '书籍标签包含黑手党题材。', bestFor: ['copy', 'video', 'poster'] });
    else if (/wolf|lycan|luna|alpha|shifter/.test(category)) channels.push({ name: 'WerewolfRomance', reason: '书籍标签包含狼人或命定伴侣题材。', bestFor: ['copy', 'video', 'poster'] });
    else if (/billionaire|ceo|boss/.test(category)) channels.push({ name: 'BillionaireRomance', reason: '书籍标签包含都市权力或总裁题材。', bestFor: ['copy', 'poster'] });
    else channels.push({ name: 'DarkRomance', reason: '暂以通用情绪向频道作为人工复核候选。', bestFor: ['copy', 'video'] });
    run.artifacts.distribution = { status: 'fallback', universalHook: String(run.artifacts.posts?.[0]?.sixSteps?.hook || run.artifacts.posts?.[0]?.content || '').split(/\r?\n/)[0].slice(0, 150), zhUniversalHook: '模型推荐暂未返回，请先使用已验证的文案钩子。', channels, generatedAt: now(), error: cleanError(error) };
    addEvent(run, 'distribution_fallback', 'Distribution recommendation model was unavailable; conservative manual fallback saved');
  }
  run.artifacts.review = {
    status: 'ready_for_manual_review', facebook: { status: 'paused', automaticPublishing: false },
    book: run.artifacts.book, code: run.artifacts.code, shortUrl: run.artifacts.shortUrl,
    posts: run.artifacts.posts, video: run.artifacts.video, images: run.artifacts.images, distribution: run.artifacts.distribution,
    mediaWarnings: run.stages.P3_5.status === 'done' ? [] : [{
      stage: 'P3_5', status: run.stages.P3_5.status,
      message: run.stages.P3_5.label || '海报未完整生成，视频与文案仍可审核',
      error: run.stages.P3_5.error || ''
    }],
    createdAt: now()
  };
  try {
    // Attribution is refreshed asynchronously by the analytics worker. A
    // report provider outage must never hold the finished production package.
    run.artifacts.analytics = run.artifacts.analytics || { status: 'pending', summary: {}, findings: [] };
    run.artifacts.analytics.nextRefreshAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  } catch (error) {
    run.artifacts.analytics = { status: 'pending', refreshedAt: now(), error: cleanError(error), summary: {}, findings: ['数据将在后台自动跟进，不影响创意资产完成。'], nextRefreshAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
  }
  setStage(run, 'P6', 'done', { label: '审核包已完成，Facebook 保持手动' });
  run.state = 'completed';
  addEvent(run, 'run_completed', 'Full production completed; Facebook remains manual');
  await saveRun(redis, run);
}

async function advancePosters(redis, run) {
  try {
    await p35(redis, run);
  } catch (error) {
    const ambiguous = Boolean(error?.ambiguous);
    const status = ambiguous ? 'ambiguous' : 'partial';
    const label = ambiguous
      ? '海报提交结果不明确，已停止海报重试；视频继续生成'
      : '海报生成失败，可单独重试；视频继续生成';
    if (!ambiguous) {
      for (const asset of run.artifacts.images || []) {
        if (asset.status === 'submitting' && !asset.taskId) {
          asset.status = 'failed';
          asset.error = cleanError(error);
        }
      }
    }
    setStage(run, 'P3_5', status, { label, error: cleanError(error), nonBlocking: true });
    addEvent(run, ambiguous ? 'image_submission_ambiguous' : 'poster_branch_partial', `${label}: ${cleanError(error)}`);
    await saveRun(redis, run);
  }
}

// Process exactly one durable pipeline transition.  Keeping this primitive
// single-step is important for callers that need a tight request budget and
// for the paid-media idempotency tests below.  The worker uses
// `processRunBatch` (defined after this function) to make a one-click request
// continue through all immediately-runnable free stages without requiring a
// browser click for every node.
async function processRunOnce(redis, run) {
  if (run.state === 'queued') {
    run.state = 'running';
    addEvent(run, 'worker_started', 'One-click production started');
    await saveRun(redis, run);
  }
  const legacyPosterFailure = run.stages.P3_5?.status === 'failed' && run.stages.P3?.status === 'done' && !['failed', 'ambiguous'].includes(run.stages.P4?.status);
  const legacyPosterAmbiguous = run.stages.P3_5?.status === 'ambiguous' && run.stages.P3?.status === 'done' && !['failed', 'ambiguous', 'blocked'].includes(run.stages.P4?.status);
  if (autoRecoverableStoryFailure(run)) {
    const story = run.artifacts.evidence.storyBrief || {};
    run.state = 'running';
    const nextAttemptAt = new Date().toISOString();
    run.artifacts.evidence.storyBrief = { ...story, status: 'recovering', nextAttemptAt, repairInstruction: 'Return only the required compact JSON object; preserve every supplied chapter quote.' };
    setStage(run, 'P2', 'waiting', { phase: 'story_intelligence_repairing', recoverable: true, nextAttemptAt, error: '', label: '旧任务的全书分析正在后台自动修复' });
    addEvent(run, 'legacy_story_failure_recovered', 'A legacy malformed story-analysis result was reopened for automatic model repair from saved evidence');
    await saveRun(redis, run);
  }
  const recoverableCreativeFailure = run.state === 'failed'
    && run.stages.P3?.status === 'failed'
    && run.stages.P3?.recoverable !== false
    && !['waiting_for_operator', 'validation_waiting_for_operator', 'configuration_error'].includes(String(run.stages.P3?.phase || ''))
    && run.artifacts?.book
    && run.artifacts?.evidence?.chapters?.length
    && run.artifacts?.code
    && run.artifacts?.shortUrl
    && !run.artifacts?.video
    && !(run.artifacts?.images || []).some((item) => item?.taskId);
  if (recoverableCreativeFailure || autoRecoverableCreativeFailure(run)) {
    run.state = 'running';
    run.stages.P3 = { ...run.stages.P3, status: 'waiting', phase: 'recovered', attempt: 0, nextAttemptAt: '', error: '', recoverable: true, label: '旧创意失败已自动恢复，正在重新路由模型' };
    addEvent(run, 'legacy_creative_failure_recovered', 'Legacy P3 failure was restored from saved evidence and tracking data');
    await saveRun(redis, run);
  }
  if ((run.state === 'failed' && legacyPosterFailure) || (run.state === 'blocked' && legacyPosterAmbiguous)) {
    run.stages.P3_5 = {
      ...run.stages.P3_5,
      status: legacyPosterAmbiguous ? 'ambiguous' : 'partial',
      nonBlocking: true,
      label: legacyPosterAmbiguous ? '海报结果需人工核验；视频继续生成' : '海报失败，可单独重试；视频继续生成'
    };
    run.state = 'running';
    addEvent(run, 'legacy_poster_failure_recovered', 'Legacy poster-only failure was isolated so the video branch can continue');
    await saveRun(redis, run);
  }
  if (['completed', 'failed', 'blocked'].includes(run.state)) return run;
  let activeStage = 'P1';
  try {
    if (run.stages.P1.status !== 'done') { activeStage = 'P1'; await p1(redis, run); return run; }
    if (run.stages.P2.status !== 'done') { activeStage = 'P2'; await p2(redis, run); return run; }
    if (run.stages.P5.status !== 'done') { activeStage = 'P5'; await p5(redis, run); return run; }
    if (run.stages.P3.status !== 'done') {
      const retryAt = Date.parse(run.stages.P3.nextAttemptAt || '');
      if (run.stages.P3.status === 'waiting' && Number.isFinite(retryAt) && retryAt > Date.now()) return run;
      activeStage = 'P3'; await p3(redis, run); return run;
    }
    const optimization = run.artifacts.optimization;
    if (optimization?.status === 'awaiting_confirmation') {
      const dueAt = Date.parse(optimization.dueAt || '');
      if (!Number.isFinite(dueAt) || dueAt > Date.now()) return run;
      activeStage = 'P3';
      addEvent(run, 'creative_optimization_auto_applied', `No operator decision after one minute; ${creativeModelLabel(run)} is applying the recommended refinement.`);
      await p3(redis, run, { posts: run.artifacts.posts, videoPrompt: run.artifacts.videoPrompt, posterPrompts: run.artifacts.posterPrompts }, true);
      return run;
    }
    // Once both paid branches have durable task IDs, alternate polling. This
    // keeps poster progress visible while AC is still rendering a video.
    if (run.stages.P4.status === 'running' && !posterTerminal(run.stages.P3_5.status)) {
      const videoRetryAt = Date.parse(run.stages.P4.nextAttemptAt || '');
      if (Number.isFinite(videoRetryAt) && videoRetryAt > Date.now()) {
        activeStage = 'P3_5'; await advancePosters(redis, run); return run;
      }
      run.artifacts.mediaPollTurn = run.artifacts.mediaPollTurn === 'posters' ? 'video' : 'posters';
      if (run.artifacts.mediaPollTurn === 'posters') { activeStage = 'P3_5'; await advancePosters(redis, run); return run; }
      activeStage = 'P4'; await p4(redis, run); return run;
    }
    if (!terminal(run.stages.P4.status) && !['running'].includes(run.stages.P4.status)) { activeStage = 'P4'; await p4(redis, run); return run; }
    if (!terminal(run.stages.P3_5.status) && (run.stages.P3_5.status !== 'running' || (run.artifacts.images || []).some((item) => ['prepared', 'submitting'].includes(item.status)))) { activeStage = 'P3_5'; await advancePosters(redis, run); return run; }
    if (run.stages.P4.status === 'running') { activeStage = 'P4'; await p4(redis, run); return run; }
    if (!posterTerminal(run.stages.P3_5.status)) { activeStage = 'P3_5'; await advancePosters(redis, run); return run; }
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

// A compact fingerprint is enough to tell whether a worker invocation made a
// durable transition.  We deliberately exclude `updatedAt`: analytics and
// diagnostic saves may update that timestamp without advancing production.
function runProgressFingerprint(run) {
  const stageNames = ['P1', 'P2', 'P3', 'P3_5', 'P4', 'P5', 'P6'];
  const stages = stageNames.map((name) => {
    const stage = run?.stages?.[name] || {};
    return [name, stage.status || '', stage.phase || '', stage.cursor || 0,
      stage.nextAttemptAt || '', stage.attempt || 0, stage.retryCount || 0,
      stage.codeAttempts || 0, stage.threadId || ''].join(':');
  }).join('|');
  const artifacts = run?.artifacts || {};
  const imageState = (Array.isArray(artifacts.images) ? artifacts.images : [])
    .map((item) => [item.variant || '', item.status || '', item.taskId || '', item.url || ''].join(':')).join('|');
  const video = artifacts.video || {};
  const creative = artifacts.creativeDraft || {};
  const parts = Object.keys(creative.parts || {}).sort().join(',');
  return [run?.state || '', stages, artifacts.code || '', artifacts.linkId || '',
    artifacts.shortUrl || '', video.status || '', video.threadId || '',
    (video.videoUrls || [])[0] || '', video.lastCheckedAt || '', imageState, parts].join('||');
}

function stageProgressFingerprint(stage = {}) {
  return [stage.status || '', stage.phase || '', stage.cursor || 0,
    stage.nextAttemptAt || '', stage.attempt || 0, stage.retryCount || 0,
    stage.codeAttempts || 0, stage.threadId || '', stage.error || ''].join(':');
}

function pendingFutureRetry(run) {
  const future = (stage) => {
    // Stage objects retain diagnostic retry timestamps after completion.  A
    // stale timestamp on a `done`/`prepared` stage must never freeze the
    // one-click worker forever.
    if (!['waiting', 'running'].includes(String(stage?.status || ''))) return false;
    const at = Date.parse(stage?.nextAttemptAt || '');
    return Number.isFinite(at) && at > Date.now();
  };
  if (future(run?.stages?.P2) || future(run?.stages?.P3)) return true;
  const videoBackoff = future(run?.stages?.P4);
  const posterBackoff = future(run?.stages?.P3_5);
  // Media branches are independent.  A temporary AC poll backoff must not
  // stop a poster from being prepared/submitted, and vice versa.
  if (videoBackoff && posterBackoff) return true;
  if (videoBackoff && posterTerminal(run?.stages?.P3_5?.status)) return true;
  if (posterBackoff && terminal(run?.stages?.P4?.status)) return true;
  return false;
}

function externalMediaInFlight(run) {
  const videoStage = run?.stages?.P4 || {};
  const video = run?.artifacts?.video || {};
  const videoInFlight = ['submitting', 'running'].includes(String(videoStage.status || ''))
    && (video.threadId || video.status === 'submitting' || video.status === 'running');
  const posterStage = run?.stages?.P3_5 || {};
  const images = Array.isArray(run?.artifacts?.images) ? run.artifacts.images : [];
  const posterInFlight = ['submitting', 'running'].includes(String(posterStage.status || ''))
    && images.some((item) => ['submitting', 'running', 'queued'].includes(String(item?.status || '')) && item?.taskId);
  return { videoInFlight, posterInFlight };
}

function mediaPollFingerprint(run) {
  const video = run?.artifacts?.video || {};
  const images = Array.isArray(run?.artifacts?.images) ? run.artifacts.images : [];
  return {
    video: [video.status || '', video.threadId || '', video.lastCheckedAt || '',
      video.lastPollError || '', (video.videoUrls || [])[0] || ''].join(':'),
    posters: images.map((item) => [item.variant || '', item.status || '', item.taskId || '',
      item.lastCheckedAt || '', item.error || '', item.url || ''].join(':')).join('|')
  };
}

/**
 * Advance a run through all work that is safe to do in the current request.
 *
 * The old worker called `processRun` once, so P1 -> P2 -> P5 -> P3 required a
 * separate cron tick or a browser action for every transition.  This batch
 * wrapper removes that artificial click boundary while retaining hard safety
 * boundaries:
 *
 * - every transition is persisted by the existing stage functions;
 * - a future retry/backoff pauses the batch;
 * - once an external paid task is submitted, at most one poll is performed in
 *   this invocation and the durable task ID is left for the next worker tick;
 * - no progress means stop, preventing a hot loop on a locked or waiting run;
 * - the caller can bound steps/time for the deployment's function budget.
 */
async function processRunBatch(redis, run, options = {}) {
  const maxSteps = Math.max(1, Math.min(Number(options.maxSteps) || 10, 30));
  const maxRuntimeMs = Math.max(5000, Math.min(Number(options.maxRuntimeMs) || 240000, 700000));
  const stopAfterMedia = options.stopAfterMedia !== false;
  const startedAt = Date.now();
  const stages = [];
  let steps = 0;
  let progressed = false;
  let stopReason = 'max_steps';

  while (steps < maxSteps && Date.now() - startedAt < maxRuntimeMs) {
    if (!run || ['completed', 'failed', 'blocked'].includes(String(run.state || ''))) {
      stopReason = run?.state === 'completed' ? 'completed' : run?.state === 'failed' ? 'failed' : run?.state === 'blocked' ? 'blocked' : 'missing';
      break;
    }
    if (pendingFutureRetry(run)) {
      stopReason = 'backoff';
      break;
    }
    const before = runProgressFingerprint(run);
    const beforeStages = Object.fromEntries(Object.entries(run.stages || {})
      .map(([name, stage]) => [name, stageProgressFingerprint(stage)]));
    const beforeMedia = externalMediaInFlight(run);
    const beforeMediaPoll = mediaPollFingerprint(run);
    const updated = await processRunOnce(redis, run);
    run = updated || run;
    steps += 1;
    const after = runProgressFingerprint(run);
    const changed = before !== after;
    progressed = progressed || changed;
    const afterMedia = externalMediaInFlight(run);
    const afterMediaPoll = mediaPollFingerprint(run);
    const changedStages = Object.entries(run.stages || {}).filter(([name, stage]) => beforeStages[name] !== stageProgressFingerprint(stage)).map(([name]) => name);
    stages.push(...changedStages);

    if (!changed) {
      stopReason = 'no_progress';
      break;
    }
    if (['completed', 'failed', 'blocked'].includes(String(run.state || ''))) {
      stopReason = run.state;
      break;
    }
    // Do not spin on paid-provider polling.  A transition into an external
    // in-flight state is already useful progress; leave the durable ID for the
    // next cron tick so the provider is not hammered and no duplicate charge
    // can be caused by a second browser request.
    if (stopAfterMedia && ((!beforeMedia.videoInFlight && afterMedia.videoInFlight)
      || (!beforeMedia.posterInFlight && afterMedia.posterInFlight))) {
      stopReason = 'media_submitted';
      break;
    }
    const videoPolled = beforeMedia.videoInFlight && afterMedia.videoInFlight
      && !changedStages.includes('P3_5')
      && (beforeMediaPoll.video !== afterMediaPoll.video || changedStages.includes('P4') || changedStages.length === 0);
    const posterPolled = beforeMedia.posterInFlight && afterMedia.posterInFlight
      && !changedStages.includes('P4')
      && (beforeMediaPoll.posters !== afterMediaPoll.posters || changedStages.includes('P3_5') || changedStages.length === 0);
    if (stopAfterMedia && (videoPolled || posterPolled)) {
      stopReason = 'media_poll';
      break;
    }
    if (pendingFutureRetry(run)) {
      stopReason = 'backoff';
      break;
    }
  }
  if (steps >= maxSteps && stopReason === 'max_steps') stopReason = 'max_steps';
  else if (Date.now() - startedAt >= maxRuntimeMs && !['completed', 'failed', 'blocked'].includes(String(run?.state || ''))) stopReason = 'time_budget';
  return {
    run,
    steps,
    progressed,
    stopReason,
    elapsedMs: Date.now() - startedAt,
    stages: [...new Set(stages)]
  };
}

async function processRun(redis, run, options = {}) {
  return options?.batch ? processRunBatch(redis, run, options) : processRunOnce(redis, run);
}

module.exports = { processRun, processRunOnce, processRunBatch, p3, selectedChapters, normalizeCreative, summarizeAnalytics, refreshAnalytics, cleanError, videoPayload, referenceVideoPayload };
