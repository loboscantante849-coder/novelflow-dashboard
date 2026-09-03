const { vipEventId } = require('./novelflow-member');

const EVENT_PREFIX = 'nf_vip_event:v1:';
const BIND_USER_PREFIX = 'nf_app_binding:v1:user:';
const BIND_MEMBER_PREFIX = 'nf_app_binding:v1:member:';
const BIND_MEMBER_SCRIPT = `
-- NF_VIP_MEMBER_BIND_V1
local existing = redis.call('get', KEYS[1])
if existing then
  local ok, decoded = pcall(cjson.decode, existing)
  if not ok or not decoded or decoded['user_id'] ~= ARGV[2] then
    return -2
  end
  local owner = redis.call('get', KEYS[2])
  if owner and owner ~= ARGV[1] then
    return -1
  end
  if not owner then
    redis.call('set', KEYS[2], ARGV[1])
  end
  return 2
end
local owner = redis.call('get', KEYS[2])
if owner and owner ~= ARGV[1] then
  return -1
end
redis.call('set', KEYS[2], ARGV[1])
redis.call('set', KEYS[1], ARGV[3])
return 1
`;
const USER_DATA_VIP_COMMIT_SCRIPT = `
-- NF_VIP_USER_DATA_COMMIT_V1
for index = 3, #KEYS do
  if redis.call('get', KEYS[index]) ~= ARGV[index] then
    return -2
  end
end
if redis.call('exists', KEYS[2]) == 1 then
  return -1
end
redis.call('set', KEYS[1], ARGV[1])
redis.call('set', KEYS[2], ARGV[2])
return 1
`;

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

function bindingUserKey(username) {
  return `${BIND_USER_PREFIX}${String(username || '').trim().toLowerCase()}`;
}

function bindingMemberKey(userId) {
  return `${BIND_MEMBER_PREFIX}${String(userId || '').trim().toLowerCase()}`;
}

async function loadVerifiedNovelFlowBinding(redis, username, expectedMemberId) {
  const user = String(username || '').trim().toLowerCase();
  const memberId = String(expectedMemberId || '').trim().toLowerCase();
  if (!redis || !user || !/^[a-f0-9]{24}$/.test(memberId)) return null;

  const userKey = bindingUserKey(user);
  const memberKey = bindingMemberKey(memberId);
  const values = typeof redis.mget === 'function'
    ? await redis.mget(userKey, memberKey)
    : await Promise.all([redis.get(userKey), redis.get(memberKey)]);
  const binding = parseJson(values && values[0], null);
  const owner = String(values && values[1] || '').trim().toLowerCase();

  if (!binding && !owner) return null;
  if (!binding || binding.version !== 1 ||
      String(binding.username || '').trim().toLowerCase() !== user ||
      String(binding.user_id || '').trim().toLowerCase() !== memberId ||
      owner !== user) {
    const error = new Error('NovelFlow account binding requires reconciliation');
    error.code = 'NOVELFLOW_BINDING_CONFLICT';
    throw error;
  }
  return binding;
}

async function bindNovelFlowMember(redis, username, member, { source = 'user' } = {}) {
  const user = String(username || '').trim().toLowerCase();
  if (!redis || !user || !member || !member.user_id) throw new Error('Invalid NovelFlow member binding');
  const userKey = bindingUserKey(user);
  const memberKey = bindingMemberKey(member.user_id);
  const binding = {
    version: 1,
    username: user,
    user_id: member.user_id,
    application_id: member.application_id,
    registered_at: member.registered_at,
    verified_at: new Date().toISOString(),
    verification_source: source,
  };
  const result = Number(await redis.eval(
    BIND_MEMBER_SCRIPT,
    [userKey, memberKey],
    [user, member.user_id, JSON.stringify(binding)],
  ));
  if (result === -1) {
    const error = new Error('This NovelFlow account is already bound');
    error.code = 'NOVELFLOW_ID_ALREADY_BOUND';
    throw error;
  }
  if (result === -2) {
    const error = new Error('This dashboard account is already bound to another NovelFlow account');
    error.code = 'NOVELFLOW_BINDING_IMMUTABLE';
    throw error;
  }
  if (![1, 2].includes(result)) {
    const error = new Error('NovelFlow binding could not be saved');
    error.code = 'NOVELFLOW_BINDING_FAILED';
    throw error;
  }
  const saved = parseJson(await redis.get(userKey), null);
  if (!saved || saved.user_id !== member.user_id) {
    const error = new Error('NovelFlow binding could not be saved');
    error.code = 'NOVELFLOW_BINDING_FAILED';
    throw error;
  }
  return saved;
}

