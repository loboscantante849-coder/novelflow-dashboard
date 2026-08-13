const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { timingSafeEqual } = require('./_lib/security');
const { resolveNovelFlowMember, grantVipDays } = require('./_lib/novelflow-member');
const { EVENT_PREFIX, parseJson, updateVipEvent } = require('./_lib/vip-entitlements');

const MAX_BATCH = 20;

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  const provided = String(req.headers && req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && timingSafeEqual(provided, expected));
}

async function releaseLock(redis, key, token) {
  try {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [key], [token],
    );
  } catch (_error) {}
}

async function processEvent(redis, event) {
  if (!event || event.status !== 'pending') return event;
  const lockKey = `nf_vip_lock:v1:${event.user_id}`;
  const lockToken = crypto.randomUUID();
  const locked = await redis.set(lockKey, lockToken, { nx: true, ex: 45 });
  if (!locked) return event;
  try {
    const fresh = parseJson(await redis.get(`${EVENT_PREFIX}${event.event_id}`), event);
    if (!fresh || fresh.status !== 'pending') return fresh;
    const before = await resolveNovelFlowMember(fresh.user_id);
    const delivering = await updateVipEvent(redis, fresh, {
      status: 'delivering',
      attempts: Math.max(0, Number(fresh.attempts) || 0) + 1,
      member_end_before: before.member_end_time,
      delivery_started_at: new Date().toISOString(),
    });
    try {
      const result = await grantVipDays(delivering.user_id, delivering.days);
      const after = await resolveNovelFlowMember(delivering.user_id);
      return updateVipEvent(redis, delivering, {
        status: 'succeeded',
        succeeded_at: new Date().toISOString(),
        member_end_after: after.member_end_time,
        upstream_request_id: result.request_id,
      });
    } catch (error) {
      // The upstream mutation has no idempotency key. Any transport/server
      // failure may have applied the grant, so stop and reconcile manually.
      return updateVipEvent(redis, delivering, {
        status: 'reconciliation_required',
        reconciliation_reason: error && error.code || 'VIP_GRANT_OUTCOME_UNKNOWN',
      });
    }
  } finally {
    await releaseLock(redis, lockKey, lockToken);
  }
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
      const result = await redis.scan(cursor, { match: `${EVENT_PREFIX}*`, count: 100 });
      cursor = String(result && result[0] || '0');
      const keys = Array.isArray(result && result[1]) ? result[1] : [];
      if (keys.length) {
        const values = await redis.mget(...keys);
        for (const value of values) {
          const event = parseJson(value, null);
          if (event && event.status === 'pending') events.push(event);
          if (events.length >= MAX_BATCH) break;
        }
      }
    } while (cursor !== '0' && events.length < MAX_BATCH);
    const results = [];
    for (const event of events.slice(0, MAX_BATCH)) results.push(await processEvent(redis, event));
    return res.status(200).json({
      success: true,
      processed: results.length,
      succeeded: results.filter(event => event && event.status === 'succeeded').length,
      reconciliation_required: results.filter(event => event && event.status === 'reconciliation_required').length,
    });
  } catch (error) {
    console.error('[vip-fulfillment]', error && error.message);
    return res.status(503).json({ error: 'VIP fulfillment service unavailable' });
  }
};
