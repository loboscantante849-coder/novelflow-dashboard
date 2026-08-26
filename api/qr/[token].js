/** Public QR landing endpoint. Deliberately exposes no owner, book, or target data. */
const { getRedis } = require('../_lib/security');
const { QR_TOKEN_PATTERN, qrTokenKey, parseStored, normalizePublicUrl } = require('../_lib/qr-promotion');

module.exports = async (req, res) => {
  const token = String(req.query?.token || '').trim();
  if (req.method !== 'GET' || !QR_TOKEN_PATTERN.test(token)) return res.status(404).end();
  const redis = getRedis();
  if (!redis) return res.status(503).send('Temporarily unavailable');
  try {
    const record = parseStored(await redis.get(qrTokenKey(token)));
    const destination = normalizePublicUrl(record?.destination);
    if (!record || !destination) return res.status(404).end();
    // Scan measurement is best effort. A counter failure must never prevent a reader reaching the book.
    redis.incr(`${qrTokenKey(token)}:scans`).catch(() => {});
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, destination);
  } catch (_error) {
    return res.status(503).send('Temporarily unavailable');
  }
};
