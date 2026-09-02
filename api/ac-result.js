/**
 * GET /api/ac-result?threadId=xxx
 * 查询AC视频任务结果（已鉴权 + threadId ownership校验）
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser, isDisabledUser, checkRateLimit, getClientIp } = require('./_lib/security');
const { isLegacyAcRemarkOwnedBy } = require('./_lib/ac-ownership');

const AC_OWNER_TTL_SECONDS = 180 * 86400;
const LEGACY_LOOKUP_MAX_PAGES = 30;
const AC_RESULT_TIMEOUT_MS = 8000;

const {
  fetchAcWithTokenFallback,
  getAcProxyStatus,
  getAcHeaders,
  getAcPagedListUrl,
  getAcBaseUrl,
  parseThreadId,
  readAcToken,
  rotateAcToken,
} = require('./_lib/ac-request');

async function restoreLegacyTaskOwnership({ redis, token, threadId, username, deadlineAt }) {
  for (let pageIndex = 1; pageIndex <= LEGACY_LOOKUP_MAX_PAGES; pageIndex += 1) {
    const response = await fetchAcWithTokenFallback(redis, token, getAcPagedListUrl(100, pageIndex, 'video'), {
      headers: getAcHeaders(token),
    }, deadlineAt - Date.now());
    // A paged-list lookup can rotate the Tianji token just like the final
    // result request. Persist it without making ownership restoration fail if
    // Redis is briefly unavailable.
    await rotateAcToken(redis, response).catch(() => {});
    if (!response.ok) throw new Error('AC legacy ownership lookup failed');
    const data = await response.json().catch(() => null);
    const items = Array.isArray(data?.items) ? data.items : [];
    const ownedTask = items.some((item) => (
      item &&
      String(item.thread_id || item.threadId || item.id || '') === String(threadId) &&
      isLegacyAcRemarkOwnedBy(item.remark, username)
    ));
    if (ownedTask) {
      await redis.set(`ac_thread_owner:${threadId}`, username, { ex: AC_OWNER_TTL_SECONDS });
      return true;
    }
    if (pageIndex >= Number(data?.pageCount || 1) || items.length === 0) break;
  }
  return false;
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const username = payload.username;

  let redis = null;
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    }
  } catch(e) {}
  if (!redis) return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  try {
    if (await isDisabledUser(redis, payload, { failClosed: true, allowSafeReadOnlyWalletConflict: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (e) {
    return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  const tid = parseThreadId(req.query.threadId);
  if (!tid) {
    return res.status(400).json({ error: 'threadId required', code: 'THREAD_ID_REQUIRED' });
  }

  // Result lookup may perform a legacy multi-page ownership scan before the
  // actual upstream request. Share the bounded read budget with /api/ac-list.
  try {
    const userAllowed = await checkRateLimit(
      redis,
      `nf_rate:ac_result_user:${String(username).toLowerCase()}`,
      120,
      60,
      { failClosed: true },
    );
    const ipAllowed = await checkRateLimit(
      redis,
      `nf_rate:ac_result_ip:${String(getClientIp(req)).slice(0, 128)}`,
      360,
      60,
      { failClosed: true },
    );
    if (!userAllowed || !ipAllowed) return res.status(429).json({ error: 'Too many AC requests', code: 'RATE_LIMITED' });
  } catch (e) {
    return res.status(503).json({ error: 'AC read service temporarily unavailable', code: e.code || 'RATE_LIMIT_UNAVAILABLE' });
  }

  let token = null;
  try {
    token = await readAcToken(redis);
  } catch (_error) {
    return res.status(503).json({ error: 'AC credentials are temporarily unavailable', code: 'AC_TOKEN_UNAVAILABLE' });
  }
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  const deadlineAt = Date.now() + AC_RESULT_TIMEOUT_MS;

  // Ownership check. Historical tasks can outlive their original Redis entry,
  // so verify them against the current user's strictly-prefixed AC task list.
  try {
    const isAdm = await isAdminUser(redis, username, { failClosed: true });
    if (!isAdm) {
      const owner = await redis.get('ac_thread_owner:' + tid);
      if (!owner || String(owner).toLowerCase() !== String(username).toLowerCase()) {
        const [scanUserAllowed, scanIpAllowed] = await Promise.all([
          checkRateLimit(redis, `nf_rate:ac_legacy_scan_user:${String(username).toLowerCase()}`, 2, 3600, { failClosed: true }),
          checkRateLimit(redis, `nf_rate:ac_legacy_scan_ip:${String(getClientIp(req)).slice(0, 128)}`, 6, 3600, { failClosed: true }),
        ]);
        if (!scanUserAllowed || !scanIpAllowed) {
          return res.status(429).json({ error: 'Legacy task lookup limit reached', code: 'RATE_LIMITED' });
        }
        const restored = await restoreLegacyTaskOwnership({ redis, token, threadId: tid, username, deadlineAt });
        if (!restored) return res.status(403).json({ error: 'Not authorized to view this task' });
      }
    }
  } catch(e) {
    if (e && e.name === 'AbortError') {
      return res.status(504).json({ error: 'Video service timed out' });
    }
    return res.status(503).json({ error: 'Task ownership is temporarily unavailable', code: 'TASK_OWNER_UNAVAILABLE' });
  }

  try {
    const r = await fetchAcWithTokenFallback(redis, token, getAcBaseUrl() + `/creative/${tid}/result`, {
      headers: getAcHeaders(token),
    }, deadlineAt - Date.now());
    await rotateAcToken(redis, r).catch(e => {
      console.warn('Redis token save failed:', e.message);
    });
    const data = await r.json().catch(() => null);

    const proxyStatus = getAcProxyStatus(r.status);
    return res.status(proxyStatus).json({ success: r.status >= 200 && r.status < 300, data });
  } catch (e) {
    return res.status(e && e.name === 'AbortError' ? 504 : 502).json({
      error: e && e.name === 'AbortError' ? 'Video service timed out' : 'Video service unavailable',
    });
  }
};
