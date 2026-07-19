const { getRedis } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');

function shanghaiDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (!isCron && !requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const day = shanghaiDay();
  const key = `nf_social:leaderboard:${day}`;
  const refresh = isCron || req.query?.refresh === '1';
  try {
    if (!refresh) {
      const cached = await redis.get(key);
      if (cached) return res.status(200).json(typeof cached === 'string' ? JSON.parse(cached) : cached);
    }
    const books = await providers.topBooks(50);
    if (!books.length) throw new providers.ProviderError('Top-book source returned no usable books');
    const payload = { books, generatedAt: new Date().toISOString(), day, source: 'novelflow_uv_top50' };
    await redis.set(key, JSON.stringify(payload), { ex: 36 * 60 * 60 });
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[social/leaderboard]', error);
    return res.status(502).json({ error: 'Unable to load today\'s Top 50' });
  }
};
