const { getRedis, getRun, listRuns } = require('./_lib/store');
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
    if (!(await redis.set(lock, '1', { nx: true, ex: 300 }))) return res.status(200).json({ worked: false, locked: true });
    try {
      const updated = await processRun(redis, run);
      return res.status(200).json({ worked: true, run: updated });
    } finally { await redis.del(lock); }
  } catch (error) {
    console.error('[social/worker]', error);
    return res.status(500).json({ error: 'Worker failed' });
  }
};
