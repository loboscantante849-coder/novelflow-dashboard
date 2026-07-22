const { getRedis, getRun, listRuns, saveRun, addEvent, getCreativePlan, listCreativePlans, listDiscordJobs } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const { processRun, p3 } = require('./_lib/pipeline');
const { processCreativePlan } = require('./_lib/creative-plans');
const { processDiscordJob } = require('./_lib/discord');

module.exports = async (req, res) => {
  const cron = Boolean(process.env.CRON_SECRET) && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron && !requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const discordJob = (await listDiscordJobs(redis, 5)).find((item) => item.state === 'queued');
    if (discordJob) {
      const lock = `nf_social:discord:lock:${discordJob.id}`;
      const locked = await redis.set(lock, String(Date.now()), { nx: true, ex: 600 });
      if (!locked) return res.status(200).json({ worked: false, locked: true, discordJob: { id: discordJob.id } });
      try {
        const updated = await processDiscordJob(redis, discordJob);
        return res.status(200).json({ worked: true, discordJob: { id: updated.id, state: updated.state, phase: updated.phase } });
      } finally { await redis.del(lock); }
    }
    const requestedId = String(req.body?.id || req.query?.id || '');
    const requestedPlanId = String(req.body?.planId || req.query?.planId || '');
    const requestedCreativeSection = String(req.body?.creativeSection || req.query?.creativeSection || '');
    const runnablePlan = (item) => {
      if (item.state === 'queued') return true;
      if (item.state !== 'running') return false;
      if (['waiting', 'running'].includes(item.stages?.identity?.status)) return true;
      if (['waiting', 'running'].includes(item.stages?.evidence?.status)) return true;
      const retryAt = Date.parse(item.stages?.analysis?.nextAttemptAt || '');
      return ['waiting', 'running'].includes(item.stages?.analysis?.status) && (!Number.isFinite(retryAt) || retryAt <= Date.now());
    };
    const plan = requestedPlanId ? await getCreativePlan(redis, requestedPlanId) : (!requestedId ? (await listCreativePlans(redis, 12)).find(runnablePlan) : null);
    if (plan) {
      const lock = `nf_social:plan_lock:${plan.id}`;
      const locked = await redis.set(lock, String(Date.now()), { nx: true, ex: 720 });
      if (!locked) return res.status(200).json({ worked: false, locked: true, plan: { id: plan.id } });
      try {
        const updated = await processCreativePlan(redis, plan);
        return res.status(200).json({ worked: true, job: updated });
      } finally { await redis.del(lock); }
    }
    const runnable = (item) => {
      if (['queued', 'running'].includes(item.state)) return true;
      const creativeFailure = item.state === 'failed'
        && item.stages?.P3?.status === 'failed'
        && item.artifacts?.book
        && item.artifacts?.evidence?.chapters?.length
        && item.artifacts?.code
        && item.artifacts?.shortUrl
        && !item.artifacts?.video
        && !(item.artifacts?.images || []).some((asset) => asset?.taskId);
      if (creativeFailure) return true;
      const posterOnlyFailure = ['failed', 'blocked'].includes(item.state)
        && item.stages?.P3?.status === 'done'
        && ['failed', 'ambiguous'].includes(item.stages?.P3_5?.status)
        && !['failed', 'ambiguous', 'blocked'].includes(item.stages?.P4?.status);
      return posterOnlyFailure;
    };
    const run = requestedId ? await getRun(redis, requestedId) : (await listRuns(redis, 50)).find(runnable);
    if (!run) return res.status(200).json({ worked: false });
    if (requestedCreativeSection) {
      if (!['posts', 'videoPrompt', 'posterPrompts', 'qualityReview'].includes(requestedCreativeSection)) return res.status(400).json({ error: 'Unsupported creative section' });
      if (run.stages?.P3?.status === 'done') return res.status(200).json({ worked: false, completed: true, run });
      const sectionLock = `nf_social:creative_section:${run.id}:${requestedCreativeSection}`;
      const locked = await redis.set(sectionLock, String(Date.now()), { nx: true, ex: 720 });
      if (!locked) return res.status(200).json({ worked: false, locked: true, section: requestedCreativeSection });
      try {
        const updated = await p3(redis, run, null, false, requestedCreativeSection);
        return res.status(200).json({ worked: true, run: updated, section: requestedCreativeSection });
      } finally { await redis.del(sectionLock); }
    }
    const lock = `nf_social:lock:${run.id}`;
    let locked = await redis.set(lock, String(Date.now()), { nx: true, ex: 720 });
    if (!locked) {
      const active = Object.values(run.stages || {}).find((stage) => stage.status === 'running');
      const updatedAt = Date.parse(active?.updatedAt || '');
      // A terminated serverless invocation cannot run its finally block. Only
      // recover an old lock only after the maximum long-model window elapsed.
      if (requestedId && Number.isFinite(updatedAt) && Date.now() - updatedAt > 660000) {
        await redis.del(lock);
        addEvent(run, 'stale_worker_lock_recovered', 'Recovered a stale worker lock after an interrupted request');
        await saveRun(redis, run);
        locked = await redis.set(lock, String(Date.now()), { nx: true, ex: 720 });
      }
      if (!locked) return res.status(200).json({ worked: false, locked: true });
    }
    try {
      const updated = await processRun(redis, run);
      return res.status(200).json({ worked: true, run: updated });
    } finally { await redis.del(lock); }
  } catch (error) {
    console.error('[social/worker]', error);
    return res.status(500).json({ error: 'Worker failed' });
  }
};
