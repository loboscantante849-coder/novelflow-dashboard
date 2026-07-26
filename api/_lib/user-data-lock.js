const crypto = require('crypto');

const USER_DATA_LOCK_SECONDS = 60;

function userDataLockKey(username) {
  // Keep the established namespace so Dashboard and Admin serialize writes.
  return `nf_withdrawal_lock:${String(username || '').toLowerCase()}`;
}

async function acquireUserDataLock(redis, username) {
  if (!redis || !username) return null;
  const key = userDataLockKey(username);
  const token = crypto.randomUUID();
  const result = await redis.set(key, token, { nx: true, ex: USER_DATA_LOCK_SECONDS });
  return result === 'OK' || result === true ? { key, token } : null;
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
  acquireUserDataLock,
  releaseUserDataLock,
  userDataLockKey,
};
