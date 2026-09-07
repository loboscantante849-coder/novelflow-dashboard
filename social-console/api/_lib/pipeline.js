const { getRun, listRunSummaries, saveRun, addEvent, setStage, reserveVideoSlot, releaseVideoSlot, videoDayInfo } = require('./store');
const { acquireLease, releaseLease } = require('./lease');
const providers = require('./providers');
const videoControl = require('./video-control');
const acBudget = require('./ac-budget');
const { effectiveVideoForRun } = require('./video-asset');
const { ensureDraftForRun } = require('./publications');
const { saveAutomaticDraft } = require('../publications');
const { appForRun, codePoolForRun, deliveryForRun } = require('./distribution');
const now = () => new Date().toISOString();
const terminal = (status) => ['done', 'failed', 'ambiguous', 'partial'].includes(status);
const posterTerminal = (status) => ['done', 'ambiguous', 'partial'].includes(status);
const VIDEO_WAIT_REASONS = Object.freeze([
  'daily_video_limit', 'hourly_video_limit', 'daily_ac_points_limit',
  'ac_token_unavailable', 'ac_budget_storage_unavailable',
  // P4 normalizes pre-submit AC failures to these operator-facing reasons so
  // the worker can skip the run until its saved retry window.
  'ac_points_budget', 'ac_configuration_wait', 'ac_capacity_wait'
]);
const videoCapacityBlocked = (reason) => VIDEO_WAIT_REASONS.includes(String(reason || ''));
const TOKENDANCE_FLASH_COOLDOWN_KEY = 'nf_social:model_cooldown:tokendance_flash';
const TOKENDANCE_DEEPSEEK_COOLDOWN_SECONDS = 210;
const TOKENDANCE_MODEL_GATE_SLOTS = 4;
const isTokenDanceFlash = (model) => ['glm-5.3-flash', 'deepseek-v4-flash-preview', 'deepseek', 'ling-3.0-flash'].includes(String(model || '').toLowerCase());

async function acquireTokenDanceGate(redis, model, runId, ttlSeconds = 660) {
  if (!isTokenDanceFlash(model)) return null;
  if (await tokenDanceDeepSeekCoolingDown(redis)) {
    throw new providers.ProviderError('TokenDance DeepSeek is in a shared upstream cooldown window', { status: 429, code: 'model_capacity_cooldown' });
  }
  const id = String(runId || '');
  const gateHash = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TOKENDANCE_MODEL_GATE_SLOTS;
  const lease = await acquireLease(redis, `nf_social:model_gate:tokendance_deepseek:${gateHash}`, ttlSeconds);
  if (!lease) throw new providers.ProviderError('TokenDance DeepSeek concurrency gate is full', { status: 429, code: 'model_capacity' });
  return lease;
}

async function tokenDanceDeepSeekCoolingDown(redis) {
  return Boolean(await redis.get(TOKENDANCE_FLASH_COOLDOWN_KEY));
}

async function startTokenDanceDeepSeekCooldown(redis) {
  // The upstream quota is shared beyond this deployment. A durable cooldown
  // prevents queued runs from turning one upstream 429 into a retry storm.
  await redis.set(TOKENDANCE_FLASH_COOLDOWN_KEY, now(), { ex: TOKENDANCE_DEEPSEEK_COOLDOWN_SECONDS });
}

function creativeModelLabel(run) {
  return ({
    'glm-5.3-flash': 'GLM 5.3 Flash',
    'deepseek-v4-flash-preview': 'DeepSeek V4 Flash Preview',
    'ling-3.0-flash': 'Ling 3.0 Flash',
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

function creativeRepairModel(modelChoice) {
  // GLM can return a prose envelope instead of the required structured
  // package. Its single bounded repair therefore uses the configured
  // TokenDance DeepSeek preview rather than cycling back into GLM.
  const choice = String(modelChoice || '').toLowerCase();
  if (choice === 'glm-5.3-flash') return 'deepseek-v4-flash-preview';
  if (choice === 'deepseek-v4-flash-preview') return 'hy3';
  // Keep the legacy logical DeepSeek route on its own provider for existing
  // non-campaign tasks; only the new V4 Preview route advances to HY3.
  if (choice === 'deepseek') return 'deepseek';
  return providers.reserveModelFor(modelChoice);
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
  // Provider content filters are model-specific and can be handled by the
  // bounded compatibility fallback below; they are not credential failures.
  if (/inappropriate content|content policy|safety filter/.test(message)) return true;
  if ([400, 401, 403].includes(status)) return false;
  if (/not configured|api key|credential|unauthorized|forbidden|invalid key|missing token/.test(message)) return false;
  return true;
}

function modelCapacityError(error) {
  return Number(error?.status) === 429
    || /concurrent|并发上限|rate limit|too many requests/i.test(String(error?.message || error || ''));
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
  // The evidence fallback only composes already locked chapter material. It
  // does not require a visible Code or link, because some current routes
  // intentionally defer attribution until their integration is live.
  return structuredModelError(stage.error) && run?.artifacts?.book && run?.artifacts?.evidence?.chapters?.length;
}

function trackingReady(run) {
  const delivery = deliveryForRun(run);
  return Boolean(run?.artifacts?.code) && (!delivery?.includeLink || Boolean(run?.artifacts?.shortUrl));
}

function trackingEnabledForRun(run) {
  const appKey = String(deliveryForRun(run)?.appKey || '').toLowerCase();
  // Keep historical and test runs that predate account-level routing on their
  // original attribution behavior. Only explicit current routes defer Code.
  if (!appKey) return true;
  return appKey === 'novelflow' || appKey === 'astranovel';
}

function trackingVisibleInCopy(run) {
  return trackingEnabledForRun(run) && run?.input?.creativeProfile?.adCreativeNoTracking !== true;
}

function visibleLanguageForRun(run) {
  const specified = String(run.input?.creativeProfile?.outputLanguage || '').toLowerCase();
  if (['en', 'pt', 'es'].includes(specified)) return specified;
  if (run.input?.creativeProfile?.forceEnglish === true) return 'en';
  // Routed social accounts default to English. A non-English campaign must be
  // explicit so catalog metadata cannot silently change the published locale.
  if (deliveryForRun(run)?.accountId) return 'en';
  const book = run.artifacts?.book || {};
  const value = `${book.title || run.input?.title || ''} ${book.description || ''} ${(book.tags || []).join(' ')}`.toLowerCase();
  if (/[ñ¿¡]|\b(el|la|esposa|heredero|olvidado|alfa|contraataca|regreso)\b/.test(value)) return 'es';
  if (/[ãõáéíóúç]|\b(sem|segunda|chance|despreocupada|próspera|amor|lobisomem)\b/.test(value)) return 'pt';
  return 'en';
}

function assertVisibleLanguage(content, language) {
  const text = String(content || '').toLowerCase();
  if (language === 'en') {
    const words = text.match(/[a-zà-ɏ]+/g) || [];
    if (words.length >= 30) {
      const english = new Set(['the', 'and', 'but', 'because', 'when', 'she', 'he', 'her', 'his', 'they', 'was', 'were', 'is', 'are', 'with', 'from', 'into', 'what', 'who', 'how', 'would', 'could', 'will', 'this', 'that', 'it', 'not']);
      const portuguese = new Set(['não', 'uma', 'com', 'para', 'ela', 'ele', 'quando', 'que', 'seu', 'sua', 'mas', 'isso', 'foi', 'estava', 'sem', 'mais', 'verdade', 'escolha', 'então']);
      const spanish = new Set(['una', 'con', 'para', 'ella', 'cuando', 'que', 'pero', 'esto', 'fue', 'estaba', 'sin', 'más', 'verdad', 'decisión', 'entonces', 'quién']);
      const count = (set) => words.reduce((total, word) => total + (set.has(word) ? 1 : 0), 0);
      const englishCount = count(english);
      const foreignCount = Math.max(count(portuguese), count(spanish));
      const strongForeignOrthography = (text.match(/[ãõçñ¿¡]/g) || []).length;
      if ((foreignCount >= 5 && foreignCount > englishCount) || (strongForeignOrthography >= 2 && foreignCount >= 3)) {
        throw new providers.ProviderError('English social route received probable Portuguese or Spanish visible creative copy');
      }
      if (englishCount < 3) throw new providers.ProviderError('English social route requires clearly English visible creative copy');
    }
  }
  if (language === 'pt' && !/\b(que|não|uma|com|para|ela|ele|amor|quando|sem)\b/.test(text)) throw new providers.ProviderError('Portuguese source requires Portuguese visible creative copy');
  if (language === 'es' && !/\b(que|una|con|para|ella|el|amor|cuando|por)\b/.test(text)) throw new providers.ProviderError('Spanish source requires Spanish visible creative copy');
}

function providerOptionsForRun(run) {
  const app = appForRun(run);
  const delivery = deliveryForRun(run);
  const link = app.facebookLink || {};
  return {
    applicationId: app.applicationId,
    brandName: app.name,
    channel: link.channelCode || process.env.NOVELFLOW_CHANNEL_CODE || 'FB',
    channelSource: link.channelSource,
    channelNameId: link.channelNameId,
    redirectConfigId: link.redirectConfigId,
    landingTemplateId: link.landingTemplateId,
    landingTemplateName: link.landingTemplateName,
    operatorName: link.operatorName,
    promoter: link.promoter || run?.input?.promoter || 'xujt',
    platform: delivery?.platform || 'facebook'
  };
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

// Chapter reads are read-only, but a transient Writer Admin/catalogue outage
// used to bubble straight to processRunOnce's terminal failure handler. That
// left P2 looking permanently failed even though the exact evidence cursor
// was still intact. Keep deterministic identity/permission errors visible;
// only capacity, timeout, transport and 5xx failures receive a bounded,
// cursor-preserving retry.
function recoverableEvidenceError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || '').toLowerCase();
  // ProviderError often omits an HTTP status for deterministic content
  // validation. Do not turn an empty chapter, missing SKU, or ownership
  // mismatch into an endless background retry.
  if (/empty content|no chapters|chapter .* not found|exact .*not found|sku .*not found|ownership|inactive|invalid sku|different application|application mismatch/.test(message)) return false;
  if (status >= 400 && status < 500 && ![408, 429].includes(status)) return false;
  return !status || [408, 429].includes(status) || status >= 500
    || /timed out|timeout|temporar|network|transport|invalid json|rate limit|concurrent/.test(message);
}

// Attribution is a remote, mostly read/verify path.  A temporary Writer
// Admin outage must not turn a run into a terminal P5 failure that requires a
// manual click, while deterministic ownership/permission errors still need a
// human decision.  This helper deliberately excludes ambiguous write
// outcomes; those are handled by the durable intent/reconciliation path.
function recoverableAttributionError(error) {
  if (error?.ambiguous) return false;
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || '').toLowerCase();
  if ([400, 401, 403, 404, 409, 422].includes(status)) return false;
  if (/ownership|application mismatch|different application|disabled|invalid code|invalid link|not configured/.test(message)) return false;
  return !status || [408, 429].includes(status) || status >= 500
    || /timed out|timeout|temporar|network|transport|invalid json|rate limit|gateway|upstream/.test(message);
}

function scheduleAttributionRetry(run, error, phase = '') {
  const stage = run.stages.P5 || {};
  const retryPhase = phase || stage.phase || 'code';
  const attempt = Number(stage.attributionRetryCount || 0) + 1;
  const waitMs = Math.min(10 * 60 * 1000, 15000 * (2 ** Math.min(attempt - 1, 5)));
  const nextAttemptAt = new Date(Date.now() + waitMs).toISOString();
  if (attempt > MAX_ATTRIBUTION_PROVIDER_RETRIES) {
    setStage(run, 'P5', 'blocked', {
      phase: retryPhase,
      blockedReason: 'attribution_provider_unavailable',
      attributionRetryCount: attempt,
      nextAttemptAt: '',
      recoverable: false,
      error: '归因服务连续不可用，已停止后台重试；确认服务恢复后再手动恢复'
    });
    run.state = 'blocked';
    addEvent(run, 'attribution_provider_blocked', 'P5 stopped after bounded provider retries; no duplicate Code or link write was attempted', { attempts: attempt, phase: retryPhase });
    return '';
  }
  setStage(run, 'P5', 'waiting', {
    // Preserve the code/link phase and any durable intent fields.  The next
    // worker tick will repeat only the safe lookup or the pending verification.
    phase: retryPhase,
    attributionRetryCount: attempt,
    nextAttemptAt,
    recoverable: true,
    error: cleanError(error),
    label: '归因服务暂时不可用，已保存 Code/短链进度并自动续试'
  });
  run.state = 'running';
  addEvent(run, 'attribution_provider_wait', 'P5 attribution provider was temporarily unavailable; the saved Code/link phase will resume without creating a duplicate', {
    attempt, phase: retryPhase, nextAttemptAt, error: cleanError(error)
  });
  return nextAttemptAt;
}

function attributionWriteUncertain(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '').toLowerCase();
  return Boolean(error?.ambiguous)
    || status >= 500
    || ['provider_transport', 'provider_timeout', 'provider_invalid_json'].includes(code);
}

const MAX_ATTRIBUTION_PROVIDER_RETRIES = 12;
const MAX_ATTRIBUTION_RECONCILE_ATTEMPTS = 12;

// Older runs were persisted before P5 received an explicit phase field.  A
// worker must never silently return on those records: doing so leaves the run
// looking active while no branch can advance it.  Normalize the legacy shape
// from durable intents/artifacts before the first P5 transition.  This is
// metadata-only and never performs a remote write or allocates a new Code.
const P5_PHASES = new Set(['code', 'link', 'code_reconcile', 'link_reconcile', 'code_only', 'attribution_deferred']);
function normalizeAttributionStage(run) {
  run.stages = run.stages || {};
  const stage = run.stages.P5 || (run.stages.P5 = { status: 'waiting' });
  const status = String(stage.status || 'waiting');
  const phase = String(stage.phase || '');
  if (status === 'done' || status === 'failed' || status === 'ambiguous') return stage;
  if (P5_PHASES.has(phase)) return stage;
  const code = String(run.artifacts?.code || '').trim();
  if (stage.codeCreateIntent && code) {
    stage.phase = 'code_reconcile';
    stage.recoverable = true;
    return stage;
  }
  if (stage.linkCreateIntent && code) {
    stage.phase = 'link_reconcile';
    stage.recoverable = true;
    return stage;
  }
  // A legacy run with a Code but no phase still needs a read-only ownership
  // check before it can advance.  Never allocate a replacement Code here.
  if (code) {
    stage.phase = 'code';
    stage.recoverable = true;
    return stage;
  }
  // No durable attribution identity exists, so the normal waiting branch can
  // allocate the first route-scoped Code exactly once.
  stage.phase = '';
  return stage;
}

function scheduleAttributionReconcile(run, error, phase) {
  const stage = run.stages.P5 || {};
  const attempts = Number(stage.attributionReconcileAttempts || 0) + 1;
  if (attempts > MAX_ATTRIBUTION_RECONCILE_ATTEMPTS) {
    setStage(run, 'P5', 'ambiguous', {
      phase,
      blockedReason: 'attribution_write_ambiguous',
      recoverable: false,
      nextAttemptAt: '',
      attributionReconcileAttempts: attempts,
      error: '归因写入结果在多次只读核验后仍无法确认，请人工核对 Code/短链后再继续'
    });
    run.state = 'blocked';
    addEvent(run, 'attribution_write_ambiguous', 'P5 stopped after bounded read-only reconciliation; no duplicate Code or link write was attempted');
    return false;
  }
  scheduleAttributionRetry(run, error, phase);
  run.stages.P5.attributionReconcileAttempts = attempts;
  return true;
}

function scheduleEvidenceRetry(run, phase, error) {
  const stage = run.stages.P2 || {};
  const attempt = Number(stage.evidenceRetryCount || 0) + 1;
  const waitMs = Math.min(5 * 60 * 1000, 15000 * attempt);
  const nextAttemptAt = new Date(Date.now() + waitMs).toISOString();
  const label = phase === 'chapter_list'
    ? '章节目录暂时不可用，已保存 P2 进度并自动续试'
    : '章节证据读取暂时不可用，已保存 P2 游标并自动续试';
  setStage(run, 'P2', 'waiting', {
    label,
    phase: phase === 'chapter_list' ? 'evidence_catalogue_wait' : 'evidence_content_wait',
    evidenceRetryCount: attempt,
    nextAttemptAt,
    recoverable: true,
    error: cleanError(error)
  });
  run.state = 'running';
  addEvent(run, 'evidence_read_wait', phase === 'chapter_list'
    ? 'Chapter list read was temporarily unavailable; P2 will retry from the saved selection'
    : 'Chapter evidence read was temporarily unavailable; P2 will retry the same saved cursor', {
      attempt, nextAttemptAt, error: cleanError(error)
    });
  return nextAttemptAt;
}

function definitiveSubmissionError(error) {
  const status = Number(error?.status || 0);
  return status >= 400 && status < 500;
}

// These failures are known to happen before AC can accept a paid request.
// They must return the run to a prepared, retryable state and release the
// daily video slot; otherwise a missing token or exhausted points budget
// permanently consumes one of the 40 daily slots and leaves the campaign
// looking like a paid failure.  Transport/timeouts are deliberately excluded:
// the provider may have accepted those requests, so their intent remains
// ambiguous and the slot is retained for reconciliation.
function preSubmitVideoFailure(error) {
  const code = String(error?.code || '').toLowerCase();
  if (['ac_token_unavailable', 'ac_budget_storage_unavailable', 'ac_points_budget_exceeded'].includes(code)) return true;
  // A definitive 429 means the provider rejected the request before creating
  // a task. It is safe to retry after a short capacity wait, unlike a 5xx or
  // timeout where acceptance cannot be ruled out.
  return Number(error?.status || 0) === 429 && !Boolean(error?.ambiguous);
}

