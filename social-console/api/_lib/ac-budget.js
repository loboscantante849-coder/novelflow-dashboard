'use strict';

const crypto = require('crypto');

// AC does not currently return a documented, durable points ledger to this
// integration. Keep a conservative local estimate at the paid-request edge.
// The limit is deliberately capped even when a bad environment value is set.
const HARD_MAX_DAILY_POINTS = 1000;
const DEFAULT_DAILY_POINTS = 1000;
const DEFAULT_REQUEST_COST = 1;
const EVENT_TTL_SECONDS = 8 * 24 * 60 * 60;
const BUDGET_LOCK_TTL_SECONDS = 8;
const BUDGET_LOCK_ATTEMPTS = 12;
const LOCAL_BUDGET_LOCKS = new Map();
const RESERVATION_ID_RE = /^ac_[a-z0-9]+_[a-f0-9]{16}$/;
const NON_BILLABLE_OPERATIONS = new Set([
  // AC status/list/result endpoints are reconciliation reads.  They do not
  // create media and must never consume the paid-request budget.
  'ac_read', 'ac_result', 'ac_status',
  // SocialEcho media transfer and draft operations are not AC generation.
  // Article-list GETs remain billable in the conservative local estimate
  // because the provider's historical usage suggested they can consume quota.
  'socialecho_upload', 'socialecho_draft', 'socialecho_publish'
]);

// A Lua reserve keeps the counter check and increment in one Redis command.
// This is the only path that can authorize a paid request when direct Upstash
// Redis is available.  The fallback below uses a short distributed lease for
// Redis-compatible bridges that do not expose EVAL.
const RESERVE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1]) or 0
local limit = tonumber(ARGV[2]) or 0
local ttl = tonumber(ARGV[3]) or 60
if current < 0 then current = 0 end
if cost < 0 then cost = 0 end
if current + cost > limit then
  return {0, current, math.max(0, limit - current)}
end
local next = redis.call('INCRBY', KEYS[1], cost)
redis.call('EXPIRE', KEYS[1], ttl)
return {1, next, math.max(0, limit - next)}
`;

const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 0 then return 0 end
local cost = tonumber(ARGV[1]) or 0
if cost < 0 then cost = 0 end
local next = math.max(0, current - cost)
redis.call('SET', KEYS[1], next, 'EX', tonumber(ARGV[2]) or 60)
return next
`;

const RELEASE_SETTLEMENT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local marker = redis.call('SET', KEYS[2], ARGV[3], 'NX', 'EX', tonumber(ARGV[4]) or 60)
if not marker then return {0, math.max(0, current)} end
if current <= 0 then return {1, 0} end
local cost = tonumber(ARGV[1]) or 0
if cost < 0 then cost = 0 end
local next = math.max(0, current - cost)
redis.call('SET', KEYS[1], next, 'EX', tonumber(ARGV[2]) or 60)
return {1, next}
`;

class AcBudgetError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AcBudgetError';
    this.status = Number(options.status || 429);
    this.code = String(options.code || 'ac_points_budget_exceeded');
    this.budget = options.budget || null;
  }
}

function shanghaiDay(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(at);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}${value('month')}${value('day')}`;
}

function nextShanghaiMidnight(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(at).reduce((out, part) => {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
    return out;
  }, {});
  // Asia/Shanghai is UTC+08:00 and has no DST. Construct the next local
  // midnight explicitly so the Redis expiry is independent of Vercel region.
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, -8, 0, 0, 0));
}

function positiveInteger(value, fallback) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function dailyPointsLimit(environment = process.env) {
  const configured = environment.AC_DAILY_POINTS_LIMIT
    ?? environment.AC_DAILY_BUDGET
    ?? environment.SOCIAL_AC_DAILY_POINTS_LIMIT;
  // A configured value can lower the budget, never raise the hard safety cap.
  return Math.min(HARD_MAX_DAILY_POINTS, positiveInteger(configured, DEFAULT_DAILY_POINTS));
}

function operationCost(operation = 'video_create', environment = process.env) {
  const name = String(operation || 'video_create').toLowerCase();
  if (NON_BILLABLE_OPERATIONS.has(name)) return 0;
  const envName = name === 'video_retry' ? 'AC_RETRY_COST_POINTS'
    : name === 'video_create' ? 'AC_VIDEO_COST_POINTS'
      : 'AC_REQUEST_COST_POINTS';
  return Math.min(HARD_MAX_DAILY_POINTS, positiveInteger(environment[envName], DEFAULT_REQUEST_COST));
}

