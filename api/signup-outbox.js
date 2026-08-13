const { Redis } = require('@upstash/redis');
const { timingSafeEqual } = require('./_lib/security');
const { OUTBOX_PREFIX, deliverSignupEvent, staleDeliveringEvent } = require('./_lib/signup-outbox');

const MAX_BATCH = 25;

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function isAuthorized(req) {
  const configured = process.env.CRON_SECRET;
  const auth = String(req.headers && req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(configured && timingSafeEqual(auth, configured));
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const redis = redisClient();
  if (!redis) return res.status(503).json({ error: 'Storage unavailable' });

  try {
    const events = [];
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, { match: `${OUTBOX_PREFIX}*`, count: 100 });
      cursor = String(result && result[0] || '0');
      const keys = Array.isArray(result && result[1]) ? result[1] : [];
      if (keys.length) {
        const values = await redis.mget(...keys);
        for (const value of values) {
          const event = parseJson(value);
          if (event && (
            ['pending', 'retry_pending'].includes(event.status) || staleDeliveringEvent(event)
          )) events.push(event);
          if (events.length >= MAX_BATCH) break;
        }
      }
    } while (cursor !== '0' && events.length < MAX_BATCH);

    const results = [];
    for (const event of events.slice(0, MAX_BATCH)) {
      results.push(await deliverSignupEvent(redis, event));
    }
    return res.status(200).json({
      success: true,
      processed: results.length,
      delivered: results.filter(event => event && event.status === 'delivered').length,
      pending: results.filter(event => event && event.status !== 'delivered').length,
    });
  } catch (error) {
    console.error('[signup-outbox]', error && error.message);
    return res.status(503).json({ error: 'Signup notification service unavailable' });
  }
};
