const { getRedis, listDiscordJobSummaries } = require('./_lib/store');
const { safeEqual } = require('./_lib/auth');

function authorized(req) {
  const configured = String(process.env.NOVELFLOW_DISCORD_OPERATOR_TOKEN || '');
  const supplied = String(req.headers['x-novelflow-operator-token'] || '');
  return configured.length >= 24 && safeEqual(configured, supplied);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Operator authentication required' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const requested = Number(req.query?.limit || 30);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 30;
  const state = ['queued', 'running', 'completed', 'failed', 'blocked'].includes(String(req.query?.state || '')) ? String(req.query.state) : '';
  try {
    return res.status(200).json({ jobs: await listDiscordJobSummaries(redis, limit, state) });
  } catch (error) {
    console.error('[social/discord-jobs]', String(error?.message || error));
    return res.status(500).json({ error: 'Unable to load Discord job summaries' });
  }
};
