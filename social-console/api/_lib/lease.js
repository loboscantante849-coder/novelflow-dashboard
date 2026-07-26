const crypto = require('crypto');

function leaseValue(owner, acquiredAt = Date.now()) {
  return `v1|${Number(acquiredAt)}|${owner}`;
}

function leaseInfo(value) {
  const raw = String(value ?? '');
  const match = /^v1\|(\d+)\|([a-f0-9-]+)$/i.exec(raw);
  if (match) return { raw, acquiredAt: Number(match[1]), owner: match[2] };
  const legacyTimestamp = Number(raw);
  return { raw, acquiredAt: Number.isFinite(legacyTimestamp) ? legacyTimestamp : 0, owner: '' };
}

async function acquireLease(redis, key, ttlSeconds = 810) {
  const owner = crypto.randomUUID();
  const value = leaseValue(owner);
  const acquired = await redis.set(key, value, { nx: true, ex: ttlSeconds });
  return acquired ? { key, owner, value, acquiredAt: Date.now(), ttlSeconds } : null;
}

// Upstash supports atomic Lua compare-and-delete, while the optional storage
// bridge currently exposes only get/del. Prefer the atomic path and retain a
// compare-before-delete fallback for bridge compatibility.
async function releaseLease(redis, lease) {
  if (!lease) return false;
  if (typeof redis.eval === 'function') {
    try {
      const removed = await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        [lease.key],
        [lease.value]
      );
      return Number(removed) > 0;
    } catch {
      // Some Redis-compatible bridges expose eval with a different signature.
      // Fall through to the portable ownership check.
    }
  }
  const current = await redis.get(lease.key);
  if (String(current ?? '') !== lease.value) return false;
  return Number(await redis.del(lease.key)) > 0;
}

async function recoverStaleLease(redis, key, staleAfterMs) {
  const observed = await redis.get(key);
  if (observed == null) return false;
  const info = leaseInfo(observed);
  if (!info.acquiredAt || Date.now() - info.acquiredAt <= staleAfterMs) return false;
  // Re-read immediately before deletion so a lease that expired and was
  // replaced while this worker was inspecting it cannot be removed.
  const current = await redis.get(key);
  if (String(current ?? '') !== info.raw) return false;
  await redis.del(key);
  return true;
}

module.exports = { acquireLease, releaseLease, recoverStaleLease, leaseInfo };
