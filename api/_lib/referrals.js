const crypto = require('crypto');
const { ACTIVITY_VERSION, isWithinActivity } = require('./activity-config');

const REFERRAL_VERSION = 1;
const PENDING_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFERRAL_CODE_NS = 'nf_referral_code:v1';
const REFERRAL_RELATION_NS = 'nf_referrer_of:v1';
const REFERRAL_INDEX_NS = 'nf_referrals:v1';
const ACTIVITY_REFERRAL_INDEX_NS = 'nf_activity_referrals:v1';

function normalizeReferralCode(value) {
  const code = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(code) ? code : null;
}

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return username && username.length <= 50 ? username : null;
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return null; }
}

function referralError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function referralCodeKey(username) {
  return `${REFERRAL_CODE_NS}:user:${username}`;
}

function referralCodeOwnerKey(code) {
  return `${REFERRAL_CODE_NS}:code:${code}`;
}

function referralUrl(code) {
  return `https://novelflow.top/?ref=${encodeURIComponent(code)}`;
}

function extractReferralCode(req) {
  const body = req && req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
  const query = req && req.query && typeof req.query === 'object' ? req.query : {};
  const headers = req && req.headers && typeof req.headers === 'object' ? req.headers : {};
  const direct = [body.referral_code, query.ref, headers['x-referral']]
    .find(value => typeof value === 'string' && value.trim());
  if (direct) return direct.trim();
  if (typeof headers.referer === 'string') {
    try {
      const value = new URL(headers.referer).searchParams.get('ref');
      if (value && value.trim()) return value.trim();
    } catch (_error) {
      // Ignore malformed Referer values.
    }
  }
  return null;
}

async function ensureReferralCode(redis, usernameValue) {
  const username = normalizeUsername(usernameValue);
  if (!redis || !username) throw referralError('Invalid referral account', 'INVALID_REFERRAL_ACCOUNT');
  const userKey = referralCodeKey(username);
  const storedCode = normalizeReferralCode(await redis.get(userKey));
  if (storedCode) {
    const ownerKey = referralCodeOwnerKey(storedCode);
    const owner = normalizeUsername(await redis.get(ownerKey));
    if (!owner) await redis.set(ownerKey, username, { nx: true });
    if (normalizeUsername(await redis.get(ownerKey)) === username) {
      return { referral_code: storedCode, referral_url: referralUrl(storedCode) };
    }
    throw referralError('Referral code ownership conflict', 'REFERRAL_CODE_CONFLICT');
  }

  const legacyApplication = parseJson(await redis.get(`nf_recommender:v1:application:${username}`));
  const legacyCode = normalizeReferralCode(legacyApplication && legacyApplication.referral_code);
  if (legacyCode) {
    const legacyOwner = normalizeUsername(await redis.get(`nf_recommender:v1:code:${legacyCode}`));
    if (legacyOwner === username) {
      await redis.set(referralCodeOwnerKey(legacyCode), username, { nx: true });
      const currentOwner = normalizeUsername(await redis.get(referralCodeOwnerKey(legacyCode)));
      if (currentOwner === username) {
        await redis.set(userKey, legacyCode, { nx: true });
        const winner = normalizeReferralCode(await redis.get(userKey));
        if (winner && normalizeUsername(await redis.get(referralCodeOwnerKey(winner))) === username) {
          return { referral_code: winner, referral_url: referralUrl(winner) };
        }
      }
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `nfref_${crypto.randomBytes(9).toString('base64url')}`;
    const ownerKey = referralCodeOwnerKey(code);
    const ownerCreated = await redis.set(ownerKey, username, { nx: true });
    if (!(ownerCreated === 'OK' || ownerCreated === true)) continue;
    const codeCreated = await redis.set(userKey, code, { nx: true });
    if (codeCreated === 'OK' || codeCreated === true) {
      return { referral_code: code, referral_url: referralUrl(code) };
    }
    const winner = normalizeReferralCode(await redis.get(userKey));
    await redis.del(ownerKey);
    if (winner && normalizeUsername(await redis.get(referralCodeOwnerKey(winner))) === username) {
      return { referral_code: winner, referral_url: referralUrl(winner) };
    }
  }
  throw referralError('Could not allocate a referral code', 'REFERRAL_CODE_UNAVAILABLE');
}

async function resolveReferralOwner(redis, code) {
  const current = normalizeUsername(await redis.get(referralCodeOwnerKey(code)));
  if (current) return current;
  const legacy = normalizeUsername(await redis.get(`nf_recommender:v1:code:${code}`));
  if (!legacy) return null;
  await redis.set(referralCodeOwnerKey(code), legacy, { nx: true });
  const resolved = normalizeUsername(await redis.get(referralCodeOwnerKey(code)));
  if (!resolved) return null;
  await redis.set(referralCodeKey(resolved), code, { nx: true });
  return resolved;
}

async function validateReferral(redis, childValue, codeValue) {
  if (!codeValue) return null;
  const code = normalizeReferralCode(codeValue);
  if (!code) throw referralError('Invalid referral code', 'INVALID_REFERRAL_CODE');
  const child = normalizeUsername(childValue);
  if (!redis || !child) throw referralError('Invalid referral account', 'INVALID_REFERRAL_ACCOUNT');
  const parent = await resolveReferralOwner(redis, code);
  if (!parent) throw referralError('Referral code is not active', 'INVALID_REFERRAL_CODE');
  if (parent === child) throw referralError('You cannot refer yourself', 'SELF_REFERRAL');
  return { child, parent, referral_code: code };
}

async function stageReferral(redis, childValue, codeValue) {
  if (!codeValue) return null;
  const child = normalizeUsername(childValue);
  if (!redis || !child) throw referralError('Invalid referral account', 'INVALID_REFERRAL_ACCOUNT');
  const relationshipKey = `${REFERRAL_RELATION_NS}:${child}`;
  const existing = parseJson(await redis.get(relationshipKey));
  if (existing) return existing;
  const pendingKey = `nf_referral_pending:v1:${child}`;
  const pending = parseJson(await redis.get(pendingKey));
  if (pending) return pending;
  const validated = await validateReferral(redis, child, codeValue);
  const record = {
    version: REFERRAL_VERSION,
    campaign_version: ACTIVITY_VERSION,
    child,
    parent: validated.parent,
    referral_code: validated.referral_code,
    staged_at: new Date().toISOString(),
  };
  await redis.set(pendingKey, JSON.stringify(record), { nx: true, ex: PENDING_TTL_SECONDS });
  return parseJson(await redis.get(pendingKey)) || record;
}

async function repairReferralIndexes(redis, relationship) {
  if (!relationship || !normalizeUsername(relationship.parent) || !normalizeUsername(relationship.child)) return;
  const parent = normalizeUsername(relationship.parent);
  const child = normalizeUsername(relationship.child);
  await redis.sadd(`${REFERRAL_INDEX_NS}:${parent}`, child);
  if (relationship.campaign_version === ACTIVITY_VERSION && isWithinActivity(relationship.bound_at)) {
    await redis.sadd(`${ACTIVITY_REFERRAL_INDEX_NS}:${parent}`, child);
  }
}

async function getCampaignReferralCount(redis, usernameValue) {
  const username = normalizeUsername(usernameValue);
  if (!redis || !username) return 0;
  return Math.max(0, Number(await redis.scard(`${ACTIVITY_REFERRAL_INDEX_NS}:${username}`)) || 0);
}

async function acquireReferralLock(redis, child) {
  const key = `nf_referral_lock:v1:${child}`;
  const token = crypto.randomUUID();
  const result = await redis.set(key, token, { nx: true, ex: 15 });
  return result === 'OK' || result === true ? { key, token } : null;
}

async function releaseReferralLock(redis, lock) {
  if (!lock) return;
  try {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [lock.key],
      [lock.token],
    );
  } catch (_error) {
    // Lock TTL is the final fallback.
  }
}

