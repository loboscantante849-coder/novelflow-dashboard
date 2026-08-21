const crypto = require('crypto');

const USER_DATA_LOCK_SECONDS = 20;
const USER_DATA_LOCK_PREFIX = 'nf_user_data_lock:v2:';
const USER_DATA_LOCKED_COMMIT_SCRIPT = `
-- NF_USER_DATA_LOCKED_COMMIT_V1
for index = 2, #KEYS do
  if redis.call('get', KEYS[index]) ~= ARGV[index] then
    return 0
  end
end
redis.call('set', KEYS[1], ARGV[1])
return 1
`;

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

async function commitUserDataUnderLock(redis, userDataKey, userData, lockOrLocks) {
  const locks = (Array.isArray(lockOrLocks) ? lockOrLocks : [lockOrLocks]).filter(Boolean);
  if (!redis || !userDataKey || !locks.length || locks.some(lock => !lock.key || !lock.token)) {
    const error = new Error('Invalid locked user-data commit');
    error.code = 'INVALID_USER_DATA_COMMIT';
    throw error;
  }
  const result = Number(await redis.eval(
    USER_DATA_LOCKED_COMMIT_SCRIPT,
    [userDataKey, ...locks.map(lock => lock.key)],
    [JSON.stringify(userData), ...locks.map(lock => lock.token)],
  ));
  if (result === 1) return;
  const error = new Error('User-data lock ownership was lost before commit');
  error.code = 'USER_DATA_LOCK_LOST';
  throw error;
}

module.exports = {
  USER_DATA_LOCK_SECONDS,
  USER_DATA_LOCK_PREFIX,
  acquireUserDataLock,
  commitUserDataUnderLock,
  releaseUserDataLock,
  userDataLockKey,
};
