/**
 * POST /api/confirm
 *
 * v2.5.1 - Security P0 fixes 2026-07-06 (C-02, H-04, M-05)
 *  - JWT required (401 if not logged in); discordUsername is taken from JWT, body value ignored.
 *  - Strict schema validation: bookName/bookId/bookTitle/lang must be strings with length caps.
 *  - Per (username, bookId) dedup against nf_subs + nf_user_data:<u>.myBooks.
 *  - Per-user daily creation cap (50) + IP rate limit (anon 5/h, logged-in 50/h).
 *  - All text inputs stripped of HTML tags before storage.
 *  - Disabled accounts (nf_user_data:<u>.disabled) rejected.
 */
const { handlePreflight } = require('./_lib/cors');
const { bookstoreFetch } = require('./_lib/bookstore-fetch');
const {
  getClientIp, getAuthPayload, checkRateLimit,
  validateString, stripHtml, isDisabledUser,
} = require('./_lib/security');
const { normalizeRedisKey } = require('./_lib/redis-values');
const { Redis } = require('@upstash/redis');
const { acquireUserDataLock, releaseUserDataLock } = require('./_lib/user-data-lock');

const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
const DEFAULT_CHANNEL_NAME = 'NovelFlow_SocialMedia_Facebook-grounp_Facebook_xujt';
const DEFAULT_CHANNEL_NAME_ID = '699ef7b8194eb218db3c2270';
const STARTING_CODE = 1000;
const MAX_CODE = 99999;

// Rate limits
const AUTH_IP_LIMIT = 50;
const USER_DAILY_LIMIT = 50;
const RATE_WINDOW = 3600; // 1h for IP
const DAILY_WINDOW = 86400; // 24h for per-user daily cap
const CONFIRM_LOCK_TTL = 900; // Covers the slowest upstream code-allocation retry window.
const UPSTREAM_DEADLINE_MS = 24000;
const UPSTREAM_REQUEST_TIMEOUT_MS = 5000;
const MAX_CODE_ATTEMPTS = 8;

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

/**
 * Look up CPS channel config for a user from KV.
 */
async function getCpsChannel(redis, username) {
  if (!redis || !username) return null;
  const raw = await redis.hget('nf_cps_channels', username.toLowerCase());
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function upstreamTimeout(deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining < 500) {
    const error = new Error('Bookstore request timed out');
    error.code = 'UPSTREAM_TIMEOUT';
    throw error;
  }
  return Math.min(UPSTREAM_REQUEST_TIMEOUT_MS, remaining);
}

async function fetchBookstore(url, options, deadlineAt) {
  return bookstoreFetch(url, options, { timeoutMs: upstreamTimeout(deadlineAt) });
}

async function ensureCpsChannel(redis, username, deadlineAt) {
  if (!username || username === 'Anonymous') return null;
  const existing = await getCpsChannel(redis, username);
  if (existing) return existing;

  let channelCode = username.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 50);
  if (!channelCode) {
    console.warn(`[ensureCpsChannel] Non-ASCII username "${username}" - fallback default`);
    return null;
  }
  const fullChannelCode = `NovelFlow_SocialMedia_CPS_${channelCode}`;

  try {
      const { response: listResp } = await fetchBookstore(
        `https://admin.novelspa.app/api/v1/novelmanage/SocialMediaChannelConfig?productLine=NovelFlow&channelSource=CPS&channelNumber=${encodeURIComponent(channelCode)}&page=1&pageSize=10`,
        {
          headers: {
            'X-OS': 'web', 'X-AppName': 'web-admin',
            'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1',
            'Origin': 'https://admin.novelspa.app'
          }
        },
        deadlineAt,
      );
      if (listResp && listResp.ok) {
        const listData = await listResp.json();
        if (listData.data?.data?.length > 0) {
          const existingCh = listData.data.data.find(ch => ch.channelCode === channelCode);
          if (existingCh) {
            const info = {
              channelCode: existingCh.channelCode,
              channelNameId: existingCh.id,
              fullChannelCode: existingCh.fullChannelCode
            };
            await redis.hset('nf_cps_channels', { [username.toLowerCase()]: JSON.stringify(info) });
            return info;
          }
        }
      }
  } catch (e) { console.error('[ensureCpsChannel] List lookup failed:', e.message); }
  return null;
}

