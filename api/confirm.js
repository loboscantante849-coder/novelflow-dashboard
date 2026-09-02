/**
 * POST /api/confirm
 *
 * v2.5.1 - Security P0 fixes 2026-07-06 (C-02, H-04, M-05)
 *  - JWT required (401 if not logged in); discordUsername is taken from JWT, body value ignored.
 *  - Strict schema validation: bookName/bookId/bookTitle/lang must be strings with length caps.
 *  - Per explicit request id dedup; a book may have multiple independent links/codes.
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
const { commitUserDataUnderLock, releaseUserDataLock } = require('./_lib/user-data-lock');
const { acquireWalletCreationSourceGuard, assertApprovedSourceAccess } = require('./_lib/income-source-owners');
const {
  acquireWalletDataLock,
  resolveUsernameAlias,
  resolveReadOnlyWalletStorageIdentity,
  walletIdentityConflict,
} = require('./_lib/wallet-identity');
const {
  normalizeHttpsCoverUrl,
  fetchTrustedBookCover,
  cacheBookCover,
} = require('./_lib/book-covers');

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
const CODE_COLLISION_STRIDE = 100;

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

async function upstreamErrorSummary(response) {
  if (!response || typeof response.clone !== 'function') return '';
  try {
    const data = await response.clone().json();
    const code = String(data?.code ?? data?.status ?? data?.errorCode ?? '').slice(0, 40);
    const message = stripHtml(String(data?.message ?? data?.msg ?? data?.error ?? ''))
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 180);
    return [code && `code=${code}`, message && `message=${message}`].filter(Boolean).join(', ');
  } catch (_) {
    return '';
  }
}

function isPromotionCodeCollision(summary) {
  return /keyword.{0,80}(exist|duplicate|already)/i.test(String(summary || ''));
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
    const identity = await resolveReadOnlyWalletStorageIdentity(redis, u);
    if (identity.conflict) throw walletIdentityConflict(identity);
    const rawUd = await redis.get(`nf_user_data:${identity.storageUsername}`);
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
                cover: normalizeHttpsCoverUrl(b.cover || b.coverImage || ''),
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

async function isActiveConfirmLock(redis, key, record) {
  if (!redis || !record?.pending) return false;
  const startedAt = Number(record.startedAt);
  if (Number.isFinite(startedAt)) {
    return startedAt > Date.now() - (CONFIRM_LOCK_TTL * 1000);
  }

  // Older failed requests overwrote the 15-minute in-flight lock with a
  // 24-hour pending record. A legacy pending value with a longer TTL is a
  // failed request, not work that is still running.
  const ttl = await redis.ttl(key);
  return ttl >= 0 && ttl <= CONFIRM_LOCK_TTL;
}

async function reserveNextCode(redis, fallbackCode) {
  if (!redis) return fallbackCode;
  await redis.set('nf_next_code', STARTING_CODE, { nx: true });
  let reserved = Number(await redis.incr('nf_next_code')) - 1;
  if (!Number.isFinite(reserved) || reserved < STARTING_CODE) {
    await redis.set('nf_next_code', STARTING_CODE, { xx: true });
    reserved = Number(await redis.incr('nf_next_code')) - 1;
  }
  if (!Number.isFinite(reserved) || reserved < STARTING_CODE) {
    const error = new Error('promotion code counter is invalid');
    error.code = 'CODE_COUNTER_INVALID';
    throw error;
  }
  return reserved;
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
  let lock = null;
  try {
    const walletLock = await acquireWalletDataLock(redis, username, { allowReviewedLegacyConflict: true });
    lock = walletLock.lock;
    if (!lock) {
      const error = new Error('user data is busy');
      error.code = 'USER_DATA_BUSY';
      throw error;
    }
    const userKey = `nf_user_data:${walletLock.identity.storageUsername}`;
    const raw = await redis.get(userKey);
    let data = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const error = new Error('user data is corrupt');
      error.code = 'USER_DATA_CORRUPT';
      throw error;
    }
    if (data.disabled) {
      const error = new Error('account is disabled');
      error.code = 'ACCOUNT_DISABLED';
      throw error;
    }
    if (data.wallet_merged_into) {
      const error = new Error('wallet has been merged');
      error.code = 'WALLET_MERGED';
      throw error;
    }
    if (!Array.isArray(data.myBooks)) data.myBooks = [];
    const key = String(submission.code || submission.linkId || submission.bookId || '');
    // A book is not the identity of a promotion asset. Keep every code/link
    // for the same book; only an exact asset identifier may be merged on retry.
    const index = data.myBooks.findIndex(book => {
      if (!book) return false;
      const sameCode = submission.code && book.code && String(book.code) === String(submission.code);
      const sameLinkId = submission.linkId && book.linkId && String(book.linkId) === String(submission.linkId);
      return Boolean(sameCode || sameLinkId || (key && !submission.bookId && String(book.code || book.linkId || '') === key));
    });
    const existingBook = index >= 0 && data.myBooks[index] && typeof data.myBooks[index] === 'object'
      ? data.myBooks[index]
      : null;
    const existingSameBook = data.myBooks.find(book => book && submission.bookId &&
      String(book.bookId || '') === String(submission.bookId));
    const book = {
      bookId: submission.bookId,
      title: submission.matchedBookName || submission.bookName || 'Unknown',
      bookName: submission.bookName || submission.matchedBookName || 'Unknown',
      // A retry/repair must not erase a cover already synced to the account.
      cover: normalizeHttpsCoverUrl(submission.cover) ||
        normalizeHttpsCoverUrl(existingBook?.cover || existingBook?.coverImage ||
          existingSameBook?.cover || existingSameBook?.coverImage || ''),
      submittedAt: submission.submittedAt || new Date().toISOString(),
    };
    if (submission.code) book.code = String(submission.code);
    if (submission.link) book.link = submission.link;
    if (submission.linkId) book.linkId = submission.linkId;
    if (index >= 0) data.myBooks[index] = { ...data.myBooks[index], ...book };
    else data.myBooks.push(book);
    data.lastSyncAt = Date.now();
    await commitUserDataUnderLock(redis, userKey, data, [lock]);
  } finally {
    await releaseUserDataLock(redis, lock);
  }
}

async function establishWalletSourceOwnership(redis, username) {
  let lock = null;
  let sourceGuard = null;
  try {
    const walletLock = await acquireWalletDataLock(redis, username, { allowReviewedLegacyConflict: true });
    lock = walletLock.lock;
    if (!lock) {
      const error = new Error('user data is busy');
      error.code = 'USER_DATA_BUSY';
      throw error;
    }
    sourceGuard = await acquireWalletCreationSourceGuard(redis, username, walletLock.identity);
    const userKey = `nf_user_data:${walletLock.identity.storageUsername}`;
    const raw = await redis.get(userKey);
    if (raw == null) {
      // Establish the wallet owner before any upstream code/link side effect.
      // A competing approved raw alias will see this record under the source
      // lock and fail closed instead of creating an orphan promotion asset.
      await commitUserDataUnderLock(redis, userKey, {}, [lock, sourceGuard]);
      return walletLock.identity;
    }
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (cause) {
      const error = new Error('user data is corrupt');
      error.code = 'USER_DATA_CORRUPT';
      error.cause = cause;
      throw error;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const error = new Error('user data is corrupt');
      error.code = 'USER_DATA_CORRUPT';
      throw error;
    }
    if (data.disabled) {
      const error = new Error('account is disabled');
      error.code = 'ACCOUNT_DISABLED';
      throw error;
    }
    if (data.wallet_merged_into) {
      const error = new Error('wallet has been merged');
      error.code = 'WALLET_MERGED';
      throw error;
    }
    return walletLock.identity;
  } finally {
    await releaseUserDataLock(redis, sourceGuard);
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
    if (await isDisabledUser(redis, payload, { failClosed: true, allowSafeReadOnlyWalletConflict: true })) {
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
  const vRequestId = validateString(body.requestId, { name: 'requestId', maxLen: 80 });
  if (!vRequestId.ok) return res.status(vRequestId.status).json({ error: vRequestId.error });

  // Strip HTML from all text fields
  const cleanUsername = resolveUsernameAlias(stripHtml(username).substring(0, 50)) || 'Anonymous';
  const cleanBookName = stripHtml(vBookName.value).substring(0, 200);
  const cleanBookTitle = stripHtml(vBookTitle.value).substring(0, 200);
  const lang = vLang.value || 'en';
  const languageCode = (lang === 'es' ? 'es' : 'en');
  const bookId = vBookId.value; // already validated as string ≤64
  const requestId = vRequestId.value ? String(vRequestId.value).trim() : '';
  if (requestId && !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    return res.status(400).json({ error: 'Invalid request id', code: 'INVALID_REQUEST_ID' });
  }

  // Promotion assets are independent per request, but the authenticated
  // account still must be an approved owner of its reporting source. Reviewed
  // historical aliases (Cons/DRAS) are accepted as one canonical owner.
  try {
    const identity = await resolveReadOnlyWalletStorageIdentity(redis, cleanUsername);
    if (identity.conflict) throw walletIdentityConflict(identity);
    await assertApprovedSourceAccess(redis, cleanUsername, identity);
  } catch (error) {
    if (error && error.code === 'WALLET_IDENTITY_CONFLICT') {
      return res.status(409).json({ error: 'Account identity recovery required', code: error.code });
    }
    if (error && ['INCOME_SOURCE_OWNER_UNVERIFIED', 'INCOME_SOURCE_OWNER_CONFLICT', 'INCOME_SOURCE_BUSY'].includes(error.code)) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    return res.status(503).json({ error: 'Service temporarily unavailable', code: error && error.code || 'USER_DATA_UNAVAILABLE' });
  }

  // -------- DEDUP CHECK (before consuming any rate limit quota) --------
  // Explicit request ids make each deliberate create independent, so one book
  // can have multiple promotion assets. Legacy callers without a request id
  // retain the old per-book idempotency behavior.
  const dedupKey = requestId
    ? `nf_confirm_dedup:${cleanUsername.toLowerCase()}:${bookId}:${requestId}`
    : `nf_confirm_dedup:${cleanUsername.toLowerCase()}:${bookId}`;
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
            if (await isActiveConfirmLock(redis, dedupKey, c)) {
              return res.status(200).json({
                success: true,
                status: 'pending',
                submissionId: c.submissionId || null,
                matchedBookName: cleanBookTitle || cleanBookName,
                message: 'Link is being created for this book'
              });
            }
            await redis.del(dedupKey);
          } else {
            existingCode = String(c.code); existingLink = c.link || null; existingLinkId = c.linkId || null;
            existingSubmission = c.submission && typeof c.submission === 'object' ? c.submission : null;
          }
        }
      } catch { if (typeof cached === 'string' && /^\d+$/.test(cached)) existingCode = cached; }
    }
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'DEDUP_UNAVAILABLE' });
  }
  // Fallback: scan-based lookup (for entries created before dedupKey was added)
  if (!existingCode && !requestId) {
    try {
      const existing = await findExistingForBook(redis, cleanUsername, bookId);
      if (existing) {
        existingCode = existing.code;
        existingLink = existing.link;
        existingLinkId = existing.linkId;
        existingSubmission = existing.submission || null;
      }
    } catch (error) {
      if (error && error.code === 'WALLET_IDENTITY_CONFLICT') {
        return res.status(409).json({ error: 'Account identity recovery required', code: error.code });
      }
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
        JSON.stringify({ pending: true, submissionId, startedAt: Date.now() }),
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
    let fallbackCode = STARTING_CODE;
    let lastAllocationStatus = null;
    let allocationAttempts = 0;
    for (let attempts = 0; attempts < MAX_CODE_ATTEMPTS; attempts++) {
      const reservedCode = await reserveNextCode(redis, fallbackCode++);
      const tryCode = reservedCode + (attempts * CODE_COLLISION_STRIDE);
      if (tryCode >= MAX_CODE) break;
      allocationAttempts += 1;
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

      lastAllocationStatus = codeResp.status;
      if (authUnavailable || codeResp.status === 401 || codeResp.status === 403) {
        upstreamAuthUnavailable = true;
        break;
      }
      if (codeResp.ok) {
        const codeData = await codeResp.json();
        if (codeData.data) {
          finalCode = tryCode;
          break;
        }
        // A 2xx response without data means this keyword is already occupied.
        // The atomic counter lets this request and concurrent users move on.
        continue;
      }
      const detail = await upstreamErrorSummary(codeResp);
      if (codeResp.status === 400 && isPromotionCodeCollision(detail)) continue;
      // Other validation, server, and throttling failures will not be fixed by
      // changing only the keyword. Release the lock and let the client retry.
      console.error(`[confirm] Bookstore code allocation rejected: status=${codeResp.status}${detail ? `, ${detail}` : ''}`);
      break;
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
      if (confirmLockOwned) await releaseConfirmLock(redis, dedupKey, submissionId);
      confirmLockOwned = false;
      console.error(`[confirm] Code allocation failed after ${allocationAttempts} attempts; upstream status=${lastAllocationStatus || 'none'}`);
      return res.status(502).json({
        success: false, submissionId, status: 'failed',
        error: 'Unable to allocate a promotion code. Please retry.',
        code: 'CODE_ALLOCATION_FAILED',
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

    // Never trust a client-provided image URL. Resolve the selected book again
    // from the authenticated bookstore API; cover failures remain cosmetic and
    // must not roll back a valid promotion code/link.
    let trustedCover = '';
    try {
      const coverBudgetMs = deadlineAt - Date.now();
      if (coverBudgetMs >= 700) {
        trustedCover = await fetchTrustedBookCover(bookId, { timeoutMs: Math.min(3000, coverBudgetMs) });
      }
    } catch (error) {
      console.warn('[confirm] trusted cover lookup failed:', error.message);
    }

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
    if (trustedCover) completedSub.cover = trustedCover;

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
      if (trustedCover) {
        try {
          await cacheBookCover(redis, bookId, trustedCover);
        } catch (error) {
          console.warn('[confirm] cover cache write failed:', error.message);
        }
      }
      await persistSubmissionIndexes(redis, cleanUsername, completedSub);
      try {
        await persistUserBook(redis, cleanUsername, completedSub);
      } catch (e) {
        if (e?.code === 'WALLET_IDENTITY_CONFLICT') {
          console.warn('[confirm] wallet cache skipped:', e.code);
        } else {
        console.error('[confirm] myBooks merge failed:', e.message);
        const persistenceError = new Error(`User promotion data could not be merged: ${e.message}`);
        persistenceError.code = e.code || 'USER_DATA_UNAVAILABLE';
        throw persistenceError;
        }
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
    if (error && error.code === 'WALLET_IDENTITY_CONFLICT') {
      return res.status(409).json({
        success: false,
        submissionId,
        status: 'failed',
        error: 'Account identity recovery required',
        code: error.code,
      });
    }
    if (error && error.code === 'ACCOUNT_DISABLED') {
      return res.status(403).json({
        success: false,
        submissionId,
        status: 'failed',
        error: 'Account disabled',
        code: error.code,
      });
    }
    if (error && error.code === 'WALLET_MERGED') {
      return res.status(409).json({
        success: false,
        submissionId,
        status: 'failed',
        error: 'Wallet merged into a primary account',
        code: error.code,
      });
    }
    if (error && ['INCOME_SOURCE_OWNER_UNVERIFIED', 'INCOME_SOURCE_OWNER_CONFLICT', 'INCOME_SOURCE_BUSY'].includes(error.code)) {
      return res.status(409).json({
        success: false,
        submissionId,
        status: 'failed',
        error: error.message,
        code: error.code,
      });
    }
    const timedOut = error && error.code === 'UPSTREAM_TIMEOUT';
    return res.status(timedOut ? 504 : 502).json({
      success: false, submissionId, status: 'failed',
      error: timedOut ? 'Bookstore request timed out. Please retry.' : 'Unable to create the promotion link. Please retry.',
      code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
    });
  }
};

module.exports._test = {
  establishWalletSourceOwnership,
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