function budgetRetryAt(budget) {
  const reset = Date.parse(String(budget?.resetAt || ''));
  if (Number.isFinite(reset) && reset > Date.now()) return new Date(reset + 1000).toISOString();
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

async function releaseUnsubmittedVideoSlot(redis, video, reason = 'pre_submit_failure') {
  const slot = video?.slot;
  if (!slot?.key || slot.override || slot.releasedAt) return false;
  await releaseVideoSlot(redis, slot.key).catch(() => {});
  slot.releasedAt = now();
  slot.releaseReason = String(reason || '').slice(0, 120);
  return true;
}

function activeAcBudgetReservation(video) {
  const reservation = video?.budgetReservation;
  if (!reservation || reservation.granted !== true || reservation.billable === false) return null;
  if (reservation.releasedAt || reservation.settledAt) return null;
  return reservation;
}

function budgetReservationForVideo(video) {
  return activeAcBudgetReservation(video) || null;
}

async function reserveAcBudgetForVideo(redis, run, video) {
  const existing = budgetReservationForVideo(video);
  if (existing) return existing;
  const reservation = await acBudget.reserve(redis, 'video_create', {
    metadata: {
      source: 'pipeline.p4',
      runId: String(run?.id || ''),
      remark: String(video?.remark || ''),
      payloadFingerprint: String(video?.payloadFingerprint || '')
    }
  });
  if (!reservation?.granted) throw acBudget.budgetError(reservation, 'video_create', reservation?.cost || 1);
  // Save the complete reservation before the paid provider call. A worker
  // interruption after this point can reconcile the same intent without
  // authorizing a second request or reserving a second point.
  video.budgetReservation = {
    granted: true,
    billable: reservation.billable !== false,
    reservationId: String(reservation.reservationId || ''),
    settlementKey: String(reservation.settlementKey || ''),
    day: String(reservation.day || ''),
    key: String(reservation.key || ''),
    eventsKey: String(reservation.eventsKey || ''),
    limit: Number(reservation.limit || 0),
    resetAt: String(reservation.resetAt || ''),
    expiresIn: Number(reservation.expiresIn || 0),
    timeZone: String(reservation.timeZone || 'Asia/Shanghai'),
    scope: String(reservation.scope || 'day'),
    used: Number(reservation.used || 0),
    remaining: Number(reservation.remaining || 0),
    cost: Number(reservation.cost || 1),
    operation: String(reservation.operation || 'video_create'),
    reservedAt: now()
  };
  // The reservation itself is a durable paid-intent boundary. Persist it
  // before changing P4 to submitting or calling the provider so a function
  // timeout/restart can reuse the same point reservation instead of creating
  // a second one for the same prepared payload.
  await saveRun(redis, run);
  return video.budgetReservation;
}

async function settleAcBudgetForVideo(redis, video, result = {}) {
  const reservation = activeAcBudgetReservation(video);
  if (!reservation) return false;
  try {
    const settled = await acBudget.outcome(redis, reservation, {
      status: String(result.status || 'submitted_or_unknown'),
      externalId: String(result.externalId || video?.threadId || ''),
      providerCode: String(result.providerCode || '')
    });
    if (!settled) {
      reservation.settlementError = 'AC budget settlement was not confirmed';
      reservation.lastSettlementAttemptAt = now();
      return false;
    }
    reservation.settledAt = now();
    reservation.settlementStatus = String(result.status || 'submitted_or_unknown');
    return true;
  } catch (error) {
    // A successful AC task must never be turned into a failed run because
    // accounting telemetry was briefly unavailable. Keep the reservation
    // durable so the next reconciliation can settle it idempotently.
    reservation.settlementError = cleanError(error);
    reservation.lastSettlementAttemptAt = now();
    return false;
  }
}

async function releaseAcBudgetForVideo(redis, video, reason = 'pre_submit_failure') {
  const reservation = activeAcBudgetReservation(video);
  if (!reservation) return false;
  try {
    const released = await acBudget.release(redis, reservation, reason);
    if (released) {
      reservation.releasedAt = now();
      reservation.releaseReason = String(reason || '').slice(0, 160);
      reservation.settlementStatus = 'released';
    }
    return Boolean(released);
  } catch (error) {
    reservation.releaseError = cleanError(error);
    reservation.lastReleaseAttemptAt = now();
    return false;
  }
}

function reusableVideoSlot(video) {
  const slot = video?.slot;
  if (!slot?.key || slot.releasedAt || slot.settledAt) return null;
  const current = videoDayInfo();
  // A slot from a previous Beijing business day must never be reused. Its
  // Redis key will expire independently; the new day needs a fresh reserve.
  if (String(slot.key) !== String(current.key)) return null;
  return {
    ...current,
    ...slot,
    granted: true,
    used: Number(slot.position || slot.used || 0),
    remaining: Math.max(0, Number(current.limit || slot.limit || 0) - Number(slot.position || slot.used || 0)),
    override: slot.override === true
  };
}

function syncRun(target, source) {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  Object.assign(target, source);
  return target;
}

function selectedChapters(chapters, payPoint, sceneChapters = [], sceneLane = null, sceneRepeatIndex = null, sceneRepeatCount = null) {
  const sorted = [...chapters].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const lockedOrders = [...new Set((Array.isArray(sceneChapters) ? sceneChapters : [])
    .map(Number)
    .filter((chapter) => Number.isInteger(chapter) && chapter > 0))]
    .sort((left, right) => left - right);
  if (lockedOrders.length) {
    const byOrder = new Map(sorted.map((item) => [Number(item.order || 0), item]));
    const missing = lockedOrders.filter((order) => !byOrder.has(order));
    if (missing.length) throw new providers.ProviderError(`Scene chapter lock could not find chapters ${missing.join(', ')}`);
    return lockedOrders.map((order) => byOrder.get(order)).map((item) => ({
      id: String(item.id), order: Number(item.order || 0), title: String(item.title || ''), source: 'scene_lock'
    }));
  }
  const hasLane = sceneLane !== null && sceneLane !== undefined && sceneLane !== '';
  const lane = Number(sceneLane);
  const repeatCount = Number(sceneRepeatCount);
  const repeatIndex = Number(sceneRepeatIndex) - 1;
  if (hasLane && Number.isInteger(repeatCount) && repeatCount >= 2
    && Number.isInteger(repeatIndex) && repeatIndex >= 0 && repeatIndex < repeatCount) {
    const minimum = repeatCount * 3;
    if (sorted.length < minimum) throw new providers.ProviderError(`Source-locked scene repeat requires at least ${minimum} chapters`);
    const windowSize = Math.min(5, Math.max(3, Math.floor(sorted.length / repeatCount)));
    const start = repeatCount === 1 ? 0 : Math.round((sorted.length - windowSize) * repeatIndex / (repeatCount - 1));
    return sorted.slice(start, start + windowSize).map((item) => ({
      id: String(item.id), order: Number(item.order || 0), title: String(item.title || ''), source: `scene_lane_${lane}`
    }));
  }
  if (hasLane && Number.isInteger(lane) && lane >= 0 && lane <= 2) {
    // Repeated-book campaign assets use disjoint source windows instead of
    // asking the model to "be different" over the same opening evidence.
    // Two repeats use lanes 0 and 2; lane 1 is reserved for a future third
    // scene. Six chapters are the minimum for two non-overlapping 3-chapter
    // windows, otherwise the quality-preserving repeat must fail before P3.
    if (sorted.length < 6) throw new providers.ProviderError('Source-locked scene repeat requires at least six chapters');
    const windowSize = Math.min(5, Math.max(3, Math.floor(sorted.length / 3)));
    const start = Math.round((sorted.length - windowSize) * lane / 2);
    return sorted.slice(start, start + windowSize).map((item) => ({
      id: String(item.id), order: Number(item.order || 0), title: String(item.title || ''), source: `scene_lane_${lane}`
    }));
  }
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

const MECHANICAL_BRIDGE_PATTERNS = Object.freeze([
  /that one line changes the air/i,
  /the pressure is already there, sharp and personal/i,
  /then the story turns just enough/i,
  /what looked survivable becomes/i,
  /and then comes the shift nobody can take back/i
]);

function assertPremiumCopyOpening(content) {
  const text = String(content || '').trim();
  if (MECHANICAL_BRIDGE_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new providers.ProviderError('Creative post uses a repeated mechanical bridge template; rewrite with source-specific detail and consequence');
  }
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  if (/^(?:["“']?chapter\s+\d+["”']?|["“']?note\s+to\s+readers?["”']?|pov\s*:?\s*.*|[a-z][a-z0-9 _-]{0,48}\s*['’]s\s+pov\s*:?)$/i.test(firstLine)) {
    throw new providers.ProviderError('Creative post cannot begin with a chapter label, Note to Readers, or a bare POV label');
  }
}

function storySpecificCta(line, language = 'en') {
  const value = String(line || '').trim();
  const normalized = normalizedSourceText(value);
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length < 7 || /^(?:read it now|click here|start reading|continue reading|learn more)[.!?]*$/i.test(value)) return false;
  const legacy = /\b(?:see|read)\s+what\s+happens\s+when\b|\b(?:veja|leia)\s+o\s+que\s+acontece\s+quando\b|\b(?:mira|lee)\s+lo\s+que\s+pasa\s+cuando\b/i;
  if (legacy.test(value)) return true;
  const freshInvitation = language === 'pt'
    ? /\b(?:descubra|acompanhe|veja\s+se|qual|quem|como|ser[aá]|pode)\b/i
    : language === 'es'
      ? /\b(?:descubre|acompaña|mira\s+si|cu[aá]l|qui[eé]n|c[oó]mo|podr[aá]|puede)\b/i
      : /\b(?:find\s+out|discover|follow|stay\s+for|watch\s+what|which|who|what|how|would|can|will|the\s+next\s+(?:move|choice|chapter))\b/i;
  return freshInvitation.test(value) && (/[?]\s*$/.test(value) || /\b(?:find\s+out|discover|follow|stay\s+for|watch\s+what|descubra|acompanhe|descubre|acompaña)\b/i.test(value));
}

function copyShingles(content, size = 4) {
  const words = String(content || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/#[A-Za-z][A-Za-z0-9_]*/g, ' ')
    .replace(/["“][^"”]{3,220}["”]/g, ' ')
    .replace(/\b(?:search|use)\s+(?:code|promo(?:tion)?\s*code)\b[^\n]*/gi, ' ')
    .toLowerCase()
    .match(/[a-zÀ-ɏ]+/g) || [];
  const result = new Set();
  for (let index = 0; index <= words.length - size; index += 1) result.add(words.slice(index, index + size).join(' '));
  return result;
}

function shingleSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function campaignCopySkeleton(content) {
  return String(content || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/#[A-Za-z][A-Za-z0-9_]*/g, ' ')
    .replace(/["“][^"”]{3,220}["”]/g, ' ')
    .replace(/\b(?:search|use)\s+(?:code|promo(?:tion)?\s*code)\b[^\n]*/gi, ' ')
    .replace(/\b\d{4,6}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
}

async function reserveCampaignCreativeUniqueness(redis, run, creative) {
  const campaignId = String(run.input?.campaign?.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 100);
  if (!redis || !campaignId || run.input?.creativeProfile?.uniquenessRequired !== true) return null;
  const registryKey = `nf_social:campaign:${campaignId}:creative_registry`;
  const lockKey = `${registryKey}:lock`;
  let lease = null;
  for (let attempt = 0; attempt < 12 && !lease; attempt += 1) {
    lease = await acquireLease(redis, lockKey, 10);
    if (!lease) await new Promise((resolve) => setTimeout(resolve, 75));
  }
  if (!lease) throw new providers.ProviderError('Campaign creative uniqueness registry is temporarily busy', { status: 429 });
  try {
    let entries = [];
    try {
      const parsed = JSON.parse(String(await redis.get(registryKey) || '[]'));
      if (Array.isArray(parsed)) entries = parsed.filter((item) => item && typeof item === 'object' && item.runId !== run.id).slice(-80);
    } catch {}
    const skeletons = creative.posts.map((post) => campaignCopySkeleton(post.content));
    const openingFingerprints = creative.posts.map((post) => providers.sha(normalizedSourceText(String(post.content).split(/\r?\n/).find((line) => line.trim()) || '')).slice(0, 24));
    const evidenceChapters = [...new Set((creative.videoPrompt?.evidenceChapters || creative.videoPrompt?.sourceEvidence?.map((item) => item.chapter) || []).map(Number).filter(Boolean))].sort((left, right) => left - right);
    const sceneFingerprint = providers.sha(JSON.stringify({
      sku: String(run.input?.sku || ''),
      evidenceChapters,
      hook: normalizedSourceText(creative.videoPrompt?.hook),
      reversal: normalizedSourceText(creative.videoPrompt?.reversal),
      cliffhanger: normalizedSourceText(creative.videoPrompt?.cliffhanger)
    }));
    for (const entry of entries) {
      if (entry.sceneFingerprint && entry.sceneFingerprint === sceneFingerprint) {
        throw new providers.ProviderError('Creative package missing required campaign uniqueness: the same story scene was already reserved');
      }
      if ((entry.openingFingerprints || []).some((fingerprint) => openingFingerprints.includes(fingerprint))) {
        throw new providers.ProviderError('Creative package missing required campaign uniqueness: an opening line was already reserved');
      }
      for (const current of skeletons) {
        for (const previous of entry.skeletons || []) {
          if (shingleSimilarity(copyShingles(current), copyShingles(previous)) >= 0.72) {
            throw new providers.ProviderError('Creative package missing required campaign uniqueness: its copy skeleton is too similar to another campaign item');
          }
        }
      }
    }
    const reservation = {
      runId: run.id,
      accountId: Number(run.input?.delivery?.accountId || 0),
      sku: String(run.input?.sku || '').slice(0, 100),
      formatId: String(run.input?.creativeProfile?.creativeForm || '').slice(0, 80),
      openingFingerprints,
      sceneFingerprint,
      skeletons,
      reservedAt: now()
    };
    await redis.set(registryKey, JSON.stringify([...entries, reservation].slice(-80)), { ex: 30 * 24 * 60 * 60 });
    return { sceneFingerprint, openingFingerprints, threshold: 0.72, reservedAt: reservation.reservedAt };
  } finally {
    await releaseLease(redis, lease);
  }
}

function sourceRelevantHashtags(run, content, existing = []) {
  const haystack = `${run?.artifacts?.book?.title || ''} ${(run?.artifacts?.book?.tags || []).join(' ')} ${content || ''}`.toLowerCase();
  const candidates = [];
  if (/alpha|luna|lycan|wolf|mate|pack/.test(haystack)) candidates.push('#WerewolfRomance', '#FatedMates', '#ParanormalRomance');
  if (/ceo|billionaire|boss|tycoon/.test(haystack)) candidates.push('#BillionaireRomance', '#OfficeRomance');
  if (/mafia|don|crime|underworld/.test(haystack)) candidates.push('#MafiaRomance', '#DarkRomance');
  if (/daughter|mother|father|family|wife|divorce/.test(haystack)) candidates.push('#FamilyDrama', '#SecondChanceRomance');
  if (/revenge|regret|betray|ashes|walks away/.test(haystack)) candidates.push('#RevengeRomance', '#EmotionalRead');
  candidates.push('#RomanceReads', '#RomanceBooks', '#FictionReads', '#BookTok', '#BookRecs');
  const normalized = [...existing, ...candidates]
    .map((tag) => String(tag || '').trim())
    .filter((tag) => /^#[A-Za-z][A-Za-z0-9_]*$/.test(tag));
  return [...new Set(normalized.map((tag) => tag.toLowerCase()))]
    .map((lower) => normalized.find((tag) => tag.toLowerCase() === lower))
    .slice(0, 8);
}

function canonicalizeHashtagEnding(content, run) {
  const original = String(content || '').trim();
  const observed = original.match(/#[A-Za-z][A-Za-z0-9_]*/g) || [];
  const tags = sourceRelevantHashtags(run, original, observed);
  // Move tags out of prose and put the bounded, source-relevant set on the
  // required final line.  This never changes the narrative, CTA, Code, URL,
  // evidence, or emoji; it only repairs a common structured-output layout
  // lapse from compatible gateways.
  const body = original.replace(/#[A-Za-z][A-Za-z0-9_]*/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${body}\n${tags.slice(0, Math.max(5, Math.min(8, tags.length))).join(' ')}`.trim();
}

function normalizeCreative(result, run, options = {}) {
  const source = result.creative || {};
  const needsPosterCreative = posterCreativeRequired(run);
  // A campaign scene lock is a hard evidence boundary, not prompt advice.
  // Validate every cited quote against only the locked chapters so a model
  // cannot quietly fall back to the book's familiar opening hook.
  const sourceChapters = sceneEvidenceChapters(run);
  if (!Array.isArray(source.posts) || source.posts.length !== 2) throw new providers.ProviderError('Creative model did not return exactly two posts');
  const expectedTypes = ['hook', 'escalation'];
  const delivery = deliveryForRun(run);
  const appName = delivery?.appName || 'NovelFlow';
  const includeTracking = trackingVisibleInCopy(run);
  const sourceLanguage = run.input?.creativeProfile?.forceEnglish === true ? 'en' : visibleLanguageForRun(run);
  const includeLink = includeTracking && delivery?.includeLink !== false;
  const posts = source.posts.map((post, index) => {
    const six = post.sixSteps || {};
    for (const key of ['hook', 'pain', 'sensory', 'contrast', 'deepDesire', 'emotionalCta']) if (!String(six[key] || '').trim()) throw new providers.ProviderError(`Creative model omitted ${key}`);
    const evidence = Array.isArray(post.evidence) ? post.evidence : [];
    if (evidence.length < 2) throw new providers.ProviderError('Each post must cite at least two chapter excerpts');
    if (!evidenceMatchesSource(evidence, sourceChapters)) throw new providers.ProviderError('Creative post evidence must be exact text from its cited chapter');
    const type = expectedTypes[index];
    const expectedFormat = index === 0
      ? String(run.input?.creativeProfile?.creativeForm || '')
      : String(run.input?.creativeProfile?.secondaryForm || '');
    if (run.input?.creativeProfile?.uniquenessRequired === true) {
      if (!expectedFormat || String(post.formatId || '') !== expectedFormat) throw new providers.ProviderError(`Creative post must preserve assigned format ${expectedFormat || index}`);
      if (!String(post.openingGrammar || '').trim()) throw new providers.ProviderError('Creative post must preserve its assigned opening grammar');
      if (index === 0 && run.input?.creativeProfile?.openingGrammar && String(post.openingGrammar) !== String(run.input.creativeProfile.openingGrammar)) throw new providers.ProviderError('Primary creative post changed its assigned opening grammar');
    }
    let content = String(post.content || Object.values(six).join('\n\n')).trim();
    assertVisibleLanguage(content, sourceLanguage);
    if (options.allowTemplateCandidate !== true) assertPremiumCopyOpening(content);
    const linkPlacement = includeLink && run.input?.creativeProfile?.ctaLinkPlacement === 'front' ? 'front' : 'end';
    if (includeLink && run.artifacts.shortUrl && !content.includes(run.artifacts.shortUrl)) content += `\n${run.artifacts.shortUrl}`;
    if (includeLink && linkPlacement === 'front' && run.artifacts.shortUrl) {
      const url = String(run.artifacts.shortUrl);
      const withoutUrl = content.split(/\r?\n/).filter((line) => line.trim() !== url).join('\n').trim();
      content = `${url}\n\n${withoutUrl}`.trim();
    }
    content = canonicalizeHashtagEnding(content, run);
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const hashtags = content.match(/#[A-Za-z][A-Za-z0-9_]*/g) || [];
    if (hashtags.length < 5 || hashtags.length > 8) throw new providers.ProviderError('Creative post must end with 5-8 relevant hashtags');
    const shortUrlIndex = includeLink && run.artifacts.shortUrl ? lines.findIndex((line) => line === run.artifacts.shortUrl) : -1;
    if (includeLink && run.artifacts.shortUrl && (linkPlacement === 'front' ? shortUrlIndex !== 0 : shortUrlIndex < 2)) throw new providers.ProviderError(linkPlacement === 'front' ? 'Creative post must place the verified short URL first' : `Creative post must put the verified short URL after its CTA and ${appName} Code guidance`);
    if (!includeLink && lines.some((line) => /^https?:\/\//i.test(line))) throw new providers.ProviderError('Only eligible Facebook drafts may contain a link');
    const code = String(run.artifacts.code || '').trim();
    const codeGuidancePattern = `\\b(?:search|use)\\s+(?:code|promo(?:tion)?\\s*code)\\b`;
    // Deferred-attribution routes intentionally have no Code.  Do not turn
    // an empty code into `\\b\\b`, which matches every word boundary and
    // falsely rejects otherwise valid English copy.
    const forbiddenTracking = code
      ? new RegExp(`\\b${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|${codeGuidancePattern}`, 'i')
      : new RegExp(codeGuidancePattern, 'i');
    if (!includeTracking && forbiddenTracking.test(content)) throw new providers.ProviderError('Advertising creative must not include Code guidance');
    const ctaLine = linkPlacement === 'front'
      ? lines[lines.length - 3] || String(six.emotionalCta || '').trim()
      : shortUrlIndex >= 2 ? lines[shortUrlIndex - 2] : lines[includeTracking ? lines.length - 3 : lines.length - 2] || String(six.emotionalCta || '').trim();
    if (!storySpecificCta(ctaLine, sourceLanguage)) throw new providers.ProviderError('Creative post CTA must use a story-specific localized invitation or unresolved question');
    const codeLine = linkPlacement === 'front' ? lines[lines.length - 2] || '' : shortUrlIndex >= 1 ? lines[shortUrlIndex - 1] : lines[lines.length - 2] || '';
    if (includeTracking && (!new RegExp(appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(codeLine) || !new RegExp(`\\b${String(run.artifacts.code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(codeLine))) throw new providers.ProviderError(`Creative post must include a ${appName} Code search line`);
    const tagLine = lines[lines.length - 1] || '';
    const tagsOnFinalLine = tagLine.match(/#[A-Za-z][A-Za-z0-9_]*/g) || [];
    if (!tagLine || tagsOnFinalLine.length !== hashtags.length || (includeLink && linkPlacement === 'end' && shortUrlIndex !== lines.length - 2) || (!includeLink && tagLine !== lines[lines.length - 1])) throw new providers.ProviderError(includeLink && linkPlacement === 'end' ? 'Creative post must end with its short URL and one hashtag-only line' : 'Creative post must end with one hashtag-only line and contain no URL');
    const narrative = linkPlacement === 'front'
      ? lines.slice(1, Math.max(1, lines.length - 3)).join('\n')
      : lines.slice(0, Math.max(0, shortUrlIndex >= 0 ? shortUrlIndex - 2 : lines.length - (includeTracking ? 3 : 2))).join('\n');
    if (/\b(?:read it now|click here|start reading|read the explosive beginning|use\s+(?:code|promo(?:tion)?\s*code)|code\s*[:#-]?\s*\d+)/i.test(narrative)) throw new providers.ProviderError('Creative post used a mechanical CTA or promotion-code wording in its narrative');
    const narrativeLines = narrative.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const paragraphBlocks = narrative.split(/\r?\n\s*\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (paragraphBlocks.length < 3 && narrativeLines.length < 3) throw new providers.ProviderError('Creative post must use readable short paragraphs');
    const normalizedLines = narrativeLines.map(normalizedSourceText).filter((line) => line.length >= 24);
    if (new Set(normalizedLines).size !== normalizedLines.length) throw new providers.ProviderError('Creative post repeats a visible narrative line instead of advancing the story');
    const emojiCount = (narrative.match(/[\u{2600}-\u{27BF}\u{1F300}-\u{1FAFF}]/gu) || []).length;
    const emojiMin = run.input?.creativeProfile?.emojiRange === '3-5' ? 3 : 2;
    const emojiMax = run.input?.creativeProfile?.emojiRange === '3-5' ? 5 : 4;
    if (emojiCount < emojiMin || emojiCount > emojiMax) throw new providers.ProviderError(`Creative post needs ${emojiMin}-${emojiMax} fitting emoji in its narrative`);
    if ((narrative.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length < 70) throw new providers.ProviderError('Creative post needs enough story-specific narrative detail');
    return { type, formatId: String(post.formatId || expectedFormat), openingGrammar: String(post.openingGrammar || ''), sixSteps: six, content, zhContent: String(post.zhContent || '').trim(), evidence };
  });
  const quoteOpeningRequired = run.input?.creativeProfile?.openingGrammar === 'dialogue_verdict'
    || run.input?.creativeProfile?.hookDevice === 'dialogue_cut'
    || run.input?.creativeProfile?.creativeForm === 'witnessed_confrontation';
  if (quoteOpeningRequired && !/^\s*["“][^\n"”]{3,180}["”]/.test(posts[0].content)) throw new providers.ProviderError('The assigned dialogue-verdict form must open with a grounded quoted character line');
  const openingLines = posts.map((post) => normalizedSourceText(String(post.content).split(/\r?\n/).find((line) => line.trim()) || ''));
  if (openingLines[0] && openingLines[0] === openingLines[1]) throw new providers.ProviderError('Primary and secondary creative versions must use different openings');
  if (run.input?.creativeProfile?.uniquenessRequired === true) {
    const similarity = shingleSimilarity(copyShingles(posts[0].content), copyShingles(posts[1].content));
    if (similarity >= 0.72) throw new providers.ProviderError('Creative versions repeat the same copy skeleton; rewrite with different form, rhythm, and CTA');
  }
  const videoPrompt = source.videoPrompt || {};
  const posterPrompts = Array.isArray(source.posterPrompts) ? source.posterPrompts : [];
  const byVariant = new Map(posterPrompts.map((item) => [String(item.variant || ''), item]));
  if (options.skipMedia !== true) {
    if (!String(videoPrompt.adCopy || '').trim() || !String(videoPrompt.buildRequirement || '').trim()) throw new providers.ProviderError('Creative model returned an empty video prompt');
    assertVisibleLanguage([
      videoPrompt.hook, videoPrompt.valuePromise, videoPrompt.escalation,
      videoPrompt.reversal, videoPrompt.cliffhanger, videoPrompt.adCopy
    ].join(' '), sourceLanguage);
    assertVisibleLanguage(videoPrompt.buildRequirement, sourceLanguage);
    if (run.input?.creativeProfile?.qualityMode === 'premium') {
      const sourceViolation = premiumVideoEvidenceViolation(videoPrompt);
      // Evidence continuation is an explicitly operator-approved recovery
      // path. It still blocks author notes, explicit sexual text, and wake-up
      // openings, but it may proceed when the locked source lacks a strong
      // conflict-object score so the item can reach SocialEcho for review.
      const onlyLowInformation = /hook lacks a concrete conflict object/i.test(String(sourceViolation || ''));
      if (sourceViolation && !(options.allowLowInfoVideo === true && onlyLowInformation)) {
        throw new providers.ProviderError(sourceViolation, { status: 422, code: 'video_source_not_renderable' });
      }
    }
    // Reject the low-value wake-up/bedroom opener before it can reach AC. The
    // worker will use its bounded repair/fallback path to produce a concrete,
    // source-grounded action instead; no paid task is touched here.
    if (typeof videoControl.assertPremiumVideoOpening === 'function') videoControl.assertPremiumVideoOpening(videoPrompt.buildRequirement);
    for (const key of ['hook', 'valuePromise', 'escalation', 'reversal', 'cliffhanger']) if (String(videoPrompt[key] || '').trim().length < 12) throw new providers.ProviderError(`Creative model omitted video ${key}`);
    const videoEvidence = Array.isArray(videoPrompt.sourceEvidence) ? videoPrompt.sourceEvidence : [];
    if (videoEvidence.length < 3 || videoEvidence.some((item) => !Number(item?.chapter) || String(item?.quote || '').trim().length < 8)) throw new providers.ProviderError('Video prompt must cite three grounded story beats');
    if (!evidenceMatchesSource(videoEvidence, sourceChapters)) throw new providers.ProviderError('Video prompt evidence must be exact text from its cited chapter');
  }
  const videoEvidence = Array.isArray(videoPrompt.sourceEvidence) ? videoPrompt.sourceEvidence : [];
  if (options.skipMedia !== true && needsPosterCreative) {
    for (const variant of ['luminous_cinema', 'editorial_romance']) {
      const item = byVariant.get(variant);
      if (!item || String(item.prompt || '').trim().length < 100) throw new providers.ProviderError(`Creative model returned an invalid ${variant} image prompt`);
    }
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
    posterPrompts: needsPosterCreative
      ? ['luminous_cinema', 'editorial_romance'].map((variant) => ({ variant, prompt: String(byVariant.get(variant).prompt), zhPrompt: String(byVariant.get(variant).zhPrompt || '') }))
      : [],
    qualityReview: { recommendation, status: String(review.status || '') === 'verified' ? 'verified' : 'unverified', conclusion: String(review.conclusion || '当前创意已完成确定性结构校验；模型质量结论未单独验证。').trim().slice(0, 260), why: String(review.why || '文案、视频剧情和海报提示词已通过后端结构与证据门，质量建议仅供人工复核。').trim().slice(0, 360), target: ['copy', 'video', 'poster', 'package'].includes(String(review.target || '')) ? String(review.target) : 'package' }
  };
}

async function p1(redis, run) {
  setStage(run, 'P1', 'running', { label: '正在核验书名与 SKU' });
  await saveRun(redis, run);
  const saved = run.input?.verifiedBook;
  const savedIsExact = saved
    && String(saved.bookSkuId || '') === String(run.input.sku || '')
    && providers.titleKey(saved.title) === providers.titleKey(run.input.title)
    && String(saved.cityBookId || '');
  // A newly-created run may carry the server-verified bookstore record from
  // creation. Reuse it rather than asking a known-lagging index to re-verify.
  let book;
  if (savedIsExact) {
    book = { ...saved, tags: Array.isArray(saved.tags) ? saved.tags : [] };
  } else {
    try {
      book = await providers.findExactBook(run.input.title, run.input.sku, providerOptionsForRun(run));
    } catch (error) {
      // Identity lookup is read-only. Preserve the exact title/SKU and queue
      // only transient upstream failures; a deterministic 404/ownership
      // mismatch still bubbles to the terminal P1 failure path.
      if (!recoverableEvidenceError(error)) throw error;
      const attempt = Number(run.stages.P1.identityRetryCount || 0) + 1;
      const nextAttemptAt = new Date(Date.now() + Math.min(5 * 60 * 1000, 15000 * attempt)).toISOString();
      setStage(run, 'P1', 'waiting', {
        label: '书籍身份服务暂时不可用，已保存 SKU 并自动续试',
        phase: 'identity_provider_wait',
        identityRetryCount: attempt,
        nextAttemptAt,
        recoverable: true,
        error: cleanError(error)
      });
      run.state = 'running';
      addEvent(run, 'identity_read_wait', 'Exact book identity lookup was temporarily unavailable; P1 will retry the same title and SKU', { attempt, nextAttemptAt, error: cleanError(error) });
      await saveRun(redis, run);
      return;
    }
  }
  run.input.title = book.title;
  run.input.sku = book.bookSkuId;
  run.artifacts.book = book;
  setStage(run, 'P1', 'done', { label: '书籍身份已核验', bookSkuId: book.bookSkuId, nextAttemptAt: '', identityRetryCount: 0, error: '' });
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
    const catalogueEvidence = run.input?.verifiedBook?.catalogueEvidence;
    if (catalogueEvidence?.source === 'bookstore_operator_session' && Array.isArray(catalogueEvidence.chapters) && catalogueEvidence.chapters.length >= 3) {
      const imported = catalogueEvidence.chapters.map((chapter) => ({
        id: String(chapter.id), order: Number(chapter.order), title: String(chapter.title), content: String(chapter.content), source: 'bookstore_catalogue'
      }));
      run.artifacts.evidence = {
        mode: 'bookstore_operator_evidence', chapterListCount: catalogueEvidence.chapterStructure?.length || imported.length,
        requested: imported.length, completed: imported.length,
        refs: imported.map(({ id, order, title, source }) => ({ id, order, title, source })), chapters: imported,
        chapterStructure: (catalogueEvidence.chapterStructure || []).map((chapter) => ({ order: Number(chapter.order), title: String(chapter.title) }))
      };
      run.artifacts.book.chapterCount = run.artifacts.evidence.chapterListCount;
      setStage(run, 'P2', 'running', { label: `已导入书库已读证据 ${imported.length}/${imported.length}`, cursor: imported.length, total: imported.length });
      addEvent(run, 'bookstore_evidence_imported', 'Operator-session bookstore chapter evidence was imported after exact SKU and application authorization verification');
      await saveRun(redis, run);
      return;
    }
    let chapters;
    try {
      chapters = await providers.listChapters(run.artifacts.book.cityBookId);
    } catch (error) {
      if (!recoverableEvidenceError(error)) throw error;
      scheduleEvidenceRetry(run, 'chapter_list', error);
      await saveRun(redis, run);
      return;
    }
    if (!chapters.length) throw new providers.ProviderError('No chapters were returned for this book');
    const refs = selectedChapters(
      chapters,
      run.artifacts.book.payPoint,
      run.input?.creativeProfile?.sceneChapters,
      run.input?.creativeProfile?.sceneLane,
      run.input?.creativeProfile?.sceneRepeatIndex,
      run.input?.creativeProfile?.sceneRepeatCount
    );
    if (run.input?.creativeProfile?.sceneLane !== null
      && run.input?.creativeProfile?.sceneLane !== undefined
      && run.input?.creativeProfile?.sceneLane !== ''
      && Number.isInteger(Number(run.input.creativeProfile.sceneLane))) {
      run.input.creativeProfile.sceneChapters = refs.map((ref) => ref.order);
    }
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
  // Older durable evidence snapshots that were already fully downloaded did
  // not always retain an empty `refs` array. Normalize that harmless legacy
  // shape before reading the cursor so P2 can still perform its model stage.
  evidence.refs = Array.isArray(evidence.refs) ? evidence.refs : [];
  evidence.chapters = Array.isArray(evidence.chapters) ? evidence.chapters : [];
  // Normalize legacy snapshots before choosing the next batch. A serverless
  // interruption can leave a persisted chapter body ahead of the old cursor;
  // deriving the cursor from immutable chapter IDs prevents duplicate reads
  // and keeps evidence.completed/requested numerically comparable.
  const uniqueRefs = [];
  const seenRefs = new Set();
  for (const ref of evidence.refs) {
    const key = String(ref?.id || ref?.order || '');
    if (!key || seenRefs.has(key)) continue;
    seenRefs.add(key);
    uniqueRefs.push(ref);
  }
  evidence.refs = uniqueRefs;
  const uniqueChapters = [];
  const seenChapters = new Set();
  for (const chapter of evidence.chapters) {
    const key = String(chapter?.id || chapter?.order || '');
    if (!key || seenChapters.has(key)) continue;
    seenChapters.add(key);
    uniqueChapters.push(chapter);
  }
  evidence.chapters = uniqueChapters;
  evidence.requested = Number.isFinite(Number(evidence.requested))
    ? Number(evidence.requested) : evidence.refs.length;
  evidence.completed = evidence.chapters.length;
  const downloadedIds = new Set(evidence.chapters.map((chapter) => String(chapter?.id || '')));
  // Recompute from the first reference rather than trusting a possibly stale
  // persisted cursor. This preserves any gap when a prior batch completed
  // out-of-order before the worker was interrupted.
  let cursor = 0;
  while (cursor < evidence.refs.length && downloadedIds.has(String(evidence.refs[cursor]?.id || ''))) cursor += 1;
  if (stage.cursor !== cursor) setStage(run, 'P2', 'running', { cursor, total: evidence.requested });
  const batch = evidence.refs.slice(cursor, cursor + 2).filter((ref) => !downloadedIds.has(String(ref?.id || '')));
  if (batch.length) {
    let downloaded;
    try {
      downloaded = await Promise.all(batch.map(async (ref) => ({ ...ref, content: String(await providers.chapterContent(ref.id, providerOptionsForRun(run))).slice(0, 16000) })));
    } catch (error) {
      if (!recoverableEvidenceError(error)) throw error;
      scheduleEvidenceRetry(run, 'chapter_content', error);
      await saveRun(redis, run);
      return;
    }
    evidence.chapters.push(...downloaded);
    evidence.completed = evidence.chapters.length;
    let next = cursor + batch.length;
    while (next < evidence.refs.length && evidence.chapters.some((chapter) => String(chapter?.id || '') === String(evidence.refs[next]?.id || ''))) next += 1;
    setStage(run, 'P2', 'running', { label: `正在下载证据 ${next}/${evidence.requested}`, cursor: next, total: evidence.requested, phase: 'evidence_downloading', evidenceRetryCount: 0, nextAttemptAt: '', recoverable: true, error: '' });
    await saveRun(redis, run);
    return;
  }
  if (Number(evidence.completed) !== Number(evidence.requested)) throw new providers.ProviderError('Chapter evidence download is incomplete');
  const story = evidence.storyBrief || {};
  // Premium batches deliberately separate deterministic source grounding from
  // optional high-level strategy prose. The latter has repeatedly been the
  // least reliable TokenDance JSON surface, while P3 still requires a full
  // model-produced creative package before any media can start. Skipping this
  // nonessential call reduces latency/cost without allowing evidence fallback
  // copy to reach P4.
  if (run.input?.creativeProfile?.qualityMode === 'premium' && story.status !== 'ready') {
    const plan = sourceGroundedPlan(run);
    evidence.storyBrief = {
      status: 'ready', model: 'source-grounded-plan', responseId: '', createdAt: now(), plan,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      reason: 'premium_p3_requires_full_model_package'
    };
    run.artifacts.storyBrief = evidence.storyBrief;
    run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), {
      section: 'storyBrief', requestedModel: '', model: 'source-grounded-plan', completedAt: now(),
      triggerReason: 'premium batch uses locked chapter evidence before full P3 generation',
      outputStatus: 'optional strategy call skipped; P3 remains model-gated'
    }].slice(-24);
    setStage(run, 'P2', 'done', { label: `${evidence.completed} 个章节证据已锁定；高级批次跳过非必要策略摘要`, completeness: 100, phase: 'evidence_ready_premium', recoverable: false, error: '', nextAttemptAt: '', evidenceRetryCount: 0 });
    addEvent(run, 'premium_story_strategy_skipped', 'Premium production preserved complete source evidence and skipped the optional strategy model call; P3 remains fail-closed on a full model creative package');
    await saveRun(redis, run);
    return;
  }
  const retryAt = Date.parse(story.nextAttemptAt || '');
  if (story.status !== 'ready') {
    if (Number.isFinite(retryAt) && retryAt > Date.now()) return;
    const route = ensureModelRoute(run);
    const preferred = String(route.preferredModel || run.input?.creativeProfile?.modelChoice || 'hy3');
    const current = String(story.modelChoice || route.activeModel || preferred);
    setStage(run, 'P2', 'running', { label: `${creativeModelLabel(run)} 正在梳理全书故事结构`, phase: 'story_intelligence', error: '', nextAttemptAt: '' });
    await saveRun(redis, run);
    let providerLease = null;
    try {
      // Story intelligence can take the same long TokenDance path as P3.
      // Share the four-slot gate so P2 cannot consume all upstream capacity
      // while P3 creative sections wait behind it.
      providerLease = await acquireTokenDanceGate(redis, current, run.id, 660);
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
      if (modelCapacityError(error)) {
        const attempt = Number(story.attempt || 0) + 1;
        const nextAttemptAt = new Date(Date.now() + 30000).toISOString();
        evidence.storyBrief = { ...story, status: 'recovering', attempt, modelChoice: current, nextAttemptAt, error: cleanError(error) };
        run.state = 'running';
        setStage(run, 'P2', 'waiting', { label: `${creativeModelLabel(run)} 当前并发已满，30 秒后继续`, phase: 'story_intelligence_capacity_wait', recoverable: true, nextAttemptAt, error: cleanError(error), attempt });
        addEvent(run, 'story_intelligence_capacity_wait', 'Model capacity is temporarily full; the saved chapter evidence and active model route will be retried without switching models', { current, nextAttemptAt });
        await saveRun(redis, run);
        return;
      }
      const attempt = Number(story.attempt || 0) + 1;
      // TokenDance DeepSeek structured-output blips get one bounded JSON-only
      // repair without spending a cross-provider reserve. If that repair is
      // malformed too, the complete locked evidence is more trustworthy than
      // another identical long request; continue deterministically instead.
      const sameRouteStructuredRepair = story.fallbackUsed || current === 'deepseek';
      if (sameRouteStructuredRepair && structuredModelError(error) && Number(story.repairAttempts || 0) < 1) {
        const repairAttempts = Number(story.repairAttempts || 0) + 1;
        const nextAttemptAt = new Date(Date.now() + 1500).toISOString();
        evidence.storyBrief = { ...story, status: 'recovering', repairAttempts, attempt, modelChoice: current, nextAttemptAt, error: cleanError(error), repairInstruction: 'Return only the required compact JSON object; preserve every supplied chapter quote.' };
        run.state = 'running';
        setStage(run, 'P2', 'waiting', { label: `${creativeModelLabel(run)} 正在修复故事分析格式（第 ${repairAttempts} 次）`, phase: 'story_intelligence_repairing', recoverable: true, nextAttemptAt, error: cleanError(error), attempt });
        addEvent(run, 'story_intelligence_repair_scheduled', 'The active model will retry the saved full-book analysis with a stricter JSON-only instruction', { current, repairAttempts, nextAttemptAt });
        await saveRun(redis, run);
        return;
      }
      if (sameRouteStructuredRepair && structuredModelError(error)) {
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
        // Some TokenDance routes now reject romance/abuse source text at the
        // provider safety layer. Give the operator-approved fast route one
        // bounded compatibility attempt before marking the run unrecoverable.
        if (/inappropriate content|content policy|safety filter/i.test(message) && current !== 'hy3') {
          const nextAttemptAt = new Date(Date.now() + 1000).toISOString();
          evidence.storyBrief = { ...story, status: 'recovering', modelChoice: 'hy3', fallbackUsed: false, nextAttemptAt, error: message, fallbackFrom: current };
          route.activeModel = 'hy3';
          route.fallbackModel = '';
          route.fallbackUsed = false;
          route.switchedAt = now();
          route.switchReason = '内容安全策略拒绝高级模型；使用一次兼容性模型重试';
          run.input.creativeProfile = { ...(run.input.creativeProfile || {}), modelChoice: 'hy3' };
          setStage(run, 'P2', 'waiting', { label: '内容安全策略触发，兼容性模型将重试故事梳理', phase: 'story_intelligence_compatibility_retry', recoverable: true, nextAttemptAt, error: message, fallbackFrom: current });
          addEvent(run, 'story_intelligence_compatibility_retry', 'Provider safety filtering rejected the premium model; one bounded hy3 compatibility retry was scheduled', { current, nextAttemptAt });
          await saveRun(redis, run);
          return;
        }
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
    } finally {
      await releaseLease(redis, providerLease);
    }
  }
  setStage(run, 'P2', 'done', { label: `${evidence.completed} 个章节证据已锁定`, completeness: 100, nextAttemptAt: '', evidenceRetryCount: 0, error: '' });
  addEvent(run, 'evidence_ready', `${evidence.completed} chapter evidence records ready`);
  await saveRun(redis, run);
}

async function nextCode(redis, run) {
  const pool = codePoolForRun(run);
  // The scoped storage bridge only persists strings, while Redis INCR still
  // accepts the stored decimal value and returns the next numeric code.
  await redis.set(pool.counterKey, String(pool.counterStart || pool.codeMin - 1), { nx: true });
  const code = Number(await redis.incr(pool.counterKey));
  if (!Number.isSafeInteger(code) || code < pool.codeMin || code > pool.codeMax) throw new providers.ProviderError(`${pool.name} promotion Code pool is exhausted`, { status: 409 });
  return String(code);
}

function codeOwned(record, run) {
  const app = appForRun(run);
  const ids = [record?.bookId, record?.bookSkuId].map(String);
  const applicationMatches = !record?.applicationId || String(record.applicationId) === app.applicationId;
  return ids.includes(String(run.input.sku)) && applicationMatches && String(record?.channel || '') === (providerOptionsForRun(run).channel || 'FB');
}

function codeConflict(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return Number(error?.status) === 409 || /already\s*exists|duplicate|conflict|occupied|已存在|重复|占用/.test(message);
}

async function advanceCode(redis, run, stage, reason) {
  const previous = run.artifacts.code;
  run.artifacts.code = await nextCode(redis, run);
  const attempts = Number(stage.codeAttempts || 0) + 1;
  if (attempts > 100) throw new providers.ProviderError('Could not allocate a free promotion code after 100 attempts');
  setStage(run, 'P5', 'running', { label: `Code ${previous} ${reason}，顺延到 ${run.artifacts.code}`, phase: 'code', codeAttempts: attempts });
  addEvent(run, 'code_advanced', `Code ${previous} ${reason}; advanced to ${run.artifacts.code}`);
  await saveRun(redis, run);
}

async function p5(redis, run) {
  const stage = normalizeAttributionStage(run);
  if (stage.status === 'waiting' && !trackingEnabledForRun(run)) {
    run.artifacts.code = '';
    run.artifacts.keywordId = '';
    run.artifacts.shortUrl = '';
    run.artifacts.linkId = '';
    const delivery = deliveryForRun(run);
    setStage(run, 'P5', 'done', { label: `${delivery?.appName || 'This application'} attribution Code deferred until development is live`, phase: 'attribution_deferred' });
    addEvent(run, 'tracking_deferred', 'Attribution Code and link creation were intentionally deferred for this application until its development path is live');
    await saveRun(redis, run);
    return;
  }
  if (stage.status === 'waiting') {
    // A waiting P5 can be either the first allocation or a recoverable
    // provider backoff.  Preserve an already assigned Code and its phase on
    // retries; allocating a fresh number here would orphan the previous Code
    // and could make a later link/caption point at the wrong attribution.
    const pendingCode = String(run.artifacts?.code || '').trim();
    const pendingPhase = ['code', 'link', 'code_reconcile', 'link_reconcile'].includes(String(stage.phase || '')) ? String(stage.phase) : '';
    if (pendingCode && pendingPhase) {
      setStage(run, 'P5', 'running', { label: pendingPhase.includes('link') ? `正在核验 Code ${pendingCode} 对应短链` : `正在核验 Code ${pendingCode}`, phase: pendingPhase, nextAttemptAt: '', error: '' });
    } else {
      const candidate = await nextCode(redis, run);
      run.artifacts.code = candidate;
      setStage(run, 'P5', 'running', { label: `正在核验 Code ${candidate}`, phase: 'code', nextAttemptAt: '', error: '' });
    }
    await saveRun(redis, run);
    return;
  }
  if (stage.phase === 'code_reconcile') {
    const options = providerOptionsForRun(run);
    const existing = await providers.keywordRecord(run.artifacts.code, options);
    if (existing && codeOwned(existing, run) && providers.enabled(existing.isEnable)) {
      run.artifacts.keywordId = String(existing.id || '');
      delete stage.codeCreateIntent;
      setStage(run, 'P5', 'running', { label: `Code ${run.artifacts.code} 已核验，继续处理短链`, phase: 'code', attributionReconcileAttempts: 0, nextAttemptAt: '', error: '' });
      await saveRun(redis, run);
      return;
    }
    scheduleAttributionReconcile(run, new providers.ProviderError('Code 写入结果暂未在远端可见'), 'code_reconcile');
    await saveRun(redis, run);
    return;
  }
  if (stage.phase === 'link_reconcile') {
    const options = providerOptionsForRun(run);
    const promoter = options.promoter || run.input.promoter;
    const link = await providers.findLink(run.input.sku, promoter, run.artifacts.code, options);
    if (link?.shortUrl) {
      delete stage.linkCreateIntent;
      run.artifacts.shortUrl = providers.absoluteUrl(link.shortUrl);
      run.artifacts.linkId = String(link.id || '');
      setStage(run, 'P5', 'done', { label: `Code ${run.artifacts.code} 与短链已验证`, phase: 'link', attributionReconcileAttempts: 0, nextAttemptAt: '', error: '' });
      addEvent(run, 'tracking_ready', `Verified Code ${run.artifacts.code} and short link after read-only reconciliation`);
      await saveRun(redis, run);
      return;
    }
    scheduleAttributionReconcile(run, new providers.ProviderError('短链写入结果暂未在远端可见'), 'link_reconcile');
    await saveRun(redis, run);
    return;
  }
  if (stage.phase === 'code') {
    const options = providerOptionsForRun(run);
    const existing = await providers.keywordRecord(run.artifacts.code, options);
    if (existing && !codeOwned(existing, run)) {
      await advanceCode(redis, run, stage, '已占用');
      return;
    }
    if (!existing) {
      // Persist a write intent before the remote POST.  If the response is
      // uncertain, subsequent worker ticks switch to a read-only lookup and
      // never issue the same paid/side-effecting request twice.
      if (!stage.codeCreateIntent) {
        stage.codeCreateIntent = { code: String(run.artifacts.code), requestedAt: now() };
        await saveRun(redis, run);
        try { await providers.createKeyword(run.input.sku, run.artifacts.code, options); }
        catch (error) {
          if (codeConflict(error)) { delete stage.codeCreateIntent; await advanceCode(redis, run, stage, '创建冲突'); return; }
          if (attributionWriteUncertain(error)) {
            scheduleAttributionReconcile(run, error, 'code_reconcile');
            await saveRun(redis, run);
            return;
          }
          delete stage.codeCreateIntent;
          throw error;
        }
      }
      const verified = await providers.keywordRecord(run.artifacts.code, options);
      if (!verified || !codeOwned(verified, run) || !providers.enabled(verified.isEnable)) {
        scheduleAttributionReconcile(run, new providers.ProviderError('Created promotion code could not be verified remotely'), 'code_reconcile');
        await saveRun(redis, run);
        return;
      }
      delete stage.codeCreateIntent;
      run.artifacts.keywordId = String(verified.id || '');
    } else {
      if (!providers.enabled(existing.isEnable)) throw new providers.ProviderError(`Promotion Code ${run.artifacts.code} exists but is disabled`);
      run.artifacts.keywordId = String(existing.id || '');
    }
    const delivery = deliveryForRun(run);
    if (delivery && !delivery.includeLink) {
      run.artifacts.shortUrl = '';
      run.artifacts.linkId = '';
      setStage(run, 'P5', 'done', { label: `${delivery.appName} Code ${run.artifacts.code} verified; ${delivery.platform} is code-only`, phase: 'code_only', code: run.artifacts.code });
      addEvent(run, 'tracking_ready', `Verified ${delivery.appName} Code ${run.artifacts.code}; ${delivery.platform} is code-only`);
      await saveRun(redis, run);
      return;
    }
    setStage(run, 'P5', 'running', { label: 'Code 已验证，正在创建短链', phase: 'link' });
    await saveRun(redis, run);
    return;
  }
  if (stage.phase === 'link') {
    const options = providerOptionsForRun(run);
    const promoter = options.promoter || run.input.promoter;
    let link = await providers.findLink(run.input.sku, promoter, run.artifacts.code, options);
    if (!link) {
      if (!stage.linkCreateIntent) {
        stage.linkCreateIntent = { code: String(run.artifacts.code), requestedAt: now() };
        await saveRun(redis, run);
        let created;
        try { created = await providers.createLink(run.artifacts.book, promoter, run.artifacts.code, options); }
        catch (error) {
          if (attributionWriteUncertain(error)) {
            scheduleAttributionReconcile(run, error, 'link_reconcile');
            await saveRun(redis, run);
            return;
          }
          delete stage.linkCreateIntent;
          throw error;
        }
        link = created?.id ? await providers.findLink(run.input.sku, promoter, run.artifacts.code, options) : null;
      } else {
        // A prior create response was uncertain; only the read-only lookup is
        // allowed on this path.
        scheduleAttributionReconcile(run, new providers.ProviderError('Short-link creation outcome requires read-only reconciliation'), 'link_reconcile');
        await saveRun(redis, run);
        return;
      }
    }
    if (!link?.shortUrl) {
      scheduleAttributionReconcile(run, new providers.ProviderError('Short link was not readable after creation'), 'link_reconcile');
      await saveRun(redis, run);
      return;
    }
    delete stage.linkCreateIntent;
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

const creativeCoreSections = ['posts', 'videoPrompt', 'posterPrompts'];
const creativeSectionOrder = [...creativeCoreSections, 'qualityReview'];
const creativeSectionLabels = { posts: '双语六步法文案', videoPrompt: '视频剧情包', posterPrompts: '海报提示词', qualityReview: '质量审查' };
const longCreativeModels = new Set(['glm-5.3-flash', 'deepseek-v4-flash-preview', 'ling-3.0-flash', 'deepseek', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'kimi-k2.7-code']);

function posterCreativeRequired(run) {
  return run?.input?.posterGenerationRequired !== false
    && run?.input?.campaign?.autoSocialEchoDraft !== true;
}

async function withCreativeMergeLock(redis, runId, work) {
  const key = `nf_social:creative_merge:${runId}`;
  // Use an owner-tagged lease instead of deleting the key unconditionally.
  // A slow merge can outlive the old 20s TTL; an unconditional `del` from
  // that stale worker would then remove a newer worker's lock and allow two
  // section results to overwrite one another.  The shared lease helper uses
  // compare-and-delete when the backing store supports it and a safe
  // ownership check otherwise.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const lease = await acquireLease(redis, key, 60);
    if (lease) {
      try { return await work(); } finally { await releaseLease(redis, lease); }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, 40 + attempt * 2)));
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

function pendingCreativeSections(draft, run = null) {
  const requiredCore = posterCreativeRequired(run)
    ? creativeCoreSections
    : creativeCoreSections.filter((key) => key !== 'posterPrompts');
  const core = requiredCore.filter((key) => !draft.parts[key]);
  if (core.length) return core;
  return draft.parts.qualityReview ? [] : ['qualityReview'];
}

function hasCreativeSectionValue(section, value) {
  if (section === 'posts') return Array.isArray(value) && value.length === 2;
  if (section === 'videoPrompt') return value && typeof value === 'object' && String(value.hook || '').trim().length > 0;
  if (section === 'posterPrompts') {
    const byVariant = new Map((Array.isArray(value) ? value : []).map((item) => [String(item?.variant || ''), item]));
    return ['luminous_cinema', 'editorial_romance'].every((variant) => String(byVariant.get(variant)?.prompt || '').trim().length >= 20);
  }
  // An empty quality object is intentionally accepted. normalizeCreative will
  // label it unverified rather than pretending that quality review passed.
  return section === 'qualityReview';
}

function discardCreativeCoreForModelSwitch(run, draft, { fromModel, toModel, triggerSection, error }) {
  const discardedSections = creativeSectionOrder.filter((section) => draft.parts?.[section]);
  const discardedUsage = [...(draft.usage || [])];
  if (discardedUsage.length) {
    run.artifacts.modelActivity = [
      ...(run.artifacts.modelActivity || []),
      ...discardedUsage.map((item) => ({
        ...item,
        validationStatus: 'discarded_model_switch',
        outputStatus: '已从最终创意包移除，由唯一备用模型统一重新生成',
        discardReason: `${triggerSection} triggered the task-wide switch from ${fromModel} to ${toModel}`
      }))
    ].slice(-24);
  }
  draft.discardedGenerations = [
    ...(draft.discardedGenerations || []),
    {
      at: now(),
      fromModel,
      toModel,
      triggerSection,
      sections: discardedSections,
      totalTokens: discardedUsage.reduce((total, item) => total + Number(item.totalTokens || 0), 0),
      error: cleanError(error)
    }
  ].slice(-4);
  // Every core output must come from the same task route. A completed primary
  // section is accounted for above, but cannot survive into the reserve draft.
  draft.parts = {};
  draft.usage = [];
  draft.inFlight = {};
  draft.repairAttempts = {};
  draft.validationRepairAttempts = 0;
  draft.validationFallbackUsed = true;
  draft.recoveryRevision = {
    instruction: 'Regenerate every core creative section with the active reserve model so copy, video, and poster directions form one coherent package. Use only the saved exact chapter evidence.',
    failedSection: triggerSection,
    previousModel: fromModel,
    validationError: cleanError(error)
  };
  return discardedSections;
}

function sceneEvidenceChapters(run) {
  const chapters = run.artifacts?.evidence?.chapters || [];
  const lockedOrders = Array.isArray(run.input?.creativeProfile?.sceneChapters)
    ? new Set(run.input.creativeProfile.sceneChapters.map(Number))
    : new Set();
  if (!lockedOrders.size) return chapters;
  // Never widen a campaign scene lock to the entire book. If P2 retained too
  // little evidence for the requested scene, the deterministic fallback will
  // fail closed before paid media rather than recycling an unrelated hook.
  return chapters.filter((chapter) => lockedOrders.has(Number(chapter.order)));
}

// Source pages occasionally contain line-wrapped prose without terminal
// punctuation. Keep the fallback evidence literal in that case instead of
// treating a well-downloaded chapter as unusable merely because its formatter
// omitted a period. The returned excerpt is always a contiguous substring of
// the saved content; it never invents or rewrites story text.
function chapterEvidenceQuote(value, minLength = 36, maxLength = 180) {
  const content = String(value || '').replace(/\s+/g, ' ').trim();
  if (!content) return '';
  const sentence = content.match(new RegExp(`[\\p{L}][^.!?]{${Math.max(1, minLength - 1)},${maxLength}}[.!?]`, 'u'))?.[0]?.trim();
  if (sentence) return sentence;
  const start = content.search(/\p{L}/u);
  if (start < 0) return '';
  const candidate = content.slice(start, start + maxLength);
  if (candidate.length < minLength) return '';
  const lastSpace = candidate.lastIndexOf(' ');
  const end = lastSpace >= minLength ? lastSpace : candidate.length;
  return candidate.slice(0, end).trim();
}

function videoEvidenceScore(quote) {
  const text = normalizedSourceText(quote);
  if (!text) return -100;
  let score = Math.min(20, Math.floor(text.length / 10));
  if (/\b(?:a\/n|author'?s? note|warning)\b/.test(text)) score -= 120;
  if (/\b(?:sex|sexual|cock|dick|breasts?|naked|half-naked|flesh slapping|in bed)\b/.test(text)) score -= 120;
  if (/\b(?:woke up|wake(?:s| me)? from|alarm goes off|morning routine|opening my eyes)\b/.test(text)) score -= 90;
  if (/\b(?:said|told|warned|declared|asked|accused|fired|married|eloped|exploded|slapped|bleed|blood|door|letter|contract|ring|phone|police|hospital|gun|knife|taped|locked|refused|walked away)\b/.test(text)) score += 35;
  if (/\b(?:my name is|i sat |i stood |i looked |the moon hung|rain drops|from the tall windows)\b/.test(text)) score -= 28;
  return score;
}

function premiumVideoEvidenceViolation(videoPrompt = {}) {
  const hook = String(videoPrompt.hook || '');
  const source = [hook, ...(Array.isArray(videoPrompt.sourceEvidence) ? videoPrompt.sourceEvidence.map((item) => item?.quote) : [])].join(' ');
  const text = normalizedSourceText(source);
  if (/\b(?:a\/n|author'?s? note|warning)\b/.test(text)) return 'Video source evidence contains an author note or content warning, not a renderable scene';
  if (/\b(?:sex|sexual|cock|dick|breasts?|naked|half-naked|flesh slapping|in bed)\b/.test(text)) return 'Video source evidence contains explicit sexual content and cannot enter a social video draft';
  if (/\b(?:woke up|wake(?:s| me)? from|alarm goes off|morning routine|opening my eyes)\b/.test(text)) return 'Video source evidence begins with a wake-up or routine opening';
  if (videoEvidenceScore(hook) < 18) return 'Video source hook lacks a concrete conflict object, decisive action, or public consequence';
  return '';
}

function groundedVideoFallback(run, draft) {
  const post = draft.parts?.posts?.[0];
  const six = post?.sixSteps || {};
  if (!post || !six.hook || !six.contrast || !six.emotionalCta) return null;
  const evidence = [];
  const lockedOrders = new Set(sceneEvidenceChapters(run).map((chapter) => Number(chapter.order)));
  for (const item of [...(post.evidence || []), ...((draft.parts?.posts?.[1]?.evidence) || [])]) {
    if (!Number(item?.chapter) || !String(item?.quote || '').trim()) continue;
    if (lockedOrders.size && !lockedOrders.has(Number(item.chapter))) continue;
    if (!evidence.some((value) => value.chapter === Number(item.chapter) && value.quote === String(item.quote).trim())) evidence.push({ chapter: Number(item.chapter), quote: String(item.quote).trim() });
  }
  for (const chapter of sceneEvidenceChapters(run)) {
    if (evidence.length >= 3) break;
    const quote = chapterEvidenceQuote(chapter.content, 24, 140);
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

function sourceGroundedCreativeFallback(run, options = {}) {
  const result = (creative, error = '') => options.diagnostics === true ? { creative, error } : creative;
  const language = visibleLanguageForRun(run);
  // The fallback must honour the same visible-copy contract as the model
  // route.  Its localized templates contain two fitting emoji by default;
  // add exactly one only when this run explicitly requests the 3–5 profile.
  // Keeping this deterministic makes a malformed model response recoverable
  // without relaxing the post validator or inventing story details.
  const requiredEmojiSuffix = run.input?.creativeProfile?.emojiRange === '3-5' ? ' \u2728' : '';
  const chapters = sceneEvidenceChapters(run);
  const candidates = chapters
    .map((chapter) => ({ chapter: Number(chapter.order), quote: chapterEvidenceQuote(chapter.content, 36, 180) }))
    .filter((item) => item.quote)
    .sort((left, right) => left.chapter - right.chapter);
  // AC contracts must describe one coherent scene. Select the strongest three
  // excerpts from a single <= six-chapter span rather than independently
  // taking high-scoring moments from across the sampled book.
  const windows = candidates.map((start) => candidates.filter((item) => item.chapter >= start.chapter && item.chapter - start.chapter <= 5));
  const eligible = windows.filter((window) => window.length >= 3);
  const bestWindow = eligible.sort((left, right) => {
    const score = (items) => items.reduce((total, item) => total + videoEvidenceScore(item.quote), 0);
    return score(right) - score(left) || left[0].chapter - right[0].chapter;
  })[0] || [];
  const evidence = bestWindow
    .sort((left, right) => videoEvidenceScore(right.quote) - videoEvidenceScore(left.quote) || left.chapter - right.chapter)
    .slice(0, 3)
    .sort((left, right) => left.chapter - right.chapter);
  if (evidence.length < 3) return result(null, 'Locked chapter evidence needs three usable excerpts');
  if (trackingEnabledForRun(run) && !trackingReady(run)) return result(null, 'Required attribution is not ready for this route');
  const delivery = deliveryForRun(run);
  const appName = delivery?.appName || 'NovelFlow';
  const includeTracking = trackingVisibleInCopy(run);
  const includeLink = includeTracking && delivery?.includeLink !== false;
  const [opening, pressure, turn] = evidence;
  const localized = language === 'pt'
    ? {
      tags: `#${appName} #Romance #Drama #Leitura #BookTok #Ficcao`,
      sensory: (quote) => `A decisao pesa em cada silencio: ${quote}`,
      deepDesire: 'Encontrar a verdade antes que a proxima escolha feche todas as saidas.',
      cta: 'Veja o que acontece quando a verdade por tras dessa escolha nao pode mais ficar escondida.',
      codeLine: `Pesquise o Codigo ${run.artifacts.code} no ${appName} para continuar a historia.`,
      hook: (lead, middle, ending) => `"${lead.quote}"\n\nEssa frase muda o ar ao redor de cada escolha que vem depois. A pressao ja esta presente, pessoal e impossivel de ignorar. ${middle.quote} 🖤 O silencio transforma cada detalhe em aviso, porque uma decisao documentada ja tornou o proximo passo impossivel de evitar.\n\nEntao a historia muda o bastante para que fugir pareca impossivel. ${ending.quote} A pergunta nao e mais se isso importa, mas quanto esse momento vai custar e quem tera de enfrentar a consequencia primeiro. 🔥`,
      escalation: (lead, middle, ending) => `"${lead.quote}"\n\nO que parecia suportavel se torna muito mais perigoso quando as consequencias chegam. ${middle.quote} 💔 Nada pode diminuir essa pressao agora; cada fato documentado leva a historia para mais perto de uma escolha que ninguem consegue desfazer em silencio.\n\nE entao chega a mudanca que nao tem volta. ${ending.quote} Cada promessa, medo e escolha impossivel fica em jogo, deixando uma decisao sem resposta que muda o proximo passo de todos. 🩸`,
      escalationBeat: (quote) => `A pressao aumenta em torno de: ${quote}`,
      cliffhanger: 'Pare na escolha cujas consequencias ainda nao foram resolvidas.',
      buildRequirement: '0-2s: abra no conflito documentado. 2-5s: mostre a reacao ao risco pessoal. 5-8s: aperte a pressao em torno do conflito comprovado. 8-11s: revele a mudanca de expectativa sustentada pela fonte. 11-15s: pare na escolha sem resposta. Vertical 9:16, personagens adultos, continuidade cinematografica, figurino e aparencia consistentes, sem legendas, texto legivel, logos, cartoes de CTA ou fatos inventados.'
    }
    : language === 'es'
      ? {
        tags: `#${appName} #Romance #Drama #Lectura #BookTok #Ficcion`,
        sensory: (quote) => `La decision pesa en cada silencio: ${quote}`,
        deepDesire: 'Encontrar la verdad antes de que la siguiente decision cierre todas las salidas.',
        cta: 'Mira lo que pasa cuando la verdad detras de esta decision ya no puede seguir oculta.',
        codeLine: `Busca el Codigo ${run.artifacts.code} en ${appName} para continuar la historia.`,
        hook: (lead, middle, ending) => `"${lead.quote}"\n\nEsa frase cambia el aire alrededor de cada decision que sigue. La presion ya esta ahi, personal e imposible de ignorar. ${middle.quote} 🖤 El silencio convierte cada detalle en una advertencia, porque una decision documentada ya hizo imposible evitar el siguiente paso.\n\nEntonces la historia cambia lo suficiente para que escapar parezca imposible. ${ending.quote} La pregunta ya no es si importa, sino cuanto costara este momento y quien enfrentara primero la consecuencia. 🔥`,
        escalation: (lead, middle, ending) => `"${lead.quote}"\n\nLo que parecia soportable se vuelve mucho mas peligroso cuando llegan las consecuencias. ${middle.quote} 💔 Nada puede reducir esa presion ahora; cada hecho documentado lleva la historia hacia una decision que nadie puede deshacer en silencio.\n\nY entonces llega el cambio que nadie puede revertir. ${ending.quote} Cada promesa, miedo y eleccion imposible queda en juego, dejando una decision sin resolver que cambia el siguiente paso de todos. 🩸`,
        escalationBeat: (quote) => `La presion aumenta alrededor de: ${quote}`,
        cliffhanger: 'Deten la escena en la decision cuyas consecuencias aun no se resuelven.',
        buildRequirement: '0-2s: abre con el conflicto documentado. 2-5s: muestra la reaccion al riesgo personal. 5-8s: aumenta la presion alrededor del conflicto comprobado. 8-11s: revela el cambio de expectativa sostenido por la fuente. 11-15s: detente en la decision sin resolver. Vertical 9:16, personajes adultos, continuidad cinematografica, vestuario y apariencia consistentes, sin subtitulos, texto legible, logotipos, tarjetas CTA ni hechos inventados.'
      }
      : {
        tags: `#${appName} #RomanceReads #BookTok #RomanceBooks #MustRead #Fiction`,
        sensory: (quote) => `The moment hangs on one choice: ${quote}`,
        deepDesire: 'To reach the truth before the next choice closes every way back.',
        cta: 'See what happens when the truth behind this choice can no longer stay hidden.',
        codeLine: `Search Code ${run.artifacts.code} in ${appName} to continue the story.`,
        hook: (lead, middle, ending) => `"${lead.quote}"\n\nThat one line changes the air around every choice that follows. The pressure is already there, sharp and personal, and nobody gets to pretend it is harmless. ${middle.quote} 🖤 The silence after it makes every ordinary detail feel like a warning, because one documented choice has already made the next one impossible to ignore.\n\nThen the story turns just enough to make escape feel impossible. ${ending.quote} The question is no longer whether it matters. It is what this moment will cost, what truth can still be protected, and who will have to face the consequence first. 🔥`,
        escalation: (lead, middle, ending) => `"${lead.quote}"\n\nWhat looked survivable becomes something far more dangerous when the consequences finally arrive. ${middle.quote} 💔 Nothing in the room can make that pressure smaller now; each documented beat forces the story closer to a choice nobody can quietly undo.\n\nAnd then comes the shift nobody can take back. ${ending.quote} Every promise, every fear, and every impossible choice is suddenly on the line, leaving one unresolved decision that changes how every person in the scene has to move next. 🩸`,
        escalationBeat: (quote) => `Pressure rises around: ${quote}`,
        cliffhanger: 'Hold on the choice whose consequences have not yet been resolved.',
        buildRequirement: '0-2s: open on the exact documented disruption. 2-5s: show the protagonist reacting to the personal stake. 5-8s: tighten visual pressure around the documented conflict. 8-11s: reveal the supported shift in expectation. 11-15s: hold on the unresolved choice. Vertical 9:16, adult characters, cinematic continuity, consistent wardrobe and appearance, no subtitles, readable text, logos, CTA cards, or invented plot points.'
      };
  const premiumFallbackOpening = language === 'pt'
    ? 'A abertura deve mostrar uma acao ou objeto de conflito comprovado; nunca comece com alguem acordando na cama, abrindo os olhos ou uma rotina matinal generica.'
    : language === 'es'
      ? 'La apertura debe mostrar una accion u objeto de conflicto comprobado; nunca empieces con alguien despertando en la cama, abriendo los ojos o una rutina matutina generica.'
      : 'The opening must show a documented action or conflict object; never begin with someone waking in bed, opening their eyes, or a generic morning routine.';
  localized.buildRequirement = `${localized.buildRequirement} ${premiumFallbackOpening}`;
  const tags = localized.tags;
  const visualContinuity = String(run.input?.creativeProfile?.visualContinuity || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  const sceneLock = String(run.input?.creativeProfile?.sceneBrief || '').replace(/\s+/g, ' ').trim().slice(0, 900);
  const visualLock = visualContinuity ? ` Character continuity lock: ${visualContinuity}` : ' Character continuity lock: keep the same two adult leads, wardrobe, and defining features across the image.';
  const sceneDirective = sceneLock ? ` Locked scene only: ${sceneLock}` : '';
  const makePost = (type, lead, middle, ending, cited) => {
    const profile = run.input?.creativeProfile || {};
    const sixSteps = {
      hook: lead.quote,
      pain: middle.quote,
      sensory: localized.sensory(middle.quote),
      contrast: ending.quote,
      deepDesire: localized.deepDesire,
      emotionalCta: localized.cta
    };
    const englishNarrative = () => {
      const form = String(profile.creativeForm || 'evidence_discovery');
      const first = `“${lead.quote}”`;
      const scenes = {
        witnessed_confrontation: `${first}\n\nThe room has witnesses, but no one steps in. ${middle.quote} ⚡🖤\n\nBy the time ${ending.quote} lands, the person being judged has already made a choice nobody in that crowd can undo. The next question is whether anyone will admit what they saw.`,
        evidence_discovery: `${first}\n\nThe proof is small enough to miss until it changes the meaning of everything. ${middle.quote} 🔎🖤\n\nThen ${ending.quote} turns a private doubt into a question no one can put back. Someone must decide whether the discovery stays hidden or becomes the truth.`,
        pursuit_in_motion: `${first}\n\nThere is no time to explain while the next move is already happening. ${middle.quote} 🏃🔥\n\nWhen ${ending.quote} cuts off the easy exit, standing still becomes its own decision. Every step now carries a consequence neither side can avoid.`,
        public_power_reversal: `${first}\n\nThe balance shifts in front of everyone. ${middle.quote} 👑⚡\n\nAfter ${ending.quote}, the people who expected obedience have to face what they helped create. No one in the crowd can pretend the old order still exists.`,
        protective_interruption: `${first}\n\nOne person moves before the damage can become permanent. ${middle.quote} 🛡️🖤\n\nBut ${ending.quote} makes it clear that protection comes with a cost of its own. The interruption may save one person while exposing another.`,
        ceremony_rupture: `${first}\n\nThe symbol meant to seal the moment suddenly becomes the thing that breaks it. ${middle.quote} 💍🔥\n\nWhen ${ending.quote}, every promise in the room has a different price. The ceremony cannot continue as though the rupture never happened.`,
        deadline_choice: `${first}\n\nThe clock is not loud, but every second narrows the answer. ${middle.quote} ⏳⚡\n\nThen ${ending.quote} leaves only one choice that can still be made in time. Waiting for a safer moment is no longer an option.`,
        authority_arrival: `${first}\n\nThe door opens, and everyone understands the rules have changed. ${middle.quote} 🚪👑\n\nAfter ${ending.quote}, the truth belongs to the room, not to the person hiding it. The arrival forces every witness to choose a side.`,
        secret_overheard: `${first}\n\nThe secret was never meant to reach this pair of ears. ${middle.quote} 🤫🖤\n\nWhen ${ending.quote}, silence stops being protection and becomes a decision. The listener must choose what to do with the knowledge.`,
        contract_or_letter_break: `${first}\n\nThe paper has an answer written into it, whether anyone wants to read it or not. ${middle.quote} 📜🔥\n\nThen ${ending.quote} turns one signature into a line nobody can cross unchanged. The document now carries more weight than every promise around it.`,
        identity_recognition: `${first}\n\nRecognition arrives before either of them is ready for it. ${middle.quote} ✨🖤\n\nAfter ${ending.quote}, pretending not to know becomes more dangerous than the truth. One look has made the next conversation unavoidable.`,
        departure_challenge: `${first}\n\nThis is the moment someone tries to leave without asking permission. ${middle.quote} 🚶⚡\n\nWhen ${ending.quote}, the person left behind has one chance to answer with action. The distance between them has become a challenge, not an ending.`
      };
      const base = scenes[form] || scenes.evidence_discovery;
      return type === 'hook'
        ? base
        : `${first}\n\nWhat follows is not a misunderstanding; it is the consequence already moving through the scene. ${middle.quote} 🔥🖤\n\n${ending.quote} leaves one question: who will take responsibility when the next choice cannot be taken back? The answer changes what each person can ask of the other.`;
    };
    const narrative = language === 'en'
      ? englishNarrative()
      : type === 'hook' ? localized.hook(lead, middle, ending) : localized.escalation(lead, middle, ending);
    return {
      type,
      formatId: type === 'hook' ? String(profile.creativeForm || 'evidence_discovery') : String(profile.secondaryForm || 'accusation_aftershock'),
      openingGrammar: type === 'hook' ? String(profile.openingGrammar || 'conflict_object_action') : 'source_consequence',
      sixSteps,
      evidence: cited,
      content: `${narrative}${requiredEmojiSuffix}\n\n${sixSteps.emotionalCta}${includeTracking ? `\n${localized.codeLine}${includeLink ? `\n${run.artifacts.shortUrl}` : ''}` : ''}\n${tags}`,
      zhContent: includeTracking
        ? `原文证据续航版：围绕第 ${lead.chapter}、${middle.chapter}、${ending.chapter} 章已锁定冲突，使用故事悬念 CTA 与 ${appName} 归因信息。`
        : `广告素材审核版：围绕第 ${lead.chapter}、${middle.chapter}、${ending.chapter} 章锁定冲突，只保留故事悬念 CTA，归因信息单独交付。`
    };
  };
  const creative = {
    posts: [
      makePost('hook', opening, pressure, turn, [opening, pressure]),
      makePost('escalation', pressure, turn, opening, [pressure, turn])
    ],
    videoPrompt: {
      hook: opening.quote,
      valuePromise: pressure.quote,
      escalation: localized.escalationBeat(pressure.quote),
      reversal: turn.quote,
      cliffhanger: localized.cliffhanger,
      sourceEvidence: evidence,
      evidenceChapters: evidence.map((item) => item.chapter),
      adCopy: `${opening.quote} ${pressure.quote} ${turn.quote}`,
      buildRequirement: localized.buildRequirement,
      zhHook: `钩子：${opening.quote}`,
      zhValuePromise: `价值：${pressure.quote}`,
      zhEscalation: `升级：${pressure.quote}`,
      zhReversal: `反转：${turn.quote}`,
      zhCliffhanger: '悬念：停在原文尚未解决的选择上。'
    },
    posterPrompts: [
      { variant: 'luminous_cinema', prompt: `Cinematic vertical romance poster, adult protagonists, a decisive emotional confrontation grounded in this exact story beat: ${opening.quote}. Show the documented pressure and the later shift without adding events, readable facial emotion, dramatic rim lighting, refined contemporary romance cover composition, 4:5, no text, no logos, no watermark, no childlike appearance.`, zhPrompt: '电影感：围绕原文已锁定的决定性冲突，强调人物情绪和光影。' },
      { variant: 'editorial_romance', prompt: `Editorial romance poster, adult protagonists, elegant restrained tension drawn only from these supported story beats: ${pressure.quote} ${turn.quote}. Sophisticated fashion-magazine framing, realistic cinematic texture, intimate but non-explicit emotional distance, 4:5, no text, no logos, no watermark, consistent adult appearance and wardrobe.`, zhPrompt: '编辑感：围绕原文冲突与反转，克制而具有张力。' }
    ],
    qualityReview: { recommendation: 'keep', status: 'unverified', conclusion: '模型未能返回可解析结构；已从锁定章节证据生成可用的续航创意包。', why: '文案、视频剧情和海报提示词只使用已保存的章节原句与中性叙事连接，不新增剧情事实。', target: 'package' }
  };
  // Short locked excerpts can make an otherwise valid scene candidate miss
  // the production readability threshold. Extend only the visible narrative
  // with the same cited consequence, then count emoji on the final narrative
  // rather than assuming every assigned form starts with the same amount.
  for (const post of creative.posts) {
    const marker = `\n\n${post.sixSteps.emotionalCta}`;
    const index = post.content.indexOf(marker);
    if (index < 0) continue;
    let narrative = post.content.slice(0, index).trim();
    const deliveryTail = post.content.slice(index);
    if (language === 'en' && (narrative.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length < 70) {
      narrative += `\n\nThat documented moment does not end when the words are spoken. ${post.sixSteps.contrast} It changes what can be asked, what can be forgiven, and what each person risks by staying silent.`;
    }
    const emoji = narrative.match(/[\u{2600}-\u{27BF}\u{1F300}-\u{1FAFF}]/gu) || [];
    const minimum = run.input?.creativeProfile?.emojiRange === '3-5' ? 3 : 2;
    const additions = ['✨', '🔥', '🖤'];
    narrative += additions.slice(0, Math.max(0, minimum - emoji.length)).join('');
    post.content = `${narrative}${deliveryTail}`;
  }
  for (const poster of creative.posterPrompts) {
    poster.prompt = poster.prompt.replace(' 4:5,', `${sceneDirective}${visualLock} 4:5,`);
  }
  try {
    // The deterministic package is stored only as an operator-review
    // candidate. Keep the normal mechanical-template gate for model output,
    // but allow this candidate to be materialized so the operator can inspect
    // and rewrite it without unlocking paid media.
    const normalized = normalizeCreative({ creative }, run, { allowTemplateCandidate: true, allowLowInfoVideo: options.allowLowInfoVideo === true });
    return result(normalized);
  } catch (error) {
    // The fallback is deliberately strict: it must pass the identical
    // deterministic contract as model output.  Preserve the compact,
    // scrubbed validation category for an authenticated operator so an
    // evidence recovery cannot fail as an unexplained 409.  It contains no
    // chapter text, provider payload, or credentials.
    const diagnostic = cleanError(error);
    return result(null, diagnostic);
  }
}

// A malformed post result gets its normal primary/reserve path and one
// JSON-only repair.  After that, another identical long request is less
// trustworthy than the complete locked evidence.  When P2 has already
// continued from evidence, the first malformed P3 post is enough to take the
// same deterministic path.  The resulting package still passes the normal
// copy validator and uses only saved chapter evidence.
function shouldShortCircuitPostsToSourceEvidence(run, draft, pendingSection) {
  if (pendingSection !== 'posts') return false;
  // An explicit operator retry must exercise the currently configured model
  // route. Short-circuiting manual_retry here made every retry immediately
  // recreate the same evidence candidate without contacting the provider.
  const priorError = String(run.stages?.P3?.error || draft?.failures?.posts?.error || '');
  if (!structuredModelError(priorError)) return false;
  const p2AlreadyContinued = run.stages?.P2?.phase === 'evidence_continuation';
  const repairAttempts = Number(draft?.repairAttempts?.posts || draft?.failures?.posts?.repairAttempts || 0);
  return p2AlreadyContinued || repairAttempts >= 1;
}

function applySourceGroundedCreativeFallback(run, creative, error) {
  const message = cleanError(error || 'Both model routes returned malformed structured output');
  // Evidence continuation is a candidate for operator review, not a creative
  // pass. The deterministic copy is intentionally conservative and can be
  // useful for comparison, but it must never become an implicit P3 success or
  // unlock a paid P4/P3.5 branch. Keep it under a separate namespace so the
  // normal downstream stages cannot mistake it for approved creative output.
  const candidateAt = now();
  run.artifacts.evidenceContinuationCandidate = {
    status: 'awaiting_operator_review',
    source: 'locked_chapter_evidence',
    createdAt: candidateAt,
    validationStatus: 'candidate_only',
    posts: creative.posts,
    translations: { language: 'zh-CN', posts: creative.posts.map((item) => item.zhContent) },
    videoPrompt: creative.videoPrompt,
    posterPrompts: creative.posterPrompts,
    qualityReview: creative.qualityReview
  };
  // Remove any stale core fields left by a malformed model response. Keeping
  // them populated would make the UI look ready and could let a later worker
  // accidentally compile a paid contract after an operator refresh.
  delete run.artifacts.posts;
  delete run.artifacts.translations;
  delete run.artifacts.videoPrompt;
  delete run.artifacts.posterPrompts;
  delete run.artifacts.qualityReview;
  run.artifacts.optimization = { status: 'evidence_continuation_review', review: creative.qualityReview, candidateCreatedAt: candidateAt };
  run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), {
    section: 'creativePackage', requestedModel: run.artifacts?.modelRoute?.activeModel || run.input?.creativeProfile?.modelChoice || 'AI', model: 'evidence-continuation',
    fallbackFrom: run.artifacts?.modelRoute?.activeModel || '', completedAt: now(), triggerReason: '两条模型路线均未返回可解析结构',
    outputStatus: '已从锁定原文证据保存候选包；等待人工审核，禁止后续付费媒体', error: message
  }].slice(-24);
  delete run.artifacts.creativeDraft;
  run.state = 'failed';
  setStage(run, 'P3', 'failed', { label: '模型格式异常；证据续航包已保存，等待人工审核后再生成媒体', phase: 'evidence_continuation_review', recoverable: false, error: message, nextAttemptAt: '' });
  addEvent(run, 'creative_evidence_candidate_saved', 'Both model routes returned malformed structure; an evidence-grounded candidate was saved for operator review and paid media remains locked', { error: message, candidateCreatedAt: candidateAt });
}

async function finalizeCreativeDraft(redis, run) {
  const draft = run.artifacts.creativeDraft;
  if (!draft || pendingCreativeSections(draft, run).length) return run;
  const result = {
    creative: {
      posts: draft.parts.posts,
      videoPrompt: draft.parts.videoPrompt,
      posterPrompts: posterCreativeRequired(run) ? draft.parts.posterPrompts : [],
      qualityReview: draft.parts.qualityReview
    },
    model: draft.usage.map((item) => item.model).filter(Boolean).join(' / '),
    responseId: draft.usage.map((item) => item.responseId).filter(Boolean).join(','),
    usage: draft.usage.reduce((total, item) => ({ inputTokens: total.inputTokens + Number(item.inputTokens || 0), outputTokens: total.outputTokens + Number(item.outputTokens || 0), totalTokens: total.totalTokens + Number(item.totalTokens || 0) }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  };
  let creative;
  let uniquenessReservation = null;
  try {
    creative = normalizeCreative(result, run);
    uniquenessReservation = await reserveCampaignCreativeUniqueness(redis, run, creative);
  } catch (error) {
    if (Number(error?.status) === 429 && /uniqueness registry/i.test(String(error?.message || ''))) {
      const nextAttemptAt = new Date(Date.now() + 1500).toISOString();
      run.state = 'running';
      setStage(run, 'P3', 'waiting', { label: 'Campaign 创意去重正在排队，已保留当前产物', phase: 'campaign_uniqueness_wait', nextAttemptAt, error: '', recoverable: true });
      await saveRun(redis, run);
      return run;
    }
    const coreReady = draft.parts?.posts && draft.parts?.videoPrompt
      && (!posterCreativeRequired(run) || draft.parts?.posterPrompts);
    const repairAttempts = Number(draft.validationRepairAttempts || 0);
    if (structuredModelError(error) && repairAttempts < 2) {
      draft.validationRepairAttempts = repairAttempts + 1;
      draft.parts = {};
      draft.usage = [];
      draft.recoveryRevision = { instruction: 'The previous package was not parseable. Return one compact JSON object with every required field and no prose outside it.', validationError: cleanError(error) };
      draft.failures = Object.fromEntries((posterCreativeRequired(run) ? ['posts', 'videoPrompt', 'posterPrompts'] : ['posts', 'videoPrompt'])
        .map((section) => [section, { attempt: repairAttempts + 1, at: now(), error: cleanError(error), recoverable: true }]));
      run.artifacts.creativeDraft = draft;
      run.state = 'running';
      setStage(run, 'P3', 'waiting', { label: `模型输出格式正在自动修复（第 ${repairAttempts + 1} 次）`, phase: 'model_output_repairing', attempt: repairAttempts + 1, nextAttemptAt: new Date(Date.now() + 1500).toISOString(), error: cleanError(error), recoverable: true });
      addEvent(run, 'creative_validation_repair_scheduled', 'Malformed creative package will be regenerated from the saved chapter evidence before any paid media is touched', { repairAttempts: repairAttempts + 1, error: cleanError(error) });
      await saveRun(redis, run);
      return run;
    }
    if (draft.validationFallbackUsed && coreReady) {
      const fallbackCreative = sourceGroundedCreativeFallback(run);
      if (fallbackCreative) {
        applySourceGroundedCreativeFallback(run, fallbackCreative, error);
        await saveRun(redis, run);
        return run;
      }
      const message = cleanError(error);
      run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), ...draft.usage.map((item) => ({ ...item, validationStatus: 'rejected', validationError: message, outputStatus: '产物保留，待人工复核' }))].slice(-24);
      run.state = 'failed';
      setStage(run, 'P3', 'failed', { label: '备用模型与证据续航均未通过校验，请人工处理后再生成媒体', phase: 'validation_waiting_for_operator', error: message, recoverable: false });
      addEvent(run, 'creative_validation_waiting_for_operator', 'The reserve package failed validation and no validated evidence continuation was available; paid media was not allowed to continue');
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
    const nextModel = creativeRepairModel(previousModel);
    run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), ...draft.usage.map((item) => ({ ...item, validationStatus: 'rejected', validationError: cleanError(error) }))].slice(-24);
    draft.parts = {};
    draft.usage = [];
    draft.validationAttempts = attempt;
    draft.validationFallbackUsed = true;
    draft.recoveryRevision = { instruction: 'Regenerate every creative section from the saved exact chapter evidence. Correct the prior validation failure and do not reuse unsupported quotes.', validationError: cleanError(error) };
    draft.failures = Object.fromEntries((posterCreativeRequired(run) ? ['posts', 'videoPrompt', 'posterPrompts'] : ['posts', 'videoPrompt'])
      .map((section) => [section, { attempt, at: now(), error: cleanError(error), nextAttemptAt }]));
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
  if (uniquenessReservation) run.artifacts.campaignUniqueness = uniquenessReservation;
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
  const pending = pendingCreativeSections(draft, run);
  const pendingSection = requestedSection && pending.includes(requestedSection) ? requestedSection : pending[0];
  if (shouldShortCircuitPostsToSourceEvidence(run, draft, pendingSection)) {
    const fallbackCreative = sourceGroundedCreativeFallback(run);
    if (fallbackCreative) {
      applySourceGroundedCreativeFallback(run, fallbackCreative, run.stages?.P3?.error || draft.failures?.posts?.error);
      addEvent(run, 'creative_posts_evidence_circuit_breaker', 'P2 had already continued from locked evidence and P3 posts were structurally malformed, so the validated full evidence package replaced another model retry');
      await saveRun(redis, run);
      return run;
    }
  }
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
    let requestRouteModel = '';
    let requestRouteSwitchedAt = '';
      let providerLease = null;
      try {
      const reviewInput = pendingSection === 'qualityReview' ? { posts: draft.parts.posts, videoPrompt: draft.parts.videoPrompt, posterPrompts: draft.parts.posterPrompts } : (revision || draft.recoveryRevision || null);
      const route = ensureModelRoute(run);
      requestRouteModel = String(route.activeModel || '');
      requestRouteSwitchedAt = String(route.switchedAt || '');
      // TokenDance capacity is shared across every campaign run. A single
      // server-side gate prevents 36 browser/cron wakeups from turning into a
      // self-inflicted 429 storm; P3 keeps the same model and resumes later.
      if (pendingSection !== 'qualityReview') providerLease = await acquireTokenDanceGate(redis, requestRouteModel, run.id, 660);
      sectionResult = await providers.generateCreative(run.artifacts.book, sceneEvidenceChapters(run), run.artifacts.code, run.artifacts.shortUrl, reviewInput, { ...(run.input.creativeProfile || {}), adCreativeNoTracking: !trackingEnabledForRun(run) || run.input?.creativeProfile?.adCreativeNoTracking === true, modelChoice: route.activeModel, storyBrief: run.artifacts.storyBrief?.plan || null, delivery: deliveryForRun(run) }, pendingSection);
      if (!hasCreativeSectionValue(pendingSection, sectionResult?.creative?.[pendingSection])) {
        // Keep failure diagnostics useful without retaining model text or
        // chapter material.  TokenDance-compatible endpoints can return a
        // root object with a present-but-mis-shaped section; distinguishing
        // that from a missing root is required to repair the adapter safely.
        const shape = providers.structuredShape(sectionResult?.creative?.[pendingSection]);
        throw new providers.ProviderError(`Creative model returned incomplete creative ${pendingSection} (${shape})`);
      }
    } catch (error) {
      return withCreativeMergeLock(redis, run.id, async () => {
        const latest = await getRun(redis, run.id) || run;
        const latestDraft = draftFor(latest, suppressOptimizationReview);
        delete latestDraft.inFlight?.[pendingSection];
        latestDraft.failures = { ...(latestDraft.failures || {}) };
        const attempt = Number(latestDraft.failures[pendingSection]?.attempt || 0) + 1;
        const route = ensureModelRoute(latest);
        const staleCoreFailure = creativeCoreSections.includes(pendingSection)
          && requestRouteModel
          && (String(route.activeModel || '') !== requestRouteModel || String(route.switchedAt || '') !== requestRouteSwitchedAt);
        if (staleCoreFailure) {
          latest.artifacts.modelActivity = [...(latest.artifacts.modelActivity || []), {
            section: pendingSection,
            requestedModel: requestRouteModel,
            model: '',
            completedAt: now(),
            triggerReason: '模型路线切换前已发出的请求',
            outputStatus: '返回时任务已切换模型，该失败不影响新路线',
            validationStatus: 'discarded_stale_route',
            error: cleanError(error)
          }].slice(-24);
          latest.artifacts.creativeDraft = latestDraft;
          latest.state = 'running';
          setStage(latest, 'P3', 'waiting', { label: '旧模型请求已结束，继续生成统一模型创意包', phase: 'stale_route_discarded', error: '', nextAttemptAt: '' });
          addEvent(latest, 'creative_stale_failure_discarded', `${pendingSection} failed after the task route changed and did not affect the reserve package`, { requestRouteModel, activeModel: route.activeModel, error: cleanError(error) });
          await saveRun(redis, latest);
          return syncRun(originalRun, latest);
        }
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
        const deepSeekTimeout = isTokenDanceFlash(requestRouteModel)
          && Number(error?.status || 0) === 504
          && String(error?.code || '') === 'provider_timeout';
        if (modelCapacityError(error) || deepSeekTimeout) {
          const upstreamCapacityError = deepSeekTimeout || (isTokenDanceFlash(requestRouteModel)
            && !['model_capacity', 'model_capacity_cooldown'].includes(String(error?.code || '')));
          if (upstreamCapacityError) await startTokenDanceDeepSeekCooldown(redis);
          const waitMs = upstreamCapacityError ? TOKENDANCE_DEEPSEEK_COOLDOWN_SECONDS * 1000 : 30000;
          const nextAttemptAt = new Date(Date.now() + waitMs).toISOString();
          latestDraft.failures[pendingSection] = { attempt, at: now(), error: cleanError(error), nextAttemptAt, recoverable: true, capacityWait: true };
          latest.artifacts.creativeDraft = latestDraft;
          latest.state = 'running';
          const waitingLabel = upstreamCapacityError
            ? `${creativeSectionLabels[pendingSection]} 上游限流冷却中，210 秒后继续`
            : `${creativeSectionLabels[pendingSection]} 当前并发已满，30 秒后继续`;
          setStage(latest, 'P3', 'waiting', { label: waitingLabel, phase: 'model_capacity_wait', attempt, nextAttemptAt, error: cleanError(error), recoverable: true, pendingSection });
          addEvent(latest, 'creative_model_capacity_wait', 'Model capacity is temporarily full; completed creative sections and the active model route were preserved for retry', { pendingSection, model: route.activeModel, nextAttemptAt, upstreamCooldown: upstreamCapacityError });
          await saveRun(redis, latest);
          return syncRun(originalRun, latest);
        }
        const preferredModel = String(route.preferredModel || latest.input?.creativeProfile?.modelChoice || 'hy3');
        const alreadyUsedReserve = latestDraft.modelRoute?.fallbackUsed === true || Boolean(error?.fallbackModel);
        if (alreadyUsedReserve) {
          const message = cleanError(error);
          // Keep the counter recoverable even when a legacy detail projection
          // retained only the per-section failure record.
          const repairAttempts = Number(latestDraft.repairAttempts?.[pendingSection] || latestDraft.failures?.[pendingSection]?.repairAttempts || 0);
          // Posts are fully reconstructible from the locked evidence package.
          // Once the reserve route has failed, use that deterministic package
          // immediately, including routes whose attribution Code is deferred.
          if (pendingSection === 'posts' && structuredModelError(error)) {
            const fallbackCreative = sourceGroundedCreativeFallback(latest);
            if (fallbackCreative) {
              applySourceGroundedCreativeFallback(latest, fallbackCreative, message);
              addEvent(latest, 'creative_posts_evidence_circuit_breaker', 'Posts were rebuilt from locked chapter evidence after the reserve model failed; no attribution or media submission was required');
              await saveRun(redis, latest);
              return syncRun(originalRun, latest);
            }
          }
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
            // A malformed video section can arrive before usable AI posts
            // were saved.  In that case the narrow video fallback cannot
            // safely reconstruct the prompt.  The full evidence fallback is
            // still deterministic, validated, and free; use it before
            // treating the run as operator-blocked.  It never submits media.
            const fallbackCreative = sourceGroundedCreativeFallback(latest);
            if (fallbackCreative) {
              applySourceGroundedCreativeFallback(latest, fallbackCreative, message);
              addEvent(latest, 'creative_video_package_evidence_continuation', 'Video prompt was incomplete after the reserve model; the full validated creative package was rebuilt from locked chapter evidence before any media submission');
              await saveRun(redis, latest);
              return syncRun(originalRun, latest);
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
          // Poster prompts are a deterministic, non-paid creative artifact.
          // If both model routes return an incomplete poster section, keep the
          // saved chapter evidence authoritative and synthesize the two
          // required variants locally instead of dead-ending the whole run.
          // This does not touch the paid image branch; P3.5 still performs its
          // normal pause/idempotency checks before any submission.
          if (pendingSection === 'posterPrompts') {
            const grounded = sourceGroundedCreativeFallback(latest);
            if (grounded?.posterPrompts?.length === 2) {
              latestDraft.parts.posterPrompts = grounded.posterPrompts;
              delete latestDraft.failures[pendingSection];
              latest.artifacts.modelActivity = [...(latest.artifacts.modelActivity || []), {
                section: pendingSection,
                requestedModel: preferredModel,
                model: 'evidence-fallback',
                fallbackFrom: error?.fallbackFrom || preferredModel,
                fallbackModel: error?.fallbackModel || '',
                fallbackReason: 'poster prompt model output incomplete',
                completedAt: now(),
                triggerReason: 'evidence-grounded poster continuation',
                outputStatus: 'two validated poster prompts built from locked chapter evidence',
                error: message
              }].slice(-24);
              latest.artifacts.creativeDraft = latestDraft;
              latest.state = 'running';
              setStage(latest, 'P3', 'waiting', {
                label: '海报提示词已从锁定原文证据补齐，继续剩余创意节点',
                phase: 'poster_evidence_fallback',
                error: message,
                recoverable: false,
                nextAttemptAt: ''
              });
              addEvent(latest, 'creative_poster_evidence_fallback', 'Incomplete poster output was replaced with two evidence-grounded variants; no paid image request was made here');
              await saveRun(redis, latest);
              const finalized = await finalizeCreativeDraft(redis, latest);
              return syncRun(originalRun, finalized);
            }
          }
          if (pendingSection === 'posts' && structuredModelError(error)) {
            const fallbackCreative = sourceGroundedCreativeFallback(latest);
            if (fallbackCreative) {
              applySourceGroundedCreativeFallback(latest, fallbackCreative, message);
              await saveRun(redis, latest);
              return syncRun(originalRun, latest);
            }
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
        const reserveModel = creativeRepairModel(activeModel);
        const nextAttemptAt = new Date(Date.now() + 1000).toISOString();
        const discardedSections = creativeCoreSections.includes(pendingSection)
          ? discardCreativeCoreForModelSwitch(latest, latestDraft, { fromModel: activeModel, toModel: reserveModel, triggerSection: pendingSection, error })
          : [];
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
        addEvent(latest, 'creative_task_model_switched', `${pendingSection} caused one task-wide model switch; the complete creative package now uses ${reserveModel}`, { attempt, preferredModel, activeModel, reserveModel, nextAttemptAt, discardedSections });
        // Keep the legacy event name for existing operational timelines; the
        // task-wide switch event above is the authoritative routing record.
        addEvent(latest, 'creative_section_fallback_scheduled', `${pendingSection} scheduled the task-wide reserve route`, { attempt, preferredModel, activeModel, reserveModel, nextAttemptAt });
        await saveRun(redis, latest);
        return syncRun(originalRun, latest);
      });
    } finally {
      await releaseLease(redis, providerLease);
    }
    return withCreativeMergeLock(redis, run.id, async () => {
      const latest = await getRun(redis, run.id) || run;
      const latestDraft = draftFor(latest, suppressOptimizationReview);
      delete latestDraft.inFlight?.[pendingSection];
      const latestRoute = ensureModelRoute(latest);
      const staleCoreResult = creativeCoreSections.includes(pendingSection)
        && requestRouteModel
        && (String(latestRoute.activeModel || '') !== requestRouteModel || String(latestRoute.switchedAt || '') !== requestRouteSwitchedAt);
      if (staleCoreResult) {
        latest.artifacts.modelActivity = [...(latest.artifacts.modelActivity || []), {
          section: pendingSection,
          requestedModel: requestRouteModel,
          model: sectionResult.model,
          responseId: sectionResult.responseId,
          latencyMs: Number(sectionResult.latencyMs || 0),
          completedAt: now(),
          triggerReason: '模型路线切换前已发出的请求',
          outputStatus: '返回时任务已切换模型，该结果已丢弃',
          validationStatus: 'discarded_stale_route',
          ...sectionResult.usage
        }].slice(-24);
        latest.artifacts.creativeDraft = latestDraft;
        latest.state = 'running';
        setStage(latest, 'P3', 'waiting', { label: '旧模型结果已丢弃，继续生成统一模型创意包', phase: 'stale_route_discarded', error: '', nextAttemptAt: '' });
        addEvent(latest, 'creative_stale_result_discarded', `${pendingSection} completed after the task route changed and was excluded from the final package`, { requestRouteModel, activeModel: latestRoute.activeModel });
        await saveRun(redis, latest);
        return syncRun(originalRun, latest);
      }
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
      const waitingOn = pendingCreativeSections(latestDraft, latest);
      setStage(latest, 'P3', 'waiting', { label: waitingOn.length ? `${creativeSectionLabels[pendingSection]}已保存，${waitingOn.length} 项创意并行中` : '全部创意已保存，准备质量校验', phase: 'section_saved', error: '', nextAttemptAt: '' });
      addEvent(latest, 'creative_section_ready', `${pendingSection} saved; independent creative sections may continue in parallel`);
      await saveRun(redis, latest);
      const finalized = await finalizeCreativeDraft(redis, latest);
      return syncRun(originalRun, finalized);
    });
  }
  return finalizeCreativeDraft(redis, run);
}

function videoPayload(run, options = {}) {
  return videoControl.compileVideoContract(run, { kind: 'original', ...options });
}

function referenceVideoPayload(run, referenceAssetId) {
  return videoPayload(run, { kind: 'reference', referenceAssetIds: [referenceAssetId] });
}

function preparedVideoArtifact(prepared) {
  return {
    status: 'prepared',
    remark: prepared.remark,
    payload: prepared.payload,
    payloadFingerprint: prepared.payloadFingerprint,
    control: prepared.control,
    controlWarnings: [...(prepared.warnings || [])],
    submissionAllowed: prepared.submissionAllowed,
    threadId: '',
    videoUrls: [],
    // Filled by P4 immediately before the paid AC call. Keeping the
    // reservation on the artifact makes a serverless interruption resumable.
    budgetReservation: null
  };
}

const reusableVideoContractFields = Object.freeze([
  'hook',
  'valuePromise',
  'escalation',
  'reversal',
  'cliffhanger',
  'adCopy',
  'buildRequirement',
  'evidenceChapters'
]);

function normalizedVideoContract(run) {
  const prompt = run?.artifacts?.videoPrompt || {};
  const normalized = {};
  for (const field of reusableVideoContractFields) {
    const value = prompt[field];
    if (field === 'evidenceChapters') {
      if (!Array.isArray(value) || !value.length) return null;
      normalized[field] = value.map((chapter) => String(chapter || '').trim()).filter(Boolean);
      if (normalized[field].length !== value.length) return null;
      continue;
    }
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    normalized[field] = text;
  }
  return normalized;
}

function videoContractFingerprint(run) {
  const contract = normalizedVideoContract(run);
  return contract ? providers.sha(JSON.stringify(contract)) : '';
}

function exactSiblingVideo(run, siblingRuns) {
  const sku = String(run?.input?.sku || '');
  const fingerprint = videoContractFingerprint(run);
  if (!sku || !fingerprint) return [];
  const matches = [];
  for (const sibling of siblingRuns || []) {
    if (!sibling || sibling.id === run.id || String(sibling.input?.sku || '') !== sku) continue;
    const campaignId = String(run.input?.campaign?.id || '');
    if (run.input?.creativeProfile?.uniquenessRequired === true
      && campaignId
      && String(sibling.input?.campaign?.id || '') === campaignId) continue;
    const video = sibling.artifacts?.video || {};
    const url = String(video.videoUrls?.[0] || '');
    if (sibling.stages?.P4?.status !== 'done'
      || video.status !== 'completed'
      || !String(video.threadId || '')
      || !url.startsWith('https://')
      || !String(video.mediaValidation?.contentType || '').toLowerCase().startsWith('video/')
      || videoContractFingerprint(sibling) !== fingerprint) continue;
    matches.push({ sibling, video, url, fingerprint });
  }
  return matches;
}

async function recoverPreparedVideoFromExactSibling(redis, run, suppliedSiblings = null) {
  const stage = run?.stages?.P4 || {};
  const currentVideo = run?.artifacts?.video || {};
  if (stage.status !== 'prepared'
    || stage.blockedReason !== 'operator_video_pause'
    || currentVideo.status !== 'prepared'
    || currentVideo.threadId
    || currentVideo.submitAttemptedAt) return false;
  const loadedIds = new Set();
  const loadCompletedSameSku = async (summaries) => {
    const candidates = (summaries || []).filter((item) => item.id !== run.id
      && !loadedIds.has(item.id)
      && String(item.input?.sku || '') === String(run.input?.sku || '')
      && item.stages?.P4?.status === 'done'
      && item.artifacts?.video?.videoUrls?.[0]);
    candidates.forEach((item) => loadedIds.add(item.id));
    return (await Promise.all(candidates.map((item) => getRun(redis, item.id)))).filter(Boolean);
  };
  const verifiedSource = async (siblings) => {
    for (const candidate of exactSiblingVideo(run, siblings)) {
      try {
        const validation = await providers.validateVideo(candidate.url);
        if (String(validation?.contentType || '').toLowerCase().startsWith('video/')) return { source: candidate, verifiedMedia: validation };
      } catch {
        // A stale or unreadable historical URL is not reusable. Continue to
        // another exact match without changing the target or submitting AC.
      }
    }
    return null;
  };
  let recovered = null;
  if (Array.isArray(suppliedSiblings)) {
    recovered = await verifiedSource(suppliedSiblings);
  } else {
    // Most reuse comes from a recent sibling and should not pay the latency of
    // a deep history scan. Only fall back to 500 summaries when the latest 150
    // contain no verified exact-contract source.
    recovered = await verifiedSource(await loadCompletedSameSku(await listRunSummaries(redis, 150)));
    if (!recovered) {
      const lastDeepCheck = Date.parse(stage.lastDeepReuseCheckedAt || '');
      if (Number.isFinite(lastDeepCheck) && Date.now() - lastDeepCheck < 30 * 60 * 1000) return false;
      const deepMissKey = `nf_social:video_reuse_scan:${providers.sha(`${String(run.input?.sku || '')}:${videoContractFingerprint(run)}`).slice(0, 32)}`;
      if (await redis.get(deepMissKey)) return false;
      recovered = await verifiedSource(await loadCompletedSameSku(await listRunSummaries(redis, 500)));
      stage.lastDeepReuseCheckedAt = now();
      if (!recovered) {
        // Share the negative result across sibling accounts with the same SKU
        // and contract. They still check the recent 150 first, so a newly
        // completed source becomes reusable immediately during this cooldown.
        await redis.set(deepMissKey, stage.lastDeepReuseCheckedAt, { ex: 30 * 60 });
        // Keep the negative-cache audit durable without making an idle task
        // look newly progressed or moving it to the top of the dashboard.
        await saveRun(redis, run, { preserveUpdatedAt: true });
        return false;
      }
    }
  }
  const source = recovered?.source || null;
  const verifiedMedia = recovered?.verifiedMedia || null;
  if (!source || !verifiedMedia) return false;
  const preparedAudit = {
    status: currentVideo.status,
    remark: String(currentVideo.remark || ''),
    payloadFingerprint: String(currentVideo.payloadFingerprint || ''),
    blockedReason: String(stage.blockedReason || ''),
    lastReconciledAt: String(stage.lastReconciledAt || ''),
    preservedAt: now()
  };
  const sourceUrl = String(verifiedMedia.resolvedUrl || source.url);
  Object.assign(currentVideo, {
    status: 'completed',
    threadId: String(source.video.threadId),
    videoUrls: [sourceUrl],
    mediaValidation: verifiedMedia,
    coverImageUrl: String(source.video.coverImageUrl || currentVideo.coverImageUrl || ''),
    videoModel: String(source.video.videoModel || currentVideo.videoModel || ''),
    isUserAdCopy: source.video.isUserAdCopy === true,
    executionControls: source.video.executionControls || currentVideo.executionControls || null,
    reusedFromRunId: source.sibling.id,
    sourceThreadId: String(source.video.threadId),
    contractFingerprint: source.fingerprint,
    reuseMode: 'exact_sibling_video_contract',
    preparedAudit,
    recoveredAt: now(),
    error: '',
    lastCheckedAt: now(),
    lastPollError: ''
  });
  initializeVisualQa(currentVideo);
  setStage(run, 'P4', 'done', {
    label: '已复用同 SKU、同视频合同的历史验证成片；未提交新 AC 任务',
    threadId: currentVideo.threadId,
    blockedReason: '',
    nextAttemptAt: '',
    recoverable: false,
    error: '',
    reusedFromRunId: source.sibling.id,
    contractFingerprint: source.fingerprint
  });
  addEvent(run, 'prepared_video_recovered_from_exact_sibling', 'Prepared video was completed without a new AC request by reusing a verified historical video with the exact SKU and normalized creative contract', {
    sourceRunId: source.sibling.id,
    sourceThreadId: currentVideo.sourceThreadId,
    contractFingerprint: source.fingerprint
  });
  await saveRun(redis, run);
  return true;
}

function mergeExecutionWarnings(video, executionControls) {
  const warnings = videoControl.executionWarnings(video?.control, executionControls);
  video.controlWarnings = [...new Set([...(video.controlWarnings || []), ...warnings])].slice(-12);
  return warnings;
}

function initializeVisualQa(video) {
  if (video.executionQa) return video.executionQa;
  video.executionQa = {
    status: 'pending_manual_review',
    score: null,
    criteria: ['adult_character_identity', 'conflict_object_opening', 'event_order', 'ending_lock', 'vertical_usability'],
    createdAt: now()
  };
  return video.executionQa;
}

function threadId(value) {
  return String(providers.taskIdOf(value) || '');
}

// A provider list can return a matching remark with an incomplete row while
// its detail/index is still converging. Never promote that row to `running`:
// an empty thread ID would make the next poll call an unrelated task and could
// strand the run indefinitely. Treat it as "not reconciled" so the normal
// retry/ambiguity path remains in control.
function reconciledThreadId(value) {
  const id = threadId(value);
  return id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) ? id : '';
}

async function p4(redis, run, options = {}) {
  const manualVideoLimitOverride = options.manualVideoLimitOverride === true;
  const stage = run.stages.P4;
  if (await recoverPreparedVideoFromExactSibling(redis, run)) return;
  const pauseSetting = String(process.env.SOCIAL_VIDEO_GENERATION_PAUSED || '').trim().toLowerCase();
  const experimentRunId = String(process.env.SOCIAL_VIDEO_EXPERIMENT_RUN_ID || '').trim();
  const experimentAllowsRun = !experimentRunId || experimentRunId === run.id;
  const experimentSubtitleWire = experimentAllowsRun && String(process.env.SOCIAL_VIDEO_EXPERIMENT_SUBTITLE_WIRE || '').trim() === 'number_zero' ? 'number_zero' : '';
  const explicitGlobalPause = pauseSetting ? !['0', 'false', 'off'].includes(pauseSetting) : false;
  const perRunMediaAuthorized = run.input?.paidMediaSubmissionAuthorized === true;
  // Production stays fail-closed by default, but an operator-approved run
  // carries a durable media flag. A historical prepared run has no such flag
  // and remains paused; an explicit global pause still wins everywhere.
  const submissionsPaused = explicitGlobalPause || (!perRunMediaAuthorized && !pauseSetting && process.env.VERCEL_ENV === 'production') || !experimentAllowsRun;
  if (submissionsPaused && ['waiting', 'prepared'].includes(stage.status) && !run.artifacts?.video?.threadId) {
    if (stage.status === 'waiting') {
      const prepared = videoPayload(run);
      run.artifacts.video = preparedVideoArtifact(prepared);
    } else {
      const lastReconciledAt = Date.parse(stage.lastReconciledAt || '');
       if (stage.blockedReason === 'operator_video_pause' && Number.isFinite(lastReconciledAt) && Date.now() - lastReconciledAt < 10 * 60 * 1000) return;
       if (!Number.isFinite(lastReconciledAt) || Date.now() - lastReconciledAt >= 10 * 60 * 1000) {
         const reconciled = await providers.findAcTask(run.artifacts.video.remark);
          const reconciledId = reconciledThreadId(reconciled);
          if (reconciledId) {
            run.artifacts.video.threadId = reconciledId;
           run.artifacts.video.status = 'running';
           if (run.artifacts.video.slot && !run.artifacts.video.slot.override) run.artifacts.video.slot.settledAt = now();
           await settleAcBudgetForVideo(redis, run.artifacts.video, { status: 'reconciled', externalId: run.artifacts.video.threadId });
           setStage(run, 'P4', 'running', { label: '暂停期间已找回既有视频任务，继续回收结果', threadId: run.artifacts.video.threadId, blockedReason: '', nextAttemptAt: '' });
          await saveRun(redis, run);
          return;
        }
        stage.lastReconciledAt = now();
      }
    }
    if (stage.blockedReason !== 'operator_video_pause') {
      setStage(run, 'P4', 'prepared', { label: '视频提交已暂停；提示词与任务参数已安全保存', blockedReason: 'operator_video_pause', recoverable: true, nextAttemptAt: '' });
      run.state = 'running';
      addEvent(run, 'video_submission_paused', 'Video payload was prepared but not submitted because the operator paused new video generation');
      await saveRun(redis, run);
    } else if (stage.lastReconciledAt) {
      await saveRun(redis, run);
    }
    return;
  }
  const capacityRetryAt = Date.parse(stage.nextAttemptAt || '');
  if (!manualVideoLimitOverride && stage.status === 'prepared' && videoCapacityBlocked(stage.blockedReason) && Number.isFinite(capacityRetryAt) && capacityRetryAt > Date.now()) return;
  if (stage.status === 'waiting') {
    const prepared = videoPayload(run);
    run.artifacts.video = preparedVideoArtifact(prepared);
    setStage(run, 'P4', 'prepared', { label: '视频任务已就绪，等待提交' });
    await saveRun(redis, run);
    return;
  }
  let video = run.artifacts.video;
  if (experimentSubtitleWire && stage.status === 'prepared' && video?.status === 'prepared' && !video.threadId && !video.submitAttemptedAt) {
    const prepared = videoPayload(run, { controlOverride: { ...(run.input?.videoControl || {}), subtitleWireValue: experimentSubtitleWire } });
    run.artifacts.video = preparedVideoArtifact(prepared);
    video = run.artifacts.video;
    setStage(run, 'P4', 'prepared', { label: '单条 AC 字幕控制实验合同已准备', blockedReason: '', error: '', nextAttemptAt: '' });
    addEvent(run, 'video_subtitle_wire_experiment_prepared', 'One authorized AC experiment changed only the subtitle wire value to numeric zero', { payloadFingerprint: prepared.payloadFingerprint });
    await saveRun(redis, run);
  }
  const pollRetryAt = Date.parse(stage.nextAttemptAt || '');
  if (stage.status === 'running' && Number.isFinite(pollRetryAt) && pollRetryAt > Date.now()) return;
  if (stage.status === 'prepared') {
    // Capacity-prepared tasks have never been submitted, so they do not need
    // a billable reconciliation call before checking the local quota again.
    // This also keeps a full-day queue usable when AC credentials are absent.
    const reconciled = video.remark === 'capacity-wait' && !video.submitAttemptedAt
      ? null
      : await providers.findAcTask(video.remark);
    const reconciledId = reconciledThreadId(reconciled);
    if (reconciledId) {
      video.threadId = reconciledId;
      video.status = 'running';
      await settleAcBudgetForVideo(redis, video, { status: 'reconciled', externalId: video.threadId });
      setStage(run, 'P4', 'running', { label: '已找回视频任务，正在生成', threadId: video.threadId, blockedReason: '', nextAttemptAt: '' });
      await saveRun(redis, run);
      return;
    }
    if (reconciled) {
      // A matching remark with no usable task ID is evidence that AC saw the
      // request, but it is not safe to issue a second paid submission. Keep
      // the run ambiguous for operator reconciliation instead of falling
      // through to `submitAc`.
      throw new providers.ProviderError('AC returned a matching remark without a valid task ID; automatic retry is disabled', { ambiguous: true });
    }
    if (video.submissionAllowed === false || video.control?.policy?.production === false) {
      setStage(run, 'P4', 'prepared', { label: '实验模板仅生成 dry-run 合同，等待单变量实验授权', blockedReason: 'experimental_template', recoverable: true, nextAttemptAt: '' });
      addEvent(run, 'video_experimental_template_held', 'Experimental AC template remained prepared; no paid video was submitted', { template: video.control?.template || '' });
      await saveRun(redis, run);
      return;
    }
    const existingSlot = reusableVideoSlot(video);
    let slot = existingSlot || await reserveVideoSlot(redis);
    if (!slot.granted && manualVideoLimitOverride) {
      slot = { ...slot, granted: true, override: true, used: slot.limit + 1, remaining: 0 };
      addEvent(run, 'video_limit_operator_override', 'Operator-authorized temporary video-capacity override used for this submission', { limit: slot.limit });
    }
    if (!slot.granted) {
      const nextAttemptAt = new Date(Date.now() + Math.max(60, Number(slot.expiresIn || 60)) * 1000).toISOString();
      setStage(run, 'P4', 'prepared', { label: `本日视频额度已满（${slot.limit}/${slot.limit}），已自动排队到次日 00:00`, blockedReason: 'daily_video_limit', nextWindow: slot.resetLabel, nextAttemptAt, recoverable: true });
      run.state = 'running';
      addEvent(run, 'video_day_waiting', `Daily video capacity is full; the saved task will resume after ${nextAttemptAt} while other branches continue`, { nextAttemptAt, limit: slot.limit, timeZone: slot.timeZone });
      await saveRun(redis, run);
      return;
    }
    if (!existingSlot) {
      video.slot = { key: slot.key, day: slot.label, resetAt: slot.resetAt, reservedAt: now(), position: slot.used, limit: slot.limit, ...(slot.override ? { override: true } : {}) };
      // Persist the day-slot reservation before reserving AC points. If the
      // function is interrupted between these two independent stores, the
      // next invocation can reuse this exact slot instead of incrementing the
      // daily counter a second time.
      try {
        await saveRun(redis, run);
      } catch (error) {
        await releaseUnsubmittedVideoSlot(redis, video, 'slot_persist_failed');
        throw error;
      }
    }
    try {
      await reserveAcBudgetForVideo(redis, run, video);
    } catch (error) {
      // The local AC points reservation is made after the video-day slot so a
      // budget outage/limit cannot strand either resource. No provider call
      // has happened yet, therefore releasing the slot is unambiguous.
      // `reserveAcBudgetForVideo` persists its reservation before returning;
      // if that persistence fails after the counter was incremented, release
      // the points as well as the day slot. Both operations are idempotent.
      await releaseAcBudgetForVideo(redis, video, String(error?.code || 'ac_budget_persist_failed'));
      await releaseUnsubmittedVideoSlot(redis, video, String(error?.code || 'ac_budget_storage_unavailable'));
      const code = String(error?.code || '').toLowerCase();
      const nextAttemptAt = code === 'ac_points_budget_exceeded'
        ? budgetRetryAt(error?.budget)
        : new Date(Date.now() + 30_000).toISOString();
      const blockedReason = code === 'ac_points_budget_exceeded' ? 'ac_points_budget' : 'ac_configuration_wait';
      setStage(run, 'P4', 'prepared', {
        label: blockedReason === 'ac_points_budget'
          ? 'AC 估算积分额度已满，已释放视频槽位并等待下个结算日'
          : 'AC 预算存储暂不可用，已释放视频槽位并等待恢复',
        blockedReason,
        recoverable: true,
        nextAttemptAt,
        error: cleanError(error)
      });
      run.state = 'running';
      addEvent(run, 'video_budget_wait', 'AC budget reservation was not available before submission; the video-day slot was released and the prepared intent will retry later', { code: code || 'ac_budget_storage_unavailable', nextAttemptAt });
      await saveRun(redis, run);
      return;
    }
    video.status = 'submitting';
    video.submitAttemptedAt = now();
    setStage(run, 'P4', 'submitting', { label: `正在提交付费视频（本日 ${slot.used}/${slot.limit}）` });
    await saveRun(redis, run);
    try {
      const response = await providers.submitAc(video.payload, { budgetReservation: budgetReservationForVideo(video) });
      video.threadId = threadId(response);
      if (!video.threadId) {
        await settleAcBudgetForVideo(redis, video, { status: 'accepted_without_task_id' });
        throw new providers.ProviderError('AC accepted the request without a thread ID', { ambiguous: true });
      }
      await settleAcBudgetForVideo(redis, video, { status: 'submitted', externalId: video.threadId });
      if (video.slot && !video.slot.override) video.slot.settledAt = now();
      video.status = 'running';
      video.submittedAt = now();
      setStage(run, 'P4', 'running', { label: '视频已提交，正在生成', threadId: video.threadId, blockedReason: '', nextAttemptAt: '' });
      addEvent(run, 'video_submitted', 'One paid AC video submitted', { threadId: video.threadId });
      await saveRun(redis, run);
      return;
    } catch (error) {
      // `submitAttemptedAt` is persisted before the provider call so a
      // serverless interruption can never silently duplicate a paid request.
      // A handful of errors are nevertheless provably pre-submit (no AC
      // token/storage, local points cap, or a definitive 429).  Clear that
      // intent only for this allow-list, release the reserved daily slot, and
      // keep P4 prepared for a bounded retry.  All other transport/5xx errors
      // remain ambiguous and retain their slot and intent for reconciliation.
      if (!video.threadId && preSubmitVideoFailure(error)) {
        await releaseAcBudgetForVideo(redis, video, String(error?.code || 'pre_submit_failure'));
        const code = String(error?.code || '').toLowerCase();
        await releaseUnsubmittedVideoSlot(redis, video, code || 'provider_429');
        video.status = 'prepared';
        video.submitAttemptedAt = '';
        video.submittedAt = '';
        video.error = cleanError(error);
        const nextAttemptAt = code === 'ac_points_budget_exceeded'
          ? budgetRetryAt(error?.budget)
          : new Date(Date.now() + 30_000).toISOString();
        const blockedReason = code === 'ac_points_budget_exceeded'
          ? 'ac_points_budget'
          : code === 'ac_token_unavailable' || code === 'ac_budget_storage_unavailable'
            ? 'ac_configuration_wait'
            : 'ac_capacity_wait';
        setStage(run, 'P4', 'prepared', {
          label: blockedReason === 'ac_points_budget'
            ? 'AC 估算积分额度已满，已释放视频槽位并等待下个结算日'
            : blockedReason === 'ac_configuration_wait'
              ? 'AC 凭证或存储暂不可用，已释放视频槽位并等待恢复'
              : 'AC 当前拒绝请求，已释放视频槽位并等待重试',
          blockedReason,
          recoverable: true,
          nextAttemptAt,
          error: cleanError(error)
        });
        run.state = 'running';
        addEvent(run, 'video_pre_submit_wait', 'AC rejected the request before creating a paid task; the daily slot was released and the prepared intent will retry later', {
          code: code || 'provider_429', nextAttemptAt
        });
        await saveRun(redis, run);
        return;
      }
      // Definitive validation/authorization failures cannot create a task;
      // avoid leaking the daily capacity slot even though the run is reported
      // as failed for operator visibility. A 5xx/timeout is intentionally not
      // released because it may have reached AC.
      if (!video.threadId && definitiveSubmissionError(error)) {
        await releaseAcBudgetForVideo(redis, video, String(error?.code || 'definitive_rejection'));
        await releaseUnsubmittedVideoSlot(redis, video, String(error?.code || 'definitive_rejection'));
      }
      if (!definitiveSubmissionError(error)) {
        // Transport/5xx outcomes may have reached AC. Settle the local
        // reservation as submitted-or-unknown while preserving the durable
        // ambiguity and requiring reconciliation by remark.
        await settleAcBudgetForVideo(redis, video, { status: 'submitted_or_unknown', externalId: video.threadId });
        error.ambiguous = true;
      }
      throw error;
    }
  }
  if (stage.status === 'submitting') {
    let reconciled;
    try {
      reconciled = await providers.findAcTask(video.remark);
    } catch (error) {
      if (recoverablePollingError(error)) {
        const attempt = Number(stage.reconcileFailures || 0) + 1;
        const nextAttemptAt = new Date(Date.now() + Math.min(5 * 60 * 1000, 30000 * attempt)).toISOString();
        setStage(run, 'P4', 'submitting', { label: `视频提交结果暂不可核验，后台将自动重试对账（${attempt}）`, reconcileFailures: attempt, recoverable: true, nextAttemptAt, error: cleanError(error) });
        run.state = 'running';
        await saveRun(redis, run);
        return;
      }
      throw error;
    }
    if (!reconciled) {
      await settleAcBudgetForVideo(redis, video, { status: 'submitted_or_unknown' });
      throw new providers.ProviderError('Video submission outcome is ambiguous; automatic retry is disabled', { ambiguous: true });
    }
    const reconciledId = reconciledThreadId(reconciled);
    if (!reconciledId) {
      await settleAcBudgetForVideo(redis, video, { status: 'submitted_or_unknown' });
      throw new providers.ProviderError('AC returned a matching remark without a valid task ID; automatic retry is disabled', { ambiguous: true });
    }
    video.threadId = reconciledId;
    video.status = 'running';
    if (video.slot && !video.slot.override) video.slot.settledAt = now();
    await settleAcBudgetForVideo(redis, video, { status: 'reconciled', externalId: video.threadId });
    setStage(run, 'P4', 'running', { label: '已找回视频任务，正在生成', threadId: video.threadId, blockedReason: '', nextAttemptAt: '' });
    await saveRun(redis, run);
    return;
  }
  if (stage.status === 'running') {
    try {
      const result = await providers.acResult(video.threadId);
      Object.assign(video, result, { lastCheckedAt: now(), lastPollError: '' });
      mergeExecutionWarnings(video, result.executionControls);
      if (result.status === 'completed') {
          await settleAcBudgetForVideo(redis, video, { status: 'completed', externalId: video.threadId });
        try {
          video.mediaValidation = await providers.validateVideo(result.videoUrls[0]);
          initializeVisualQa(video);
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
    promptFingerprint: providers.sha(prompt.prompt),
    idempotencyKey: providers.sha(`${run.id}:${prompt.variant}:${prompt.prompt}`),
    provider: 'iiit', status: 'prepared', taskId: '', providerRequestId: '', url: ''
  }));
}

function exactSiblingPoster(asset, siblingRuns, sku) {
  const fingerprint = providers.sha(String(asset?.prompt || ''));
  if (!fingerprint || !asset?.variant) return null;
  for (const sibling of siblingRuns || []) {
    if (String(sibling?.input?.sku || '') !== String(sku || '')) continue;
    const match = (sibling.artifacts?.images || []).find((candidate) => candidate?.variant === asset.variant
      && candidate?.status === 'success'
      && String(candidate?.url || '').startsWith('https://')
      && providers.sha(String(candidate?.prompt || '')) === fingerprint
      && String(candidate?.mediaValidation?.contentType || '').toLowerCase().startsWith('image/'));
    if (match) return { sibling, match, fingerprint };
  }
  return null;
}

async function recoverAmbiguousPostersFromExactSibling(redis, run, suppliedSiblings = null) {
  if (run.stages?.P3_5?.status !== 'ambiguous') return false;
  // A uniqueness-required campaign promises a distinct creative package for
  // every slot. Even an exact-SKU, exact-prompt sibling would break that
  // contract and could hide scene drift between repeated-book variants.
  // Preserve the ambiguous paid intent for reconciliation instead of
  // silently replacing it with media produced for another run.
  if (run.input?.creativeProfile?.uniquenessRequired === true
    && String(run.input?.campaign?.id || '').trim()) return false;
  const incomplete = (run.artifacts?.images || []).filter((asset) => asset?.status !== 'success' && !asset?.taskId);
  if (!incomplete.length) return false;
  let siblings = suppliedSiblings;
  if (!Array.isArray(siblings)) {
    const summaries = await listRunSummaries(redis, 150);
    const sameSku = summaries.filter((item) => item.id !== run.id
      && String(item.input?.sku || '') === String(run.input?.sku || '')
      && (item.artifacts?.images || []).some((asset) => asset?.status === 'success' && asset?.url));
    siblings = (await Promise.all(sameSku.map((item) => getRun(redis, item.id)))).filter(Boolean);
  }
  const recoveries = incomplete.map((asset) => ({ asset, source: exactSiblingPoster(asset, siblings, run.input?.sku) }));
  // Recover atomically. A partial match must not silently turn the remaining
  // ambiguous intent back into a paid submission path.
  if (recoveries.some((item) => !item.source)) return false;
  for (const { asset, source } of recoveries) {
    asset.ambiguousSubmission = {
      status: asset.status,
      submitAttemptedAt: asset.submitAttemptedAt || '',
      providerRequestId: asset.providerRequestId || '',
      preservedAt: now()
    };
    asset.status = 'success';
    asset.provider = 'iiit_exact_sibling_reuse';
    asset.promptFingerprint = source.fingerprint;
    asset.url = source.match.url;
    asset.mediaValidation = source.match.mediaValidation;
    asset.reusedFromRunId = source.sibling.id;
    asset.reusedFromVariant = source.match.variant;
    asset.recoveredAt = now();
    asset.error = '';
  }
  setStage(run, 'P3_5', 'done', { label: '模糊海报已从同 SKU、同提示词指纹的已验证成品恢复', recoveredFromExactSibling: true, error: '' });
  addEvent(run, 'ambiguous_posters_recovered_from_exact_sibling', 'Ambiguous IIIT poster intents were resolved without a new provider request by reusing verified assets with the exact SKU, variant, and prompt fingerprint', {
    recovered: recoveries.map(({ asset }) => ({ variant: asset.variant, sourceRunId: asset.reusedFromRunId, promptFingerprint: asset.promptFingerprint }))
  });
  await saveRun(redis, run);
  return true;
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
  // Video-only deliveries can opt out of posters. Mark the optional branch
  // terminal without creating or submitting any image task. If a task ID is
  // already present, preserve it and continue normal reconciliation instead
  // of hiding a paid request.
  const videoOnlyDelivery = run.input?.posterGenerationRequired === false
    || run.input?.campaign?.autoSocialEchoDraft === true;
  if (videoOnlyDelivery) {
    const existingImages = Array.isArray(run.artifacts?.images) ? run.artifacts.images : [];
    const hasPaidImageTask = existingImages.some((asset) => asset?.taskId || ['submitting', 'running'].includes(String(asset?.status || '')));
    if (!hasPaidImageTask) {
      if (stage.status !== 'partial' || stage.nonBlocking !== true) {
        run.artifacts = run.artifacts || {};
        run.artifacts.images = existingImages.map((asset) => ({ ...asset, status: asset.status === 'prepared' ? 'skipped' : asset.status }));
        setStage(run, 'P3_5', 'partial', { label: '本次视频交付不需要海报；未提交图片任务', nonBlocking: true, recoverable: false, error: '' });
        addEvent(run, 'poster_generation_skipped', 'Poster generation was disabled for this video-only delivery; no image task was submitted');
        await saveRun(redis, run);
      }
      return;
    }
  }
  const imagePauseSetting = String(process.env.SOCIAL_IMAGE_GENERATION_PAUSED || '').trim().toLowerCase();
  // IIIT is the authorized poster route. Production fails closed until an operator
  // deliberately sets the pause flag to false.
  const explicitImageGlobalPause = imagePauseSetting ? !['0', 'false', 'off'].includes(imagePauseSetting) : false;
  const perRunMediaAuthorized = run.input?.paidMediaSubmissionAuthorized === true;
  const imageSubmissionsPaused = explicitImageGlobalPause || (!perRunMediaAuthorized && !imagePauseSetting && process.env.VERCEL_ENV === 'production');
  if (stage.status === 'waiting') {
    run.artifacts.images = preparedImages(run);
    setStage(run, 'P3_5', 'prepared', { label: '两张海报任务已就绪' });
    await saveRun(redis, run);
    return;
  }
  const prepared = run.artifacts.images.find((item) => item.status === 'prepared');
  if (prepared && imageSubmissionsPaused) {
    if (stage.blockedReason !== 'operator_image_pause') {
      setStage(run, 'P3_5', 'prepared', { label: '新海报提交已暂停；莓图任务意图已安全保存', blockedReason: 'operator_image_pause', recoverable: true, nextAttemptAt: '' });
      addEvent(run, 'image_submission_paused', 'IIIT poster request was prepared but not submitted because the operator paused new image generation');
      await saveRun(redis, run);
    }
    return;
  }
  if (prepared) {
    prepared.status = 'submitting';
    prepared.submitAttemptedAt = now();
    setStage(run, 'P3_5', 'running', { label: `正在提交 ${prepared.variant} 海报` });
    await saveRun(redis, run);
    try {
      const result = await providers.submitImage(prepared);
      const resultUrl = String(result.url || result.result?.url || '');
      prepared.taskId = String(result.id || result.task_id || '');
      prepared.providerRequestId = String(result.requestId || result.request_id || prepared.taskId || '');
      prepared.provider = String(result.provider || 'iiit');
      prepared.status = String(result.status || (resultUrl ? 'success' : 'queued'));
      prepared.url = resultUrl || prepared.url;
      prepared.submittedAt = now();
      if (prepared.status === 'success') {
        if (!prepared.url) throw new providers.ProviderError('IIIT returned success without a media URL', { ambiguous: true });
        try {
          prepared.mediaValidation = await providers.validateImage(prepared.url);
          prepared.url = prepared.mediaValidation.resolvedUrl || prepared.url;
          addEvent(run, 'image_submitted', `${prepared.variant} IIIT image completed`, { provider: prepared.provider, requestId: prepared.providerRequestId });
        } catch (error) {
          prepared.status = 'preview_failed';
          prepared.error = `Poster completed but cannot be previewed: ${cleanError(error)}`;
          addEvent(run, 'image_preview_failed', `${prepared.variant} returned a terminal task but its image URL could not be verified`, { provider: prepared.provider, error: prepared.error });
        }
      } else if (!prepared.taskId) {
        throw new providers.ProviderError('Image provider accepted the request without a media URL or recoverable task ID', { ambiguous: true });
      } else {
        addEvent(run, 'image_submitted', `${prepared.variant} IIIT image task submitted`, { taskId: prepared.taskId });
      }
      setStage(run, 'P3_5', 'running', { label: `${run.artifacts.images.filter((item) => item.status === 'success').length}/2 张海报已回传` });
      await saveRun(redis, run);
      return;
    } catch (error) { throw error; }
  }
  const ambiguous = run.artifacts.images.find((item) => item.status === 'submitting' && !item.taskId);
  if (ambiguous) throw new providers.ProviderError(`${ambiguous.variant} image submission is ambiguous; automatic retry is disabled`, { ambiguous: true });
  const pending = run.artifacts.images.filter((item) => item.taskId && ['iiit', ''].includes(String(item.provider || '')) && !['success', 'failed', 'expired'].includes(item.status));
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
  const effectiveVideo = effectiveVideoForRun(run).asset || run.artifacts?.video;
  const executionQa = effectiveVideo?.executionQa || {};
  if (run.input?.creativeProfile?.qualityMode === 'premium'
    && executionQa.status === 'rejected') {
    run.artifacts.review = {
      ...(run.artifacts.review || {}),
      status: 'video_fidelity_rejected',
      facebook: { status: 'paused', automaticPublishing: false },
      video: effectiveVideo
    };
    setStage(run, 'P6', 'blocked', {
      label: '成片保真验收已拒绝，已阻止进入 SocialEcho 草稿',
      blockedReason: 'video_fidelity_review',
      recoverable: false,
      error: Array.isArray(executionQa.defects) ? executionQa.defects.join(', ') : 'video fidelity rejected'
    });
    run.state = 'blocked';
    addEvent(run, 'video_fidelity_review_rejected', 'Premium visual QA rejected the finished AC video; draft delivery remains blocked');
    await saveRun(redis, run);
    return;
  }
  const pendingFidelityReview = run.input?.creativeProfile?.qualityMode === 'premium'
    && executionQa.status !== 'approved';
  const controlWarnings = Array.isArray(effectiveVideo?.controlWarnings) ? effectiveVideo.controlWarnings : [];
  // AC may normalize the subtitle wire value differently from the request.
  // Subtitles are deterministic post-production, so preserve the warning and
  // route it to the review package. A reference-count mismatch is different:
  // it can change character continuity and remains a hard packaging stop.
  const fatalControlWarnings = controlWarnings.filter((warning) => warning === 'server_reference_count_mismatch');
  const postProductionWarnings = controlWarnings.filter((warning) => warning === 'server_enable_subtitles_true');
  if (fatalControlWarnings.length) {
    run.artifacts.review = {
      status: 'blocked_by_execution_controls',
      facebook: { status: 'paused', automaticPublishing: false },
      video: effectiveVideo,
      mediaWarnings: fatalControlWarnings.map((warning) => ({ stage: 'P4', status: 'execution_control_mismatch', message: warning }))
    };
    setStage(run, 'P6', 'blocked', { label: 'AC 角色引用参数与导演合同不一致，已阻止进入发布草稿', blockedReason: 'execution_control_mismatch', recoverable: true, error: fatalControlWarnings.join(',') });
    run.state = 'blocked';
    addEvent(run, 'video_execution_control_blocked', 'AC execution controls did not match the approved video contract; publication packaging was blocked', { warnings: controlWarnings });
    await saveRun(redis, run);
    return;
  }
  if (postProductionWarnings.length) {
    run.artifacts.review = {
      ...(run.artifacts.review || {}),
      mediaWarnings: postProductionWarnings.map((warning) => ({ stage: 'P4', status: 'post_production_required', message: warning, action: 'Remove generated subtitles before operator review/publishing' }))
    };
    addEvent(run, 'video_execution_warning_routed_to_postproduction', 'Subtitle execution drift was retained as a deterministic post-production requirement; it does not block draft packaging', { warnings: postProductionWarnings });
  }
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
  const mediaWarnings = [];
  if (pendingFidelityReview) {
    mediaWarnings.push({
      stage: 'P4',
      status: 'pending_manual_review',
      message: '成片已通过媒体校验，仍待人工保真复核；该告警不阻塞草稿交付。',
      error: ''
    });
  }
  if (run.stages.P3_5.status !== 'done') {
    mediaWarnings.push({
      stage: 'P3_5', status: run.stages.P3_5.status,
      message: run.stages.P3_5.label || '海报未完整生成，视频与文案仍可审核',
      error: run.stages.P3_5.error || ''
    });
  }
  run.artifacts.review = {
    status: 'ready_for_manual_review', facebook: { status: 'paused', automaticPublishing: false },
    book: run.artifacts.book, code: run.artifacts.code, shortUrl: run.artifacts.shortUrl,
    posts: run.artifacts.posts, video: effectiveVideo, images: run.artifacts.images, distribution: run.artifacts.distribution,
    mediaWarnings,
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
  const publicationDraft = await ensureDraftForRun(redis, run);
  if (publicationDraft) {
    run.artifacts.review.publicationDraftId = publicationDraft.id;
    run.artifacts.review.publicationStatus = publicationDraft.status;
    addEvent(run, 'publication_draft_ready', 'P6 review assets were saved as an idempotent internal publication draft');
  } else {
    run.artifacts.review.publicationStatus = 'awaiting_finished_video';
    addEvent(run, 'publication_draft_deferred', 'The review package is complete but no finished video URL was available for a publication draft');
  }
  setStage(run, 'P6', 'done', { label: publicationDraft ? '审核包与内部草稿已就绪' : '审核包已完成，等待成片后生成草稿' });
  await saveRun(redis, run);
}

async function p7(redis, run) {
  setStage(run, 'P7', 'running', { label: '正在核验 SocialEcho 草稿交付状态', error: '' });
  await saveRun(redis, run);
  const publicationDraft = await ensureDraftForRun(redis, run);
  if (!publicationDraft) throw new providers.ProviderError('P7 requires finished copy and a verified video URL', { status: 409 });
  run.artifacts.review = run.artifacts.review || { status: 'ready_for_manual_review' };
  run.artifacts.review.publicationDraftId = publicationDraft.id;
  run.artifacts.review.publicationStatus = publicationDraft.status;
  let deliveredDraft;
  try {
    deliveredDraft = await saveAutomaticDraft(redis, publicationDraft);
  } catch (error) {
    const durableDraft = error?.draft || publicationDraft;
    run.artifacts.review.publicationStatus = durableDraft.status || (error?.ambiguous ? 'publish_ambiguous' : 'failed');
    run.artifacts.review.publicationError = cleanError(error);
    run.artifacts.review.socialEchoDraftId = durableDraft.provider?.externalDraftId || '';
    if (durableDraft.status !== 'external_draft') {
      addEvent(run, error?.ambiguous ? 'socialecho_draft_ambiguous' : 'socialecho_draft_failed', `P7 SocialEcho draft was not confirmed: ${cleanError(error)}`);
      await saveRun(redis, run);
      throw error;
    }
    deliveredDraft = durableDraft;
    addEvent(run, 'socialecho_draft_reconciled', 'P7 found the SocialEcho status 0 draft after an ambiguous response');
  }
  run.artifacts.review.publicationStatus = deliveredDraft.status;
  run.artifacts.review.publicationError = '';
  run.artifacts.review.socialEchoDraftId = deliveredDraft.provider?.externalDraftId || '';
  if (deliveredDraft.status === 'external_draft' && String(deliveredDraft.provider?.externalDraftId || '').trim()) {
    const scheduled = String(deliveredDraft.deliveryMode || '').toLowerCase() === 'scheduled' || Boolean(deliveredDraft.scheduledAt);
    setStage(run, 'P7', 'done', { label: scheduled ? 'SocialEcho status 1 定时任务已创建并保存外部 ID' : 'SocialEcho status 0 草稿已创建并保存外部 ID，等待人工审核' });
    addEvent(run, 'socialecho_draft_created', scheduled ? 'P7 created a SocialEcho status 1 scheduled task with a confirmed external ID; no immediate publication occurred' : 'P7 created a SocialEcho status 0 draft with a confirmed external ID; no direct publication occurred');
  } else {
    setStage(run, 'P7', 'waiting', { label: '内部草稿已持久化，尚未取得 SocialEcho 外部 ID', blockedReason: 'external_submission_required', recoverable: true });
    // Asset production is complete, but the internal pub_* record is not an
    // external SocialEcho task. Mark the run terminal for the worker so it
    // does not spin forever, while preserving P7 as visibly pending and
    // keeping the active-run guard in store.js until external submission is
    // resolved.
    run.state = 'completed';
    addEvent(run, 'publication_review_ready', 'P0-P6 production is complete; P7 has an internal review draft and still requires a SocialEcho external ID');
    await saveRun(redis, run);
    return;
  }
  run.state = 'completed';
  addEvent(run, 'run_completed', 'P0-P7 production completed and is waiting for operator publication review');
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
async function processRunOnce(redis, run, options = {}) {
  if (run.state === 'queued') {
    run.state = 'running';
    addEvent(run, 'worker_started', 'One-click production started');
    await saveRun(redis, run);
  }
  if (run.stages.P3_5?.status === 'ambiguous') await recoverAmbiguousPostersFromExactSibling(redis, run);
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
    && trackingReady(run)
    && !run.artifacts?.video
    && !(run.artifacts?.images || []).some((item) => item?.taskId);
  const structuredLegacyCreativeFailure = autoRecoverableCreativeFailure(run);
  if (structuredLegacyCreativeFailure) {
    const fallbackCreative = sourceGroundedCreativeFallback(run);
    if (fallbackCreative) {
      applySourceGroundedCreativeFallback(run, fallbackCreative, run.stages.P3.error);
      await saveRun(redis, run);
    }
  }
  // Evidence continuation now fails closed and stores a review candidate. Do
  // not immediately reopen that terminal state in the same worker tick.
  if (recoverableCreativeFailure || (structuredLegacyCreativeFailure && run.stages.P3?.status !== 'done' && !run.artifacts?.evidenceContinuationCandidate)) {
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
  if (run.state === 'blocked'
    && run.stages?.P6?.status === 'blocked'
    && run.stages.P6.blockedReason === 'execution_control_mismatch'
    && run.stages?.P4?.status === 'done') {
    run.state = 'running';
    run.stages.P6 = { ...run.stages.P6, status: 'waiting', blockedReason: '', error: '', recoverable: true, label: '字幕执行偏差已转为后期处理要求，审核包继续组装' };
    addEvent(run, 'execution_warning_reopened_for_postproduction', 'Reopened P6 after routing subtitle execution drift to deterministic post-production');
    await saveRun(redis, run);
  }
  if (['completed', 'failed', 'blocked'].includes(run.state)) return run;
  let activeStage = 'P1';
  try {
    if (run.stages.P1.status !== 'done') {
      const retryAt = Date.parse(run.stages.P1.nextAttemptAt || '');
      if (run.stages.P1.status === 'waiting' && Number.isFinite(retryAt) && retryAt > Date.now()) return run;
      activeStage = 'P1'; await p1(redis, run); return run;
    }
    if (run.stages.P2.status !== 'done') {
      const retryAt = Date.parse(run.stages.P2.nextAttemptAt || '');
      const evidenceReadBackoff = ['evidence_catalogue_wait', 'evidence_content_wait'].includes(String(run.stages.P2.phase || ''));
      // P2's story-analysis retries retain their source-of-truth retry time
      // under evidence.storyBrief. Let p2 inspect that durable record rather
      // than treating a stale stage timestamp as a permanent click barrier.
      // Read-only chapter retry phases, however, have no nested record and
      // must be skipped until their saved P2 window opens.
      if (evidenceReadBackoff && run.stages.P2.status === 'waiting' && Number.isFinite(retryAt) && retryAt > Date.now()) return run;
      activeStage = 'P2'; await p2(redis, run); return run;
    }
    if (run.stages.P5.status !== 'done') {
      const attributionRetryAt = Date.parse(run.stages.P5.nextAttemptAt || '');
      if (run.stages.P5.status === 'waiting' && Number.isFinite(attributionRetryAt) && attributionRetryAt > Date.now()) return run;
      activeStage = 'P5'; await p5(redis, run); return run;
    }
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
    const videoCapacityRetryAt = Date.parse(run.stages.P4.nextAttemptAt || '');
    if (run.stages.P4.status === 'prepared' && run.stages.P4.blockedReason === 'experimental_template') return run;
    const videoProviderCoolingDown = run.stages.P4.status === 'prepared'
      && run.stages.P4.blockedReason === 'ac_provider_unavailable'
      && Number.isFinite(videoCapacityRetryAt)
      && videoCapacityRetryAt > Date.now();
    if (videoProviderCoolingDown) return run;
    const videoWaitingForCapacity = options.manualVideoLimitOverride !== true && run.stages.P4.status === 'prepared'
      && videoCapacityBlocked(run.stages.P4.blockedReason)
      && Number.isFinite(videoCapacityRetryAt)
      && videoCapacityRetryAt > Date.now();
    if (videoWaitingForCapacity) {
      if (!posterTerminal(run.stages.P3_5.status)) { activeStage = 'P3_5'; await advancePosters(redis, run); return run; }
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
      activeStage = 'P4'; await p4(redis, run, options); return run;
    }
    // A paused video is already durably prepared. Let the independent poster
    // branch continue so a video pause cannot starve P3.5 forever.
    const videoOperatorPaused = run.stages.P4.status === 'prepared' && run.stages.P4.blockedReason === 'operator_video_pause';
    if (videoOperatorPaused && !posterTerminal(run.stages.P3_5.status)) { activeStage = 'P3_5'; await advancePosters(redis, run); return run; }
    if (!terminal(run.stages.P4.status) && !['running'].includes(run.stages.P4.status)) { activeStage = 'P4'; await p4(redis, run, options); return run; }
    if (!terminal(run.stages.P3_5.status) && (run.stages.P3_5.status !== 'running' || (run.artifacts.images || []).some((item) => ['prepared', 'submitting'].includes(item.status)))) { activeStage = 'P3_5'; await advancePosters(redis, run); return run; }
    if (run.stages.P4.status === 'running') { activeStage = 'P4'; await p4(redis, run, options); return run; }
    if (!posterTerminal(run.stages.P3_5.status)) { activeStage = 'P3_5'; await advancePosters(redis, run); return run; }
    if (run.stages.P4.status !== 'done') throw new providers.ProviderError('Video stage did not complete');
    if (run.stages.P6.status !== 'done') { activeStage = 'P6'; await p6(redis, run); return run; }
    if (run.stages.P7?.status !== 'done') { activeStage = 'P7'; await p7(redis, run); return run; }
    return run;
  } catch (error) {
    const message = cleanError(error);
    const ambiguous = Boolean(error?.ambiguous);
    if (activeStage === 'P5' && !ambiguous && recoverableAttributionError(error)) {
      scheduleAttributionRetry(run, error);
      await saveRun(redis, run);
      return run;
    }
    const recoverableVideoProviderOutage = activeStage === 'P4'
      && !ambiguous
      && !run.artifacts?.video?.threadId
      && !run.artifacts?.video?.submitAttemptedAt
      && (Number(error?.status || 0) >= 500
        || ['provider_invalid_json', 'provider_transport', 'provider_timeout'].includes(String(error?.code || '')));
    if (recoverableVideoProviderOutage) {
      const nextAttemptAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      setStage(run, 'P4', 'prepared', {
        label: '上游 AC 服务暂时不可用，已保留任务并自动续排',
        blockedReason: 'ac_provider_unavailable',
        recoverable: true,
        nextAttemptAt,
        error: message
      });
      run.state = 'running';
      addEvent(run, 'video_provider_wait', 'AC reconciliation was unavailable before any paid submission; the prepared task will retry without creating a duplicate', { nextAttemptAt, error: message });
      await saveRun(redis, run);
      return run;
    }
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
  const stageNames = ['P0', 'P1', 'P2', 'P3', 'P3_5', 'P4', 'P5', 'P6', 'P7'];
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
  const p2EvidenceBackoff = ['evidence_catalogue_wait', 'evidence_content_wait'].includes(String(run?.stages?.P2?.phase || ''));
  if (future(run?.stages?.P1) || (p2EvidenceBackoff && future(run?.stages?.P2)) || future(run?.stages?.P3) || future(run?.stages?.P5)) return true;
  const videoBackoff = future(run?.stages?.P4);
  const posterBackoff = future(run?.stages?.P3_5);
  // Media branches are independent.  A temporary AC poll backoff must not
  // stop a poster from being prepared/submitted, and vice versa.
  if (videoBackoff && posterBackoff) return true;
  if (videoBackoff && posterTerminal(run?.stages?.P3_5?.status)) return true;
  if (posterBackoff && terminal(run?.stages?.P4?.status)) return true;
  // If only the video poll/capacity branch is waiting, let a non-terminal
  // poster branch run in this invocation. Conversely, an image backoff must
  // not prevent an immediately pollable video from advancing.
  if (videoBackoff && !posterTerminal(run?.stages?.P3_5?.status)) return false;
  if (posterBackoff && !terminal(run?.stages?.P4?.status)) return false;
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

// A terminal state normally stops a batch before processRunOnce can inspect
// it.  Keep that rule for every paid, ambiguous, or operator-held outcome,
// but let the narrowly-defined evidence-only recovery paths reach their
// state-machine handler.  Those handlers either rebuild from already locked
// evidence or isolate a poster-only legacy failure; neither submits media.
function terminalRunCanAdvance(run) {
  if (!run || run.state === 'completed') return false;
  const p3 = run.stages?.P3 || {};
  const p35 = run.stages?.P3_5 || {};
  const p4 = run.stages?.P4 || {};
  const posterCanContinue = p3.status === 'done'
    && !['failed', 'ambiguous', 'blocked'].includes(String(p4.status || ''));
  if (run.state === 'failed') {
    return autoRecoverableStoryFailure(run)
      || autoRecoverableCreativeFailure(run)
      || (p35.status === 'failed' && posterCanContinue);
  }
  return run.state === 'blocked'
    && ((p35.status === 'ambiguous' && posterCanContinue)
      || (run.stages?.P6?.status === 'blocked' && run.stages.P6.blockedReason === 'execution_control_mismatch' && p4.status === 'done'));
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
    const terminal = ['completed', 'failed', 'blocked'].includes(String(run?.state || ''));
    if (!run || (terminal && !terminalRunCanAdvance(run))) {
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
    const updated = await processRunOnce(redis, run, options);
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

module.exports = { processRun, processRunOnce, processRunBatch, p1, p2, p3, p5, selectedChapters, normalizeCreative, assertPremiumCopyOpening, assertVisibleLanguage, sourceGroundedCreativeFallback, applySourceGroundedCreativeFallback, reserveCampaignCreativeUniqueness, recoverAmbiguousPostersFromExactSibling, recoverPreparedVideoFromExactSibling, videoContractFingerprint, chapterEvidenceQuote, summarizeAnalytics, refreshAnalytics, cleanError, videoPayload, referenceVideoPayload, normalizeAttributionStage };
