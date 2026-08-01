/**
 * GET /api/ac-list
 * 查询AC视频任务列表（已鉴权）
 * Auto-paginates AC's paged-list to collect all reels belonging to the current user.
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser, isDisabledUser } = require('./_lib/security');
const { isLegacyAcRemarkOwnedBy } = require('./_lib/ac-ownership');

const AC_OWNER_TTL_SECONDS = 180 * 86400;
const PAGE_FETCH_CONCURRENCY = 4;

function pageError(status = 502) {
  const error = new Error('AC API error');
  error.acStatus = status;
  return error;
}

async function fetchAcPage(token, pageIndex, pageSize) {
  const response = await fetch(AC_BASE + `/creative/paged-list?PageSize=${pageSize}&PageIndex=${pageIndex}`, {
    headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
  });
  const data = await response.json().catch(() => null);
  if (response.status < 200 || response.status >= 300) throw pageError(response.status);
  if (!data || !Array.isArray(data.items)) throw pageError();
  return {
    pageIndex,
    data,
    accessToken: response.headers.get('accesstoken') || null,
  };
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ---- AUTH ----
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const currentUser = payload.username;

  // ---- TOKEN ----
  let redis = null;
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    }
  } catch(e) {}
  if (!redis) return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  try {
    if (await isDisabledUser(redis, currentUser, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (e) {
    return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
  }
  let token = null;
  try {
    token = await redis.get('ac_token');
  } catch (_error) {
    return res.status(503).json({ error: 'AC credentials are temporarily unavailable', code: 'AC_TOKEN_UNAVAILABLE' });
  }
  if (!token) token = process.env.AC_TOKEN;
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  // ---- Check admin ----
  let isAdm = false;
  try {
    isAdm = await isAdminUser(redis, currentUser, { failClosed: true });
  } catch(e) {
    return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  const clientPs = Math.max(5, Math.min(parseInt(req.query.pageSize) || 50, 100));
  const clientPi = Math.max(1, parseInt(req.query.pageIndex) || 1);
  const TARGET_USER_REELS = 50;
  const MAX_PAGES = 30;

  try {
    let allItems = [];
    let newToken = null;
    let acTotal = 0;

    if (isAdm) {
      const ps = clientPs, pi = clientPi;
      const r = await fetch(AC_BASE + `/creative/paged-list?PageSize=${ps}&PageIndex=${pi}`, {
        headers: { 'Authorization': 'Bearer ' + token, 'x-client': 'beidou-web', 'X-Project-Id': '1006' }
      });
      newToken = r.headers.get('accesstoken') || null;
      const data = await r.json().catch(() => null);
      if (newToken && redis) {
        redis.set('ac_token', newToken).catch(()=>{});
      }
      return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data });
    }

    const firstPage = await fetchAcPage(token, 1, 100);
    newToken = firstPage.accessToken;
    acTotal = firstPage.data.total || 0;
    let pageCount = Math.max(1, Math.min(Number(firstPage.data.pageCount) || 1, MAX_PAGES));
    let stop = false;

    const processPage = (page) => {
      if (!newToken && page.accessToken) newToken = page.accessToken;
      const matching = page.data.items.filter(item => (
        item && isLegacyAcRemarkOwnedBy(item.remark, currentUser)
      ));
      allItems.push(...matching);
      const reportedPageCount = Math.max(1, Number(page.data.pageCount) || 1);
      pageCount = Math.min(pageCount, reportedPageCount, MAX_PAGES);
      stop = allItems.length >= TARGET_USER_REELS || page.pageIndex >= pageCount || page.data.items.length === 0;
    };

    processPage(firstPage);
    for (let start = 2; !stop && start <= pageCount; start += PAGE_FETCH_CONCURRENCY) {
      const pageIndexes = [];
      for (let pageIndex = start; pageIndex < start + PAGE_FETCH_CONCURRENCY && pageIndex <= pageCount; pageIndex += 1) {
        pageIndexes.push(pageIndex);
      }
      const results = await Promise.allSettled(pageIndexes.map(pageIndex => fetchAcPage(token, pageIndex, 100)));
      // Process in page order, so a failure after the first page that satisfies
      // the target is not treated as a required page from this speculative batch.
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === 'rejected') throw result.reason;
        processPage(result.value);
        if (stop) break;
      }
    }

    if (newToken && redis) {
      redis.set('ac_token', newToken).catch(e => console.warn('Redis token save failed:', e.message));
    }

    // The AC list itself is already filtered by the user's signed nf_<user>_
    // remark. Refresh ownership here so historical reels can load their media
    // result without every card scanning AC again.
    await Promise.all(allItems.map(async (item) => {
      const threadId = item && (item.thread_id || item.threadId || item.id);
      if (!threadId) return;
      await redis.set(`ac_thread_owner:${threadId}`, currentUser, { ex: AC_OWNER_TTL_SECONDS });
    }));

    const result = {
      pageIndex: clientPi,
      pageSize: allItems.length,
      total: allItems.length,
      pageCount: 1,
      items: allItems
    };

    return res.status(200).json({ success: true, data: result });
  } catch (e) {
    if (e && e.acStatus) {
      return res.status(e.acStatus).json({ success: false, error: 'AC API error' });
    }
    return res.status(502).json({ error: 'Video service unavailable' });
  }
};