/**
 * Find an existing submission for (username, bookId) from nf_subs + nf_user_data:<u>.myBooks.
 * Returns {code, link, linkId} or null.
 */
async function findExistingForBook(redis, username, bookId) {
  if (!redis) return null;
  const u = username.toLowerCase();
  try {
    // 1. Scan nf_user_subs set
    const members = await redis.smembers(`nf_user_subs:${u}`);
    if (members && members.length) {
      for (const rawKey of members) {
        const key = normalizeRedisKey(rawKey);
        if (!key) continue;
        if (key.startsWith('_pending_')) continue;
        const raw = await redis.hget('nf_subs', key);
        if (!raw) continue;
        let sub;
        try { sub = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
        if (sub && String(sub.bookId) === String(bookId) && sub.code && sub.status !== 'failed') {
          return {
            code: String(sub.code), link: sub.link || null, linkId: sub.linkId || null,
            submission: sub,
          };
        }
      }
    }
    // 2. Check nf_user_data:<u>.myBooks
    const rawUd = await redis.get(`nf_user_data:${u}`);
    if (rawUd) {
      let ud;
      try { ud = typeof rawUd === 'string' ? JSON.parse(rawUd) : rawUd; } catch { ud = null; }
      if (ud && Array.isArray(ud.myBooks)) {
        for (const b of ud.myBooks) {
          if (b && String(b.bookId || b.id) === String(bookId) && (b.code || b.link)) {
            return {
              code: b.code ? String(b.code) : null, link: b.link || null, linkId: b.linkId || null,
              submission: {
                discordUsername: username,
                status: 'completed',
                bookId: b.bookId || b.id,
                matchedBookName: b.title || b.bookName || 'Unknown',
                bookName: b.title || b.bookName || 'Unknown',
                code: b.code ? String(b.code) : null,
                link: b.link || null,
                linkId: b.linkId || null,
                submittedAt: b.submittedAt || null,
              },
            };
          }
        }
      }
    }
    return null;
  } catch (e) {
    console.error('[confirm] findExistingForBook error:', e.message);
    throw e;
  }
}

async function releaseConfirmLock(redis, key, submissionId) {
  if (!redis || !submissionId) return;
  try {
    const raw = await redis.get(key);
    const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (record?.pending && record.submissionId === submissionId) await redis.del(key);
  } catch (error) {
    console.error('[confirm] lock release failed:', error.message);
  }
}

async function persistSubmissionIndexes(redis, username, submission) {
  const code = String(submission.code);
  const userKey = `nf_user_subs:${String(username).toLowerCase()}`;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await redis.hset('nf_subs', { [code]: JSON.stringify(submission) });
      await redis.sadd(userKey, code);
      const saved = await redis.hget('nf_subs', code);
      if (!saved) throw new Error('submission record verification failed');
      const members = await redis.smembers(userKey);
      if (!members.some(member => normalizeRedisKey(member) === code)) throw new Error('submission index verification failed');
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const error = new Error(`Promotion record could not be persisted: ${lastError?.message || 'unknown error'}`);
  error.code = 'SUBMISSION_PERSIST_FAILED';
  throw error;
}

async function repairSubmissionIndex(redis, username, code, submission = null) {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) return false;
  const raw = await redis.hget('nf_subs', normalizedCode);
  if (!raw && submission && String(submission.code || '') === normalizedCode) {
    await redis.hset('nf_subs', { [normalizedCode]: JSON.stringify(submission) });
  } else if (!raw) {
    return false;
  }
  const userKey = `nf_user_subs:${String(username).toLowerCase()}`;
  await redis.sadd(userKey, normalizedCode);
  const members = await redis.smembers(userKey);
  return members.some(member => normalizeRedisKey(member) === normalizedCode);
}

