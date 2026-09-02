/**
 * POST /api/ac-refresh
 * 服务端自检 AC token 有效性并刷新（管理员通过 header 触发，不接受客户端传 token）
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser, isDisabledUser, checkAdminKey } = require('./_lib/security');
const {
  fetchAcWithTokenFallback,
  getAcProxyStatus,
  getAcHeaders,
  getAcPagedListUrl,
  readAcToken,
  rotateAcToken,
} = require('./_lib/ac-request');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Only admin (JWT or x-admin-key) can trigger server-side token refresh
  const payload = getAuthPayload(req);
  const hasAdminKey = checkAdminKey(req);
  let isAdm = hasAdminKey;
  let redis = null;
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    }
  } catch(e) {}
  if (!hasAdminKey) {
    if (!payload) return res.status(403).json({ error: 'Admin only' });
    if (!redis) return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
    try {
      if (await isDisabledUser(redis, payload, { failClosed: true, allowSafeReadOnlyWalletConflict: true })) {
        return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
      }
    } catch (e) {
      return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
    }
    try {
      isAdm = await isAdminUser(redis, payload.username, { failClosed: true });
    } catch (e) {
      return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
    }
  }
  if (!isAdm) return res.status(403).json({ error: 'Admin only' });

  let token = null;
  try {
    token = await readAcToken(redis);
  } catch (_error) {
    return res.status(503).json({ error: 'AC credentials are temporarily unavailable', code: 'AC_TOKEN_UNAVAILABLE' });
  }
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  try {
    const r = await fetchAcWithTokenFallback(redis, token, getAcPagedListUrl(5, 1, 'video'), {
      headers: getAcHeaders(token),
    });
    await rotateAcToken(redis, r).catch(e => {
      console.warn('Redis save failed:', e.message);
    });
    await r.json().catch(() => null);

    const proxyStatus = getAcProxyStatus(r.status);
    if (r.status < 200 || r.status >= 300) {
      return res.status(proxyStatus).json({ success: false, error: 'Token invalid' });
    }

    return res.status(200).json({ success: true, message: 'Token valid' });
  } catch (e) {
    return res.status(502).json({ error: 'Video service unavailable' });
  }
};
