const { getRedis, getRun, getRunDetail, getRunSummary, listRuns, listRunSummaries, newRun, saveRun, getCreativePlan, registerActiveRun, findActiveRun, acquireRunCreation, releaseRunCreation } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const { normalizeCreative, refreshAnalytics } = require('./_lib/pipeline');
const providers = require('./_lib/providers');

const text = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
const publicError = (error, fallback) => {
  const message = String(error?.message || fallback || 'The requested operation could not be completed')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gi, '[redacted]')
    .slice(0, 500);
  const status = Number(error?.status || 0);
  return { status: status >= 400 && status < 600 ? status : 502, message };
};
const CREATIVE_PROFILE_OPTIONS = Object.freeze({
  copyStyle: new Set(['system_best', 'revenge_comeback', 'forbidden_tension', 'dark_redemption']),
  ctaStyle: new Set(['story_cliffhanger', 'identity_reveal', 'romantic_tension', 'revenge_payoff']),
  videoStyle: new Set(['five_beat', 'reversal', 'slow_burn', 'revenge']),
  posterStyle: new Set(['system_best', 'luminous_cinema', 'editorial_romance']),
  modelChoice: new Set(['hy3', 'deepseek', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'kimi-k2.7-code', 'qwen3.5-flash', 'glm-4.5-air', 'kimi-k2.5', 'minimax-m2.5', 'glm-5.2', 'kimi-k3', 'minimax-m3'])
});

function sanitizeCreativeProfile(value) {
  const profile = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.entries(CREATIVE_PROFILE_OPTIONS).map(([key, allowed]) => {
    const selected = String(profile[key] || '').trim();
    return [key, allowed.has(selected) ? selected : [...allowed][0]];
  }));
}

function sanitizePlanning(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    planId: text(value.planId, 100),
    preferredModel: CREATIVE_PROFILE_OPTIONS.modelChoice.has(String(value.preferredModel || '')) ? String(value.preferredModel) : '',
    actualModel: CREATIVE_PROFILE_OPTIONS.modelChoice.has(String(value.actualModel || '')) ? String(value.actualModel) : '',
    fallbackUsed: value.fallbackUsed === true
  };
}

function buildRunInput(book, body = {}, planning = null) {
  return {
    title: book.title,
    sku: book.bookSkuId,
    source: text(body.source, 100) || 'manual',
    automationMode: 'one_click',
    promoter: text(body.promoter, 80) || 'xujt',
    videoTemplate: text(body.videoTemplate, 80) || 'adaptive_seedance',
    fullBookEvidence: body.fullBookEvidence !== false,
    paidAuthorized: body.paidAuthorized === true,
    creativeProfile: sanitizeCreativeProfile(body.creativeProfile),
    planning,
    requestedAt: new Date().toISOString()
  };
}

