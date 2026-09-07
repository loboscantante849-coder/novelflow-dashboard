const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const RUN_INDEX = 'nf_social:runs';
const PLAN_INDEX = 'nf_social:creative_plans';
const DISCORD_JOB_INDEX = 'nf_social:discord:jobs';
const DISCORD_HISTORY_INDEX = 'nf_social:discord:history';
const runKey = (id) => `nf_social:run:${id}`;
const runDetailKey = (id) => `nf_social:run_detail:${id}`;
const runAssetsKey = (id) => `nf_social:run_assets:${id}`;
const planKey = (id) => `nf_social:creative_plan:${id}`;
const runSummaryKey = (id) => `nf_social:run_summary:${id}`;
const planSummaryKey = (id) => `nf_social:creative_plan_summary:${id}`;
const ACTIVE_RUN_TTL = 90 * 24 * 60 * 60;
// Vercel's longest production handlers are allowed to run for 800 seconds.
// Creation locks must outlive that complete reservation window so an older
// single-run endpoint cannot race a 36-slot campaign while it is still
// making every reserved identity durable.
const RUN_CREATE_LOCK_TTL = 900;
const runScope = (sku, accountId = 0) => `${String(sku || '').trim().toLowerCase()}:${Number(accountId || 0) || 0}`;
const activeRunKey = (sku, accountId = 0) => `nf_social:active_run:${crypto.createHash('sha256').update(runScope(sku, accountId)).digest('hex').slice(0, 32)}`;
const activeRunsKey = (sku, accountId = 0) => `nf_social:active_runs:${crypto.createHash('sha256').update(runScope(sku, accountId)).digest('hex').slice(0, 32)}`;
const runCreateLockKey = (sku, accountId = 0) => `nf_social:run_create_lock:${crypto.createHash('sha256').update(runScope(sku, accountId)).digest('hex').slice(0, 32)}`;
const RUN_SUMMARY_VERSION = 8;

const AUTOPILOT_STAGES = Object.freeze(['P0', 'P1', 'P2', 'P5', 'P3', 'P3_5', 'P4', 'P6', 'P7']);
const HARNESS_STAGES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P3_5', 'P4', 'P5', 'P6', 'P7']);
const HARNESS_LABELS = Object.freeze({
  P0: 'P0 selection lock', P1: 'P1 identity', P2: 'P2 evidence', P3: 'P3 creative',
  P3_5: 'P3.5 posters', P4: 'P4 video', P5: 'P5 attribution', P6: 'P6 review package', P7: 'P7 SocialEcho draft'
});
const AUTOPILOT_LABELS = Object.freeze({
  P0: '锁定投放目标与选书快照',
  P1: '核验书籍身份',
  P2: '读取章节并建立证据',
  P5: '创建并验证 Code / 短链',
  P3: '生成文案与创意提示词',
  P3_5: '生成推广海报',
  P4: '提交并等待视频生成',
  P6: '组装审核包并开启数据跟进',
  P7: '创建或核验 SocialEcho 草稿'
});

function runIsActive(run) {
  const state = String(run?.state || '');
  if (['reserved', 'queued', 'running', 'blocked'].includes(state)) return true;
  // P0-P6 may be complete while P7 deliberately waits for an external
  // SocialEcho ID. Treat that review-ready delivery as active for duplicate
  // protection even though the worker correctly stops polling it.
  if (state === 'completed'
    && String(run?.stages?.P7?.status || '') !== 'done'
    && Boolean(run?.artifacts?.review?.publicationDraftId)) return true;
  if (state !== 'failed') return false;
  const videoTask = Boolean(run?.artifacts?.video?.threadId);
  const posterTask = (Array.isArray(run?.artifacts?.images) ? run.artifacts.images : []).some((item) => item?.taskId);
  return videoTask || posterTask;
}

