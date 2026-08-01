const { getRedis } = require('./_lib/store');
const { acquireLease, releaseLease } = require('./_lib/lease');
const { refreshAnalytics } = require('./_lib/pipeline');
const { getRun, listRunSummaries, saveRun, addEvent } = require('./_lib/store');

const CRON_LIMIT = 8;

async function reconcile(redis, limit = CRON_LIMIT) {
  const summaries = await listRunSummaries(redis, Math.max(limit * 3, limit));
  const candidates = summaries.filter((item) => {
    if (item.state !== 'completed' || (!item.artifacts?.code && !item.artifacts?.linkId)) return false;
    const next = Date.parse(item.artifacts?.analytics?.nextRefreshAt || '');
    return !Number.isFinite(next) || next <= Date.now();
  }).slice(0, limit);
  let refreshed = 0;
  for (const candidate of candidates) {
    const lease = await acquireLease(redis, `nf_social:analytics_lock:${candidate.id}`, 120);
    if (!lease) continue;
    try {
      const run = await getRun(redis, candidate.id);
      if (!run || run.state !== 'completed' || (!run.artifacts?.code && !run.artifacts?.linkId)) continue;
      await refreshAnalytics(run, 90);
      addEvent(run, 'analytics_auto_refreshed', '后台自动跟进 Code 与 Link 归因数据；生产任务保持不变');
      await saveRun(redis, run, { preserveUpdatedAt: true });
      refreshed += 1;
  } catch (error) {
      const current = await getRun(redis, candidate.id).catch(() => null);
      if (current) {
        current.artifacts = current.artifacts || {};
        current.artifacts.analytics = { ...(current.artifacts.analytics || {}), lastAttemptAt: new Date().toISOString(), stale: true, error: String(error?.message || error).slice(0, 300), nextRefreshAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
        await saveRun(redis, current, { preserveUpdatedAt: true });
      }
    } finally {
      await releaseLease(redis, lease);
    }
  }
  return { candidates: candidates.length, refreshed };
}

module.exports = async (req, res) => {
  const cronSecret = String(process.env.CRON_SECRET || '');
  const cron = Boolean(cronSecret) && req.headers.authorization === `Bearer ${cronSecret}`;
  if (!cron) return res.status(401).json({ error: 'Analytics worker is cron-only' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const limit = Math.max(1, Math.min(Number(req.query?.limit || req.body?.limit) || CRON_LIMIT, 12));
    const result = await reconcile(redis, limit);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('[social/analytics-worker]', String(error?.message || error).slice(0, 300));
    return res.status(500).json({ error: 'Analytics refresh failed; the last verified snapshot was kept' });
  }
};

module.exports.reconcile = reconcile;
