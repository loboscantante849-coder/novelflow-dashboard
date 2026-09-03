const crypto = require('crypto');

const OUTBOX_PREFIX = 'nf_outbox:signup:v1:';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const REQUEST_TIMEOUT_MS = 6000;
const DELIVERY_LEASE_MS = 10 * 60 * 1000;

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function configured() {
  return Boolean(
    process.env.NF_FEISHU_REGISTRATION_APP_ID &&
    process.env.NF_FEISHU_REGISTRATION_APP_SECRET &&
    process.env.NF_FEISHU_REGISTRATION_BASE_TOKEN &&
    process.env.NF_FEISHU_REGISTRATION_TABLE_ID
  );
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function signupEventId(username) {
  return `signup_${hashValue(String(username || '').trim().toLowerCase()).slice(0, 32)}`;
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

function outboxKey(eventId) {
  return `${OUTBOX_PREFIX}${eventId}`;
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const body = text ? parseJson(text, { raw: text.slice(0, 200) }) : {};
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function getFeishuToken() {
  if (cachedToken && cachedTokenExpiresAt > Date.now()) return cachedToken;
  const { response, body } = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.NF_FEISHU_REGISTRATION_APP_ID,
      app_secret: process.env.NF_FEISHU_REGISTRATION_APP_SECRET,
    }),
  });
  if (!response.ok || Number(body && body.code) !== 0 || !body.tenant_access_token) {
    const error = new Error('Feishu token unavailable');
    error.code = 'FEISHU_TOKEN_UNAVAILABLE';
    throw error;
  }
  cachedToken = String(body.tenant_access_token);
  const expiresIn = Math.max(60, Number(body.expire) || 7200);
  cachedTokenExpiresAt = Date.now() + Math.max(30000, (expiresIn - 300) * 1000);
  return cachedToken;
}

async function findRemoteSignupRecord(token, eventId) {
  const base = encodeURIComponent(process.env.NF_FEISHU_REGISTRATION_BASE_TOKEN);
  const table = encodeURIComponent(process.env.NF_FEISHU_REGISTRATION_TABLE_ID);
  const filter = encodeURIComponent(`CurrentValue.[event_id]="${String(eventId).replace(/["\\]/g, '')}"`);
  const { response, body } = await fetchJson(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${table}/records?page_size=1&filter=${filter}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok || Number(body && body.code) !== 0) {
    const error = new Error('Feishu record reconciliation failed');
    error.code = 'FEISHU_RECONCILIATION_FAILED';
    throw error;
  }
  const items = body && body.data && Array.isArray(body.data.items) ? body.data.items : [];
  return items[0] || null;
}

function normalizedDevice(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (/iphone|ipad|ios/.test(ua)) return 'iOS';
  if (/android/.test(ua)) return 'Android';
  if (/mobile/.test(ua)) return 'Mobile Web';
  return ua ? 'Desktop Web' : 'Unknown';
}

function buildSignupEvent({ username, memberId, referralCode, inviter, appInviteCode, ip, userAgent }) {
  const canonicalUsername = String(username || '').trim().toLowerCase();
  return {
    version: 1,
    type: 'signup',
    event_id: signupEventId(canonicalUsername),
    username: canonicalUsername,
    member_id: memberId == null ? null : Number(memberId),
    registered_at: new Date().toISOString(),
    referral_code: String(referralCode || ''),
    inviter: String(inviter || ''),
    app_invite_code: String(appInviteCode || ''),
    ip_hash: hashValue(ip).slice(0, 24),
    device: normalizedDevice(userAgent),
    status: 'pending',
    attempts: 0,
  };
}

async function stageSignupEvent(redis, input) {
  const event = buildSignupEvent(input);
  const key = outboxKey(event.event_id);
  const created = await redis.set(key, JSON.stringify(event), { nx: true });
  return created === 'OK' || created === true ? event : parseJson(await redis.get(key), event);
}

async function createAccountWithSignupEvent(redis, passwordKey, passwordHash, input) {
  const event = buildSignupEvent(input);
  const key = outboxKey(event.event_id);
  const script = [
    '-- NF_SIGNUP_ACCOUNT_CREATE_V1',
    "if redis.call('exists', KEYS[1]) == 1 then return 0 end",
    "redis.call('set', KEYS[1], ARGV[1])",
    "redis.call('set', KEYS[2], ARGV[2], 'NX')",
    'return 1',
  ].join('\n');
  const created = await redis.eval(script, [passwordKey, key], [passwordHash, JSON.stringify(event)]);
  return Number(created) === 1 ? event : null;
}

