const crypto = require('crypto');
const { bookstoreFetch } = require('./bookstore-fetch');

const APPLICATION_ID = '642fc1ace309494378a774a6';
const USER_API = 'https://admin.novelflow.app/api/v1/usermanage/userinfo/page';
const GRANT_API = 'https://admin.novelflow.app/api/v1/usermanage/member';
const REQUEST_TIMEOUT_MS = 7000;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function normalizePublicId(value) {
  const id = String(value || '').trim();
  return OBJECT_ID_RE.test(id) ? id.toLowerCase() : null;
}

function extractRows(payload) {
  const candidates = [payload && payload.data && payload.data.data, payload && payload.data, payload && payload.items];
  for (const rows of candidates) if (Array.isArray(rows)) return rows;
  return [];
}

function sanitizeMember(row) {
  if (!row || !OBJECT_ID_RE.test(String(row.userId || ''))) return null;
  return {
    user_id: String(row.userId).toLowerCase(),
    application_id: String(row.applicationId || ''),
    registered_at: row.accountRegistTime || row.createTime || null,
    member_end_time: row.memberEndTime || row.subscribeEndTime || null,
  };
}

async function upstreamJson(url, options = {}) {
  const { response, authUnavailable } = await bookstoreFetch(url, options, { timeoutMs: REQUEST_TIMEOUT_MS });
  if (!response) {
    const error = new Error('NovelFlow admin authentication unavailable');
    error.code = authUnavailable ? 'UPSTREAM_AUTH_UNAVAILABLE' : 'UPSTREAM_UNAVAILABLE';
    throw error;
  }
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_error) { body = {}; }
  return { response, body };
}

async function resolveNovelFlowMember(value) {
  const userId = normalizePublicId(value);
  if (!userId) {
    const error = new Error('Use the 24-character NovelFlow User ID shown in the app profile');
    error.code = 'INVALID_NOVELFLOW_USER_ID';
    throw error;
  }
  const query = new URLSearchParams({
    pageIndex: '1', pageSize: '2', current: '1', applicationId: APPLICATION_ID, userId,
  });
  const { response, body } = await upstreamJson(`${USER_API}?${query}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok || Number(body && body.code) !== 200) {
    const error = new Error('NovelFlow user lookup failed');
    error.code = response.status === 401 ? 'UPSTREAM_AUTH_UNAVAILABLE' : 'NOVELFLOW_LOOKUP_FAILED';
    throw error;
  }
  const matches = extractRows(body).map(sanitizeMember).filter(member => (
    member && member.user_id === userId && member.application_id === APPLICATION_ID
  ));
  if (matches.length !== 1) {
    const error = new Error(matches.length ? 'NovelFlow user is ambiguous' : 'NovelFlow user was not found');
    error.code = matches.length ? 'NOVELFLOW_USER_AMBIGUOUS' : 'NOVELFLOW_USER_NOT_FOUND';
    throw error;
  }
  return matches[0];
}

async function grantVipDays(userId, days) {
  if (!OBJECT_ID_RE.test(String(userId || '')) || !Number.isInteger(days) || days <= 0 || days > 365) {
    const error = new Error('Invalid VIP grant');
    error.code = 'INVALID_VIP_GRANT';
    throw error;
  }
  const { response, body } = await upstreamJson(GRANT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ applicationId: APPLICATION_ID, platForm: 1, days, userId }),
  });
  if (!response.ok || ![0, 200].includes(Number(body && body.code))) {
    const error = new Error('NovelFlow VIP grant failed');
    error.code = response.status === 401 ? 'UPSTREAM_AUTH_UNAVAILABLE' : 'VIP_GRANT_FAILED';
    throw error;
  }
  return { success: true, request_id: body.requestId || null };
}

function vipEventId(username, source, sourceId) {
  return `vip_${crypto.createHash('sha256').update(`${String(username).toLowerCase()}:${source}:${sourceId}`).digest('hex').slice(0, 32)}`;
}

module.exports = {
  APPLICATION_ID,
  OBJECT_ID_RE,
  grantVipDays,
  normalizePublicId,
  resolveNovelFlowMember,
  sanitizeMember,
  vipEventId,
};
