/**
 * POST /api/ac-retry
 * 重试AC视频任务（已鉴权 + threadId ownership校验）
 */
const { setCORSHeaders } = require('./_lib/cors');
const { checkRateLimit, getAuthPayload, getClientIp, getRedis, isAdminUser, isDisabledUser } = require('./_lib/security');
const {
  fetchAcWithTokenFallback,
  getAcProxyStatus,
  getAcBaseUrl,
  getAcHeaders,
  parseThreadId,
  readAcToken,
  rotateAcToken,
} = require('./_lib/ac-request');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const username = payload.username;

  const tid = parseThreadId(req.body?.threadId);
  if (!tid) return res.status(400).json({ error: 'Invalid threadId', code: 'INVALID_THREAD_ID' });

  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  try {
    if (await isDisabledUser(redis, payload, { failClosed: true, allowSafeReadOnlyWalletConflict: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (e) {
    return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  // Ownership check
  try {
    const isAdm = await isAdminUser(redis, username, { failClosed: true });
    if (!isAdm) {
      const owner = await redis.get('ac_thread_owner:' + tid);
      if (!owner || String(owner).toLowerCase() !== String(username).toLowerCase()) {
        return res.status(403).json({ error: 'Not authorized to retry this task' });
      }
    }
  } catch(e) {
    return res.status(503).json({ error: 'Task ownership is temporarily unavailable', code: 'TASK_OWNER_UNAVAILABLE' });
  }

  try {
    const [userAllowed, ipAllowed] = await Promise.all([
      checkRateLimit(redis, `nf_rate:ac_retry_user:${String(username).toLowerCase()}`, 10, 3600, { failClosed: true }),
      checkRateLimit(redis, `nf_rate:ac_retry_ip:${String(getClientIp(req)).slice(0, 128)}`, 30, 3600, { failClosed: true }),
    ]);
    if (!userAllowed || !ipAllowed) return res.status(429).json({ error: 'Retry limit reached', code: 'RATE_LIMITED' });
  } catch (_error) {
    return res.status(503).json({ error: 'Retry service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
  }

  let token = null;
  try {
    token = await readAcToken(redis);
  } catch (_error) {
    return res.status(503).json({ error: 'AC credentials are temporarily unavailable', code: 'AC_TOKEN_UNAVAILABLE' });
  }
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  try {
    const r = await fetchAcWithTokenFallback(redis, token, getAcBaseUrl() + `/creative/${tid}/retry`, {
      method: 'POST',
      headers: getAcHeaders(token, { 'Content-Type': 'application/json' }),
    });
    await rotateAcToken(redis, r).catch(e => console.warn('Redis token save failed:', e.message));
    const data = await r.json().catch(() => null);
    if (r.status >= 200 && r.status < 300) {
      await redis.del(`nf_ac_list_cache:${String(username).toLowerCase()}`).catch(() => {});
    }
    const proxyStatus = getAcProxyStatus(r.status);
    return res.status(proxyStatus).json({ success: r.status >= 200 && r.status < 300, data });
  } catch (e) {
    return res.status(e && e.name === 'AbortError' ? 504 : 502).json({
      error: e && e.name === 'AbortError' ? 'Video service timed out' : 'Video service unavailable',
    });
  }
};
