const MEMBER_ID_NS = 'nf_member_id:v1';
const MEMBER_META_NS = 'nf_member_meta:v1';
const MEMBER_ID_COUNTER_KEY = `${MEMBER_ID_NS}:counter`;
const MEMBER_ID_START = 100;

const ALLOCATE_MEMBER_ID_SCRIPT = `
-- NF_MEMBER_ID_ALLOCATE_V1
local existing = redis.call('get', KEYS[1])
if existing then
  local reverse_key = ARGV[3] .. tostring(existing)
  local owner = redis.call('get', reverse_key)
  if not owner then redis.call('setnx', reverse_key, ARGV[1]) end
  if redis.call('get', reverse_key) == ARGV[1] then return existing end
  return ''
end
local counter = tonumber(redis.call('get', KEYS[2]) or '0')
if counter < tonumber(ARGV[2]) - 1 then
  redis.call('set', KEYS[2], tostring(tonumber(ARGV[2]) - 1))
end
for attempt = 1, 1000 do
  local member_id = redis.call('incr', KEYS[2])
  local reverse_key = ARGV[3] .. tostring(member_id)
  if redis.call('setnx', reverse_key, ARGV[1]) == 1 then
    redis.call('set', KEYS[1], tostring(member_id))
    return tostring(member_id)
  end
end
return ''
`;

function normalizeMemberUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return username && username.length <= 50 ? username : null;
}

function memberIdKey(username) {
  return `${MEMBER_ID_NS}:user:${username}`;
}

function memberMetaKey(username) {
  return `${MEMBER_META_NS}:${username}`;
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return null; }
}

function normalizeIsoDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function ensureMemberId(redis, usernameValue) {
  const username = normalizeMemberUsername(usernameValue);
  if (!redis || !username) throw new Error('Invalid member account');
  const allocated = Number(await redis.eval(
    ALLOCATE_MEMBER_ID_SCRIPT,
    [memberIdKey(username), MEMBER_ID_COUNTER_KEY],
    [username, String(MEMBER_ID_START), `${MEMBER_ID_NS}:id:`],
  ));
  if (!Number.isInteger(allocated) || allocated < MEMBER_ID_START) {
    const error = new Error('Could not allocate member ID');
    error.code = 'MEMBER_ID_UNAVAILABLE';
    throw error;
  }
  return allocated;
}

async function ensureMemberMeta(redis, usernameValue, options = {}) {
  const username = normalizeMemberUsername(usernameValue);
  if (!redis || !username) throw new Error('Invalid member account');
  const key = memberMetaKey(username);
  const existing = parseJson(await redis.get(key));
  if (existing) return existing;

  const now = new Date().toISOString();
  const record = {
    version: 1,
    username,
    source: ['local', 'discord'].includes(options.source) ? options.source : 'legacy',
    created_at: normalizeIsoDate(options.createdAt),
    first_seen_at: now,
  };
  await redis.set(key, JSON.stringify(record), { nx: true });
  return parseJson(await redis.get(key)) || record;
}

async function ensureMemberIdentity(redis, username, options = {}) {
  const [id, meta] = await Promise.all([
    ensureMemberId(redis, username),
    ensureMemberMeta(redis, username, options),
  ]);
  return { id, ...meta };
}

module.exports = {
  ALLOCATE_MEMBER_ID_SCRIPT,
  MEMBER_ID_COUNTER_KEY,
  MEMBER_ID_NS,
  MEMBER_ID_START,
  MEMBER_META_NS,
  ensureMemberId,
  ensureMemberIdentity,
  ensureMemberMeta,
  memberIdKey,
  memberMetaKey,
  normalizeMemberUsername,
};
