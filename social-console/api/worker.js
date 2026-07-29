const { getRedis, getRun, listRunSummaries, saveRun, addEvent, getCreativePlan, listCreativePlanSummaries, listDiscordJobs, saveCreativePlan } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const { processRun, p3 } = require('./_lib/pipeline');
const { processCreativePlan } = require('./_lib/creative-plans');
const { processDiscordJob } = require('./_lib/discord');
const { acquireLease, releaseLease, recoverStaleLease } = require('./_lib/lease');
const providers = require('./_lib/providers');

const WORKER_LEASE_SECONDS = 810;
const STALE_LEASE_MS = 825000;
const STALE_CREATIVE_MS = 14 * 60 * 1000;

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
    run.state = 'failed';
    run.stages.P3 = { ...stage, status: 'failed', phase: 'waiting_for_operator', recoverable: false, nextAttemptAt: '', label: '唯一备用模型任务中断，请人工选择重试', error: '后台执行窗口结束，未收到可核实的模型结果', updatedAt: new Date().toISOString() };
    addEvent(run, 'stale_creative_waiting_for_operator', 'The one permitted reserve model ended without a verifiable result; automatic calls stopped');
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
  if (!cron && !requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const requestedId = String(req.body?.id || req.query?.id || '');
    const requestedPlanId = String(req.body?.planId || req.query?.planId || '');
    const requestedCreativeSection = String(req.body?.creativeSection || req.query?.creativeSection || '');
    const detailOnly = ['1', 'true'].includes(String(req.body?.detailOnly || req.query?.detailOnly || '').toLowerCase());
    const recoverCreative = ['1', 'true'].includes(String(req.body?.recoverCreative || req.query?.recoverCreative || '').toLowerCase());
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
      if (['queued', 'running'].includes(item.state)) return true;
      const creativeFailure = item.state === 'failed'
        && item.stages?.P3?.status === 'failed'
        && item.stages?.P3?.recoverable !== false
        && !['waiting_for_operator', 'validation_waiting_for_operator', 'configuration_error'].includes(String(item.stages?.P3?.phase || ''))
        && item.stages?.P1?.status === 'done'
        && item.stages?.P2?.status === 'done'
        && item.stages?.P5?.status === 'done'
        && !item.artifacts?.video
        && !(item.artifacts?.images || []).some((asset) => asset?.taskId);
      if (creativeFailure) return true;
      return ['failed', 'blocked'].includes(item.state)
        && item.stages?.P3?.status === 'done'
        && ['failed', 'ambiguous'].includes(item.stages?.P3_5?.status)
        && !['failed', 'ambiguous', 'blocked'].includes(item.stages?.P4?.status);
    };

    let run = null;
    if (requestedId) {
      run = await getRun(redis, requestedId);
      if (!run) return res.status(404).json({ error: 'Run not found' });
    } else {
      const candidates = (await listRunSummaries(redis, 50)).filter(runnable).slice(0, 4);
      for (const candidate of candidates) {
        const full = await getRun(redis, candidate.id);
        if (full && runnable(full)) { run = full; break; }
      }
    }
    if (!run) return res.status(200).json({ worked: false });

    if (requestedCreativeSection) {
      if (run.stages?.P3?.status === 'done') return res.status(200).json({ worked: false, completed: true, run: runResult(run) });
      const leaseState = await acquireRecoverableLease(redis, `nf_social:creative_section:${run.id}:${requestedCreativeSection}`);
      if (!leaseState) return res.status(200).json({ worked: false, locked: true, section: requestedCreativeSection });
      try {
        const updated = await p3(redis, run, null, false, requestedCreativeSection);
        return res.status(200).json({ worked: true, run: runResult(updated), section: requestedCreativeSection });
      } finally { await releaseLease(redis, leaseState.lease); }
    }

    const leaseState = await acquireRecoverableLease(redis, `nf_social:lock:${run.id}`);
    if (!leaseState) return res.status(200).json({ worked: false, locked: true });
    try {
      compactStoredEvidence(run);
      const interruptedCreative = recoverInterruptedCreative(run);
      if (leaseState.recovered) {
        addEvent(run, 'stale_worker_lock_recovered', 'Recovered an interrupted worker lease from the latest saved stage');
        await saveRun(redis, run);
      }
      if (interruptedCreative) await saveRun(redis, run);
      const updated = await processRun(redis, run);
      return res.status(200).json({ worked: true, run: runResult(updated) });
    } finally { await releaseLease(redis, leaseState.lease); }
  } catch (error) {
    console.error('[social/worker]', error);
    return res.status(500).json({ error: 'Worker failed' });
  }
};
