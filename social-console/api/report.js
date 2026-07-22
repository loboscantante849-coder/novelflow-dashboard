const { getRedis, listRunSummaries, videoCapacity } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const { buildWeeklyReport } = require('./_lib/report');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const requestedDays = Number(req.query?.days || 7);
  const days = [7, 30].includes(requestedDays) ? requestedDays : 7;
  try {
    const [runs, videoLimit] = await Promise.all([listRunSummaries(redis, 50), videoCapacity(redis)]);
    return res.status(200).json(buildWeeklyReport(runs, videoLimit, days));
  } catch (error) {
    console.error('[social/report]', error);
    return res.status(500).json({ error: 'Unable to build the weekly report' });
  }
};
