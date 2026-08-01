const { requireSession } = require('./_lib/auth');
const { putreportRows } = require('./_lib/providers');

function date(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSession(req, res)) return;
  const linkId = String(req.query?.linkId || req.query?.adId || '').trim();
  if (!/^[a-f0-9]{24,64}$/i.test(linkId)) return res.status(400).json({ error: 'A valid linkId or adId is required' });
  const days = Math.max(1, Math.min(Number(req.query?.days) || 2, 90));
  const from = date(req.query?.from);
  const to = date(req.query?.to);
  if ((req.query?.from && !from) || (req.query?.to && !to) || (from && to && from > to)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD and from cannot be after to' });
  try {
    const report = await putreportRows('', linkId, days, { from, to });
    const totals = report.rows.reduce((sum, row) => ({
      pullUv: sum.pullUv + row.pullUv, newUv: sum.newUv + row.newUv,
      d7Income: sum.d7Income + row.d7Income, d14Income: sum.d14Income + row.d14Income, visits: sum.visits + row.visits
    }), { pullUv: 0, newUv: 0, d7Income: 0, d14Income: 0, visits: 0 });
    return res.status(200).json({ linkId, ...report, totals });
  } catch (error) {
    const status = Number(error?.status || 502);
    const credential = status === 401 || /invalid_grant/i.test(String(error?.message || ''));
    return res.status(credential ? 503 : (status >= 400 && status < 600 ? status : 502)).json({
      error: credential ? 'Reporting credentials are expired or invalid' : 'Unable to query real-time reporting',
      code: credential ? 'REPORT_AUTH_INVALID' : 'REPORT_UNAVAILABLE'
    });
  }
};
