'use strict';

const crypto = require('crypto');
const { requireSession, requireOperatorMutation } = require('./auth');
const { getRedis, reserveVideoSlot, releaseVideoSlot } = require('./store');
const acBudget = require('./ac-budget');
const {
  fetchAcWithTokenFallback,
  getAcBaseUrl,
  getAcHeaders,
  getAcPagedListUrl,
  getAcProxyStatus,
  normalizeAcToken,
  parseThreadId,
  readAcToken,
  rotateAcToken
} = require('./ac-request');

const OWNER_TTL = 180 * 24 * 60 * 60;

function paused() {
  const value = String(process.env.SOCIAL_VIDEO_GENERATION_PAUSED || '').trim().toLowerCase();
  return value && !['0', 'false', 'off'].includes(value);
}

function jsonBody(req) {
  if (req?.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  return {};
}

function safeThreadId(value) {
  return parseThreadId(value);
}

function extractTaskId(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  for (const key of ['thread_id', 'threadId', 'task_id', 'taskId', 'id']) {
    const candidate = String(value[key] ?? '').trim();
    if (parseThreadId(candidate)) return candidate;
  }
  for (const key of ['data', 'creative', 'task', 'result', 'item']) {
    const nested = extractTaskId(value[key], seen);
    if (nested) return nested;
  }
  return '';
}

function normalizeRemark(payload) {
  const current = String(payload?.remark || '').trim();
  if (current && current.length <= 240) return current;
  const stable = { ...payload };
  delete stable.remark;
  return `nf_social_${crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32)}`;
}

async function readToken(redis) {
  try { return await readAcToken(redis); } catch { return null; }
}

async function upstream(path, options = {}, timeoutMs = 30000) {
  const redis = getRedis();
  const token = await readToken(redis);
  if (!token) {
    const error = new Error('AC credentials are not configured');
    error.status = 503;
    error.code = 'ac_token_unavailable';
    throw error;
  }
  let response;
  try {
    response = await fetchAcWithTokenFallback(redis, token, `${getAcBaseUrl()}${path}`, {
      ...options,
      headers: getAcHeaders(token, options.headers)
    }, timeoutMs);
    await rotateAcToken(redis, response).catch(() => {});
  } catch (error) {
    throw error;
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {
    const error = new Error('AC service returned invalid JSON');
    error.status = getAcProxyStatus(response.status);
    error.code = 'provider_invalid_json';
    throw error;
  }
  return { response, data, redis };
}

function sendUpstream(res, result) {
  const status = getAcProxyStatus(result.response.status);
  return res.status(status).json({ success: result.response.ok, data: redactAcSecrets(result.data) });
}

function redactAcSecrets(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactAcSecrets(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:authorization|token|access_token|accessToken|accesstoken|refresh_token|refreshToken|x-ac-token)$/i.test(key)) continue;
    output[key] = redactAcSecrets(item, seen);
  }
  return output;
}

function definitiveAcError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  return !error?.ambiguous && status >= 400 && status < 500;
}

function definitiveAcResponse(response) {
  const status = Number(response?.status || 0);
  return status >= 400 && status < 500;
}

async function rememberTask(redis, threadId, metadata = {}) {
  if (!redis || !threadId) return;
  await redis.set(`nf_social:ac_task:${threadId}`, JSON.stringify({
    threadId,
    owner: 'social-console',
    createdAt: new Date().toISOString(),
    ...metadata
  }), { ex: OWNER_TTL }).catch(() => {});
}

async function authorizeTask(redis, threadId) {
  if (!redis) return false;
  const raw = await redis.get(`nf_social:ac_task:${threadId}`).catch(() => null);
  if (!raw) return false;
  let value = raw;
  if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { value = {}; } }
  return String(value?.owner || '') === 'social-console';
}

function requireRead(req, res) {
  return requireSession(req, res);
}

function requireMutation(req, res) {
  return requireOperatorMutation(req, res);
}

