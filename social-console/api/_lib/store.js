const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const RUN_INDEX = 'nf_social:runs';
const PLAN_INDEX = 'nf_social:creative_plans';
const DISCORD_JOB_INDEX = 'nf_social:discord:jobs';
const DISCORD_HISTORY_INDEX = 'nf_social:discord:history';
const runKey = (id) => `nf_social:run:${id}`;
const runDetailKey = (id) => `nf_social:run_detail:${id}`;
const planKey = (id) => `nf_social:creative_plan:${id}`;
const runSummaryKey = (id) => `nf_social:run_summary:${id}`;
const planSummaryKey = (id) => `nf_social:creative_plan_summary:${id}`;
const ACTIVE_RUN_TTL = 90 * 24 * 60 * 60;
const RUN_CREATE_LOCK_TTL = 120;
const activeRunKey = (sku) => `nf_social:active_run:${crypto.createHash('sha256').update(String(sku || '').trim().toLowerCase()).digest('hex').slice(0, 32)}`;
const runCreateLockKey = (sku) => `nf_social:run_create_lock:${crypto.createHash('sha256').update(String(sku || '').trim().toLowerCase()).digest('hex').slice(0, 32)}`;
const RUN_SUMMARY_VERSION = 7;

const AUTOPILOT_STAGES = Object.freeze(['P1', 'P2', 'P5', 'P3', 'P3_5', 'P4', 'P6']);
const AUTOPILOT_LABELS = Object.freeze({
  P1: '核验书籍身份',
  P2: '读取章节并建立证据',
  P5: '创建并验证 Code / 短链',
  P3: '生成文案与创意提示词',
  P3_5: '生成推广海报',
  P4: '提交并等待视频生成',
  P6: '组装审核包并开启数据跟进'
});

function runIsActive(run) {
  const state = String(run?.state || '');
  if (['queued', 'running', 'blocked'].includes(state)) return true;
  if (state !== 'failed') return false;
  const videoTask = Boolean(run?.artifacts?.video?.threadId);
  const posterTask = (Array.isArray(run?.artifacts?.images) ? run.artifacts.images : []).some((item) => item?.taskId);
  return videoTask || posterTask;
}

function nextAutopilotAction(run) {
  const stages = run?.stages || {};
  const pending = AUTOPILOT_STAGES.find((name) => String(stages[name]?.status || 'waiting') !== 'done');
  if (!pending) return { nextAction: 'done', nextActionLabel: '全部生产节点已完成' };
  const stage = stages[pending] || {};
  const label = String(stage.label || AUTOPILOT_LABELS[pending] || pending).slice(0, 180);
  return { nextAction: pending, nextActionLabel: label };
}

/**
 * Return a small, safe, and backwards-compatible projection of the durable
 * one-click state. Old runs do not have this object; their state is derived
 * from the existing pipeline stages without rewriting the run on read.
 */