async function waitForActiveRun(redis, sku, attempts = 6) {
  for (let index = 0; index < attempts; index += 1) {
    const existing = await findActiveRun(redis, sku);
    if (existing) return existing;
    if (index < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

// Full runs contain every downloaded chapter and provider payload. Returning
// that raw object makes a detail click compete with the worker for bandwidth
// and can leave a serverless response open for minutes. Keep the UI contract,
// but bound the evidence and diagnostic fields that are only needed for the
// detail view.
function detailPayload(run) {
  const copy = JSON.parse(JSON.stringify(run));
  const artifacts = copy.artifacts || {};
  if (artifacts.book) {
    artifacts.book.description = String(artifacts.book.description || '').slice(0, 4000);
  }
  if (artifacts.evidence && Array.isArray(artifacts.evidence.chapters)) {
    const chapters = artifacts.evidence.chapters;
    artifacts.evidence.chapterCount = chapters.length;
    artifacts.evidence.chapters = chapters.slice(0, 80).map((chapter) => ({
      ...chapter,
      content: String(chapter.content || '').slice(0, 8000),
      title: String(chapter.title || '').slice(0, 300)
    }));
  }
  // The chapter index is useful to the worker, not to the browser detail view.
  delete artifacts.chapterList;
  if (artifacts.creativeDraft) {
    const draft = artifacts.creativeDraft;
    artifacts.creativeDraft = {
      parts: Object.fromEntries(Object.entries(draft.parts || {}).map(([key, value]) => [key, { status: value?.status || 'ready' }])),
      inFlight: draft.inFlight || {},
      failures: Object.fromEntries(Object.entries(draft.failures || {}).map(([key, value]) => [key, {
        attempt: value?.attempt || 1,
        error: String(value?.error || '').slice(0, 300),
        nextAttemptAt: value?.nextAttemptAt || ''
      }])),
      usage: Array.isArray(draft.usage) ? draft.usage.slice(-24) : []
    };
  }
  if (Array.isArray(artifacts.events)) artifacts.events = artifacts.events.slice(-120);
  if (Array.isArray(copy.events)) copy.events = copy.events.slice(-80).map((event) => ({ at: event.at, type: event.type, message: String(event.message || '').slice(0, 500) }));
  if (Array.isArray(artifacts.posts)) artifacts.posts = artifacts.posts.map((post) => ({ ...post, content: String(post.content || '').slice(0, 12000), zhContent: String(post.zhContent || '').slice(0, 12000) }));
  if (Array.isArray(artifacts.images)) artifacts.images = artifacts.images.map((image) => ({ ...image, prompt: String(image.prompt || '').slice(0, 5000), zhPrompt: String(image.zhPrompt || '').slice(0, 5000) }));
  if (artifacts.videoPrompt) artifacts.videoPrompt = { ...artifacts.videoPrompt, adCopy: String(artifacts.videoPrompt.adCopy || '').slice(0, 10000), buildRequirement: String(artifacts.videoPrompt.buildRequirement || '').slice(0, 10000) };
  if (artifacts.videoPromptDraft) artifacts.videoPromptDraft = { ...artifacts.videoPromptDraft, adCopy: String(artifacts.videoPromptDraft.adCopy || '').slice(0, 10000), buildRequirement: String(artifacts.videoPromptDraft.buildRequirement || '').slice(0, 10000) };
  copy.artifacts = artifacts;
  return copy;
}

function copyAssetPayload(run) {
  return {
    id: run.id,
    posts: (Array.isArray(run?.artifacts?.posts) ? run.artifacts.posts : []).map((post) => ({
      type: String(post?.type || ''),
      content: String(post?.content || '').slice(0, 12000),
      zhContent: String(post?.zhContent || '').slice(0, 12000)
    }))
  };
}

async function listRunsPayload(redis, loader = listRunSummaries) {
  return { runs: await loader(redis, 50) };
}

async function archiveFailedRuns(redis, loader = listRuns) {
  // Read the durable index, rather than just the currently visible list, so a
  // failed task cannot reappear after older entries are paged into view.
  const runs = await loader(redis, 500);
  const archived = [];
  for (const run of runs) {
    const hasFailedStage = Object.values(run?.stages || {}).some((stage) => stage?.status === 'failed');
    if (run?.state !== 'failed' && !hasFailedStage) continue;
    run.state = 'archived';
    run.archivedAt = new Date().toISOString();
    run.events = [...(run.events || []), { at: run.archivedAt, type: 'failed_run_archived', message: 'Operator cleared this failed task from the production console; external Code, links, and paid task records remain unchanged' }].slice(-80);
    await saveRun(redis, run);
    archived.push(run.id);
  }
  return archived;
}

async function loadRunView(redis, id, detailLoader = getRunDetail, summaryLoader = getRunSummary, detailDeadlineMs = 2500) {
  // A drawer must never wait on a large/legacy detail snapshot before it can
  // show the durable progress summary. The summary is written with every run
  // transition, while an older detail snapshot can be rebuilt in the background.
  const summary = await summaryLoader(redis, id);
  if (!summary) {
    const detail = await detailLoader(redis, id);
    return detail ? { run: detail, partial: false } : { run: null, partial: false };
  }
  let timeout;
  const detail = await Promise.race([
    Promise.resolve().then(() => detailLoader(redis, id)).catch(() => null),
    new Promise((resolve) => { timeout = setTimeout(() => resolve(null), detailDeadlineMs); })
  ]);
  clearTimeout(timeout);
  if (detail) return { run: detail, partial: false };
  return { run: { ...summary, _summary: false, _detailPartial: true }, partial: true };
}

async function resolvePlanning(redis, value) {
  const planning = sanitizePlanning(value);
  if (!planning?.planId) return planning;
  const job = await getCreativePlan(redis, planning.planId);
  if (!job || job.state !== 'completed' || !job.artifacts?.plan) return planning;
  const plan = job.artifacts.plan;
  return {
    ...planning,
    preferredModel: job.input?.preferredModelChoice || planning.preferredModel,
    actualModel: job.artifacts?.usage?.model || job.input?.modelChoice || planning.actualModel,
    fallbackUsed: Boolean(job.input?.fallbackUsed),
    completedAt: job.stages?.analysis?.completedAt || job.updatedAt,
    strategy: {
      editorialThesis: String(plan.editorialThesis || '').slice(0, 1200),
      rationale: plan.rationale && typeof plan.rationale === 'object' ? plan.rationale : {},
      recommendedProfile: plan.recommendedProfile && typeof plan.recommendedProfile === 'object' ? plan.recommendedProfile : {},
      copyBlueprint: plan.copyBlueprint && typeof plan.copyBlueprint === 'object' ? plan.copyBlueprint : {},
      videoBlueprint: plan.videoBlueprint && typeof plan.videoBlueprint === 'object' ? plan.videoBlueprint : {},
      posterBlueprint: plan.posterBlueprint && typeof plan.posterBlueprint === 'object' ? plan.posterBlueprint : {},
      evidence: Array.isArray(plan.evidence) ? plan.evidence.slice(0, 5).map((item) => ({ chapter: Number(item.chapter || 0), quote: String(item.quote || '').slice(0, 240), why: String(item.why || '').slice(0, 300) })) : []
    }
  };
}

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  try {
    if (req.method === 'GET') {
      const id = text(req.query?.id, 100);
      const view = id ? await loadRunView(redis, id) : { run: null, partial: false };
      if (id && !view.run) return res.status(404).json({ error: 'Run not found' });
      if (id && req.query?.asset === 'copy') return !view.partial ? res.status(200).json(copyAssetPayload(view.run)) : res.status(202).json({ pending: true, posts: [] });
      if (req.query?.id && req.query?.asset) return res.status(400).json({ error: 'Unsupported asset view' });
      if (id && !view.partial) return res.status(200).json({ run: view.run });
      if (id && view.partial) return res.status(202).json(view);
      return res.status(200).json(await listRunsPayload(redis));
    }
    if (req.method === 'PATCH') {
      if (req.body?.action === 'archive_failed_all') {
        return res.status(200).json({ archived: await archiveFailedRuns(redis) });
      }
      const run = await getRun(redis, text(req.body?.id, 100));
      if (!run) return res.status(404).json({ error: 'Run not found' });
      if (req.body?.action === 'refresh_analytics') {
        if (!run.artifacts?.linkId && !run.artifacts?.code) return res.status(409).json({ error: 'A verified Code or link is required before querying analytics' });
        const days = Math.max(1, Math.min(Number(req.body?.days) || 30, 180));
        await refreshAnalytics(run, days);
        run.events.push({ at: new Date().toISOString(), type: 'analytics_refreshed', message: `Real-time attribution refreshed for the most recent ${days} days` });
        await saveRun(redis, run, { preserveUpdatedAt: true });
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'delete_asset') {
        const asset = text(req.body?.asset, 40);
        const paidInFlight = (value) => ['submitting', 'running'].includes(String(value?.status || ''));
        if (asset === 'copy') {
          run.artifacts.posts = [];
          run.artifacts.translations = null;
          if (run.artifacts.review) run.artifacts.review.posts = [];
        } else if (asset === 'video') {
          if (paidInFlight(run.artifacts.video)) return res.status(409).json({ error: 'The paid video is still generating and cannot be removed yet' });
          run.artifacts.video = null;
          if (run.artifacts.review) run.artifacts.review.video = null;
        } else if (asset === 'reference_video') {
          if (paidInFlight(run.artifacts.referenceVideo)) return res.status(409).json({ error: 'The reference video is still generating and cannot be removed yet' });
          run.artifacts.referenceVideo = null;
        } else if (asset === 'posters') {
          if ((run.artifacts.images || []).some(paidInFlight)) return res.status(409).json({ error: 'A paid poster is still generating and cannot be removed yet' });
          run.artifacts.images = [];
          if (run.artifacts.review) run.artifacts.review.images = [];
        } else {
          return res.status(400).json({ error: 'Unsupported asset removal' });
        }
        run.events.push({ at: new Date().toISOString(), type: 'asset_removed', message: `${asset} removed from the console view` });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'creative_variant') {
        if (!run.artifacts?.book || !run.artifacts?.evidence?.chapters?.length || !run.artifacts?.code) return res.status(409).json({ error: 'Creative inputs are not ready' });
        const current = { posts: run.artifacts.posts, videoPrompt: run.artifacts.videoPrompt, posterPrompts: run.artifacts.posterPrompts };
        const result = await providers.generateCreative(run.artifacts.book, run.artifacts.evidence.chapters, run.artifacts.code, run.artifacts.shortUrl, current, run.input.creativeProfile || {});
        const creative = normalizeCreative(result, run);
        run.artifacts.creativeVersions = [...(run.artifacts.creativeVersions || []), { at: new Date().toISOString(), posts: run.artifacts.posts, videoPrompt: run.artifacts.videoPrompt, posterPrompts: run.artifacts.posterPrompts }].slice(-3);
        run.artifacts.posts = creative.posts;
        run.artifacts.translations = { language: 'zh-CN', posts: creative.posts.map((item) => item.zhContent) };
        run.artifacts.videoPrompt = creative.videoPrompt;
        run.artifacts.posterPrompts = creative.posterPrompts;
        run.artifacts.qualityReview = creative.qualityReview;
        run.artifacts.qualityReview.phase = 'post_generation';
        run.artifacts.qualityReview.reviewedAt = new Date().toISOString();
        run.artifacts.optimization = { status: 'manual_variant_applied', review: creative.qualityReview, resolvedAt: new Date().toISOString() };
        run.artifacts.usage = run.artifacts.usage || {};
        run.artifacts.usage.creativeVariant = { model: result.model, responseId: result.responseId, ...result.usage };
        run.events.push({ at: new Date().toISOString(), type: 'creative_variant_ready', message: 'The selected AI model created a new evidence-grounded creative version' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'rewrite_video_prompt') {
        if (!run.artifacts?.book || !run.artifacts?.evidence?.chapters?.length || !run.artifacts?.code) return res.status(409).json({ error: 'Locked book, chapter evidence, and Code are required before rewriting a video prompt' });
        const current = { videoPrompt: run.artifacts.videoPrompt };
        const result = await providers.generateCreative(run.artifacts.book, run.artifacts.evidence.chapters, run.artifacts.code, run.artifacts.shortUrl, current, run.input.creativeProfile || {}, 'videoPrompt');
        const draft = result.creative?.videoPrompt || {};
        for (const key of ['hook', 'valuePromise', 'escalation', 'reversal', 'cliffhanger', 'adCopy', 'buildRequirement']) if (String(draft[key] || '').trim().length < 12) throw new providers.ProviderError(`Video rewrite omitted ${key}`);
        if (!Array.isArray(draft.sourceEvidence) || draft.sourceEvidence.length < 3) throw new providers.ProviderError('Video rewrite requires three source evidence beats');
        run.artifacts.videoPromptDraft = { ...draft, status: 'ready_for_review', id: `video_${Date.now().toString(36)}`, generatedAt: new Date().toISOString(), model: result.model, responseId: result.responseId, usage: result.usage };
        run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), { section: 'videoPromptRewrite', requestedModel: run.input?.creativeProfile?.modelChoice, model: result.model, responseId: result.responseId, completedAt: new Date().toISOString(), ...result.usage }].slice(-24);
        run.events.push({ at: new Date().toISOString(), type: 'video_prompt_rewritten', message: 'AI produced a source-grounded video prompt draft for operator review; no paid video was submitted' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'approve_video_prompt') {
        const draft = run.artifacts?.videoPromptDraft;
        if (!draft || draft.status !== 'ready_for_review') return res.status(409).json({ error: 'No video-prompt draft is waiting for review' });
        run.artifacts.videoPrompt = { ...draft };
        run.artifacts.videoPromptDraft = { ...draft, status: 'approved', approvedAt: new Date().toISOString() };
        run.artifacts.videoRevision = null;
        run.events.push({ at: new Date().toISOString(), type: 'video_prompt_approved', message: 'Operator approved the rewritten video prompt; a separate confirmation is still required before paid video submission' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'discard_video_prompt') {
        if (!run.artifacts?.videoPromptDraft) return res.status(409).json({ error: 'No video-prompt draft is available to discard' });
        run.artifacts.videoPromptDraft = null;
        run.events.push({ at: new Date().toISOString(), type: 'video_prompt_discarded', message: 'Operator kept the previous video prompt' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'distribution_plan') {
        if (!run.artifacts?.book || !run.artifacts?.posts?.length) return res.status(409).json({ error: 'Finished copy is required before creating a distribution recommendation' });
        const result = await providers.generateDistributionPlan(run.artifacts.book, {
          posts: run.artifacts.posts, videoPrompt: run.artifacts.videoPrompt, posterPrompts: run.artifacts.posterPrompts,
          storyBrief: run.artifacts.storyBrief?.plan || null
        }, run.artifacts?.modelRoute?.activeModel || run.input?.creativeProfile?.modelChoice || 'hy3');
        run.artifacts.distribution = { ...result.plan, status: 'ready', generatedAt: new Date().toISOString(), model: result.model };
        if (run.artifacts.review) run.artifacts.review.distribution = run.artifacts.distribution;
        run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), { section: 'distribution', requestedModel: run.artifacts?.modelRoute?.activeModel || run.input?.creativeProfile?.modelChoice || 'hy3', model: result.model, responseId: result.responseId, completedAt: new Date().toISOString(), ...result.usage }].slice(-24);
        run.events.push({ at: new Date().toISOString(), type: 'distribution_ready', message: 'Manual channel recommendations and reusable hook are ready' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'set_creative_model') {
        const modelChoice = text(req.body?.modelChoice, 80);
        if (!CREATIVE_PROFILE_OPTIONS.modelChoice.has(modelChoice)) return res.status(400).json({ error: 'Unsupported creative model' });
        if (run.stages?.P3?.status === 'done' || run.artifacts?.video || (run.artifacts?.images || []).length) return res.status(409).json({ error: 'The creative model cannot change after creative media has started' });
        run.input.creativeProfile = { ...(run.input.creativeProfile || {}), modelChoice };
        const planning = await resolvePlanning(redis, req.body?.planning);
        if (planning && !run.input?.planning?.strategy) run.input.planning = planning;
        delete run.artifacts.creativeDraft;
        run.state = 'running';
        run.stages.P3 = { status: 'waiting', attempt: 0, phase: 'model_switched', nextAttemptAt: '', error: '', label: `${modelChoice} queued for creative generation` };
        run.events.push({ at: new Date().toISOString(), type: 'creative_model_switched', message: `Creative model switched to ${modelChoice} before paid media submission` });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'attach_planning_snapshot') {
        if (run.input?.planning?.strategy) {
          if (run.artifacts?.qualityReview && !run.artifacts.qualityReview.phase) {
            const reviewActivity = [...(run.artifacts.modelActivity || [])].reverse().find((item) => item.section === 'qualityReview' && item.validationStatus !== 'rejected');
            run.artifacts.qualityReview.phase = 'post_generation';
            run.artifacts.qualityReview.reviewedAt = reviewActivity?.completedAt || run.stages?.P3?.completedAt || run.updatedAt;
            await saveRun(redis, run);
            return res.status(200).json({ run, migrated: true });
          }
          return res.status(200).json({ run, unchanged: true });
        }
        const planning = await resolvePlanning(redis, req.body?.planning);
        if (!planning?.strategy) return res.status(409).json({ error: 'Completed pre-production strategy not found' });
        run.input.planning = planning;
        run.events.push({ at: new Date().toISOString(), type: 'planning_snapshot_attached', message: 'Immutable pre-production strategy snapshot attached to the run' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'optimization_decision') {
        const decision = text(req.body?.decision, 20);
        const optimization = run.artifacts?.optimization;
        if (optimization?.status !== 'awaiting_confirmation') return res.status(409).json({ error: 'No pending AI optimization exists for this run' });
        if (decision === 'apply') {
          optimization.dueAt = new Date(Date.now() - 1000).toISOString();
          optimization.status = 'awaiting_confirmation';
          run.events.push({ at: new Date().toISOString(), type: 'creative_optimization_confirmed', message: 'Operator confirmed the DeepSeek refinement' });
        } else if (decision === 'keep') {
          optimization.status = 'kept_by_operator';
          optimization.resolvedAt = new Date().toISOString();
          run.events.push({ at: new Date().toISOString(), type: 'creative_optimization_kept', message: 'Operator kept the current creative package' });
        } else return res.status(400).json({ error: 'Unsupported optimization decision' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action !== 'retry') return res.status(400).json({ error: 'Unsupported action' });
      const blocked = Object.entries(run.stages).find(([, value]) => value.status === 'ambiguous');
      if (blocked) return res.status(409).json({ error: `${blocked[0]} has an ambiguous paid submission and cannot be retried automatically` });
      const hourlyLimit = Object.entries(run.stages).find(([, value]) => value.status === 'blocked' && value.blockedReason === 'hourly_video_limit');
      if (hourlyLimit) {
        run.state = 'running';
        run.stages[hourlyLimit[0]] = { ...hourlyLimit[1], status: 'prepared', retryCount: Number(hourlyLimit[1].retryCount || 0) + 1, error: '' };
        run.events.push({ at: new Date().toISOString(), type: 'video_limit_retry_requested', message: 'Video submission queued after hourly limit block' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      const partialPoster = run.stages.P3_5?.status === 'partial' ? ['P3_5', run.stages.P3_5] : null;
      if (partialPoster) {
        const retryNumber = Number(partialPoster[1].retryCount || 0) + 1;
        for (const asset of run.artifacts.images || []) {
          if (!['failed', 'expired'].includes(String(asset.status || ''))) continue;
          asset.manualRetryCount = Number(asset.manualRetryCount || 0) + 1;
          asset.taskId = '';
          asset.url = '';
          asset.error = '';
          asset.status = 'prepared';
          asset.idempotencyKey = providers.sha(`${run.id}:${asset.variant}:${asset.prompt}:manual:${asset.manualRetryCount}`);
        }
        run.state = 'running';
        run.stages.P3_5 = { ...partialPoster[1], status: 'running', retryCount: retryNumber, error: '', label: '海报已单独排队重试，视频结果保持不变' };
        run.stages.P6 = { status: 'waiting' };
        run.events.push({ at: new Date().toISOString(), type: 'poster_manual_retry_requested', message: 'Operator explicitly queued the failed poster branch for one retry' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (run.state === 'failed' && run.stages.P3?.status === 'waiting') {
        run.state = 'running';
        run.stages.P3 = { ...run.stages.P3, recoverable: true, error: '', label: run.stages.P3.label || '已恢复已保存的创意分段，继续补齐剩余部分' };
        run.events.push({ at: new Date().toISOString(), type: 'inconsistent_creative_state_recovered', message: 'A saved creative section overrode an obsolete failed run state; remaining sections will continue' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      const failed = Object.entries(run.stages).find(([, value]) => value.status === 'failed');
      if (!failed) return res.status(409).json({ error: 'No failed stage to retry' });
      run.state = 'running';
      if (failed[0] === 'P3_5') {
        run.stages.P3_5 = { ...failed[1], status: 'running', retryCount: Number(failed[1].retryCount || 0) + 1, error: '' };
        run.events.push({ at: new Date().toISOString(), type: 'poster_repair_retry_requested', message: 'Failed poster queued for DeepSeek prompt repair or safe continuation' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      run.stages[failed[0]] = {
        status: 'waiting', retryCount: Number(failed[1].retryCount || 0) + 1,
        ...(failed[0] === 'P3' ? { attempt: 0, phase: 'manual_retry', nextAttemptAt: '', error: '' } : {})
      };
      run.events.push({ at: new Date().toISOString(), type: 'retry_requested', message: `${failed[0]} queued for retry` });
      await saveRun(redis, run);
      return res.status(200).json({ run });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const title = text(req.body?.title, 200);
    const sku = text(req.body?.sku, 100);
    if (!title) return res.status(400).json({ error: 'Exact book title is required' });
    let book;
    try {
      // Do this before creating any state: historical funnel titles can point
      // to removed or renamed books, which must never become failed jobs.
      book = await providers.findExactBook(title, sku);
    } catch (error) {
      const message = error?.status === 404
        ? `“${title}” is not an active exact NovelFlow bookstore record and cannot start automation.`
        : String(error?.message || 'Book identity validation failed');
      return res.status(422).json({ error: message });
    }
    const planning = await resolvePlanning(redis, req.body?.planning);
    if (planning?.planId) {
      const existing = (await listRunSummaries(redis, 50)).find((item) => String(item.input?.planning?.planId || '') === planning.planId);
      if (existing) return res.status(200).json({ run: existing, duplicate: true });
    }
    const input = buildRunInput(book, req.body || {}, planning);
    if (!input.paidAuthorized) return res.status(400).json({ error: 'One-click paid generation authorization is required' });
    // A double-click or an ambiguous network response must never create a
    // second paid-media path for the same book. The short lock covers the
    // creation race; the durable SKU pointer covers the lifetime of a run.
    const lock = await acquireRunCreation(redis, input.sku);
    if (!lock.acquired) {
      const existing = await waitForActiveRun(redis, input.sku);
      if (existing) return res.status(200).json({ run: existing, duplicate: true });
      return res.status(409).json({ error: 'A one-click task for this book is being created; please wait for its status to appear.' });
    }
    try {
      const existing = await findActiveRun(redis, input.sku);
      if (existing) return res.status(200).json({ run: existing, duplicate: true });
      const run = await saveRun(redis, newRun(input));
      await registerActiveRun(redis, run);
      return res.status(202).json({ run });
    } finally {
      await releaseRunCreation(redis, lock);
    }
  } catch (error) {
    console.error('[social/runs]', error);
    // Do not turn a model, validation, or storage diagnosis into the same
    // unhelpful message. The client needs a safe, actionable reason to keep
    // the failed-video rewrite path moving.
    const failure = publicError(error, 'Unable to update production run');
    return res.status(failure.status).json({ error: failure.message });
  }
};

module.exports.copyAssetPayload = copyAssetPayload;
module.exports.listRunsPayload = listRunsPayload;
module.exports.loadRunView = loadRunView;
module.exports.buildRunInput = buildRunInput;
module.exports.waitForActiveRun = waitForActiveRun;
module.exports.archiveFailedRuns = archiveFailedRuns;
