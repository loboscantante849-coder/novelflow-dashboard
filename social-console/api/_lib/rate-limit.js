const crypto = require('crypto');

const fallback = new Map();

function requestIdentity(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req?.socket?.remoteAddress || 'unknown');
}

function limitKey(scope, identity) {
  const digest = crypto.createHash('sha256').update(String(identity || 'unknown')).digest('hex').slice(0, 24);
  return `nf_social:rate:${String(scope || 'default').replace(/[^a-z0-9_-]/gi, '_')}:${digest}`;
}

async function consumeRateLimit(redis, scope, identity, limit, windowSeconds) {
  const key = limitKey(scope, identity);
  if (redis) {
    await redis.set(key, '0', { nx: true, ex: windowSeconds });
    const count = Number(await redis.incr(key));
    return { allowed: count <= limit, count, retryAfter: windowSeconds };
  }
  const now = Date.now();
  const current = fallback.get(key);
  const entry = !current || current.expiresAt <= now ? { count: 0, expiresAt: now + windowSeconds * 1000 } : current;
  entry.count += 1;
  fallback.set(key, entry);
  return { allowed: entry.count <= limit, count: entry.count, retryAfter: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)) };
}

module.exports = { consumeRateLimit, requestIdentity, limitKey };