function eventKey(eventId) {
  return `${EVENT_PREFIX}${eventId}`;
}

function buildVipEntitlement({ username, binding, source, sourceId, days, metadata = {} }) {
  const user = String(username || '').trim().toLowerCase();
  const memberId = String(binding && binding.user_id || '').trim().toLowerCase();
  const normalizedSource = String(source || '').trim();
  const normalizedSourceId = String(sourceId == null ? '' : sourceId).trim();
  const normalizedDays = Number(days);
  if (!user || !/^[a-f0-9]{24}$/.test(memberId) || !normalizedSource || !normalizedSourceId ||
      !Number.isInteger(normalizedDays) || normalizedDays <= 0 || normalizedDays > 365) {
    const error = new Error('Invalid VIP entitlement');
    error.code = 'INVALID_VIP_ENTITLEMENT';
    throw error;
  }
  const eventId = vipEventId(user, normalizedSource, normalizedSourceId);
  return {
    version: 1,
    event_id: eventId,
    username: user,
    user_id: memberId,
    source: normalizedSource,
    source_id: normalizedSourceId,
    days: normalizedDays,
    status: 'pending',
    attempts: 0,
    created_at: new Date().toISOString(),
    metadata,
  };
}

async function createVipEntitlement(redis, input) {
  const event = buildVipEntitlement(input);
  const key = eventKey(event.event_id);
  const existing = parseJson(await redis.get(key), null);
  if (existing) return { event: existing, created: false };
  const created = await redis.set(key, JSON.stringify(event), { nx: true });
  return created === 'OK' || created === true
    ? { event, created: true }
    : { event: parseJson(await redis.get(key), event), created: false };
}

async function commitUserDataWithVipEntitlement(redis, { userDataKey, userData, event, lock, additionalLocks = [] }) {
  const locks = [lock, ...additionalLocks].filter(Boolean);
  if (!redis || !userDataKey || !userData || !event || !locks.length || locks.some(item => !item.key || !item.token)) {
    const error = new Error('Invalid atomic VIP commit');
    error.code = 'INVALID_VIP_COMMIT';
    throw error;
  }
  const result = Number(await redis.eval(
    USER_DATA_VIP_COMMIT_SCRIPT,
    [userDataKey, eventKey(event.event_id), ...locks.map(item => item.key)],
    [JSON.stringify(userData), JSON.stringify(event), ...locks.map(item => item.token)],
  ));
  if (result === 1) return { event, created: true };
  const error = new Error(result === -1
    ? 'VIP entitlement already exists'
    : 'Reward lock expired before the VIP entitlement could be committed');
  error.code = result === -1 ? 'VIP_ENTITLEMENT_EXISTS' : 'VIP_ATOMIC_COMMIT_FAILED';
  throw error;
}

async function updateVipEvent(redis, event, changes) {
  const updated = { ...event, ...changes, updated_at: new Date().toISOString() };
  await redis.set(eventKey(event.event_id), JSON.stringify(updated));
  return updated;
}

module.exports = {
  BIND_MEMBER_SCRIPT,
  EVENT_PREFIX,
  bindNovelFlowMember,
  bindingMemberKey,
  bindingUserKey,
  buildVipEntitlement,
  commitUserDataWithVipEntitlement,
  createVipEntitlement,
  eventKey,
  loadVerifiedNovelFlowBinding,
  parseJson,
  updateVipEvent,
};
