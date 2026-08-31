/**
 * GET /api/ac-list
 * 查询AC视频任务列表（已鉴权）
 * Auto-paginates AC's paged-list to collect all reels belonging to the current user.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser, isDisabledUser, checkRateLimit, getClientIp } = require('./_lib/security');
const { isLegacyAcRemarkOwnedBy } = require('./_lib/ac-ownership');

const AC_OWNER_TTL_SECONDS = 180 * 86400;
const PAGE_FETCH_CONCURRENCY = 4;
const AC_LIST_USER_LIMIT = 6;
const AC_LIST_IP_LIMIT = 30;
const AC_LIST_TIMEOUT_MS = 8000;
const AC_LIST_CACHE_SECONDS = 45;

const {
  fetchAcWithTokenFallback,
  getAcHeaders,
  getAcPagedListUrl,
  getResponseAccessToken,
  readAcToken,
  rotateAcToken,
} = require('./_lib/ac-request');

function pageError(status = 502) {
  const error = new Error('AC API error');
  error.acStatus = status;
  return error;
}

async function fetchAcPage(redis, token, pageIndex, pageSize, deadlineAt) {
  const response = await fetchAcWithTokenFallback(redis, token, getAcPagedListUrl(pageSize, pageIndex, 'video'), {
    headers: getAcHeaders(token),
  }, deadlineAt - Date.now());
  const data = await response.json().catch(() => null);
  if (response.status < 200 || response.status >= 300) throw pageError(response.status);
  if (!data || !Array.isArray(data.items)) throw pageError();
  return {
    pageIndex,
    data,
    accessToken: getResponseAccessToken(response),
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
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (e) {
    return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  // Listing can fan out to as many as 30 upstream pages. Keep normal refreshes
  // available while preventing one account/IP from exhausting AC or Redis.
  try {
    const userAllowed = await checkRateLimit(
      redis,
      `nf_rate:ac_list_user:${String(currentUser).toLowerCase()}`,
      AC_LIST_USER_LIMIT,
      60,
      { failClosed: true },
    );
    const ipAllowed = await checkRateLimit(
      redis,
      `nf_rate:ac_list_ip:${String(getClientIp(req)).slice(0, 128)}`,
      AC_LIST_IP_LIMIT,
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
    const deadlineAt = Date.now() + AC_LIST_TIMEOUT_MS;
    let allItems = [];
    let newToken = null;
    let acTotal = 0;

    if (isAdm) {
      const ps = clientPs, pi = clientPi;
      const r = await fetchAcWithTokenFallback(redis, token, getAcPagedListUrl(ps, pi, 'video'), {
        headers: getAcHeaders(token),
      }, deadlineAt - Date.now());
      try {
        newToken = await rotateAcToken(redis, r);
      } catch (e) {
        console.warn('Redis token save failed:', e.message);
        newToken = getResponseAccessToken(r);
      }
      const data = await r.json().catch(() => null);
      return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data });
    }

    const cacheKey = `nf_ac_list_cache:${String(currentUser).toLowerCase()}`;
    try {
      const cachedRaw = await redis.get(cacheKey);
      const cached = typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw;
      if (cached && Array.isArray(cached.items)) {
        return res.status(200).json({
          success: true,
          data: {
            pageIndex: clientPi,
            pageSize: cached.items.length,
            total: cached.items.length,
            pageCount: 1,
            items: cached.items,
          },
        });
      }
    } catch (_error) {
      // A missing or corrupt cache must not hide the live list.
    }

    const firstPage = await fetchAcPage(redis, token, 1, 100, deadlineAt);
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
      const results = await Promise.allSettled(pageIndexes.map(pageIndex => fetchAcPage(redis, token, pageIndex, 100, deadlineAt)));
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
      await rotateAcToken(redis, newToken).catch(e => console.warn('Redis token save failed:', e.message));
    }

    // The AC list itself is already filtered by the user's signed nf_<user>_
    // remark. Refresh ownership here so historical reels can load their media
    // result without every card scanning AC again.
    await Promise.all(allItems.map(async (item) => {
      const threadId = item && (item.thread_id || item.threadId || item.id);
      if (!threadId) return;
      await redis.set(`ac_thread_owner:${threadId}`, currentUser, { ex: AC_OWNER_TTL_SECONDS });
      // AC does not always return a displayable book title. This metadata is
      // stored only at creation and read only after the ownership filter above.
      if (!item.book_name && !item.bookName && !item.title) {
        try {
          const rawMeta = await redis.get(`ac_thread_book:${threadId}`);
          const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
          if (meta && typeof meta.bookName === 'string' && meta.bookName.trim()) {
            item.book_name = meta.bookName.trim();
          }
        } catch (_error) {
          // Metadata improves display and search only.
        }
      }
    }));

    const result = {
      pageIndex: clientPi,
      pageSize: allItems.length,
      total: allItems.length,
      pageCount: 1,
      items: allItems
    };

    try {
      await redis.set(cacheKey, JSON.stringify({ items: allItems }), { ex: AC_LIST_CACHE_SECONDS });
    } catch (_error) {
      // Cache writes are optional; ownership hydration above remains authoritative.
    }

    return res.status(200).json({ success: true, data: result });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return res.status(504).json({ success: false, error: 'Video service timed out' });
    }
    if (e && e.acStatus) {
      return res.status(e.acStatus).json({ success: false, error: 'AC API error' });
    }
    return res.status(502).json({ error: 'Video service unavailable' });
  }
};
