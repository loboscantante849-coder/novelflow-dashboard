/**
 * GET /api/ac-result?threadId=xxx
 * 查询AC视频任务结果（已鉴权 + threadId ownership校验）
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser, isDisabledUser } = require('./_lib/security');
const { isLegacyAcRemarkOwnedBy } = require('./_lib/ac-ownership');

const AC_OWNER_TTL_SECONDS = 180 * 86400;
const LEGACY_LOOKUP_MAX_PAGES = 30;

async function restoreLegacyTaskOwnership({ redis, token, threadId, username }) {
  for (let pageIndex = 1; pageIndex <= LEGACY_LOOKUP_MAX_PAGES; pageIndex += 1) {
    const response = await fetch(`${AC_BASE}/creative/paged-list?PageSize=100&PageIndex=${pageIndex}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-client': 'beidou-web', 'X-Project-Id': '1006' },
    });
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
    if (await isDisabledUser(redis, username, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (e) {
    return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  const tid = req.query.threadId;
  if (!tid || typeof tid !== 'string' || tid.length > 200) {
    return res.status(400).json({ error: 'threadId required', code: 'THREAD_ID_REQUIRED' });
  }

  let token = null;
  try {
    token = await redis.get('ac_token');
  } catch (_error) {
    return res.status(503).json({ error: 'AC credentials are temporarily unavailable', code: 'AC_TOKEN_UNAVAILABLE' });
  }
  if (!token) token = process.env.AC_TOKEN;
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  // Ownership check. Historical tasks can outlive their original Redis entry,
  // so verify them against the current user's strictly-prefixed AC task list.
  try {
    const isAdm = await isAdminUser(redis, username, { failClosed: true });
    if (!isAdm) {
      const owner = await redis.get('ac_thread_owner:' + tid);
      if (!owner || String(owner).toLowerCase() !== String(username).toLowerCase()) {
        const restored = await restoreLegacyTaskOwnership({ redis, token, threadId: tid, username });
        if (!restored) return res.status(403).json({ error: 'Not authorized to view this task' });
      }
    }
  } catch(e) {
    return res.status(503).json({ error: 'Task ownership is temporarily unavailable', code: 'TASK_OWNER_UNAVAILABLE' });
  }

  try {
    const r = await fetch(AC_BASE + `/creative/${tid}/result`, {
      headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    if (newToken && redis) {
      redis.set('ac_token', newToken).catch(e => console.warn('Redis save failed:', e.message));
    }

    return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data });
  } catch (e) {
    return res.status(502).json({ error: 'Video service unavailable' });
  }
};
