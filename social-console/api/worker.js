const { getRedis, listRuns, saveRun } = require('./_lib/store');

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const run = (await listRuns(redis, 50)).find((item) => item.state === 'queued');
    if (!run) return res.status(200).json({ worked: false });
    const lock = `nf_social:lock:${run.id}`;
    if (!(await redis.set(lock, '1', { nx: true, ex: 300 }))) return res.status(200).json({ worked: false, locked: true });
    try {
      run.state = 'running';
      run.stages.P1 = { status: 'running', startedAt: new Date().toISOString() };
      run.events.push({ at: new Date().toISOString(), type: 'worker_started', message: 'Worker claimed full production run' });
      await saveRun(redis, run);
      return res.status(202).json({ worked: true, runId: run.id });
    } finally { await redis.del(lock); }
  } catch (error) {
    console.error('[social/worker]', error);
    return res.status(500).json({ error: 'Worker failed' });
  }
};