function autopilotProjection(run, options = {}) {
  const now = options.now || new Date().toISOString();
  const current = run?.autopilot && typeof run.autopilot === 'object' ? run.autopilot : {};
  const inputMode = String(run?.input?.automationMode || '').trim();
  const mode = String(current.mode || inputMode || 'legacy').slice(0, 40);
  const enabled = current.enabled === false ? false : (current.enabled === true || mode === 'one_click');
  const action = nextAutopilotAction(run);
  const state = String(run?.state || 'queued');
  let status;
  if (state === 'completed' || action.nextAction === 'done') status = 'completed';
  else if (state === 'blocked' || Object.values(run?.stages || {}).some((stage) => ['ambiguous', 'blocked'].includes(String(stage?.status || '')))) status = 'blocked';
  else if (state === 'failed') status = 'failed';
  else if (state === 'queued') {
    // A caller may save a stage transition before it flips the top-level
    // state. Treat that durable stage evidence as running instead of leaving
    // the dashboard on a stale queued badge.
    const hasProgress = Object.values(run?.stages || {}).some((stage) => !['waiting', ''].includes(String(stage?.status || '')));
    status = hasProgress ? 'running' : 'queued';
  }
  else {
    const pending = run?.stages?.[action.nextAction];
    status = pending && ['waiting', 'prepared'].includes(String(pending.status || '')) && Date.parse(pending.nextAttemptAt || '') > Date.now()
      ? 'waiting'
      : 'running';
  }
  return {
    enabled,
    mode,
    status,
    queuedAt: String(current.queuedAt || run?.createdAt || now),
    lastProgressAt: String(options.progress ? now : (current.lastProgressAt || run?.updatedAt || run?.createdAt || now)),
    nextAction: action.nextAction,
    nextActionLabel: action.nextActionLabel
  };
}
class RemoteRedis {
  constructor(url, secret) { this.url = url.replace(/\/$/, ''); this.secret = secret; }
  async call(op, args) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, args })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Social storage HTTP ${response.status}`);
    return body.result;
  }
  get(key) { return this.call('get', { key }); }
  mget(...keys) { return this.call('mget', { keys }); }
  set(key, value, options) { return this.call('set', { key, value, options }); }
  zrange(key, start, end, options) { return this.call('zrange', { key, start, end, options }); }
  zadd(key, entry) { return this.call('zadd', { key, entry }); }
  zrem(key, member) { return this.call('zrem', { key, member }); }
  incr(key) { return this.call('incr', { key }); }
  incrby(key, amount) { return this.call('incrby', { key, amount }); }
  del(key) { return this.call('del', { key }); }
}
function createRedis(environment = process.env) {
  const url = environment.KV_REST_API_URL;
  const token = environment.KV_REST_API_TOKEN;
  if (url && token && /^https:\/\//i.test(url)) return new Redis({ url, token });
  const bridgeUrl = environment.SOCIAL_STORE_URL;
  const bridgeSecret = environment.SOCIAL_STORE_SECRET;
  if (bridgeUrl && bridgeSecret) return new RemoteRedis(bridgeUrl, bridgeSecret);
  return null;
}
function getRedis() {
  return createRedis(process.env);
}
async function listRuns(redis, limit = 50) {
  if (!redis) return [];
  const ids = await redis.zrange(RUN_INDEX, 0, limit - 1, { rev: true });
  if (!ids.length) return [];
  const values = await Promise.all(ids.map((id) => redis.get(`nf_social:run:${id}`)));
  return values.filter(Boolean).map((value) => typeof value === 'string' ? JSON.parse(value) : value);
}
function parseStored(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function getMany(redis, keys) {
  if (!keys.length) return [];
  if (typeof redis.mget === 'function') {
    try { return await redis.mget(...keys); } catch {}
  }
  return Promise.all(keys.map((key) => redis.get(key)));
}

function summaryInput(input = {}) {
  const planning = input?.planning && typeof input.planning === 'object'
    ? {
      planId: String(input.planning.planId || ''),
      preferredModel: String(input.planning.preferredModel || ''),
      actualModel: String(input.planning.actualModel || ''),
      fallbackUsed: input.planning.fallbackUsed === true,
      completedAt: String(input.planning.completedAt || '')
    }
    : null;
  return {
    title: String(input?.title || ''),
    sku: String(input?.sku || ''),
    source: String(input?.source || '').slice(0, 100),
    automationMode: String(input?.automationMode || '').slice(0, 40),
    fullBookEvidence: input?.fullBookEvidence !== false,
    creativeProfile: input?.creativeProfile && typeof input.creativeProfile === 'object' ? input.creativeProfile : {},
    ...(planning ? { planning } : {})
  };
}

function summaryStages(stages = {}) {
  return Object.fromEntries(Object.entries(stages || {}).map(([name, stage]) => {
    const summary = { status: String(stage?.status || 'waiting') };
    const text = (key, value, limit) => {
      const normalized = String(value || '').slice(0, limit);
      if (normalized) summary[key] = normalized;
    };
    text('label', stage?.label, 180);
    text('error', stage?.error, 300);
    text('phase', stage?.phase, 100);
    if (stage?.recoverable === true) summary.recoverable = true;
    text('fallbackFrom', stage?.fallbackFrom, 100);
    text('fallbackReason', stage?.fallbackReason, 180);
    text('startedAt', stage?.startedAt, 80);
    text('blockedReason', stage?.blockedReason, 80);
    if (Number(stage?.attempt || 0) > 0) summary.attempt = Number(stage.attempt);
    text('nextAttemptAt', stage?.nextAttemptAt, 80);
    return [name, summary];
  }));
}

function summaryUsage(usage = {}) {
  return Object.fromEntries(Object.entries(usage || {}).map(([name, value]) => [name, {
    model: String(value?.model || ''),
    totalTokens: Number(value?.totalTokens || 0)
  }]));
}

function summaryModelActivity(activity = []) {
  return (Array.isArray(activity) ? activity : []).slice(-3).map((item) => {
    const summary = {};
    const text = (key, value, limit) => {
      const normalized = String(value || '').slice(0, limit);
      if (normalized) summary[key] = normalized;
    };
    text('section', item?.section, 100);
    text('requestedModel', item?.requestedModel, 100);
    text('model', item?.model, 100);
    text('fallbackFrom', item?.fallbackFrom, 100);
    text('fallbackModel', item?.fallbackModel, 100);
    text('fallbackReason', item?.fallbackReason, 180);
    text('triggerReason', item?.triggerReason, 120);
    text('outputStatus', item?.outputStatus, 120);
    if (Number(item?.latencyMs || 0) > 0) summary.latencyMs = Number(item.latencyMs);
    if (Number(item?.totalTokens || 0) > 0) summary.totalTokens = Number(item.totalTokens);
    text('completedAt', item?.completedAt, 80);
    text('error', item?.error, 240);
    text('validationStatus', item?.validationStatus, 80);
    if (item?.recovering === true) summary.recovering = true;
    if (Number(item?.attempt || 0) > 0) summary.attempt = Number(item.attempt);
    return summary;
  });
}

function runSummary(run) {
  const artifacts = run?.artifacts || {};
  const book = artifacts.book || {};
  return {
    id: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    input: summaryInput(run.input),
    autopilot: autopilotProjection(run),
    state: run.state,
    stages: summaryStages(run.stages),
    artifacts: {
      book: book ? { title: book.title, bookSkuId: book.bookSkuId, cover: book.cover } : null,
      code: artifacts.code,
      shortUrl: artifacts.shortUrl,
      linkId: artifacts.linkId,
      posts: Array.isArray(artifacts.posts) ? artifacts.posts.map((post) => ({ type: post.type, content: 'ready' })) : [],
      video: artifacts.video ? { threadId: artifacts.video.threadId, status: artifacts.video.status, videoUrls: (artifacts.video.videoUrls || []).slice(0, 1), videoModel: String(artifacts.video.videoModel || ''), isUserAdCopy: artifacts.video.isUserAdCopy === true ? true : artifacts.video.isUserAdCopy === false ? false : null, error: String(artifacts.video.error || '').slice(0, 300) } : null,
      referenceVideo: artifacts.referenceVideo ? { threadId: artifacts.referenceVideo.threadId, status: artifacts.referenceVideo.status, videoUrls: (artifacts.referenceVideo.videoUrls || []).slice(0, 1), error: String(artifacts.referenceVideo.error || '').slice(0, 300) } : null,
      videoRevision: artifacts.videoRevision ? { threadId: artifacts.videoRevision.threadId, status: artifacts.videoRevision.status, videoUrls: (artifacts.videoRevision.videoUrls || []).slice(0, 1), error: String(artifacts.videoRevision.error || '').slice(0, 300) } : null,
      images: Array.isArray(artifacts.images) ? artifacts.images.map((image) => ({ variant: image.variant, status: image.status, taskId: image.taskId, url: image.url })) : [],
      analytics: artifacts.analytics ? {
        status: String(artifacts.analytics.status || ''),
        summary: artifacts.analytics.summary || {},
        source: String(artifacts.analytics.source || ''),
        window: artifacts.analytics.window || null,
        lastSuccessfulAt: String(artifacts.analytics.lastSuccessfulAt || ''),
        lastAttemptAt: String(artifacts.analytics.lastAttemptAt || ''),
        nextRefreshAt: String(artifacts.analytics.nextRefreshAt || ''),
        stale: artifacts.analytics.stale === true,
        warning: String(artifacts.analytics.warning || '')
      } : null,
      distribution: artifacts.distribution ? { status: artifacts.distribution.status } : null,
      optimization: artifacts.optimization ? { status: artifacts.optimization.status } : null,
      review: artifacts.review ? {
        status: String(artifacts.review.status || 'ready'),
        facebook: artifacts.review.facebook ? {
          status: String(artifacts.review.facebook.status || 'paused'),
          automaticPublishing: artifacts.review.facebook.automaticPublishing === true
        } : { status: 'paused', automaticPublishing: false },
        warningCount: Array.isArray(artifacts.review.mediaWarnings) ? artifacts.review.mediaWarnings.length : 0
      } : null,
      usage: summaryUsage(artifacts.usage)
    },
    modelActivity: summaryModelActivity([...(artifacts.modelActivity || []), ...(artifacts.creativeDraft?.usage || [])]),
    events: Array.isArray(run.events) ? run.events.slice(-1).map((event) => ({ at: event?.at, type: String(event?.type || ''), message: String(event?.message || '').slice(0, 300) })) : [],
    _summary: true,
    _summaryVersion: RUN_SUMMARY_VERSION
  };
}

function runDetail(run) {
  const copy = JSON.parse(JSON.stringify(run));
  copy.autopilot = autopilotProjection(copy);
  const artifacts = copy.artifacts || {};
  if (artifacts.book) artifacts.book.description = String(artifacts.book.description || '').slice(0, 4000);
  delete artifacts.chapterList;
  if (artifacts.evidence && Array.isArray(artifacts.evidence.chapters)) {
    artifacts.evidence.chapterCount = artifacts.evidence.chapters.length;
    artifacts.evidence.chapters = artifacts.evidence.chapters.slice(0, 20).map((chapter) => ({ ...chapter, content: String(chapter.content || '').slice(0, 8000), title: String(chapter.title || '').slice(0, 300) }));
  }
  if (artifacts.creativeDraft) {
    const draft = artifacts.creativeDraft;
    artifacts.creativeDraft = {
      parts: Object.fromEntries(Object.entries(draft.parts || {}).map(([key, value]) => [key, { status: value?.status || 'ready' }])),
      inFlight: draft.inFlight || {},
      failures: Object.fromEntries(Object.entries(draft.failures || {}).map(([key, value]) => [key, { attempt: value?.attempt || 1, error: String(value?.error || '').slice(0, 300), nextAttemptAt: value?.nextAttemptAt || '', recoverable: value?.recoverable !== false, fallbackFrom: value?.fallbackFrom || '', fallbackModel: value?.fallbackModel || '' }])),
      usage: Array.isArray(draft.usage) ? draft.usage.slice(-24) : [],
      modelRoute: draft.modelRoute || null
    };
  }
  if (Array.isArray(copy.events)) copy.events = copy.events.slice(-80).map((item) => ({ at: item.at, type: item.type, message: String(item.message || '').slice(0, 500) }));
  if (Array.isArray(artifacts.posts)) artifacts.posts = artifacts.posts.map((post) => ({ ...post, content: String(post.content || '').slice(0, 12000), zhContent: String(post.zhContent || '').slice(0, 12000) }));
  if (Array.isArray(artifacts.images)) artifacts.images = artifacts.images.map((image) => ({ ...image, prompt: String(image.prompt || '').slice(0, 5000), zhPrompt: String(image.zhPrompt || '').slice(0, 5000) }));
  if (artifacts.videoPrompt) artifacts.videoPrompt = { ...artifacts.videoPrompt, adCopy: String(artifacts.videoPrompt.adCopy || '').slice(0, 10000), buildRequirement: String(artifacts.videoPrompt.buildRequirement || '').slice(0, 10000) };
  if (artifacts.videoPromptDraft) artifacts.videoPromptDraft = { ...artifacts.videoPromptDraft, adCopy: String(artifacts.videoPromptDraft.adCopy || '').slice(0, 10000), buildRequirement: String(artifacts.videoPromptDraft.buildRequirement || '').slice(0, 10000) };
  copy.artifacts = artifacts;
  copy._detailVersion = 1;
  return copy;
}
function creativePlanSummary(plan) {
  const artifacts = plan?.artifacts || {};
  return {
    id: plan.id,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    input: plan.input,
    state: plan.state,
    stages: plan.stages,
    artifacts: {
      book: artifacts.book ? { title: artifacts.book.title, cover: artifacts.book.cover, bookSkuId: artifacts.book.bookSkuId, sku: artifacts.book.sku } : null,
      usage: artifacts.usage || null,
      evidenceScope: artifacts.evidenceScope || null
    },
    events: Array.isArray(plan.events) ? plan.events.slice(-4) : [],
    _summary: true
  };
}
function creativePlanDetail(plan) {
  const artifacts = plan?.artifacts || {};
  return {
    id: plan.id,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    input: plan.input,
    state: plan.state,
    stages: plan.stages,
    artifacts: {
      book: artifacts.book || null,
      plan: artifacts.plan || null,
      evidenceScope: artifacts.evidenceScope || null,
      usage: artifacts.usage || null
    },
    events: Array.isArray(plan.events) ? plan.events.slice(-12) : []
  };
}
async function listRunSummaries(redis, limit = 12) {
  if (!redis) return [];
  const ids = await redis.zrange(RUN_INDEX, 0, limit - 1, { rev: true });
  if (!ids.length) return [];
  const storedSummaries = await getMany(redis, ids.map(runSummaryKey));
  const summaries = await Promise.all(ids.map(async (id, index) => {
    const stored = storedSummaries[index];
    const parsed = stored ? parseStored(stored) : null;
    if (parsed?._summaryVersion === RUN_SUMMARY_VERSION) return parsed;
    // One-time lazy migration for old or oversized summaries. Subsequent
    // dashboard loads only read the versioned compact projection.
    const full = await getRun(redis, id);
    if (!full) return null;
    const summary = runSummary(full);
    await redis.set(runSummaryKey(id), JSON.stringify(summary));
    return summary;
  }));
  return summaries.filter(Boolean);
}
async function getRun(redis, id) {
  if (!redis || !/^[a-z0-9_-]{12,80}$/i.test(String(id || ''))) return null;
  const value = await redis.get(runKey(id));
  return typeof value === 'string' ? JSON.parse(value) : value;
}
async function getRunDetail(redis, id) {
  if (!redis || !/^[a-z0-9_-]{12,80}$/i.test(String(id || ''))) return null;
  const value = await redis.get(runDetailKey(id));
  return value ? parseStored(value) : null;
}
async function getRunSummary(redis, id) {
  if (!redis || !/^[a-z0-9_-]{12,80}$/i.test(String(id || ''))) return null;
  const value = await redis.get(runSummaryKey(id));
  return value ? parseStored(value) : null;
}
async function saveRun(redis, run, options = {}) {
  const previousUpdatedAt = run.updatedAt;
  const now = new Date().toISOString();
  if (!options.preserveUpdatedAt) run.updatedAt = now;
  // Keep this state on the durable run itself so a browser can disappear and
  // the next worker/cron request can still explain exactly what happens next.
  // Analytics-only saves preserve the last production progress timestamp.
  run.autopilot = autopilotProjection(run, { now, progress: !options.preserveUpdatedAt });
  await Promise.all([
    redis.set(runKey(run.id), JSON.stringify(run)),
    redis.set(runSummaryKey(run.id), JSON.stringify(runSummary(run))),
    redis.set(runDetailKey(run.id), JSON.stringify(runDetail(run)))
  ]);
  // Analytics reconciliation must not make an old production run jump to the
  // top of the operations list. Its own freshness fields carry that update.
  if (!options.preserveUpdatedAt) await redis.zadd(RUN_INDEX, { score: Date.now(), member: run.id });
  if (options.preserveUpdatedAt && previousUpdatedAt) run.updatedAt = previousUpdatedAt;
  return run;
}

/** Register the currently active run for a book. The value is only an
 * identifier; all run data remains in the normal nf_social run keys. */
async function registerActiveRun(redis, run) {
  const sku = String(run?.input?.sku || '').trim();
  if (!redis || !sku || !run?.id) return run;
  await redis.set(activeRunKey(sku), run.id, { ex: ACTIVE_RUN_TTL });
  return run;
}

/**
 * Find a queued/running/ambiguous production for the same SKU. The pointer is
 * fast for new runs; the bounded index scan keeps old runs (created before the
 * pointer existed) compatible. Terminal pointers are lazily removed.
 */
async function findActiveRun(redis, sku) {
  const normalizedSku = String(sku || '').trim();
  if (!redis || !normalizedSku) return null;
  const pointer = await redis.get(activeRunKey(normalizedSku));
  if (pointer) {
    const run = await getRun(redis, String(pointer));
    if (run && runIsActive(run) && String(run.input?.sku || '').trim().toLowerCase() === normalizedSku.toLowerCase()) return run;
    await redis.del(activeRunKey(normalizedSku)).catch(() => {});
  }
  const summaries = await listRunSummaries(redis, 50);
  const match = summaries.find((run) => runIsActive(run) && String(run.input?.sku || '').trim().toLowerCase() === normalizedSku.toLowerCase());
  if (match) await registerActiveRun(redis, match);
  return match || null;
}

async function acquireRunCreation(redis, sku) {
  const normalizedSku = String(sku || '').trim();
  if (!redis || !normalizedSku) return { acquired: false, token: '', key: '' };
  const key = runCreateLockKey(normalizedSku);
  const token = crypto.randomUUID();
  const result = await redis.set(key, token, { nx: true, ex: RUN_CREATE_LOCK_TTL });
  return { acquired: result === true || String(result || '').toUpperCase() === 'OK', token, key };
}

async function releaseRunCreation(redis, lock) {
  if (!redis || !lock?.key) return;
  try {
    const current = await redis.get(lock.key);
    if (String(current || '') === String(lock.token || '')) await redis.del(lock.key);
  } catch {}
}

async function listCreativePlans(redis, limit = 12) {
  if (!redis) return [];
  const ids = await redis.zrange(PLAN_INDEX, 0, limit - 1, { rev: true });
  if (!ids.length) return [];
  const values = await Promise.all(ids.map((id) => redis.get(planKey(id))));
  return values.filter(Boolean).map((value) => typeof value === 'string' ? JSON.parse(value) : value);
}
async function listCreativePlanSummaries(redis, limit = 5) {
  if (!redis) return [];
  const ids = await redis.zrange(PLAN_INDEX, 0, Math.max(limit * 3, limit) - 1, { rev: true });
  if (!ids.length) return [];
  const storedSummaries = await getMany(redis, ids.map(planSummaryKey));
  const summaries = await Promise.all(ids.map(async (id, index) => {
    const stored = storedSummaries[index];
    if (stored) return parseStored(stored);
    const full = await getCreativePlan(redis, id);
    if (!full) return null;
    const summary = creativePlanSummary(full);
    await redis.set(planSummaryKey(id), JSON.stringify(summary));
    return summary;
  }));
  return summaries.filter((item) => item && item.state !== 'dismissed').slice(0, limit);
}
async function getCreativePlan(redis, id) {
  if (!redis || !/^plan_[a-z0-9]{12,80}$/i.test(String(id || ''))) return null;
  const value = await redis.get(planKey(id));
  return typeof value === 'string' ? JSON.parse(value) : value;
}
async function saveCreativePlan(redis, plan) {
  plan.updatedAt = new Date().toISOString();
  await Promise.all([
    redis.set(planKey(plan.id), JSON.stringify(plan)),
    redis.set(planSummaryKey(plan.id), JSON.stringify(creativePlanSummary(plan)))
  ]);
  await redis.zadd(PLAN_INDEX, { score: Date.now(), member: plan.id });
  return plan;
}

function discordJobKey(id) { return `nf_social:discord:job:${id}`; }

function discordJobSummary(job) {
  const result = job?.result || {};
  const book = (item) => ({ bookSkuId: String(item?.bookSkuId || ''), title: String(item?.title || ''), confidence: Number(item?.confidence || 0), confidenceLabel: String(item?.confidenceLabel || ''), sources: Array.isArray(item?.sources) ? item.sources.slice(0, 4) : [] });
  return {
    id: job?.id,
    kind: job?.kind,
    state: job?.state,
    phase: job?.phase,
    createdAt: job?.createdAt,
    updatedAt: job?.updatedAt,
    guildId: String(job?.guildId || ''),
    channelId: String(job?.channelId || ''),
    user: { id: String(job?.user?.id || ''), username: String(job?.user?.username || '') },
    input: {
      source: String(job?.input?.source || ''), language: String(job?.input?.language || ''),
      attachmentCount: Array.isArray(job?.input?.attachments) ? job.input.attachments.length : 0,
      ocr: Array.isArray(job?.input?.ocr) ? job.input.ocr.map((item) => ({ filename: String(item?.filename || ''), quality: String(item?.quality || ''), failed: Boolean(item?.error) })) : []
    },
    result: {
      matches: Array.isArray(result.matches) ? result.matches.slice(0, 3).map(book) : [],
      recommendations: Array.isArray(result.recommendations) ? result.recommendations.slice(0, 3).map(book) : [],
      catalogSources: Array.isArray(result.catalog?.sources) ? result.catalog.sources.slice(0, 8) : []
    },
    selectedBook: job?.selectedBook ? { bookSkuId: String(job.selectedBook.bookSkuId || ''), title: String(job.selectedBook.title || '') } : null,
    tracking: job?.tracking ? { status: String(job.tracking.status || ''), code: String(job.tracking.code || ''), linkId: String(job.tracking.linkId || ''), shortUrl: String(job.tracking.shortUrl || '') } : null,
    error: String(job?.error || '').slice(0, 500),
    _summary: true
  };
}

async function getDiscordJob(redis, id) {
  if (!redis || !/^discord_[a-z0-9_-]{12,100}$/i.test(String(id || ''))) return null;
  const value = await redis.get(discordJobKey(id));
  return value ? parseStored(value) : null;
}

async function saveDiscordJob(redis, job, queued = false) {
  job.updatedAt = new Date().toISOString();
  await Promise.all([
    redis.set(discordJobKey(job.id), JSON.stringify(job), { ex: 7 * 24 * 60 * 60 }),
    redis.zadd(DISCORD_HISTORY_INDEX, { score: Date.now(), member: job.id })
  ]);
  if (queued) await redis.zadd(DISCORD_JOB_INDEX, { score: Date.now(), member: job.id });
  return job;
}

async function listDiscordJobs(redis, limit = 10) {
  const ids = await redis.zrange(DISCORD_JOB_INDEX, 0, Math.max(0, limit - 1));
  if (!ids.length) return [];
  const jobs = await Promise.all(ids.map((id) => getDiscordJob(redis, id)));
  return jobs.filter(Boolean);
}

async function removeDiscordJobFromQueue(redis, id) {
  await redis.zrem(DISCORD_JOB_INDEX, id);
}

async function listDiscordJobSummaries(redis, limit = 50, state = '') {
  if (!redis) return [];
  const ids = await redis.zrange(DISCORD_HISTORY_INDEX, 0, Math.max(0, limit - 1), { rev: true });
  if (!ids.length) return [];
  const jobs = await Promise.all(ids.map((id) => getDiscordJob(redis, id)));
  return jobs.filter(Boolean).map(discordJobSummary).filter((job) => !state || job.state === state).slice(0, limit);
}
function newCreativePlan(input) {
  const createdAt = new Date().toISOString();
  return {
    id: `plan_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt,
    updatedAt: createdAt,
    input,
    state: 'queued',
    stages: { identity: { status: 'waiting' }, evidence: { status: 'waiting', cursor: 0 }, analysis: { status: 'waiting', attempt: 0 } },
    artifacts: { book: null, chapterList: [], evidence: [], plan: null, evidenceScope: null, usage: null },
    events: [{ at: createdAt, type: 'queued', message: 'Background AI creative planning queued' }]
  };
}
function stageMap() {
  return Object.fromEntries(['P1', 'P2', 'P3', 'P3_5', 'P4', 'P5', 'P6'].map((stage) => [stage, { status: 'waiting' }]));
}
function newRun(input) {
  const now = new Date().toISOString();
  const normalizedInput = {
    ...(input && typeof input === 'object' ? input : {}),
    source: String(input?.source || 'manual').slice(0, 100),
    automationMode: String(input?.automationMode || 'one_click').slice(0, 40) || 'one_click',
    fullBookEvidence: input?.fullBookEvidence !== false
  };
  const run = {
    id: `run_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt: now,
    updatedAt: now,
    input: normalizedInput,
    state: 'queued',
    stages: stageMap(),
    artifacts: { book: null, evidence: null, code: null, shortUrl: null, linkId: null, posts: [], translations: null, videoPrompt: null, posterPrompts: [], video: null, images: [], review: null, analytics: null, usage: {} },
    events: [{ at: now, type: 'queued', message: 'Full production run queued' }]
  };
  run.autopilot = autopilotProjection(run, { now });
  return run;
}
function addEvent(run, type, message, data = undefined) {
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push({ at: new Date().toISOString(), type, message, ...(data ? { data } : {}) });
  run.events = run.events.slice(-120);
}
function setStage(run, name, status, extra = {}) {
  const previous = run.stages[name] || {};
  const now = new Date().toISOString();
  run.stages[name] = { ...previous, ...extra, status, updatedAt: now };
  if (status === 'running' && !run.stages[name].startedAt) run.stages[name].startedAt = now;
  if (status === 'done' && !run.stages[name].completedAt) run.stages[name].completedAt = now;
  run.autopilot = autopilotProjection(run, { now, progress: true });
  return run.stages[name];
}

function videoHourInfo(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  const hour = `${value('year')}${value('month')}${value('day')}${value('hour')}`;
  const remaining = Math.max(60, Math.ceil((3600000 - (at.getTime() % 3600000)) / 1000) + 60);
  return { key: `nf_social:video_hour:${hour}`, limit: 5, expiresIn: remaining, label: `${value('month')}/${value('day')} ${value('hour')}:00` };
}

async function videoCapacity(redis) {
  const info = videoHourInfo();
  const used = Math.max(0, Number(await redis.get(info.key)) || 0);
  return { ...info, used: Math.min(used, info.limit), remaining: Math.max(0, info.limit - used) };
}

async function reserveVideoSlot(redis) {
  const info = videoHourInfo();
  await redis.set(info.key, '0', { nx: true, ex: info.expiresIn });
  const used = Number(await redis.incr(info.key));
  if (used <= info.limit) return { ...info, used, remaining: info.limit - used, granted: true };
  await redis.incrby(info.key, -1);
  return { ...info, used: info.limit, remaining: 0, granted: false };
}

async function releaseVideoSlot(redis, key) {
  if (typeof key === 'string' && key.startsWith('nf_social:video_hour:')) await redis.incrby(key, -1);
}

module.exports = { getRedis, createRedis, RemoteRedis, getMany, listRuns, listRunSummaries, getRun, getRunDetail, getRunSummary, saveRun, registerActiveRun, findActiveRun, acquireRunCreation, releaseRunCreation, newRun, addEvent, setStage, runSummary, runDetail, autopilotProjection, runIsActive, nextAutopilotAction, activeRunKey, runCreateLockKey, listCreativePlans, listCreativePlanSummaries, getCreativePlan, saveCreativePlan, newCreativePlan, creativePlanDetail, getDiscordJob, saveDiscordJob, listDiscordJobs, listDiscordJobSummaries, removeDiscordJobFromQueue, discordJobSummary, RUN_INDEX, PLAN_INDEX, DISCORD_JOB_INDEX, DISCORD_HISTORY_INDEX, videoCapacity, reserveVideoSlot, releaseVideoSlot };