async function enrichSignupEvent(redis, event, changes = {}) {
  if (!event || !event.event_id) return null;
  const key = outboxKey(event.event_id);
  const current = parseJson(await redis.get(key), null);
  if (!current || current.type !== 'signup' || !current.username || !current.registered_at) {
    const error = new Error('Signup outbox event is missing');
    error.code = 'SIGNUP_EVENT_NOT_FOUND';
    throw error;
  }
  const updated = { ...current, ...changes };
  await redis.set(key, JSON.stringify(updated));
  return updated;
}

function staleDeliveringEvent(event, now = Date.now()) {
  if (!event || event.status !== 'delivering') return false;
  const attemptedAt = Date.parse(event.last_attempt_at || '');
  return !Number.isFinite(attemptedAt) || now - attemptedAt >= DELIVERY_LEASE_MS;
}

async function deliverSignupEvent(redis, event) {
  if (!event || event.status === 'delivered' || !configured()) return event;
  const key = outboxKey(event.event_id);
  const attempt = {
    ...event,
    attempts: Math.max(0, Number(event.attempts) || 0) + 1,
    last_attempt_at: new Date().toISOString(),
    status: 'delivering',
  };
  await redis.set(key, JSON.stringify(attempt));
  try {
    const token = await getFeishuToken();
    const existing = await findRemoteSignupRecord(token, attempt.event_id);
    if (existing) {
      const delivered = {
        ...attempt,
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        remote_record_id: existing.record_id || null,
        reconciled: true,
      };
      await redis.set(key, JSON.stringify(delivered));
      return delivered;
    }
    const base = encodeURIComponent(process.env.NF_FEISHU_REGISTRATION_BASE_TOKEN);
    const table = encodeURIComponent(process.env.NF_FEISHU_REGISTRATION_TABLE_ID);
    const { response, body } = await fetchJson(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${table}/records`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields: {
          event_id: attempt.event_id,
          username: attempt.username,
          member_id: attempt.member_id,
          registered_at: Date.parse(attempt.registered_at),
          referral_code: attempt.referral_code || '',
          inviter: attempt.inviter || '',
          app_invite_code: attempt.app_invite_code || '',
          ip_hash: attempt.ip_hash,
          device: attempt.device,
        } }),
      },
    );
    if (!response.ok || Number(body && body.code) !== 0) throw new Error('Feishu record delivery failed');
    const delivered = {
      ...attempt,
      status: 'delivered',
      delivered_at: new Date().toISOString(),
      remote_record_id: body && body.data && body.data.record && body.data.record.record_id || null,
    };
    await redis.set(key, JSON.stringify(delivered));
    return delivered;
  } catch (error) {
    let reconciled = null;
    let reconciliationFailed = false;
    try {
      const token = await getFeishuToken();
      reconciled = await findRemoteSignupRecord(token, attempt.event_id);
    } catch (_reconciliationError) {
      reconciliationFailed = true;
    }
    const failed = reconciled ? {
      ...attempt,
      status: 'delivered',
      delivered_at: new Date().toISOString(),
      remote_record_id: reconciled.record_id || null,
      reconciled: true,
    } : {
      ...attempt,
      status: reconciliationFailed ? 'reconciliation_required' : 'retry_pending',
      last_error_code: reconciliationFailed
        ? 'FEISHU_RECONCILIATION_REQUIRED'
        : (error && error.code || 'FEISHU_DELIVERY_FAILED'),
    };
    await redis.set(key, JSON.stringify(failed));
    return failed;
  }
}

function _resetForTests() {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
}

module.exports = {
  DELIVERY_LEASE_MS,
  OUTBOX_PREFIX,
  buildSignupEvent,
  configured,
  createAccountWithSignupEvent,
  deliverSignupEvent,
  enrichSignupEvent,
  outboxKey,
  signupEventId,
  stageSignupEvent,
  staleDeliveringEvent,
  _resetForTests,
};
