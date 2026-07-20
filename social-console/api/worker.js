const { getRedis, getRun, listRuns, saveRun, addEvent } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const { processRun } = require('./_lib/pipeline');

module.exports = async (req, res) => {
  const cron = Boolean(process.env.CRON_SECRET) && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron && !requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const requestedId = String(req.body?.id || req.query?.id || '');
    const run = requestedId ? await getRun(redis, requestedId) : (await listRuns(redis, 50)).find((item) => ['queued', 'running'].includes(item.state));
    if (!run) return res.status(200).json({ worked: false });
    const lock = `nf_social:lock:${run.id}`;
    let locked = await redis.set(lock, String(Date.now()), { nx: true, ex: 90 });
    if (!locked) {
      const active = Object.values(run.stages || {}).find((stage) => stage.status === 'running');
      const updatedAt = Date.parse(active?.updatedAt || '');
      // A terminated serverless invocation cannot run its finally block. Only
      // recover an old lock after its active stage has been unchanged for 75s.
      if (requestedId && Number.isFinite(updatedAt) && Date.now() - updatedAt > 75000) {
        await redis.del(lock);
        addEvent(run, 'stale_worker_lock_recovered', 'Recovered a stale worker lock after an interrupted request');
        await saveRun(redis, run);
        locked = await redis.set(lock, String(Date.now()), { nx: true, ex: 90 });
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