function nextAutopilotAction(run) {
  const stages = run?.stages || {};
  const pending = AUTOPILOT_STAGES.find((name) => {
    const stage = stages[name] || {};
    // Video-only campaigns intentionally mark the optional poster branch as a
    // non-blocking partial result. It must not make a finished P0-P7 run look
    // perpetually unfinished in the dashboard or scheduler.
    if (name === 'P3_5' && stage.nonBlocking === true && String(stage.status || '') === 'partial') return false;
    return String(stage.status || 'waiting') !== 'done';
  });
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
  if (state === 'archived') status = 'archived';
  else if (state === 'completed' || action.nextAction === 'done') status = 'completed';
  else if (state === 'blocked' || Object.values(run?.stages || {}).some((stage) => ['ambiguous', 'blocked'].includes(String(stage?.status || '')))) status = 'blocked';
  else if (state === 'failed') status = 'failed';
  else if (state === 'queued') {
    // A caller may save a stage transition before it flips the top-level
    // state. Treat that durable stage evidence as running instead of leaving
    // the dashboard on a stale queued badge.
    const hasProgress = AUTOPILOT_STAGES.filter((name) => name !== 'P0')
      .some((name) => !['waiting', ''].includes(String(run?.stages?.[name]?.status || '')));
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

// Bounded, durable P0-P7 projection consumed by the console. Full evidence
// and creative payloads remain available only from the detail endpoint.
function harnessProjection(run) {
  const input = run?.input || {};
  const delivery = input.delivery && typeof input.delivery === 'object' ? input.delivery : {};
  const selection = input.p0Selection && typeof input.p0Selection === 'object' ? input.p0Selection : {};
  const artifacts = run?.artifacts || {};
  const stages = run?.stages || {};
  const stageRows = HARNESS_STAGES.map((name) => {
    const stage = stages[name] || {};
    const status = String(stage.status || 'waiting');
    const externalTaskId = name === 'P4'
      ? String(artifacts.video?.threadId || artifacts.videoRevision?.threadId || artifacts.referenceVideo?.threadId || '')
      : name === 'P3_5'
        ? (Array.isArray(artifacts.images) ? artifacts.images.map((item) => String(item?.taskId || '')).filter(Boolean).slice(0, 3) : [])
        : name === 'P7'
          // `publicationDraftId` is an internal Redis record. It must never be
          // displayed as a SocialEcho external task ID. The provider ID is
          // meaningful only after an explicit external_draft confirmation.
          ? String(artifacts.review?.publicationStatus === 'external_draft'
            ? (artifacts.review?.socialEchoDraftId || artifacts.review?.externalDraftId || '')
            : '')
          : '';
    const internalTaskId = name === 'P7' ? String(artifacts.review?.publicationDraftId || '') : '';
    return {
      key: name,
      status,
      purpose: String(stage.label || AUTOPILOT_LABELS[name] || HARNESS_LABELS[name]),
      artifact: name === 'P0'
        ? String(selection.sourceRank ? `rank:${selection.sourceRank}` : '')
        : name === 'P1'
          ? String(artifacts.book?.bookSkuId || input.sku || '')
          : name === 'P2'
            ? (artifacts.evidence?.completed ? `${Number(artifacts.evidence.completed)}/${Number(artifacts.evidence.requested || artifacts.evidence.completed)} chapters` : '')
            : name === 'P3'
              ? (Array.isArray(artifacts.posts) ? `${artifacts.posts.length} posts` : '')
              : name === 'P3_5'
                ? (Array.isArray(artifacts.images) ? `${artifacts.images.filter((item) => item?.url).length}/${artifacts.images.length} posters` : '')
                : name === 'P4'
                  ? String(artifacts.video?.status || '')
                  : name === 'P5'
                    ? String(artifacts.code || '')
                    : name === 'P6'
                      ? String(artifacts.review ? 'review package ready' : '')
                      : String(artifacts.review?.publicationStatus || artifacts.review?.publicationDraftId || ''),
      recoverable: stage.recoverable === true || ['failed', 'blocked', 'ambiguous', 'partial'].includes(status),
      nextAttemptAt: String(stage.nextAttemptAt || ''),
      externalTaskId: Array.isArray(externalTaskId) ? externalTaskId : externalTaskId || '',
      internalTaskId,
      externalStatus: name === 'P7' ? String(artifacts.review?.publicationStatus || '') : '',
      scheduledAt: name === 'P7' ? String(artifacts.review?.scheduledAt || input.campaign?.scheduledAt || '') : '',
      error: String(stage.error || '').slice(0, 300),
      blockedReason: String(stage.blockedReason || '')
    };
  });
  const isOptionalPosterTerminal = (stage) => stage.key === 'P3_5'
    && stage.status === 'partial' && stages.P3_5?.nonBlocking === true;
  const blockers = stageRows.filter((stage) => ['failed', 'blocked', 'ambiguous', 'partial'].includes(stage.status) && !isOptionalPosterTerminal(stage)).map((stage) => ({
    stage: stage.key,
    label: HARNESS_LABELS[stage.key] || stage.key,
    status: stage.status,
    reason: stage.error || stage.blockedReason || (stage.status === 'ambiguous' ? 'manual reconciliation required; no duplicate submission' : 'operator action required')
  }));
  const active = stageRows.find((stage) => stage.status !== 'done' && !isOptionalPosterTerminal(stage)) || null;
  const completed = stageRows.filter((stage) => stage.status === 'done' || isOptionalPosterTerminal(stage)).length;
  const ambiguous = stageRows.some((stage) => stage.status === 'ambiguous') || String(artifacts.review?.publicationStatus || '') === 'publish_ambiguous';
  const status = ambiguous ? 'ambiguous' : blockers.some((item) => ['failed', 'blocked'].includes(item.status)) ? (String(run?.state || '') === 'failed' ? 'failed' : 'blocked') : completed === HARNESS_STAGES.length ? 'completed' : String(run?.state || '') === 'queued' ? 'queued' : 'running';
  return {
    version: 1,
    status,
    completion: { completed, total: HARNESS_STAGES.length, percent: Math.round((completed / HARNESS_STAGES.length) * 100) },
    target: {
      locked: Boolean(delivery.applicationId && delivery.accountId && delivery.platform),
      applicationId: String(delivery.applicationId || ''),
      appKey: String(delivery.appKey || delivery.productLine || ''),
      appName: String(delivery.appName || delivery.productLine || ''),
      accountId: Number(delivery.accountId || 0),
      accountTitle: String(delivery.accountTitle || ''),
      platform: String(delivery.platform || ''),
      publishType: String(delivery.publishType || ''),
      includeLink: delivery.includeLink === true
    },
    p0: {
      locked: Boolean(delivery.accountId && (input.sku || selection.sourceRank)),
      source: String(selection.source || ''),
      windowDays: Number(selection.windowDays || 0),
      sourceRank: Number(selection.sourceRank || 0),
      recommendationRank: Number(selection.recommendationRank || 0),
      readerBase: Number(selection.readerBase || 0),
      firstReadRate: Number(selection.firstReadRate || 0),
      longReadRate: Number(selection.longReadRate || 0),
      trend7v30: selection.trend7v30 == null ? null : Number(selection.trend7v30),
      dataQuality: String(selection.dataQuality || ''),
      sourceHealth: String(selection.sourceHealth || ''),
      generatedAt: String(selection.generatedAt || ''),
      receiptVersion: Number(selection.receiptVersion || 0),
      receiptIssuedAt: String(selection.receiptIssuedAt || ''),
      filters: selection.filters && typeof selection.filters === 'object' ? {
        readBaseMin: Number(selection.filters.readBaseMin || 0),
        firstReadMin: Number(selection.filters.firstReadMin || 0),
        longReadMin: Number(selection.filters.longReadMin || 0),
        language: String(selection.filters.language || ''),
        complete: String(selection.filters.complete || ''),
        length: String(selection.filters.length || 'all'),
        genre: String(selection.filters.genre || '')
      } : null
    },
    book: { title: String(input.title || artifacts.book?.title || ''), sku: String(input.sku || artifacts.book?.bookSkuId || '') },
    activeStage: active ? { key: active.key, label: HARNESS_LABELS[active.key] || active.key, status: active.status, nextAttemptAt: active.nextAttemptAt } : null,
    nextAction: nextAutopilotAction(run),
    blockers,
    stages: stageRows
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
  // Keep Social Console state isolated from the shared application Redis.
  const url = environment.SOCIAL_KV_REST_API_URL || environment.KV_REST_API_URL;
  const token = environment.SOCIAL_KV_REST_API_TOKEN || environment.KV_REST_API_TOKEN;
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
  const delivery = input?.delivery && typeof input.delivery === 'object'
    ? {
      accountId: Number(input.delivery.accountId || 0),
      accountTitle: String(input.delivery.accountTitle || '').slice(0, 300),
      platform: String(input.delivery.platform || '').slice(0, 40),
      publishType: String(input.delivery.publishType || '').slice(0, 40),
      appKey: String(input.delivery.appKey || '').slice(0, 40),
      appName: String(input.delivery.appName || '').slice(0, 80),
      productLine: String(input.delivery.productLine || '').slice(0, 80),
      applicationId: String(input.delivery.applicationId || '').slice(0, 80),
      includeLink: input.delivery.includeLink === true
    }
    : null;
  const selection = input?.p0Selection && typeof input.p0Selection === 'object'
    ? {
      source: String(input.p0Selection.source || '').slice(0, 80),
      windowDays: Number(input.p0Selection.windowDays || 0),
      sourceRank: Number(input.p0Selection.sourceRank || 0),
      recommendationRank: Number(input.p0Selection.recommendationRank || 0),
      readerBase: Number(input.p0Selection.readerBase || 0),
      firstReadRate: Number(input.p0Selection.firstReadRate || 0),
      longReadRate: Number(input.p0Selection.longReadRate || 0),
      trend7v30: input.p0Selection.trend7v30 == null ? null : Number(input.p0Selection.trend7v30),
      dataQuality: String(input.p0Selection.dataQuality || '').slice(0, 40),
      sourceHealth: String(input.p0Selection.sourceHealth || '').slice(0, 40),
      generatedAt: String(input.p0Selection.generatedAt || '').slice(0, 80),
      receiptVersion: Number(input.p0Selection.receiptVersion || 0),
      receiptIssuedAt: String(input.p0Selection.receiptIssuedAt || '').slice(0, 80),
      filters: input.p0Selection.filters && typeof input.p0Selection.filters === 'object' ? {
        language: String(input.p0Selection.filters.language || '').slice(0, 8),
        complete: String(input.p0Selection.filters.complete || '').slice(0, 20),
        length: String(input.p0Selection.filters.length || 'all').slice(0, 10),
        genre: String(input.p0Selection.filters.genre || '').slice(0, 40),
        readBaseMin: Number(input.p0Selection.filters.readBaseMin || 0),
        firstReadMin: Number(input.p0Selection.filters.firstReadMin || 0),
        longReadMin: Number(input.p0Selection.filters.longReadMin || 0)
      } : null
    }
    : null;
  const videoControl = input?.videoControl && typeof input.videoControl === 'object'
    ? {
      version: Number(input.videoControl.version || 1),
      template: String(input.videoControl.template || 'Ad_Plot_Seedance').slice(0, 80),
      referenceAssetIds: Array.isArray(input.videoControl.referenceAssetIds) ? input.videoControl.referenceAssetIds.slice(0, 9).map((id) => String(id).slice(0, 120)) : [],
      enableSubtitles: input.videoControl.enableSubtitles === true,
      lineage: input.videoControl.lineage && typeof input.videoControl.lineage === 'object' ? {
        source: String(input.videoControl.lineage.source || '').slice(0, 40),
        threadId: String(input.videoControl.lineage.threadId || '').slice(0, 180)
      } : null
    }
    : null;
  return {
    title: String(input?.title || ''),
    sku: String(input?.sku || ''),
    source: String(input?.source || '').slice(0, 100),
    automationMode: String(input?.automationMode || '').slice(0, 40),
    fullBookEvidence: input?.fullBookEvidence !== false,
    creativeProfile: input?.creativeProfile && typeof input.creativeProfile === 'object' ? input.creativeProfile : {},
    ...(input?.campaign && typeof input.campaign === 'object' ? { campaign: {
      id: String(input.campaign.id || '').slice(0, 100),
      itemIndex: Number(input.campaign.itemIndex || 0),
      slot: Number(input.campaign.slot || 0),
      selectionTier: String(input.campaign.selectionTier || '').slice(0, 80),
      autoSocialEchoDraft: input.campaign.autoSocialEchoDraft === true,
      paidMediaAuthorized: input.campaign.paidMediaAuthorized === true,
      deliveryMode: ['draft', 'scheduled'].includes(String(input.campaign.deliveryMode || '').toLowerCase())
        ? String(input.campaign.deliveryMode).toLowerCase()
        : (String(input.campaign.scheduledAt || '').trim() ? 'scheduled' : 'draft'),
      // Keep the delivery intent in the compact summary. A missing timestamp
      // must never make a scheduled item look like an ordinary status:0 draft.
      scheduledAt: String(input.campaign.scheduledAt || '').slice(0, 80),
      timezone: String(input.campaign.timezone || input.campaign.timeZone || 'Asia/Shanghai').slice(0, 40)
    } } : {}),
    ...(videoControl ? { videoControl } : {}),
    ...(delivery?.accountId ? { delivery } : {}),
    ...(selection ? { p0Selection: selection } : {}),
    ...(planning ? { planning } : {})
  };
}

function publicVideoControl(control = {}) {
  return {
    version: Number(control?.version || 1),
    template: String(control?.template || 'Ad_Plot_Seedance').slice(0, 80),
    enableSubtitles: control?.enableSubtitles === true,
    referenceAssetIds: Array.isArray(control?.referenceAssetIds) ? control.referenceAssetIds.slice(0, 9).map((id) => String(id).slice(0, 120)) : [],
    references: Array.isArray(control?.references) ? control.references.slice(0, 9).map((reference) => ({ id: String(reference?.id || '').slice(0, 120), characterName: String(reference?.characterName || '').slice(0, 160), role: String(reference?.role || '').slice(0, 80), view: String(reference?.view || '').slice(0, 60) })) : [],
    lineage: control?.lineage && typeof control.lineage === 'object' ? { source: String(control.lineage.source || '').slice(0, 40), threadId: String(control.lineage.threadId || '').slice(0, 180) } : null,
    policy: control?.policy && typeof control.policy === 'object' ? { id: String(control.policy.id || '').slice(0, 80), production: control.policy.production === true, maxReferences: Number(control.policy.maxReferences || 0) } : null,
    chapterWindow: control?.chapterWindow && typeof control.chapterWindow === 'object' ? { start: Number(control.chapterWindow.start || 0), end: Number(control.chapterWindow.end || 0), chapters: Array.isArray(control.chapterWindow.chapters) ? control.chapterWindow.chapters.slice(0, 8).map(Number) : [] } : null
  };
}

function publicExecutionControls(execution = {}) {
  if (!execution || typeof execution !== 'object') return null;
  return {
    enableSubtitles: typeof execution.enableSubtitles === 'boolean' ? execution.enableSubtitles : null,
    isRewriting: typeof execution.isRewriting === 'boolean' ? execution.isRewriting : null,
    isGenerateImage: typeof execution.isGenerateImage === 'boolean' ? execution.isGenerateImage : null,
    effectiveVideoModel: String(execution.effectiveVideoModel || '').slice(0, 180),
    model: String(execution.effectiveVideoModel || '').slice(0, 180),
    ttsAudioVoice: String(execution.ttsAudioVoice || '').slice(0, 180),
    wordCount: String(execution.wordCount || '').slice(0, 40),
    referenceCount: Number(execution.referenceCount || 0),
    storyboard: execution.storyboard && typeof execution.storyboard === 'object' ? { length: Number(execution.storyboard.length || 0), sha256: String(execution.storyboard.sha256 || '').slice(0, 80) } : null,
    materialTraceIds: Array.isArray(execution.materialTraceIds) ? execution.materialTraceIds.slice(0, 4).map((id) => String(id).slice(0, 180)) : []
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
    if (Number(stage?.identityRetryCount || 0) > 0) summary.identityRetryCount = Number(stage.identityRetryCount);
    if (Number(stage?.evidenceRetryCount || 0) > 0) summary.evidenceRetryCount = Number(stage.evidenceRetryCount);
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

function publicationSummary(run) {
  const review = run?.artifacts?.review && typeof run.artifacts.review === 'object'
    ? run.artifacts.review : {};
  const campaign = run?.input?.campaign && typeof run.input.campaign === 'object'
    ? run.input.campaign : {};
  const publicationStatus = String(review.publicationStatus || '');
  // `publicationDraftId` is generated by this service (`pub_...`). It is not
  // a SocialEcho identifier. Only expose a provider ID after the provider has
  // explicitly confirmed an external draft.
  const externalDraftId = publicationStatus === 'external_draft'
    ? String(review.socialEchoDraftId || review.externalDraftId || '').slice(0, 180)
    : '';
  const scheduledAt = String(review.scheduledAt || campaign.scheduledAt || '').slice(0, 80);
  const deliveryMode = ['draft', 'scheduled'].includes(String(review.deliveryMode || '').toLowerCase())
    ? String(review.deliveryMode).toLowerCase()
    : (scheduledAt ? 'scheduled' : 'draft');
  return {
    status: publicationStatus || String(review.status || ''),
    publicationStatus,
    internalDraftId: String(review.publicationDraftId || '').slice(0, 180),
    // Keep the explicit name for clients that already consume this field, but
    // never fill it with the internal `pub_...` value.
    externalDraftId,
    socialEchoDraftId: externalDraftId,
    deliveryMode,
    scheduledAt,
    timezone: String(review.timezone || campaign.timezone || campaign.timeZone || 'Asia/Shanghai').slice(0, 40),
    accountId: Number(run?.input?.delivery?.accountId || review.accountId || 0) || 0,
    platform: String(run?.input?.delivery?.platform || review.platform || '').slice(0, 40),
    publishType: String(run?.input?.delivery?.publishType || review.publishType || '').slice(0, 40),
    error: String(review.publicationError || '').slice(0, 300)
  };
}

function harnessOperations(run) {
  const harness = harnessProjection(run);
  const stages = Array.isArray(harness.stages) ? harness.stages : [];
  const active = harness.activeStage || null;
  const blockers = Array.isArray(harness.blockers) ? harness.blockers : [];
  const externalTaskIds = {};
  for (const stage of stages) {
    if (stage?.externalTaskId && (Array.isArray(stage.externalTaskId) ? stage.externalTaskId.length : true)) {
      externalTaskIds[stage.key] = stage.externalTaskId;
    }
  }
  const publication = publicationSummary(run);
  const nextAttemptAt = active?.nextAttemptAt || stages
    .map((stage) => stage?.nextAttemptAt || '')
    .filter(Boolean)
    .sort()[0] || '';
  const firstBlocker = blockers[0] || null;
  return {
    currentStage: active?.key || (harness.status === 'completed' ? 'done' : ''),
    currentStageLabel: active?.label || '',
    nextAction: harness.nextAction?.nextAction || '',
    nextActionLabel: harness.nextAction?.nextActionLabel || '',
    recoverable: stages.some((stage) => stage?.recoverable === true),
    nextAttemptAt,
    blocked: Boolean(firstBlocker),
    blockedReason: firstBlocker?.reason || '',
    externalTaskIds,
    p4TaskId: externalTaskIds.P4 || '',
    p35TaskIds: externalTaskIds.P3_5 || [],
    socialEchoExternalDraftId: publication.externalDraftId,
    internalPublicationDraftId: publication.internalDraftId,
    publicationStatus: publication.publicationStatus,
    scheduledAt: publication.scheduledAt,
    deliveryMode: publication.deliveryMode,
    accountId: publication.accountId,
    platform: publication.platform
  };
}

function runSummary(run) {
  const artifacts = run?.artifacts || {};
  const book = artifacts.book || {};
  const publication = publicationSummary(run);
  return {
    id: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    input: summaryInput(run.input),
    autopilot: autopilotProjection(run),
    harness: harnessProjection(run),
    operations: harnessOperations(run),
    state: run.state,
    stages: summaryStages(run.stages),
    artifacts: {
      book: book ? { title: book.title, bookSkuId: book.bookSkuId, cover: book.cover } : null,
      code: artifacts.code,
      shortUrl: artifacts.shortUrl,
      linkId: artifacts.linkId,
      posts: Array.isArray(artifacts.posts) ? artifacts.posts.map((post) => ({ type: post.type, content: 'ready' })) : [],
      video: assetVideo(artifacts.video),
      referenceVideo: assetVideo(artifacts.referenceVideo),
      videoRevision: assetVideo(artifacts.videoRevision),
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
      review: artifacts.review ? (() => {
        // Keep the status payload light for the normal polling loop. Empty
        // P7 fields add noise to every historical task; when a publication is
        // actually present, each relevant field remains available to the UI.
        const review = {
          status: String(artifacts.review.status || 'ready'),
          facebook: artifacts.review.facebook ? {
            status: String(artifacts.review.facebook.status || 'paused'),
            automaticPublishing: artifacts.review.facebook.automaticPublishing === true
          } : { status: 'paused', automaticPublishing: false },
          warningCount: Array.isArray(artifacts.review.mediaWarnings) ? artifacts.review.mediaWarnings.length : 0
        };
        if (publication.publicationStatus) review.publicationStatus = publication.publicationStatus;
        if (publication.internalDraftId) review.publicationDraftId = publication.internalDraftId;
        if (publication.externalDraftId) {
          review.externalDraftId = publication.externalDraftId;
          review.socialEchoDraftId = publication.socialEchoDraftId;
        }
        if (publication.deliveryMode === 'scheduled' || publication.scheduledAt) {
          review.deliveryMode = publication.deliveryMode;
          review.scheduledAt = publication.scheduledAt;
          review.timezone = publication.timezone;
        }
        if (publication.accountId) review.accountId = publication.accountId;
        if (publication.platform) review.platform = publication.platform;
        if (publication.publishType) review.publishType = publication.publishType;
        if (publication.error) review.publicationError = publication.error;
        return review;
      })() : null,
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
  copy.harness = harnessProjection(copy);
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
      repairAttempts: draft.repairAttempts && typeof draft.repairAttempts === 'object' ? { ...draft.repairAttempts } : {},
      usage: Array.isArray(draft.usage) ? draft.usage.slice(-24) : [],
      modelRoute: draft.modelRoute || null
    };
  }
  if (Array.isArray(copy.events)) copy.events = copy.events.slice(-80).map((item) => ({ at: item.at, type: item.type, message: String(item.message || '').slice(0, 500) }));
  if (Array.isArray(artifacts.posts)) artifacts.posts = artifacts.posts.map((post) => ({ ...post, content: String(post.content || '').slice(0, 12000), zhContent: String(post.zhContent || '').slice(0, 12000) }));
  if (Array.isArray(artifacts.images)) artifacts.images = artifacts.images.map((image) => ({ ...image, prompt: String(image.prompt || '').slice(0, 5000), zhPrompt: String(image.zhPrompt || '').slice(0, 5000) }));
  if (artifacts.video) artifacts.video = assetVideo(artifacts.video);
  if (artifacts.referenceVideo) artifacts.referenceVideo = assetVideo(artifacts.referenceVideo);
  if (artifacts.videoRevision) artifacts.videoRevision = assetVideo(artifacts.videoRevision);
  if (Array.isArray(artifacts.characterAssets)) artifacts.characterAssets = artifacts.characterAssets.slice(0, 12).map((asset) => ({ id: assetText(asset?.id, 120), provider: assetText(asset?.provider, 40), kind: assetText(asset?.kind, 60), status: assetText(asset?.status, 60), characterId: assetText(asset?.characterId, 120), characterName: assetText(asset?.characterName, 160), label: assetText(asset?.label, 160), role: assetText(asset?.role, 80), view: assetText(asset?.view, 60), url: assetText(asset?.url, 4000), approved: asset?.approved === true, error: assetText(asset?.error, 400) }));
  if (artifacts.videoPrompt) artifacts.videoPrompt = { ...artifacts.videoPrompt, adCopy: String(artifacts.videoPrompt.adCopy || '').slice(0, 10000), buildRequirement: String(artifacts.videoPrompt.buildRequirement || '').slice(0, 10000) };
  if (artifacts.videoPromptDraft) artifacts.videoPromptDraft = { ...artifacts.videoPromptDraft, adCopy: String(artifacts.videoPromptDraft.adCopy || '').slice(0, 10000), buildRequirement: String(artifacts.videoPromptDraft.buildRequirement || '').slice(0, 10000) };
  copy.artifacts = artifacts;
  copy._detailVersion = 1;
  return copy;
}

// Opening a completed task only needs its finished assets. Keep that path
// independent from chapter evidence and provider diagnostics so a large legacy
// run cannot make the production drawer look empty.
function assetText(value, limit = 12000) {
  return String(value || '').slice(0, limit);
}

function assetVideo(video) {
  if (!video || typeof video !== 'object') return null;
  const executionQa = video.executionQa && typeof video.executionQa === 'object'
    ? {
      status: assetText(video.executionQa.status, 80),
      score: Number.isFinite(Number(video.executionQa.score)) ? Number(video.executionQa.score) : null,
      computedScore: Number.isFinite(Number(video.executionQa.computedScore)) ? Number(video.executionQa.computedScore) : null,
      criteria: video.executionQa.criteria && typeof video.executionQa.criteria === 'object' && !Array.isArray(video.executionQa.criteria)
        ? Object.fromEntries(['eventImmediacy', 'socialStakes', 'conflictObject', 'powerDelta', 'visualSpecificity', 'brandPremium']
          .filter((key) => Number.isFinite(Number(video.executionQa.criteria[key])))
          .map((key) => [key, Math.max(0, Math.min(5, Number(video.executionQa.criteria[key])))]))
        : {},
      defects: Array.isArray(video.executionQa.defects) ? video.executionQa.defects.slice(0, 8).map((item) => assetText(item, 240)) : [],
      unknownDefects: Array.isArray(video.executionQa.unknownDefects) ? video.executionQa.unknownDefects.slice(0, 8).map((item) => assetText(item, 240)) : [],
      taxonomyVersion: Number.isFinite(Number(video.executionQa.taxonomyVersion)) ? Number(video.executionQa.taxonomyVersion) : null,
      openingClass: assetText(video.executionQa.openingClass, 120),
      notes: assetText(video.executionQa.notes, 1000),
      reviewedAt: assetText(video.executionQa.reviewedAt, 80),
      reviewer: assetText(video.executionQa.reviewer, 80),
      assetKind: assetText(video.executionQa.assetKind, 40),
      assetFingerprint: assetText(video.executionQa.assetFingerprint, 80)
    }
    : null;
  return {
    status: assetText(video.status, 80),
    threadId: assetText(video.threadId, 160),
    videoUrls: Array.isArray(video.videoUrls) ? video.videoUrls.slice(0, 3).map((url) => assetText(url, 4000)) : [],
    coverImageUrl: assetText(video.coverImageUrl, 4000),
    videoModel: assetText(video.videoModel, 160),
    isUserAdCopy: video.isUserAdCopy === true ? true : video.isUserAdCopy === false ? false : null,
    payloadFingerprint: assetText(video.payloadFingerprint, 80),
    control: publicVideoControl(video.control),
    controlWarnings: Array.isArray(video.controlWarnings) ? video.controlWarnings.slice(-12).map((warning) => assetText(warning, 120)) : [],
    executionControls: video.executionControls ? { ...publicExecutionControls(video.executionControls), requestedEnableSubtitles: typeof video.control?.enableSubtitles === 'boolean' ? video.control.enableSubtitles : null } : null,
    executionQa,
    error: assetText(video.error, 500)
  };
}

function assetPrompt(prompt) {
  if (!prompt || typeof prompt !== 'object') return null;
  const copy = {};
  for (const key of ['status', 'model', 'hook', 'zhHook', 'valuePromise', 'zhValuePromise', 'escalation', 'zhEscalation', 'reversal', 'zhReversal', 'cliffhanger', 'zhCliffhanger', 'adCopy', 'zhAdCopy', 'buildRequirement', 'zhBuildRequirement']) {
    if (prompt[key] != null) copy[key] = assetText(prompt[key], 12000);
  }
  if (Array.isArray(prompt.evidenceChapters)) copy.evidenceChapters = prompt.evidenceChapters.slice(0, 12).map((value) => assetText(value, 60));
  return copy;
}

function assetAnalytics(analytics) {
  if (!analytics || typeof analytics !== 'object') return null;
  const stream = (value) => value && typeof value === 'object' ? {
    rowCount: Number(value.rowCount || 0), pullUv: Number(value.pullUv || 0), activeUv: Number(value.activeUv || 0),
    d7Income: Number(value.d7Income || 0), activationRate: value.activationRate == null ? null : Number(value.activationRate)
  } : null;
  return {
    status: assetText(analytics.status, 80), source: assetText(analytics.source, 200), window: analytics.window || null,
    summary: analytics.summary && typeof analytics.summary === 'object' ? analytics.summary : {},
    streams: { code: stream(analytics.streams?.code), link: stream(analytics.streams?.link) },
    findings: Array.isArray(analytics.findings) ? analytics.findings.slice(0, 12).map((item) => assetText(item, 500)) : [],
    lastSuccessfulAt: assetText(analytics.lastSuccessfulAt, 80), refreshedAt: assetText(analytics.refreshedAt, 80),
    stale: analytics.stale === true, warning: assetText(analytics.warning, 500)
  };
}

function assetDistribution(distribution) {
  if (!distribution || typeof distribution !== 'object') return null;
  return {
    status: assetText(distribution.status, 80), model: assetText(distribution.model, 120),
    universalHook: assetText(distribution.universalHook, 1200), zhUniversalHook: assetText(distribution.zhUniversalHook, 1200),
    channels: Array.isArray(distribution.channels) ? distribution.channels.slice(0, 12).map((channel) => ({
      name: assetText(channel?.name, 120), reason: assetText(channel?.reason, 600),
      bestFor: Array.isArray(channel?.bestFor) ? channel.bestFor.slice(0, 5).map((item) => assetText(item, 60)) : []
    })) : []
  };
}

function runAssets(run) {
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
      book: book ? { title: assetText(book.title, 500), bookSkuId: assetText(book.bookSkuId, 200), cover: assetText(book.cover, 4000), description: assetText(book.description, 4000) } : null,
      code: assetText(artifacts.code, 200),
      shortUrl: assetText(artifacts.shortUrl, 4000),
      linkId: assetText(artifacts.linkId, 200),
      posts: Array.isArray(artifacts.posts) ? artifacts.posts.map((post) => ({ type: assetText(post?.type, 120), content: assetText(post?.content), zhContent: assetText(post?.zhContent) })) : [],
      images: Array.isArray(artifacts.images) ? artifacts.images.map((image) => ({ variant: assetText(image?.variant, 120), status: assetText(image?.status, 80), taskId: assetText(image?.taskId, 200), url: assetText(image?.url, 4000), progress: Number.isFinite(Number(image?.progress)) ? Number(image.progress) : undefined, error: assetText(image?.error, 500), prompt: assetText(image?.prompt, 5000), zhPrompt: assetText(image?.zhPrompt, 5000) })) : [],
      video: assetVideo(artifacts.video),
      referenceVideo: assetVideo(artifacts.referenceVideo),
      videoRevision: assetVideo(artifacts.videoRevision),
      characterAssets: Array.isArray(artifacts.characterAssets) ? artifacts.characterAssets.slice(0, 12).map((asset) => ({ id: assetText(asset?.id, 120), provider: assetText(asset?.provider, 40), kind: assetText(asset?.kind, 60), status: assetText(asset?.status, 60), characterId: assetText(asset?.characterId, 120), characterName: assetText(asset?.characterName, 160), label: assetText(asset?.label, 160), role: assetText(asset?.role, 80), view: assetText(asset?.view, 60), url: assetText(asset?.url, 4000), approved: asset?.approved === true, error: assetText(asset?.error, 400) })) : [],
      videoPrompt: assetPrompt(artifacts.videoPrompt),
      videoPromptDraft: assetPrompt(artifacts.videoPromptDraft),
      posterPrompts: Array.isArray(artifacts.posterPrompts) ? artifacts.posterPrompts.slice(0, 4).map((item) => ({ variant: assetText(item?.variant, 120), prompt: assetText(item?.prompt, 7000), zhPrompt: assetText(item?.zhPrompt, 7000), repairCount: Number(item?.repairCount || 0) })) : [],
      distribution: assetDistribution(artifacts.distribution),
      analytics: assetAnalytics(artifacts.analytics),
      review: artifacts.review ? { status: assetText(artifacts.review.status, 80) } : null,
      usage: summaryUsage(artifacts.usage),
      modelActivity: summaryModelActivity([...(artifacts.modelActivity || []), ...(artifacts.creativeDraft?.usage || [])])
    },
    modelActivity: summaryModelActivity([...(artifacts.modelActivity || []), ...(artifacts.creativeDraft?.usage || [])]),
    events: Array.isArray(run.events) ? run.events.slice(-30).map((event) => ({ at: event?.at, type: assetText(event?.type, 100), message: assetText(event?.message, 500) })) : [],
    _assetOnly: true,
    _assetVersion: 1
  };
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
  // Archived runs stay durable for audit and external-task reconciliation,
  // but must never crowd the operator's active history list.
  const visible = [];
  const pageSize = Math.max(Math.min(limit * 3, 150), 50);
  let offset = 0;
  while (visible.length < limit) {
    const ids = await redis.zrange(RUN_INDEX, offset, offset + pageSize - 1, { rev: true });
    if (!ids.length) break;
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
    visible.push(...summaries.filter((item) => item && item.state !== 'archived'));
    if (ids.length < pageSize) break;
    offset += ids.length;
  }
  return visible.slice(0, limit);
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
async function getRunAssets(redis, id) {
  if (!redis || !/^[a-z0-9_-]{12,80}$/i.test(String(id || ''))) return null;
  const value = await redis.get(runAssetsKey(id));
  return value ? parseStored(value) : null;
}
async function saveRunAssets(redis, run) {
  if (!redis || !run?.id) return null;
  const assets = runAssets(run);
  await redis.set(runAssetsKey(run.id), JSON.stringify(assets));
  return assets;
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
    redis.set(runDetailKey(run.id), JSON.stringify(runDetail(run))),
    redis.set(runAssetsKey(run.id), JSON.stringify(runAssets(run)))
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
  const accountId = run.input?.delivery?.accountId;
  const pointerKey = activeRunKey(sku, accountId);
  const familyKey = activeRunsKey(sku, accountId);
  if (!runIsActive(run)) {
    if (typeof redis.zrem === 'function') await redis.zrem(familyKey, run.id).catch(() => {});
    const pointer = await redis.get(pointerKey).catch(() => null);
    if (String(pointer || '') === String(run.id)) await redis.del(pointerKey).catch(() => {});
    return run;
  }
  await Promise.all([
    redis.set(pointerKey, run.id, { ex: ACTIVE_RUN_TTL }),
    redis.zadd(familyKey, { score: Date.parse(run.updatedAt || run.createdAt || '') || Date.now(), member: run.id })
  ]);
  return run;
}

/**
 * Return every queued/running/ambiguous production in one immutable
 * SKU+account family. A zset is necessary because a reviewed campaign may
 * intentionally run two non-overlapping scene variants of the same book.
 * The old single pointer remains a migration/lookup accelerator, while stale
 * registry members are removed only after their durable run is inspected.
 */
async function listActiveRuns(redis, sku, accountId = 0) {
  const normalizedSku = String(sku || '').trim();
  const normalizedAccountId = Number(accountId || 0) || 0;
  if (!redis || !normalizedSku) return [];
  const pointerKey = activeRunKey(normalizedSku, normalizedAccountId);
  const familyKey = activeRunsKey(normalizedSku, normalizedAccountId);
  let members = [];
  try {
    members = typeof redis.zrange === 'function'
      ? await redis.zrange(familyKey, 0, -1, { rev: true })
      : [];
  } catch {}
  const pointer = await redis.get(pointerKey).catch(() => null);
  const ids = [...new Set([...(Array.isArray(members) ? members : []), ...(pointer ? [pointer] : [])]
    .map((value) => String(value || '')).filter(Boolean))];
  const active = [];
  for (const id of ids) {
    const run = await getRun(redis, id);
    const accountMatches = !normalizedAccountId || Number(run?.input?.delivery?.accountId || 0) === normalizedAccountId;
    const skuMatches = String(run?.input?.sku || '').trim().toLowerCase() === normalizedSku.toLowerCase();
    if (run && runIsActive(run) && accountMatches && skuMatches) active.push(run);
    else if (typeof redis.zrem === 'function') await redis.zrem(familyKey, id).catch(() => {});
  }
  // Migrate legacy runs only when neither the family registry nor its pointer
  // yielded a live item. New multi-variant campaigns never rely on this
  // bounded compatibility scan.
  if (!active.length) {
    const summaries = await listRunSummaries(redis, 50);
    const legacy = summaries.filter((run) => runIsActive(run)
      && (!normalizedAccountId || Number(run.input?.delivery?.accountId || 0) === normalizedAccountId)
      && String(run.input?.sku || '').trim().toLowerCase() === normalizedSku.toLowerCase());
    for (const summary of legacy) {
      const run = await getRun(redis, summary.id) || summary;
      if (runIsActive(run)) {
        active.push(run);
        await registerActiveRun(redis, run);
      }
    }
  }
  active.sort((left, right) => (Date.parse(right.updatedAt || right.createdAt || '') || 0)
    - (Date.parse(left.updatedAt || left.createdAt || '') || 0));
  if (active.length) {
    if (String(pointer || '') !== String(active[0].id)) {
      await redis.set(pointerKey, active[0].id, { ex: ACTIVE_RUN_TTL }).catch(() => {});
    }
  } else if (pointer) {
    await redis.del(pointerKey).catch(() => {});
  }
  return active;
}

/** Find any active member of a SKU+account family for legacy one-click
 * de-duplication. Campaign code calls listActiveRuns to validate siblings. */
async function findActiveRun(redis, sku, accountId = 0) {
  const active = await listActiveRuns(redis, sku, accountId);
  return active[0] || null;
}

async function acquireRunCreation(redis, sku, accountId = 0) {
  const normalizedSku = String(sku || '').trim();
  if (!redis || !normalizedSku) return { acquired: false, token: '', key: '' };
  const key = runCreateLockKey(normalizedSku, accountId);
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
  return Object.fromEntries(['P0', 'P1', 'P2', 'P3', 'P3_5', 'P4', 'P5', 'P6', 'P7'].map((stage) => [stage, { status: 'waiting' }]));
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
  run.stages.P0 = {
    status: 'done',
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    label: normalizedInput.delivery
      ? `${normalizedInput.delivery.appName} / ${normalizedInput.delivery.platform} / ${normalizedInput.delivery.accountTitle} selection locked`
      : 'Legacy task without an explicit target route',
    target: normalizedInput.delivery || null,
    selection: normalizedInput.p0Selection || null
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

function videoDayInfo(at = new Date()) {
  // The campaign is operated in China, so a "day" means the Beijing business
  // day. The key changes at 00:00 Asia/Shanghai, independent of a browser or
  // Vercel Function region.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  const year = Number(value('year'));
  const month = Number(value('month'));
  const day = Number(value('day'));
  const keyDate = `${value('year')}${value('month')}${value('day')}`;
  const override = String(process.env.SOCIAL_VIDEO_DAILY_LIMIT_OVERRIDE || '').trim();
  const [overrideDate, overrideValue] = override.split(':');
  const parsedOverride = Number(overrideValue);
  const limit = overrideDate === keyDate && Number.isSafeInteger(parsedOverride) && parsedOverride >= 1 && parsedOverride <= 500
    ? parsedOverride
    : 40;
  const nextMidnight = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0) - 8 * 60 * 60 * 1000);
  const expiresIn = Math.max(60, Math.ceil((nextMidnight.getTime() - at.getTime()) / 1000) + 60);
  const nextParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).formatToParts(nextMidnight);
  const nextValue = (type) => nextParts.find((part) => part.type === type)?.value || '';
  return {
    key: `nf_social:video_day:${keyDate}`,
    limit,
    expiresIn,
    label: `${value('year')}-${value('month')}-${value('day')}`,
    resetAt: nextMidnight.toISOString(),
    resetLabel: `${nextValue('month')}/${nextValue('day')} 00:00 (Asia/Shanghai)`,
    scope: 'day',
    timeZone: 'Asia/Shanghai'
  };
}

async function videoCapacity(redis) {
  const info = videoDayInfo();
  const used = Math.max(0, Number(await redis.get(info.key)) || 0);
  return { ...info, used: Math.min(used, info.limit), remaining: Math.max(0, info.limit - used) };
}

async function reserveVideoSlot(redis) {
  const info = videoDayInfo();
  await redis.set(info.key, '0', { nx: true, ex: info.expiresIn });
  const used = Number(await redis.incr(info.key));
  if (used <= info.limit) return { ...info, used, remaining: info.limit - used, granted: true };
  await redis.incrby(info.key, -1);
  return { ...info, used: info.limit, remaining: 0, granted: false };
}

async function releaseVideoSlot(redis, key) {
  if (typeof key === 'string' && key.startsWith('nf_social:video_day:')) await redis.incrby(key, -1);
}

module.exports = { getRedis, createRedis, RemoteRedis, getMany, listRuns, listRunSummaries, getRun, getRunDetail, getRunSummary, getRunAssets, saveRunAssets, saveRun, registerActiveRun, listActiveRuns, findActiveRun, acquireRunCreation, releaseRunCreation, newRun, addEvent, setStage, runSummary, runDetail, runAssets, autopilotProjection, harnessProjection, harnessOperations, publicationSummary, runIsActive, nextAutopilotAction, activeRunKey, activeRunsKey, runCreateLockKey, listCreativePlans, listCreativePlanSummaries, getCreativePlan, saveCreativePlan, newCreativePlan, creativePlanDetail, getDiscordJob, saveDiscordJob, listDiscordJobs, listDiscordJobSummaries, removeDiscordJobFromQueue, discordJobSummary, RUN_INDEX, PLAN_INDEX, DISCORD_JOB_INDEX, DISCORD_HISTORY_INDEX, videoDayInfo, videoCapacity, reserveVideoSlot, releaseVideoSlot };