function isBillableOperation(operation = '') {
  return !NON_BILLABLE_OPERATIONS.has(String(operation || '').toLowerCase());
}

function budgetInfo(at = new Date(), environment = process.env) {
  const day = shanghaiDay(at);
  const resetAt = nextShanghaiMidnight(at);
  const expiresIn = Math.max(60, Math.ceil((resetAt.getTime() - at.getTime()) / 1000) + 60);
  return {
    day,
    key: `nf_social:ac_points:${day}`,
    eventsKey: `nf_social:ac_points_events:${day}`,
    limit: dailyPointsLimit(environment),
    resetAt: resetAt.toISOString(),
    expiresIn,
    timeZone: 'Asia/Shanghai',
    scope: 'day'
  };
}

async function increment(redis, key, amount) {
  if (typeof redis?.incrby === 'function') return Number(await redis.incrby(key, amount));
  const numeric = Number(amount) || 0;
  if (numeric >= 0 && typeof redis?.incr === 'function') {
    let result = Number(await redis.get(key)) || 0;
    const steps = Math.max(0, numeric);
    for (let index = 0; index < steps; index += 1) result = Number(await redis.incr(key));
    return result;
  }
  if (numeric < 0 && typeof redis?.decrby === 'function') return Number(await redis.decrby(key, Math.abs(numeric)));
  if (numeric < 0 && typeof redis?.decr === 'function') {
    let result = Number(await redis.get(key)) || 0;
    const steps = Math.max(0, Math.abs(numeric));
    for (let index = 0; index < steps; index += 1) result = Number(await redis.decr(key));
    return result;
  }
  throw new AcBudgetError('AC budget storage does not support atomic counters', {
    status: 503, code: 'ac_budget_storage_unavailable'
  });
}

async function readUsed(redis, info) {
  const value = await redis.get(info.key);
  return Math.max(0, Number(value) || 0);
}

async function status(redis, at = new Date(), environment = process.env) {
  if (!redis) return { ...budgetInfo(at, environment), used: null, remaining: null, storage: false };
  const info = budgetInfo(at, environment);
  const used = Math.min(info.limit, await readUsed(redis, info));
  return { ...info, used, remaining: Math.max(0, info.limit - used), storage: true };
}

