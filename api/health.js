/** Public, deliberately low-detail liveness/readiness signal for the dashboard. */
const { getRedis } = require('./_lib/security');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  const redis = getRedis();
  let storage = 'degraded';
  if (redis) {
    try {
      await redis.get('nf_health_probe');
      storage = 'ok';
    } catch (_error) { /* no internal detail in public status */ }
  }
  const degraded = storage !== 'ok';
  return res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'operational',
    components: { application: 'ok', storage },
    checkedAt: new Date().toISOString(),
  });
};
