const { getRedis, getRun, listRunSummaries, saveRun, addEvent, getCreativePlan, listCreativePlanSummaries, listDiscordJobs, saveCreativePlan } = require('./_lib/store');
const { requireOperatorMutation } = require('./_lib/auth');
const { processRun, p3 } = require('./_lib/pipeline');
const { processCreativePlan } = require('./_lib/creative-plans');
const { processDiscordJob } = require('./_lib/discord');
const { acquireLease, releaseLease, recoverStaleLease } = require('./_lib/lease');
const providers = require('./_lib/providers');

const WORKER_LEASE_SECONDS = 810;
const STALE_LEASE_MS = 825000;
const STALE_CREATIVE_MS = 14 * 60 * 1000;
// A worker invocation may now advance several immediately-runnable stages,
// but keeps a hard budget so one slow provider cannot starve the cron queue.
// Paid media is intentionally handed back after one submit/poll; the next
// tick resumes from the persisted external task ID.
// A fresh run needs roughly 18 durable transitions (identity, five evidence
// batches, tracking, four creative sections, media preparation).  Keep the
// ceiling above that so a fast model can genuinely reach paid submission in
// one worker kick; the runtime budget still stops slow model calls safely.
const BATCH_MAX_STEPS = 24;
const BATCH_RUNTIME_MS = 240000;

function compactStoredEvidence(run) {
  const chapters = run.artifacts?.evidence?.chapters;
  if (Array.isArray(chapters)) chapters.forEach((chapter) => { chapter.content = String(chapter.content || '').slice(0, 16000); });
}

function recoverInterruptedCreative(run, force = false) {
  const stage = run.stages?.P3 || {};
  const startedAt = Date.parse(stage.startedAt || '');
  if (stage.status !== 'running' || !Number.isFinite(startedAt) || (!force && Date.now() - startedAt <= STALE_CREATIVE_MS)) return false;
  const draft = run.artifacts?.creativeDraft || { parts: {}, usage: [], failures: {} };
  draft.inFlight = {};
  const currentModel = String(run.input?.creativeProfile?.modelChoice || 'hy3');
  if (draft.modelRoute?.fallbackUsed) {
    const nextAttemptAt = new Date().toISOString();
    run.state = 'running';
    run.stages.P3 = { ...stage, status: 'waiting', phase: 'model_output_repairing', recoverable: true, nextAttemptAt, label: '后台模型任务中断，正在自动修复并继续', error: '上一次模型响应未完成，已从保存证据恢复', updatedAt: nextAttemptAt };
    draft.recoveryRevision = { instruction: 'The previous response was interrupted. Return only the required compact JSON object and preserve the supplied evidence.', recoveryReason: 'stale_worker' };
    addEvent(run, 'stale_creative_auto_repair_scheduled', 'The interrupted reserve-model creative task was reopened for an automatic repair pass from saved evidence');
  } else {
    const reserveModel = providers.reserveModelFor(currentModel);
    draft.modelRoute = { preferredModel: currentModel, fallbackModel: reserveModel, fallbackUsed: true, fallbackFrom: currentModel, reason: '首选模型后台执行窗口结束' };
    run.input.creativeProfile = { ...(run.input.creativeProfile || {}), modelChoice: reserveModel };
    run.stages.P3 = { ...stage, status: 'waiting', phase: 'fallback_scheduled', recoverable: true, nextAttemptAt: new Date().toISOString(), label: `${reserveModel} 将作为唯一备用模型从已保存证据接管`, error: '首选模型后台执行窗口结束，未收到可核实结果', fallbackFrom: currentModel, updatedAt: new Date().toISOString() };
    addEvent(run, 'stale_creative_fallback_scheduled', 'The primary model execution window ended; the one permitted reserve model will continue from saved evidence', { currentModel, reserveModel });
  }
  run.artifacts.creativeDraft = draft;
  return true;
}

function runResult(run) {
  return { id: run.id, state: run.state, updatedAt: run.updatedAt, stages: run.stages };
}

