const { getRedis, getRun, listRuns, newRun, saveRun } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');

const text = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  try {
    if (req.method === 'GET') {
      const run = req.query?.id ? await getRun(redis, req.query.id) : null;
      if (req.query?.id) return run ? res.status(200).json({ run }) : res.status(404).json({ error: 'Run not found' });
      return res.status(200).json({ runs: await listRuns(redis) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const title = text(req.body?.title, 200);
    const sku = text(req.body?.sku, 100);
    if (!title || !sku) return res.status(400).json({ error: 'Exact title and Book SKU are required' });
    const input = {
      title, sku,
      promoter: text(req.body?.promoter, 80) || 'xujt',
      videoTemplate: text(req.body?.videoTemplate, 80) || 'adaptive_seedance',
      fullBookEvidence: req.body?.fullBookEvidence !== false,
      requestedAt: new Date().toISOString()
    };
    const run = await saveRun(redis, newRun(input));
    return res.status(202).json({ run });
  } catch (error) {
    console.error('[social/runs]', error);
    return res.status(500).json({ error: 'Unable to persist production run' });
  }
};