function reservationId() {
  return `ac_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

function settlementKey(reservationIdValue) {
  return `nf_social:ac_points_settlement:${String(reservationIdValue || '')}`;
}

function reservationInfo(reservation, fallbackAt = new Date()) {
  const day = String(reservation?.day || '').replace(/[^0-9]/g, '');
  const fallback = budgetInfo(fallbackAt, process.env);
  if (!day) return fallback;
  return {
    day,
    key: String(reservation?.key || `nf_social:ac_points:${day}`),
    eventsKey: String(reservation?.eventsKey || `nf_social:ac_points_events:${day}`),
    limit: Number(reservation?.limit) > 0 ? Number(reservation.limit) : fallback.limit,
    resetAt: String(reservation?.resetAt || fallback.resetAt),
    expiresIn: Math.max(60, Number(reservation?.expiresIn) || EVENT_TTL_SECONDS),
    timeZone: String(reservation?.timeZone || 'Asia/Shanghai'),
    scope: 'day'
  };
}

/**
 * Check the immutable fields that identify a server-created reservation.
 * `submitAc` is also used by a few legacy adapters, so it accepts a plain
 * object rather than holding a class instance.  Rejecting malformed objects
 * here prevents an internal caller from accidentally treating
 * `{ granted: true }` as proof that the daily counter was reserved.
 */
function isValidReservation(reservation) {
  if (!reservation || reservation.granted !== true || reservation.billable === false) return false;
  const id = String(reservation.reservationId || '');
  if (!RESERVATION_ID_RE.test(id)) return false;
  if (String(reservation.settlementKey || '') !== settlementKey(id)) return false;
  const day = String(reservation.day || '');
  if (!/^\d{8}$/.test(day)) return false;
  if (String(reservation.key || '') !== `nf_social:ac_points:${day}`) return false;
  if (String(reservation.eventsKey || '') !== `nf_social:ac_points_events:${day}`) return false;
  const limit = Number(reservation.limit);
  const cost = Number(reservation.cost);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARD_MAX_DAILY_POINTS) return false;
  if (!Number.isSafeInteger(cost) || cost < 1 || cost > limit) return false;
  return typeof reservation.operation === 'string' && reservation.operation.length > 0 && reservation.operation.length <= 80;
}

function unsupportedEval(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /unknown command|not supported|unsupported|does not support|method .*eval|eval.*(404|405)|operation.*unknown/.test(message)
    || Number(error?.status || error?.statusCode || 0) === 404;
}

async function releaseLock(redis, key, value) {
  if (!redis || !key || !value) return;
  // Upstash's eval signature is (script, keys, args).  Do not make lock
  // release depend on it: a bridge may only expose GET/DEL.
  if (typeof redis.eval === 'function') {
    try {
      await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        [key], [value]
      );
      return;
    } catch (error) {
      if (!unsupportedEval(error)) return;
    }
  }
  try {
    const current = await redis.get(key);
    if (String(current ?? '') === String(value)) await redis.del(key);
  } catch {
    // The short TTL is the final safety net if a bridge is unavailable while
    // releasing a lock. Never turn a successful paid reservation into an API
    // error solely because cleanup telemetry failed.
  }
}

async function withBudgetLease(redis, info, callback) {
  if (typeof redis?.set !== 'function' || typeof redis?.get !== 'function') {
    throw new AcBudgetError('AC budget storage does not support a safe reservation lock', {
      status: 503, code: 'ac_budget_storage_unavailable'
    });
  }
  const key = `nf_social:ac_points_lock:${info.day}`;
  // Minimal test doubles (and a few legacy storage adapters) expose SET/GET
  // but not DEL/EVAL. Keep their fallback safe for concurrent calls in this
  // process; production Redis/RemoteRedis takes the distributed path below.
  if (typeof redis.del !== 'function' && typeof redis.eval !== 'function') {
    while (LOCAL_BUDGET_LOCKS.has(key)) await LOCAL_BUDGET_LOCKS.get(key).wait;
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    LOCAL_BUDGET_LOCKS.set(key, { wait: hold });
    try { return await callback(); }
    finally {
      if (LOCAL_BUDGET_LOCKS.get(key)?.wait === hold) LOCAL_BUDGET_LOCKS.delete(key);
      release();
    }
  }
  for (let attempt = 0; attempt < BUDGET_LOCK_ATTEMPTS; attempt += 1) {
    const value = `lock_${reservationId()}`;
    let acquired = false;
    try { acquired = Boolean(await redis.set(key, value, { nx: true, ex: BUDGET_LOCK_TTL_SECONDS })); } catch {
      throw new AcBudgetError('AC budget storage is unavailable', { status: 503, code: 'ac_budget_storage_unavailable' });
    }
    if (acquired) {
      try { return await callback(); }
      finally { await releaseLock(redis, key, value); }
    }
    // Keep contention bounded. A caller that cannot obtain the lock fails
    // closed instead of authorizing a request based on a stale counter.
    await new Promise((resolve) => setTimeout(resolve, 15 + attempt * 10));
  }
  throw new AcBudgetError('AC budget reservation is busy; retry later', {
    status: 503, code: 'ac_budget_storage_busy'
  });
}

function parseAtomicReserve(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const granted = Number(value[0]) === 1;
  const used = Math.max(0, Number(value[1]) || 0);
  const remaining = Math.max(0, Number(value[2]) || 0);
  return { granted, used, remaining };
}

async function atomicReserve(redis, info, cost) {
  if (typeof redis?.eval !== 'function') return null;
  try {
    const result = await redis.eval(RESERVE_SCRIPT, [info.key], [String(cost), String(info.limit), String(info.expiresIn)]);
    const parsed = parseAtomicReserve(result);
    if (!parsed) throw new AcBudgetError('AC budget storage returned an invalid reservation result', { status: 503, code: 'ac_budget_storage_unavailable' });
    return parsed;
  } catch (error) {
    if (unsupportedEval(error)) return null;
    // A transport error after EVAL could mean that Redis executed the script.
    // Failing closed is safer than falling back and double-reserving points.
    if (error instanceof AcBudgetError) throw error;
    throw new AcBudgetError('AC budget reservation could not be confirmed', { status: 503, code: 'ac_budget_storage_unavailable' });
  }
}

async function atomicRelease(redis, info, cost) {
  if (typeof redis?.eval === 'function') {
    try {
      const result = await redis.eval(RELEASE_SCRIPT, [info.key], [String(cost), String(info.expiresIn)]);
      if (result !== undefined && result !== null && Number.isFinite(Number(result))) return Number(result);
    } catch (error) {
      if (!unsupportedEval(error)) throw new AcBudgetError('AC budget release could not be confirmed', { status: 503, code: 'ac_budget_storage_unavailable' });
    }
  }
  const releaseWithLease = async () => withBudgetLease(redis, info, async () => {
    const currentRaw = await redis.get(info.key);
    if (currentRaw == null) return 0;
    const current = Math.max(0, Number(currentRaw) || 0);
    const next = Math.max(0, current - Math.max(0, Number(cost) || 0));
    if (typeof redis.set === 'function') await redis.set(info.key, String(next), { ex: info.expiresIn });
    else await increment(redis, info.key, next - current);
    return next;
  });
  // An in-process test double may expose an `eval` method with a foreign
  // signature. If it reports a nonnumeric result, use the same safe lease
  // fallback rather than treating it as a successful release.
  return releaseWithLease();
}

async function atomicReleaseWithSettlement(redis, info, marker, cost) {
  if (typeof redis?.eval !== 'function') return null;
  try {
    const markerValue = JSON.stringify({ status: 'released', at: new Date().toISOString() });
    const result = await redis.eval(
      RELEASE_SETTLEMENT_SCRIPT,
      [info.key, marker],
      [String(cost), String(info.expiresIn), markerValue, String(info.expiresIn)]
    );
    if (!Array.isArray(result) || result.length < 2) return null;
    return { claimed: Number(result[0]) === 1, used: Math.max(0, Number(result[1]) || 0) };
  } catch (error) {
    if (unsupportedEval(error)) return null;
    throw new AcBudgetError('AC budget release could not be confirmed', { status: 503, code: 'ac_budget_storage_unavailable' });
  }
}

async function saveEvent(redis, info, event) {
  const eventKey = `${info.eventsKey}:${event.id}`;
  await redis.set(eventKey, JSON.stringify(event), { ex: info.expiresIn }).catch(() => {});
  if (typeof redis.zadd === 'function') {
    await redis.zadd(info.eventsKey, { score: Date.now(), member: event.id }).catch(() => {});
  }
}

/**
 * Atomically reserves the estimated points for one request which may create
 * a new AC task. The reservation is made before the POST and is intentionally
 * retained on ambiguous/network outcomes because the provider may have
 * accepted and charged the request.
 */
async function reserve(redis, operation = 'video_create', options = {}) {
  const info = budgetInfo(options.at || new Date(), options.environment || process.env);
  const requestedCost = operationCost(operation, options.environment || process.env);
  // AC reconciliation/status reads and SocialEcho media transfer/draft
  // operations are explicitly non-billable. Article-list reads deliberately
  // remain billable under the conservative local estimate.
  if (requestedCost === 0) {
    const used = redis ? Math.min(info.limit, await readUsed(redis, info)) : null;
    return {
      granted: true,
      billable: false,
      reservationId: '',
      ...info,
      used,
      remaining: used == null ? null : Math.max(0, info.limit - used),
      cost: 0,
      operation: String(operation || '')
    };
  }
  if (!redis) {
    throw new AcBudgetError('AC budget storage is not configured', {
      status: 503, code: 'ac_budget_storage_unavailable'
    });
  }
  const cost = Math.min(info.limit, Math.max(1, positiveInteger(options.cost, requestedCost)));
  let decision = await atomicReserve(redis, info, cost);
  if (!decision) {
    decision = await withBudgetLease(redis, info, async () => {
      await redis.set(info.key, '0', { nx: true, ex: info.expiresIn });
      const current = Math.max(0, Number(await redis.get(info.key)) || 0);
      if (current + cost > info.limit) {
        return { granted: false, used: current, remaining: Math.max(0, info.limit - current) };
      }
      const used = await increment(redis, info.key, cost);
      // A bridge without INCRBY may implement increment as multiple calls;
      // verify the postcondition under the same lease before authorizing.
      if (used > info.limit) {
        const corrected = Math.max(0, used - cost);
        if (typeof redis.set === 'function') await redis.set(info.key, String(corrected), { ex: info.expiresIn });
        return { granted: false, used: corrected, remaining: Math.max(0, info.limit - corrected) };
      }
      return { granted: true, used, remaining: Math.max(0, info.limit - used) };
    });
  }
  if (!decision.granted) {
    return { granted: false, ...info, operation, cost, reason: 'daily_ac_points_limit', used: Math.min(info.limit, decision.used), remaining: Math.max(0, info.limit - decision.used) };
  }
  const id = reservationId();
  const event = {
    id,
    operation: String(operation || 'video_create'),
    cost,
    day: info.day,
    reservedAt: new Date().toISOString(),
    status: 'reserved',
    metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {}
  };
  await saveEvent(redis, info, event);
  const reservation = {
    granted: true,
    billable: true,
    reservationId: id,
    settlementKey: settlementKey(id),
    ...info,
    used: Math.min(info.limit, Number(decision.used) || 0),
    remaining: Math.max(0, info.limit - (Number(decision.used) || 0)),
    cost,
    operation
  };
  // The settlement marker is created only by release/outcome with NX.  That
  // makes either terminal operation idempotent while leaving a fresh
  // reservation open for its owner.
  return reservation;
}

async function release(redis, reservation, reason = 'preflight_not_submitted') {
  if (!redis || !reservation?.granted || !reservation.reservationId || reservation.billable === false) return false;
  const info = reservationInfo(reservation);
  const marker = reservation.settlementKey || settlementKey(reservation.reservationId);
  const cost = Math.max(1, Number(reservation.cost) || 1);
  const atomic = await atomicReleaseWithSettlement(redis, info, marker, cost);
  if (atomic) {
    if (!atomic.claimed) return false;
    await saveEvent(redis, info, {
      id: reservation.reservationId,
      operation: reservation.operation,
      cost,
      day: info.day,
      releasedAt: new Date().toISOString(),
      status: 'released',
      reason: String(reason || '').slice(0, 160)
    });
    return true;
  }
  // The storage bridge does not expose Lua. Its short lease serializes this
  // fallback so two workers cannot both consume the same open reservation.
  // Direct Upstash Redis takes the atomic script above.
  let claimed = false;
  try {
    claimed = Boolean(await redis.set(marker, JSON.stringify({ status: 'released', at: new Date().toISOString() }), { nx: true, ex: info.expiresIn }));
  } catch {
    // Do not decrement when settlement cannot be claimed; a subsequent retry
    // would otherwise be able to release the same points twice.
    return false;
  }
  if (!claimed) return false;
  try {
    await atomicRelease(redis, info, cost);
  } catch {
    // The marker remains intentionally durable. A bridge transport failure
    // after the decrement is ambiguous, and deleting it could double-release
    // points on the next worker wakeup. This is conservative (it may hold a
    // point), never a path to exceeding the hard daily cap.
    return false;
  }
  await saveEvent(redis, info, {
    id: reservation.reservationId,
    operation: reservation.operation,
    cost,
    day: info.day,
    releasedAt: new Date().toISOString(),
    status: 'released',
    reason: String(reason || '').slice(0, 160)
  });
  return true;
}

async function outcome(redis, reservation, result = {}) {
  if (!redis || !reservation?.reservationId || reservation.billable === false) return false;
  const info = reservationInfo(reservation);
  const marker = reservation.settlementKey || settlementKey(reservation.reservationId);
  let claimed = false;
  try {
    claimed = Boolean(await redis.set(marker, JSON.stringify({ status: 'outcome', at: new Date().toISOString() }), { nx: true, ex: info.expiresIn }));
  } catch {
    return false;
  }
  if (!claimed) return false;
  await saveEvent(redis, info, {
    id: reservation.reservationId,
    operation: reservation.operation,
    cost: Number(reservation.cost) || 1,
    day: info.day,
    completedAt: new Date().toISOString(),
    status: String(result.status || 'submitted_or_unknown').slice(0, 60),
    externalId: String(result.externalId || '').slice(0, 200),
    providerCode: String(result.providerCode || '').slice(0, 80)
  });
  return true;
}

function budgetError(budget, operation, cost) {
  return new AcBudgetError(
    `AC daily points budget reached (${budget.used}/${budget.limit}); ${operation} requires ${cost} estimated point${cost === 1 ? '' : 's'}`,
    { budget, code: 'ac_points_budget_exceeded' }
  );
}

module.exports = {
  HARD_MAX_DAILY_POINTS,
  DEFAULT_DAILY_POINTS,
  DEFAULT_REQUEST_COST,
  AcBudgetError,
  shanghaiDay,
  dailyPointsLimit,
  operationCost,
  budgetInfo,
  status,
  reserve,
  release,
  outcome,
  budgetError,
  isBillableOperation,
  isValidReservation,
  NON_BILLABLE_OPERATIONS
};
