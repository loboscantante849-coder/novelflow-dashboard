const { requireSession } = require('./_lib/auth');
const { quickStats } = require('./_lib/quick-stats');

function date(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSession(req, res)) return;
  const query = String(req.query?.q || req.query?.id || req.query?.url || '').trim();
  const days = Math.max(1, Math.min(Number(req.query?.days) || 2, 180));
  const from = date(req.query?.from);
  const to = date(req.query?.to);
  if ((req.query?.from && !from) || (req.query?.to && !to) || (from && to && from > to)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD and from cannot be after to' });
  try {
    const result = await quickStats(query, days, { from, to });
    return res.status(200).json(result);
  } catch (error) {
    const status = Number(error?.status || 502);
    return res.status(status >= 400 && status < 600 ? status : 502).json({ error: String(error?.message || 'Quick statistics query failed').slice(0, 240) });
  }
};