async function persistUserBook(redis, username, submission) {
  const userKey = `nf_user_data:${String(username).toLowerCase()}`;
  let lock = null;
  try {
    lock = await acquireUserDataLock(redis, username);
    if (!lock) {
      const error = new Error('user data is busy');
      error.code = 'USER_DATA_BUSY';
      throw error;
    }
    const raw = await redis.get(userKey);
    let data = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const error = new Error('user data is corrupt');
      error.code = 'USER_DATA_CORRUPT';
      throw error;
    }
    if (!Array.isArray(data.myBooks)) data.myBooks = [];
    const key = String(submission.code || submission.linkId || submission.bookId || '');
    const index = data.myBooks.findIndex(book => (
      book && (String(book.code || book.linkId || book.bookId || '') === key ||
        (submission.bookId && String(book.bookId || '') === String(submission.bookId)))
    ));
    const existingBook = index >= 0 && data.myBooks[index] && typeof data.myBooks[index] === 'object'
      ? data.myBooks[index]
      : null;
    const book = {
      bookId: submission.bookId,
      title: submission.matchedBookName || submission.bookName || 'Unknown',
      bookName: submission.bookName || submission.matchedBookName || 'Unknown',
      // A retry/repair must not erase a cover already synced to the account.
      cover: existingBook?.cover || '',
      submittedAt: submission.submittedAt || new Date().toISOString(),
    };
    if (submission.code) book.code = String(submission.code);
    if (submission.link) book.link = submission.link;
    if (submission.linkId) book.linkId = submission.linkId;
    if (index >= 0) data.myBooks[index] = { ...data.myBooks[index], ...book };
    else data.myBooks.push(book);
    data.lastSyncAt = Date.now();
    await redis.set(userKey, JSON.stringify(data));
  } finally {
    await releaseUserDataLock(redis, lock);
  }
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // -------- AUTH (C-02) --------
  const payload = getAuthPayload(req);
  const username = String(payload && payload.username || '').trim();
  if (!payload || !username) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }

  // Code allocation, deduplication, ownership checks, and rate limits all
  // depend on Redis. Never create upstream records without those safeguards.
  const redis = redisClient();
  if (!redis) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'STORAGE_UNAVAILABLE' });
  }

  const clientIp = getClientIp(req);

  // IP-based rate limit (H-04)
  const ipKey = `nf_rate:confirm_ip:${clientIp}`;
  try {
    if (!await checkRateLimit(redis, ipKey, AUTH_IP_LIMIT, RATE_WINDOW, { failClosed: true })) {
      return res.status(429).json({ error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' });
    }
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
  }

  // Disabled account check
  try {
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  // -------- SCHEMA VALIDATION (M-05) --------
  const body = req.body || {};
  // IGNORE body.discordUsername — use JWT username
  const vBookName = validateString(body.bookName, { name: 'bookName', maxLen: 200, required: true });
  if (!vBookName.ok) return res.status(vBookName.status).json({ error: vBookName.error });
  const vBookId = validateString(body.bookId, { name: 'bookId', maxLen: 64, required: true });
  if (!vBookId.ok) return res.status(vBookId.status).json({ error: vBookId.error });
  const vBookTitle = validateString(body.bookTitle, { name: 'bookTitle', maxLen: 200 });
  if (!vBookTitle.ok) return res.status(vBookTitle.status).json({ error: vBookTitle.error });
  const vLang = validateString(body.lang, { name: 'lang', maxLen: 8 });
  if (!vLang.ok) return res.status(vLang.status).json({ error: vLang.error });
  const vNotes = validateString(body.notes, { name: 'notes', maxLen: 500 });
  if (!vNotes.ok) return res.status(vNotes.status).json({ error: vNotes.error });
  const vPromo = validateString(body.promotionMethod, { name: 'promotionMethod', maxLen: 200 });
  if (!vPromo.ok) return res.status(vPromo.status).json({ error: vPromo.error });

  // Strip HTML from all text fields
  const cleanUsername = stripHtml(username).substring(0, 50) || 'Anonymous';
  const cleanBookName = stripHtml(vBookName.value).substring(0, 200);
  const cleanBookTitle = stripHtml(vBookTitle.value).substring(0, 200);
  const lang = vLang.value || 'en';
  const languageCode = (lang === 'es' ? 'es' : 'en');
  const bookId = vBookId.value; // already validated as string ≤64

  // -------- DEDUP CHECK (before consuming any rate limit quota) --------
  // Primary: fast direct key (username,bookId) → code
  const dedupKey = `nf_confirm_dedup:${cleanUsername.toLowerCase()}:${bookId}`;
  let existingCode = null;
  let existingLink = null;
  let existingLinkId = null;
  let existingSubmission = null;
  try {
    const cached = await redis.get(dedupKey);
    if (cached) {
      try {
        const c = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (c && (c.code || c.pending)) {
          if (c.pending) {
            return res.status(200).json({
              success: true,
              status: 'pending',
              submissionId: c.submissionId || null,
              matchedBookName: cleanBookTitle || cleanBookName,
              message: 'Link is being created for this book'
            });
          }
          existingCode = String(c.code); existingLink = c.link || null; existingLinkId = c.linkId || null;
          existingSubmission = c.submission && typeof c.submission === 'object' ? c.submission : null;
        }
      } catch { if (typeof cached === 'string' && /^\d+$/.test(cached)) existingCode = cached; }
    }
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'DEDUP_UNAVAILABLE' });
  }
  // Fallback: scan-based lookup (for entries created before dedupKey was added)
  if (!existingCode) {
    try {
      const existing = await findExistingForBook(redis, cleanUsername, bookId);
      if (existing) {
        existingCode = existing.code;
        existingLink = existing.link;
        existingLinkId = existing.linkId;
        existingSubmission = existing.submission || null;
      }
    } catch (_error) {
      return res.status(503).json({ error: 'Service temporarily unavailable', code: 'DEDUP_UNAVAILABLE' });
    }
  }
  if (existingCode) {
    try {
      const repaired = await repairSubmissionIndex(redis, cleanUsername, existingCode, existingSubmission);
      if (!repaired) return res.status(503).json({ error: 'Promotion record is being repaired. Please retry.', code: 'SUBMISSION_INDEX_UNAVAILABLE' });
      return res.status(200).json({
        success: true,
        status: 'existing',
        code: existingCode,
        link: existingLink,
        linkId: existingLinkId,
        message: 'Link already exists for this book'
      });
    } catch (_error) {
      return res.status(503).json({ error: 'Promotion record is being repaired. Please retry.', code: 'SUBMISSION_INDEX_UNAVAILABLE' });
    }
  }

  // Per-user daily cap (only counted for NEW submissions, not dedup hits)
  {
    const userDailyKey = `nf_rate:confirm_user:${cleanUsername.toLowerCase()}:${new Date().toISOString().slice(0,10)}`;
    try {
      if (!await checkRateLimit(redis, userDailyKey, USER_DAILY_LIMIT, DAILY_WINDOW, { failClosed: true })) {
        return res.status(429).json({ error: 'Daily limit reached (50/day)', code: 'DAILY_LIMIT' });
      }
    } catch (_error) {
      return res.status(503).json({ error: 'Service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
    }
  }

  const submissionId = 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  let confirmLockOwned = false;

  // Close the network-retry race: only one request may allocate a code for a
  // given user/book pair at a time. The lock is replaced with the completed
  // code below, so a lost client response can safely retry.
  if (redis) {
    try {
      const lockResult = await redis.set(
        dedupKey,
        JSON.stringify({ pending: true, submissionId }),
        { nx: true, ex: CONFIRM_LOCK_TTL }
      );
      if (!lockResult) {
        const lockedRaw = await redis.get(dedupKey);
        let locked = null;
        try { locked = typeof lockedRaw === 'string' ? JSON.parse(lockedRaw) : lockedRaw; } catch {}
        if (locked?.code) {
          return res.status(200).json({
            success: true, status: 'existing', code: String(locked.code),
            link: locked.link || null, linkId: locked.linkId || null,
            message: 'Link already exists for this book'
          });
        }
        return res.status(200).json({
          success: true, status: 'pending',
          submissionId: locked?.submissionId || null,
          matchedBookName: cleanBookTitle || cleanBookName,
          message: 'Link is being created for this book'
        });
      }
      confirmLockOwned = true;
    } catch (_error) {
      return res.status(503).json({ error: 'Service temporarily unavailable', code: 'LOCK_UNAVAILABLE' });
    }
  }

  try {
    const deadlineAt = Date.now() + UPSTREAM_DEADLINE_MS;
    let finalCode = null;
    let upstreamAuthUnavailable = false;
    let startCode = STARTING_CODE;
    if (redis) {
      const hint = await redis.get('nf_next_code');
      if (hint) startCode = Math.max(STARTING_CODE, parseInt(hint) || STARTING_CODE);
    }

    for (let tryCode = startCode, attempts = 0; tryCode < MAX_CODE && attempts < MAX_CODE_ATTEMPTS; tryCode++, attempts++) {
      const { response: codeResp, authUnavailable } = await fetchBookstore(`${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'X-OS': 'web', 'X-AppName': 'web-admin',
            'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
          },
          body: JSON.stringify({
            applicationId: BOOKSTORE_APP_ID,
            keyword: String(tryCode),
            bookId: bookId,
            channel: 'CPS',
            isEnable: true
          }),
        }, deadlineAt);
      if (!codeResp) {
        upstreamAuthUnavailable = authUnavailable;
        break;
      }

      if (codeResp.ok) {
        const codeData = await codeResp.json();
        if (codeData.data) {
          finalCode = tryCode;
          if (redis) await redis.set('nf_next_code', tryCode + 1);
          break;
        }
      }
    }

    if (!finalCode) {
      if (upstreamAuthUnavailable) {
        if (confirmLockOwned) await releaseConfirmLock(redis, dedupKey, submissionId);
        return res.status(503).json({
          success: false,
          submissionId,
          status: 'failed',
          error: 'Bookstore authentication is temporarily unavailable. Please retry.',
          code: 'UPSTREAM_AUTH_UNAVAILABLE',
        });
      }
      if (redis) {
        const pendingSub = {
          id: submissionId,
          bookName: cleanBookName,
          discordUsername: cleanUsername,
          promotionMethod: stripHtml(vPromo.value).substring(0, 200),
          notes: stripHtml(vNotes.value).substring(0, 500),
          bookId, matchedBookName: cleanBookTitle || cleanBookName,
          lang: languageCode,
          submittedAt: new Date().toISOString(),
          status: 'pending',
          error: 'Code creation failed'
        };
        await redis.hset('nf_subs', { [`_pending_${submissionId}`]: JSON.stringify(pendingSub) });
        await redis.sadd(`nf_user_subs:${cleanUsername.toLowerCase()}`, `_pending_${submissionId}`);
        // Record dedup key even for pending, so user can't spam-create pending entries
        try {
          await redis.set(dedupKey, JSON.stringify({ code: null, link: null, linkId: null, pending: true, submissionId }), { ex: 86400 });
        } catch (e) { console.error('[confirm] dedupKey write failed (pending):', e.message); }
      }
      confirmLockOwned = false;
      return res.status(200).json({
        success: true, submissionId, status: 'pending',
        matchedBookName: cleanBookTitle || cleanBookName,
        message: 'Code creation failed'
      });
    }

    if (redis) {
      // Persist the allocated code before creating the optional short link.
      // If the client loses its response, a retry receives this code instead
      // of allocating another one.
      try {
        await redis.set(dedupKey, JSON.stringify({ code: String(finalCode), link: null, linkId: null }), { ex: 86400 });
        confirmLockOwned = false;
      } catch (e) { console.error('[confirm] dedupKey write failed (allocated code):', e.message); }
    }

    const cpsChannel = await ensureCpsChannel(redis, cleanUsername, deadlineAt);
    const linkResult = await createLink(bookId, cleanBookTitle || cleanBookName, finalCode, languageCode, cpsChannel, deadlineAt);

    const completedSub = {
      id: submissionId,
      bookName: cleanBookName,
      discordUsername: cleanUsername,
      promotionMethod: stripHtml(vPromo.value).substring(0, 200),
      notes: stripHtml(vNotes.value).substring(0, 500),
      bookId,
      matchedBookName: cleanBookTitle || cleanBookName,
      lang: languageCode,
      submittedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      status: 'completed',
      code: String(finalCode),
      completedAt: new Date().toISOString()
    };

    if (linkResult) {
      if (linkResult.shortUrl) {
        completedSub.link = `https://${linkResult.shortUrl}`;
        completedSub.shortUrl = linkResult.shortUrl;
      }
      if (linkResult.linkId) completedSub.linkId = linkResult.linkId;
      if (linkResult.campaignId) completedSub.campaignId = linkResult.campaignId;
      if (cpsChannel) completedSub.cpsChannelCode = cpsChannel.channelCode;
    }

    if (redis) {
      // Keep a complete recovery record before indexing it. A retry can use it
      // to restore a hash/set index after a transient write failure.
      // Fast dedup key: (username, bookId) → {code, link, linkId}
      try {
        await redis.set(dedupKey, JSON.stringify({
          code: String(finalCode),
          link: completedSub.link || null,
          linkId: completedSub.linkId || null,
          submission: completedSub,
        }), { ex: 86400 });
      } catch (e) { console.error('[confirm] dedupKey write failed:', e.message); }
      await persistSubmissionIndexes(redis, cleanUsername, completedSub);
      try {
        await persistUserBook(redis, cleanUsername, completedSub);
      } catch (e) {
        console.error('[confirm] myBooks merge failed:', e.message);
        const persistenceError = new Error(`User promotion data could not be merged: ${e.message}`);
        persistenceError.code = e.code || 'USER_DATA_UNAVAILABLE';
        throw persistenceError;
      }
    }

    console.log(`[confirm] OK: code=${finalCode}, user=${cleanUsername}, book=${cleanBookTitle || cleanBookName}`);

    return res.status(200).json({
      success: true, submissionId, status: 'completed',
      code: finalCode,
      link: linkResult?.shortUrl ? `https://${linkResult.shortUrl}` : null,
      linkId: linkResult?.linkId || null,
      matchedBookName: cleanBookTitle || cleanBookName,
      message: 'Link and code created successfully!'
    });

  } catch (error) {
    if (confirmLockOwned) await releaseConfirmLock(redis, dedupKey, submissionId);
    console.error('[confirm] Error:', error);
    const timedOut = error && error.code === 'UPSTREAM_TIMEOUT';
    return res.status(timedOut ? 504 : 502).json({
      success: false, submissionId, status: 'failed',
      error: timedOut ? 'Bookstore request timed out. Please retry.' : 'Unable to create the promotion link. Please retry.',
      code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
    });
  }
};

// ============ Create Short Link ============
async function createLink(bookId, bookTitle, code, languageCode, cpsChannel, deadlineAt) {
  const linkName = `${code}${bookTitle}-书籍详情页-CPS`;
  const channelName = cpsChannel ? cpsChannel.fullChannelCode : DEFAULT_CHANNEL_NAME;
  const channelNameId = cpsChannel ? cpsChannel.channelNameId : DEFAULT_CHANNEL_NAME_ID;

  const { response: linkResp } = await fetchBookstore(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-OS': 'web', 'X-AppName': 'web-admin',
      'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
    },
    body: JSON.stringify({
      linkName,
      applicationId: BOOKSTORE_APP_ID,
      mediaSource: cpsChannel ? cpsChannel.fullChannelCode : 'SocialMedia',
      channelName,
      channelNameId,
      contentType: 1,
      contentNameOrSku: bookId,
      contentName: bookTitle,
      languageCode,
      redirectConfigId: '68fecf8b3a29f6eff435fd3b',
      redirectPosition: '书籍详情页',
      redirectProtocol: 'novelflow:///book',
      contentRedirectSequence: 1,
      operatorName: '徐敬涛',
      templateId: '6a01499261118c6285dff7dd',
      isEnabled: true,
      landingPageTemplates: [{
        templateId: '6a01499261118c6285dff7dd',
        templateName: linkName,
        templateWeight: 100,
        isDeleted: false
      }]
    })
  }, deadlineAt);

  if (linkResp && linkResp.ok) {
    const linkData = await linkResp.json();
    if (linkData.code === 200 && linkData.data) {
      const responseLinkId = linkData.data;
      if (typeof responseLinkId === 'string' && responseLinkId.length > 10) {
        let shortUrl = null;
        try {
          const { response: detailResp } = await fetchBookstore(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig/${responseLinkId}`, {
            headers: { 'Content-Type': 'application/json' }
          }, deadlineAt);
          if (detailResp && detailResp.ok) {
            const detailData = await detailResp.json();
            if (detailData.code === 200 && detailData.data?.shortUrl) {
              shortUrl = detailData.data.shortUrl;
            }
          }
        } catch (e) { console.error('Link detail fetch failed:', e.message); }
        return { shortUrl, linkId: responseLinkId, campaignId: channelNameId };
      }
      if (typeof linkData.data === 'object' && linkData.data.shortUrl) {
        return { shortUrl: linkData.data.shortUrl, linkId: null, campaignId: channelNameId };
      }
    }
  }
  console.error('Link creation failed:', linkResp ? linkResp.status : 'auth unavailable');
  return null;
}