async function finalizePendingReferral(redis, childValue) {
  const child = normalizeUsername(childValue);
  if (!redis || !child) return null;
  const relationshipKey = `${REFERRAL_RELATION_NS}:${child}`;
  const existing = parseJson(await redis.get(relationshipKey));
  if (existing) {
    await repairReferralIndexes(redis, existing);
    return existing;
  }
  const pendingKey = `nf_referral_pending:v1:${child}`;
  if (!await redis.get(pendingKey)) return null;
  const lock = await acquireReferralLock(redis, child);
  if (!lock) throw referralError('Referral binding is busy', 'REFERRAL_BUSY');
  try {
    const current = parseJson(await redis.get(relationshipKey));
    if (current) {
      await repairReferralIndexes(redis, current);
      await redis.del(pendingKey);
      return current;
    }
    const pending = parseJson(await redis.get(pendingKey));
    if (!pending || pending.child !== child) return null;
    const activeParent = await resolveReferralOwner(redis, pending.referral_code);
    if (!activeParent || activeParent !== pending.parent || activeParent === child) {
      await redis.del(pendingKey);
      return null;
    }
    const boundAt = new Date().toISOString();
    const relationship = {
      version: REFERRAL_VERSION,
      campaign_version: pending.campaign_version || ACTIVITY_VERSION,
      child,
      parent: activeParent,
      referral_code: pending.referral_code,
      bound_at: boundAt,
      commission_effective_date: boundAt.slice(0, 10),
    };
    const created = await redis.set(relationshipKey, JSON.stringify(relationship), { nx: true });
    const saved = created === 'OK' || created === true
      ? relationship
      : parseJson(await redis.get(relationshipKey));
    if (!saved) throw referralError('Referral binding could not be saved', 'REFERRAL_STORAGE_UNAVAILABLE');
    await repairReferralIndexes(redis, saved);
    await redis.del(pendingKey);
    return saved;
  } finally {
    await releaseReferralLock(redis, lock);
  }
}

module.exports = {
  ACTIVITY_REFERRAL_INDEX_NS,
  REFERRAL_CODE_NS,
  REFERRAL_INDEX_NS,
  ensureReferralCode,
  extractReferralCode,
  finalizePendingReferral,
  getCampaignReferralCount,
  normalizeReferralCode,
  repairReferralIndexes,
  stageReferral,
  validateReferral,
};