function planResult(plan) {
  return { id: plan.id, state: plan.state, updatedAt: plan.updatedAt, input: { modelChoice: plan.input?.modelChoice }, stages: plan.stages };
}

async function acquireRecoverableLease(redis, key, ttlSeconds = WORKER_LEASE_SECONDS, staleAfterMs = STALE_LEASE_MS) {
  let lease = await acquireLease(redis, key, ttlSeconds);
  if (lease) return { lease, recovered: false };
  const recovered = await recoverStaleLease(redis, key, staleAfterMs);
  if (!recovered) return null;
  lease = await acquireLease(redis, key, ttlSeconds);
  return lease ? { lease, recovered: true } : null;
}

module.exports = async (req, res) => {
  const cron = Boolean(process.env.CRON_SECRET) && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron && !requireOperatorMutation(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const requestedId = String(req.body?.id || req.query?.id || '');
    const requestedPlanId = String(req.body?.planId || req.query?.planId || '');
    const requestedCreativeSection = String(req.body?.creativeSection || req.query?.creativeSection || '');
    const detailOnly = ['1', 'true'].includes(String(req.body?.detailOnly || req.query?.detailOnly || '').toLowerCase());
    const recoverCreative = ['1', 'true'].includes(String(req.body?.recoverCreative || req.query?.recoverCreative || '').toLowerCase());
    const manualVideoLimitOverride = req.body?.manualVideoLimitOverride === true;
    if (requestedId && requestedPlanId) return res.status(400).json({ error: 'Specify either id or planId, not both' });
    if (requestedCreativeSection && !requestedId) return res.status(400).json({ error: 'A run id is required for creative section work' });
    if (requestedCreativeSection && !['posts', 'videoPrompt', 'posterPrompts', 'qualityReview'].includes(requestedCreativeSection)) return res.status(400).json({ error: 'Unsupported creative section' });
    if (detailOnly) {
      if (!requestedId) return res.status(400).json({ error: 'A run id is required for detail hydration' });
      const run = await getRun(redis, requestedId);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      compactStoredEvidence(run);
      addEvent(run, 'detail_snapshot_rebuilt', 'A compact operator detail snapshot was rebuilt without invoking any provider');
      await saveRun(redis, run);
      return res.status(200).json({ worked: true, detailReady: true, run: runResult(run) });
    }
    if (recoverCreative) {
      if (!requestedId) return res.status(400).json({ error: 'A run id is required for creative recovery' });
      const run = await getRun(redis, requestedId);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      compactStoredEvidence(run);
      const recovered = recoverInterruptedCreative(run, true);
      if (recovered) await saveRun(redis, run);
      return res.status(200).json({ worked: recovered, recoveryScheduled: recovered && run.stages?.P3?.status === 'waiting', run: runResult(run) });
    }

    // A direct browser action must always advance the task the operator chose.
    // Queue-only work is considered only for untargeted cron/worker calls.
    if (!requestedId && !requestedPlanId) {
      const discordJob = (await listDiscordJobs(redis, 5)).find((item) => item.state === 'queued');
      if (discordJob) {
        const leaseState = await acquireRecoverableLease(redis, `nf_social:discord:lock:${discordJob.id}`, 660, 675000);
        if (!leaseState) return res.status(200).json({ worked: false, locked: true, discordJob: { id: discordJob.id } });
        try {
          const updated = await processDiscordJob(redis, discordJob);
          return res.status(200).json({ worked: true, discordJob: { id: updated.id, state: updated.state, phase: updated.phase } });
        } finally { await releaseLease(redis, leaseState.lease); }
      }
    }

    const runnablePlan = (item) => {
      if (item.state === 'queued') return true;
      if (item.state === 'completed') {
        if (item.input?.autoStartProduction !== true || item.input?.productionRunId) return false;
        const nextAttemptAt = Date.parse(item.input?.autoStartNextAttemptAt || '');
        return !Number.isFinite(nextAttemptAt) || nextAttemptAt <= Date.now();
      }
      if (item.state !== 'running') return false;
      if (['waiting', 'running'].includes(item.stages?.identity?.status)) return true;
      if (['waiting', 'running'].includes(item.stages?.evidence?.status)) return true;
      const retryAt = Date.parse(item.stages?.analysis?.nextAttemptAt || '');
      return ['waiting', 'running'].includes(item.stages?.analysis?.status) && (!Number.isFinite(retryAt) || retryAt <= Date.now());
    };
    const planSummary = !requestedPlanId && !requestedId ? (await listCreativePlanSummaries(redis, 12)).find(runnablePlan) : null;
    const plan = requestedPlanId ? await getCreativePlan(redis, requestedPlanId) : planSummary ? await getCreativePlan(redis, planSummary.id) : null;
    if (requestedPlanId && !plan) return res.status(404).json({ error: 'Creative plan not found' });
    if (plan) {
      const leaseState = await acquireRecoverableLease(redis, `nf_social:plan_lock:${plan.id}`);
      if (!leaseState) return res.status(200).json({ worked: false, locked: true, plan: { id: plan.id } });
      try {
        if (leaseState.recovered) {
          plan.events = [...(plan.events || []), { at: new Date().toISOString(), type: 'stale_plan_lock_recovered', message: 'Recovered an interrupted planning worker lease' }].slice(-80);
          if (plan.stages?.analysis?.status === 'running') {
            plan.stages.analysis = { ...plan.stages.analysis, status: 'waiting', nextAttemptAt: '', error: '上一轮模型请求中断，已从保存的证据恢复', updatedAt: new Date().toISOString() };
          }
          await saveCreativePlan(redis, plan);
        }
        let updated = plan;
        let steps = 0;
        const needsAutoStart = (item) => item.state === 'completed' && item.input?.autoStartProduction === true && !item.input?.productionRunId;
        while (steps < 6 && (['queued', 'running'].includes(updated.state) || needsAutoStart(updated))) {
          updated = await processCreativePlan(redis, updated);
          steps += 1;
          const analysis = updated.stages?.analysis || {};
          if (analysis.status === 'done' || analysis.status === 'failed') break;
          if (analysis.status === 'waiting' && analysis.nextAttemptAt) break;
        }
        return res.status(200).json({ worked: true, job: planResult(updated), steps });
      } finally { await releaseLease(redis, leaseState.lease); }
    }

    const runnable = (item) => {
      if (item.state === 'queued') return true;
      if (item.state === 'running') {
        // A saved P2/P3 retry timestamp is an intentional provider backoff.
        // Do not let an early cron invocation keep selecting this run while
        // newer eligible work waits behind it.
        const modelRetryAt = [item.stages?.P1, item.stages?.P2, item.stages?.P3]
          .map((stage) => Date.parse(stage?.nextAttemptAt || ''))
          .find((value) => Number.isFinite(value) && value > Date.now());
        if (modelRetryAt) return false;
        const now = Date.now();
        const retryAt = Date.parse(item.stages?.P4?.nextAttemptAt || '');
        const posterRetryAt = Date.parse(item.stages?.P3_5?.nextAttemptAt || '');
        const waitingForVideoCapacity = item.stages?.P4?.status === 'prepared'
          && ['daily_video_limit', 'hourly_video_limit', 'ac_points_budget', 'ac_configuration_wait', 'ac_capacity_wait'].includes(String(item.stages?.P4?.blockedReason || ''))
          && Number.isFinite(retryAt)
          && retryAt > now;
        const waitingForVideoProvider = item.stages?.P4?.status === 'prepared'
          && ['ac_provider_unavailable', 'ac_points_budget', 'ac_configuration_wait', 'ac_capacity_wait'].includes(String(item.stages?.P4?.blockedReason || ''))
          && Number.isFinite(retryAt)
          && retryAt > now;
        const posterWaiting = ['waiting', 'running', 'prepared'].includes(String(item.stages?.P3_5?.status || ''))
          && Number.isFinite(posterRetryAt) && posterRetryAt > now;
        const posterFinished = ['done', 'partial', 'ambiguous'].includes(String(item.stages?.P3_5?.status || ''));
        if (waitingForVideoCapacity && posterFinished) return false;
        // A provider cooldown is global to the AC branch.  Selecting the same
        // run early would make the minutely cron starve every newer eligible
        // run without doing useful work.
        // An independent poster branch may still make progress while video is
        // cooling down; retain the run only when that branch is runnable now.
        const posterRunnable = !posterFinished && !posterWaiting;
        if (waitingForVideoProvider && !posterRunnable) return false;
        // Likewise, do not repeatedly select an in-flight video whose poll
        // backoff has not elapsed. This was the main source of queue
        // starvation: every cron tick returned `backoff` for the same oldest
        // run and never reached queued work behind it.
        const videoPollWaiting = item.stages?.P4?.status === 'running'
          && Number.isFinite(retryAt) && retryAt > now;
        if (videoPollWaiting && !posterRunnable) return false;
        if (posterWaiting && (item.stages?.P4?.status === 'done'
          || ['failed', 'ambiguous', 'blocked'].includes(String(item.stages?.P4?.status || '')))) return false;
        const optimizationDueAt = Date.parse(item.artifacts?.optimization?.dueAt || '');
        if (item.artifacts?.optimization?.status === 'awaiting_confirmation'
          && Number.isFinite(optimizationDueAt) && optimizationDueAt > now) return false;
        if (item.stages?.P4?.status === 'prepared'
          && ['operator_video_pause', 'experimental_template'].includes(String(item.stages?.P4?.blockedReason || ''))
          && posterFinished) return false;
        return true;
      }
      const creativeFailure = item.state === 'failed'
        && item.stages?.P3?.status === 'failed'
        && item.stages?.P3?.recoverable !== false
        && !['waiting_for_operator', 'validation_waiting_for_operator', 'configuration_error'].includes(String(item.stages?.P3?.phase || ''))
        && item.stages?.P1?.status === 'done'
        && item.stages?.P2?.status === 'done'
        && item.stages?.P5?.status === 'done'
        && !item.artifacts?.video
        && !(item.artifacts?.images || []).some((asset) => asset?.taskId);
      const structuredCreativeFailure = item.state === 'failed'
        && ['waiting_for_operator', 'validation_waiting_for_operator', 'model_output_repairing'].includes(String(item.stages?.P3?.phase || ''))
        && /invalid structured output|invalid json|incomplete creative|missing required/i.test(String(item.stages?.P3?.error || ''))
        && item.stages?.P1?.status === 'done'
        && item.stages?.P2?.status === 'done'
        && item.stages?.P5?.status === 'done';
      const structuredStoryFailure = item.state === 'failed'
        && ['story_intelligence_waiting_for_operator', 'story_intelligence_repairing'].includes(String(item.stages?.P2?.phase || ''))
        && /invalid structured output|invalid json|incomplete story|incomplete creative strategy|missing required/i.test(String(item.stages?.P2?.error || ''))
        && item.stages?.P1?.status === 'done';
      if (creativeFailure || structuredCreativeFailure || structuredStoryFailure) return true;
      return ['failed', 'blocked'].includes(item.state)
        && item.stages?.P3?.status === 'done'
        && ['failed', 'ambiguous'].includes(item.stages?.P3_5?.status)
        && !['failed', 'ambiguous', 'blocked'].includes(item.stages?.P4?.status);
    };

    const schedulerPriority = (item) => {
      if (['running', 'submitted'].includes(String(item.stages?.P4?.status || ''))) return 0;
      if (item.state === 'running') return 1;
      if (item.state === 'queued') return 2;
      return 3;
    };

    let run = null;
    let selectedLease = null;
    if (requestedId) {
      run = await getRun(redis, requestedId);
      if (!run) return res.status(404).json({ error: 'Run not found' });
    } else {
      // Scan a wider bounded window so a cluster of recent backoff/held runs
      // cannot hide older queued work indefinitely.
      const candidates = (await listRunSummaries(redis, 200))
        .filter(runnable)
        .sort((left, right) => schedulerPriority(left) - schedulerPriority(right)
          || Date.parse(left.updatedAt || left.createdAt || '') - Date.parse(right.updatedAt || right.createdAt || ''));
      let lockedCandidates = 0;
      for (const candidate of candidates) {
        const full = await getRun(redis, candidate.id);
        if (!full || !runnable(full)) continue;
        const idleCreativeRetry = full.state === 'running'
          && full.stages?.P3?.status === 'waiting'
          && full.stages?.P3?.phase === 'manual_retry'
          && !Object.values(full.artifacts?.creativeDraft?.inFlight || {}).some(Boolean);
        const lease = await acquireRecoverableLease(redis, `nf_social:lock:${full.id}`, 810, idleCreativeRetry ? 45000 : STALE_LEASE_MS);
        if (!lease) {
          lockedCandidates += 1;
          // Four owned worker leases are the campaign-wide model ceiling. A
          // cron tick must not bypass them merely because a queued run exists.
          if (lockedCandidates >= 4) break;
          continue;
        }
        run = full;
        selectedLease = lease;
        break;
      }
    }
    if (!run) return res.status(200).json({ worked: false });

    if (requestedCreativeSection) {
      if (run.stages?.P3?.status === 'done') return res.status(200).json({ worked: false, completed: true, run: runResult(run) });
      // Section calls from an older dashboard must share the task-wide lease.
      // This prevents a late old-model response from racing a generic worker
      // that already switched the route or moved into paid media.
      const leaseState = await acquireRecoverableLease(redis, `nf_social:lock:${run.id}`);
      if (!leaseState) return res.status(200).json({ worked: false, locked: true, section: requestedCreativeSection });
      try {
        const updated = await p3(redis, run, null, false, requestedCreativeSection);
        return res.status(200).json({ worked: true, run: runResult(updated), section: requestedCreativeSection });
      } finally { await releaseLease(redis, leaseState.lease); }
    }

    // A manual P3 retry is durably marked waiting before any provider call.
    // If a request dies in that gap, the normal 825-second lease would leave
    // the task invisible for too long. Once the stage is still waiting after
    // 45 seconds, no live model call can own it because p3 marks it running
    // before invoking the provider.
    const idleCreativeRetry = run.state === 'running'
      && run.stages?.P3?.status === 'waiting'
      && run.stages?.P3?.phase === 'manual_retry'
      && !Object.values(run.artifacts?.creativeDraft?.inFlight || {}).some(Boolean);
    const leaseState = selectedLease || await acquireRecoverableLease(redis, `nf_social:lock:${run.id}`, 810, idleCreativeRetry ? 45000 : STALE_LEASE_MS);
    if (!leaseState) return res.status(200).json({ worked: false, locked: true });
    try {
      compactStoredEvidence(run);
      const interruptedCreative = recoverInterruptedCreative(run);
      if (leaseState.recovered) {
        addEvent(run, 'stale_worker_lock_recovered', 'Recovered an interrupted worker lease from the latest saved stage');
        await saveRun(redis, run);
      }
      if (interruptedCreative) await saveRun(redis, run);
      const batch = await processRun(redis, run, {
        batch: true,
        maxSteps: BATCH_MAX_STEPS,
        maxRuntimeMs: BATCH_RUNTIME_MS,
        stopAfterMedia: true,
        manualVideoLimitOverride
      });
      const updated = batch?.run || run;
      return res.status(200).json({
        worked: Boolean(batch?.progressed ?? true),
        run: runResult(updated),
        batch: {
          steps: Number(batch?.steps || 0),
          progressed: Boolean(batch?.progressed),
          elapsedMs: Number(batch?.elapsedMs || 0),
          stopReason: String(batch?.stopReason || ''),
          stages: Array.isArray(batch?.stages) ? batch.stages : []
        }
      });
    } finally { await releaseLease(redis, leaseState.lease); }
  } catch (error) {
    console.error('[social/worker]', error);
    return res.status(500).json({ error: 'Worker failed' });
  }
};