async function create(req, res) {
  if (!requireMutation(req, res)) return;
  if (paused()) return res.status(409).json({ error: 'New video submissions are paused by the operator', code: 'VIDEO_GENERATION_PAUSED' });
  const body = jsonBody(req);
  const payload = Object.fromEntries(Object.entries({ ...body, is_generate_img: 'true', remark: normalizeRemark(body) })
    .filter(([key]) => !/^(?:authorization|token|access_token|accessToken|accesstoken|refresh_token|refreshToken|x-ac-token)$/i.test(key)));
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  // Persist the exact intended request before the single paid POST.
  const preparedKey = `nf_social:ac_prepared:${crypto.createHash('sha256').update(payload.remark).digest('hex').slice(0, 40)}`;
  await redis.set(preparedKey, JSON.stringify({ remark: payload.remark, payload, preparedAt: new Date().toISOString() }), { ex: OWNER_TTL });
  let result;
  let slot;
  let pointsReservation;
  try {
    pointsReservation = await acBudget.reserve(redis, 'video_create', { metadata: { source: 'ac-create', remark: payload.remark } });
    if (!pointsReservation.granted) {
      throw acBudget.budgetError(pointsReservation, 'video_create', pointsReservation.cost);
    }
    slot = await reserveVideoSlot(redis);
    if (!slot.granted) {
      await acBudget.release(redis, pointsReservation, 'video_daily_limit');
      return res.status(429).json({ error: `Daily video limit reached (${slot.limit}/${slot.limit}); retry after ${slot.resetLabel}`, code: 'VIDEO_DAILY_LIMIT' });
    }
    result = await upstream('/creative/by-user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 45000);
  } catch (error) {
    // A timeout/5xx may have reached AC, so retain both the points and the
    // day slot for reconciliation. Release resources only for a proven
    // pre-submit rejection (missing credentials, storage, or a definitive
    // 4xx response).
    if (slot?.key && (error?.code === 'ac_token_unavailable' || error?.code === 'ac_budget_storage_unavailable' || definitiveAcError(error))) {
      await releaseVideoSlot(redis, slot.key).catch(() => {});
    }
    if (pointsReservation?.granted) {
      if (error?.code === 'ac_token_unavailable' || error?.code === 'ac_budget_storage_unavailable' || definitiveAcError(error)) await acBudget.release(redis, pointsReservation, error?.code || 'definitive_rejection');
      else await acBudget.outcome(redis, pointsReservation, { status: 'submitted_or_unknown', providerCode: error?.code });
    }
    throw error;
  }
  if (!result.response.ok) {
    if (definitiveAcResponse(result.response)) {
      await acBudget.release(redis, pointsReservation, `provider_http_${result.response.status}`);
      await releaseVideoSlot(redis, slot?.key).catch(() => {});
    } else {
      await acBudget.outcome(redis, pointsReservation, { status: 'provider_http', providerCode: `http_${result.response.status}` });
    }
    return sendUpstream(res, result);
  }
  const threadId = extractTaskId(result.data);
  if (!threadId) {
    // The POST succeeded but did not return an ID: keep the remark durable and
    // force operator reconciliation rather than submitting an ambiguous retry.
    await acBudget.outcome(redis, pointsReservation, { status: 'accepted_without_task_id' });
    return res.status(502).json({ success: false, error: 'AC accepted the request without a task ID', code: 'SUBMIT_AMBIGUOUS', data: redactAcSecrets(result.data) });
  }
  await rememberTask(redis, threadId, { remark: payload.remark, payloadFingerprint: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
  await acBudget.outcome(redis, pointsReservation, { status: 'submitted', externalId: threadId });
  return res.status(202).json({ success: true, data: redactAcSecrets(result.data), threadId, remark: payload.remark, budget: { day: pointsReservation.day, used: pointsReservation.used, limit: pointsReservation.limit, remaining: pointsReservation.remaining, estimatedCost: pointsReservation.cost } });
}

async function list(req, res) {
  if (!requireRead(req, res)) return;
  const pageSize = Math.max(5, Math.min(Number(req.query?.pageSize) || 50, 100));
  const pageIndex = Math.max(1, Number(req.query?.pageIndex) || 1);
  const pageUrl = new URL(getAcPagedListUrl(pageSize, pageIndex, 'video'));
  const result = await upstream(pageUrl.pathname.replace(/^\/api\/v1/, '') + pageUrl.search, {}, 30000);
  const listed = result.data?.items || result.data?.data?.items || result.data?.list || [];
  if (Array.isArray(listed)) {
    await Promise.all(listed.map(async (item) => {
      const id = extractTaskId(item);
      if (id) await rememberTask(result.redis, id, { remark: String(item?.remark || '') });
    }));
  }
  return sendUpstream(res, result);
}

async function taskAction(req, res, action) {
  if (!requireMutation(req, res)) return;
  const threadId = safeThreadId(jsonBody(req).threadId || req.query?.threadId);
  if (!threadId) return res.status(400).json({ error: 'Valid threadId is required', code: 'INVALID_THREAD_ID' });
  const redis = getRedis();
  if (!(await authorizeTask(redis, threadId))) return res.status(403).json({ error: 'Not authorized to modify this task' });
  let pointsReservation;
  if (action === 'retry') {
    pointsReservation = await acBudget.reserve(redis, 'video_retry', { metadata: { source: 'ac-retry', threadId } });
    if (!pointsReservation.granted) throw acBudget.budgetError(pointsReservation, 'video_retry', pointsReservation.cost);
  }
  let result;
  try {
    result = await upstream(`/creative/${encodeURIComponent(threadId)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }, 30000);
  } catch (error) {
    if (pointsReservation?.granted) {
      if (error?.code === 'ac_token_unavailable' || error?.code === 'ac_budget_storage_unavailable' || definitiveAcError(error)) await acBudget.release(redis, pointsReservation, error?.code || 'definitive_rejection');
      else await acBudget.outcome(redis, pointsReservation, { status: 'submitted_or_unknown', providerCode: error?.code });
    }
    throw error;
  }
  if (pointsReservation?.granted) {
    if (!result.response.ok && definitiveAcResponse(result.response)) await acBudget.release(redis, pointsReservation, `provider_http_${result.response.status}`);
    else await acBudget.outcome(redis, pointsReservation, { status: result.response.ok ? 'submitted' : 'provider_http', providerCode: `http_${result.response.status}` });
  }
  return sendUpstream(res, result);
}

async function result(req, res) {
  if (!requireRead(req, res)) return;
  const threadId = safeThreadId(req.query?.threadId || jsonBody(req).threadId);
  if (!threadId) return res.status(400).json({ error: 'Valid threadId is required', code: 'INVALID_THREAD_ID' });
  const redis = getRedis();
  if (!(await authorizeTask(redis, threadId))) return res.status(403).json({ error: 'Not authorized to view this task' });
  const result = await upstream(`/creative/${encodeURIComponent(threadId)}/result`, {}, 30000);
  if (result.response.status === 204) return res.status(200).json({ success: true, data: { status: 'running', threadId } });
  return sendUpstream(res, result);
}

async function refresh(req, res) {
  if (!requireMutation(req, res)) return;
  const pageUrl = new URL(getAcPagedListUrl(5, 1, 'video'));
  const result = await upstream(pageUrl.pathname.replace(/^\/api\/v1/, '') + pageUrl.search, {}, 15000);
  if (!result.response.ok) return sendUpstream(res, result);
  return res.status(200).json({ success: true, message: 'AC token valid', data: result.data });
}

module.exports = { create, list, result, refresh, taskAction, extractTaskId, normalizeRemark, redactAcSecrets, definitiveAcError, definitiveAcResponse };
