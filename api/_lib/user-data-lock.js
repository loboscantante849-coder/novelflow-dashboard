const crypto = require('crypto');

const USER_DATA_LOCK_SECONDS = 20;
const USER_DATA_LOCK_PREFIX = 'nf_user_data_lock:v2:';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function userDataLockKey(username) {
  // The old withdrawal namespace can contain pre-expiry legacy locks. Keep all
  // current user-data writers on a fresh, shared namespace instead.
  return `${USER_DATA_LOCK_PREFIX}${String(username || '').toLowerCase()}`;
}

async function acquireUserDataLock(redis, username, { waitMs = 0, retryDelayMs = 100 } = {}) {
  if (!redis || !username) return null;
  const key = userDataLockKey(username);
  const token = crypto.randomUUID();
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  const delayMs = Math.max(25, Math.min(500, Number(retryDelayMs) || 100));

  do {
    const result = await redis.set(key, token, { nx: true, ex: USER_DATA_LOCK_SECONDS });
    if (result === 'OK' || result === true) return { key, token };
    if (Date.now() >= deadline) return null;
    await wait(Math.min(delayMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);

  return null;
}

async function releaseUserDataLock(redis, lock) {
  if (!redis || !lock) return;
  try {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [lock.key],
      [lock.token],
    );
  } catch (_) {
    // The TTL is the final fallback if the owner cannot release the lock.
  }
}

module.exports = {
  USER_DATA_LOCK_SECONDS,
  USER_DATA_LOCK_PREFIX,
  acquireUserDataLock,
  releaseUserDataLock,
  userDataLockKey,
};
