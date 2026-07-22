const crypto = require('crypto');
const { handlePreflight } = require('./_lib/cors');
const { getAuthPayload, getRedis, checkRateLimit, getClientIp } = require('./_lib/security');
const { getBookstoreToken } = require('./_lib/oidc-token');
const {
  APPLICATION_ID,
  EQUITY_API_BASE,
  BOOK_API_BASE,
  VALIDITY_MS,
  FIRST_CODE,
  canonicalUsername,
  safeParse,
  extractRows,
  extractBook,
  normalizeRemoteRecord,
  publicRecord,
  equityPayload,
} = require('./_lib/equity-code');

const LOCK_SECONDS = 45;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_CODE_ATTEMPTS = 50;

function recordKey(username) {
  return `nf_equity_code:${username}`;
}

function lockKey(username) {
  return `nf_equity_code_lock:${username}`;
}

async function loadRecord(redis, username) {
  return safeParse(await redis.get(recordKey(username)));
}

async function saveRecord(redis, username, record) {
  await redis.set(recordKey(username), JSON.stringify(record));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const body = text ? safeParse(text, { raw: text.slice(0, 300) }) : {};
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function findRemote(token, filters) {
  const query = new URLSearchParams({
    pageIndex: '1',
    pageSize: '100',
    applicationId: APPLICATION_ID,
  });
  if (filters.kolName) query.set('kolName', filters.kolName);
  if (filters.code) query.set('code', String(filters.code));

  const { response, body } = await fetchJson(`${EQUITY_API_BASE}/page?${query}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`Equity lookup failed (${response.status})`);

  return extractRows(body).find(row => {
    if (filters.kolName && canonicalUsername(row.kolName) !== canonicalUsername(filters.kolName)) return false;
    if (filters.code && String(row.code || '').toLowerCase() !== String(filters.code).toLowerCase()) return false;
    return true;
  }) || null;
}

async function verifyBook(token, bookId) {
  const query = new URLSearchParams({
    current: '1',
    pageIndex: '1',
    pageSize: '5',
    applicationId: APPLICATION_ID,
    bookStatus: '1',
    bookIds: bookId,
  });
  const { response, body } = await fetchJson(`${BOOK_API_BASE}/booklist?${query}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`Book lookup failed (${response.status})`);
  return extractBook(body, bookId);
}

async function allocateCode(redis, token, username) {
  const counterKey = 'nf_equity_code_counter';
  await redis.set(counterKey, FIRST_CODE - 1, { nx: true });
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = String(await redis.incr(counterKey));
    const existing = await findRemote(token, { code });
    if (!existing) return code;
    if (canonicalUsername(existing.kolName) === username) return code;
  }
  throw new Error('No invite code is currently available');
}

async function createRemote(token, payload) {
  const { response, body } = await fetchJson(`${EQUITY_API_BASE}/save`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const applicationError = body && (body.success === false || (Number.isFinite(Number(body.code)) && ![0, 200].includes(Number(body.code))));
  if (!response.ok || applicationError) {
    const error = new Error(`Equity creation failed (${response.status})`);
    error.responseBody = body;
    throw error;
  }
  return body;
}

async function releaseLock(redis, key, token) {
  try {
    if (await redis.get(key) === token) await redis.del(key);
  } catch (_error) {
    // The lock expires automatically.
  }
}

async function ensureAccountEnabled(redis, username) {
  const userData = safeParse(await redis.get(`nf_user_data:${username}`), {});
  return !userData.disabled;
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const auth = getAuthPayload(req);
  const username = canonicalUsername(auth && auth.username);
  if (!username) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });

  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Storage unavailable', code: 'STORAGE_UNAVAILABLE' });
  if (!await ensureAccountEnabled(redis, username)) {
    return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
  }

  if (req.method === 'GET') {
    const stored = await loadRecord(redis, username);
    return res.status(200).json({ success: true, inviteCode: publicRecord(stored) });
  }

  const allowed = await checkRateLimit(redis, `nf_rate:equity:${username}`, 10, 3600) &&
    await checkRateLimit(redis, `nf_rate:equity_ip:${getClientIp(req)}`, 30, 3600);
  if (!allowed) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });

  const bookId = String((req.body && req.body.bookId) || '').trim();
  if (!/^[a-f0-9]{24}$/i.test(bookId)) {
    return res.status(400).json({ error: 'Select a valid book from search results', code: 'INVALID_BOOK' });
  }

  const key = lockKey(username);
  const lockToken = crypto.randomUUID();
  const locked = await redis.set(key, lockToken, { nx: true, ex: LOCK_SECONDS });
  if (!locked) {
    const current = await loadRecord(redis, username);
    return res.status(409).json({
      error: 'Invite code creation is already in progress',
      code: 'CREATION_IN_PROGRESS',
      inviteCode: publicRecord(current),
    });
  }

  try {
    let record = await loadRecord(redis, username);
    if (record && ['active', 'expired'].includes(publicRecord(record).status)) {
      return res.status(200).json({ success: true, inviteCode: publicRecord(record), existing: true });
    }
    if (record && record.bookId && record.bookId !== bookId) {
      return res.status(409).json({
        error: 'This account already has an invite code request for another book',
        code: 'BOOK_ALREADY_SELECTED',
        inviteCode: publicRecord(record),
      });
    }

    const token = await getBookstoreToken();
    if (!token) return res.status(503).json({ error: 'Bookstore authentication unavailable', code: 'UPSTREAM_AUTH_UNAVAILABLE' });

    const remoteExisting = await findRemote(token, { kolName: username });
    if (remoteExisting) {
      record = normalizeRemoteRecord(remoteExisting, username);
      await saveRecord(redis, username, record);
      return res.status(200).json({ success: true, inviteCode: publicRecord(record), existing: true });
    }

    const book = await verifyBook(token, bookId);
    if (!book) return res.status(400).json({ error: 'The selected book no longer exists', code: 'BOOK_NOT_FOUND' });
    const verifiedTitle = String(book.title || book.bookName || '').trim();
    if (!verifiedTitle) return res.status(502).json({ error: 'Book data is incomplete', code: 'INVALID_BOOK_DATA' });

    let code = record && record.code ? String(record.code) : null;
    if (code) {
      const codeOwner = await findRemote(token, { code });
      if (codeOwner && canonicalUsername(codeOwner.kolName) !== username) code = null;
    }
    if (!code) code = await allocateCode(redis, token, username);
    const now = Date.now();
    record = {
      status: 'processing', username, code, bookId, bookTitle: verifiedTitle,
      channel: 'Facebook', rewardName: '1-Day VIP', rewardDays: 1,
      startTime: now, endTime: now + VALIDITY_MS,
      createdAt: record && record.createdAt ? record.createdAt : now,
      updatedAt: now,
    };
    await saveRecord(redis, username, record);

    const payload = equityPayload({ username, code, bookId, now });
    try {
      const result = await createRemote(token, payload);
      const data = result && result.data;
      record.status = 'active';
      record.remoteId = (data && data.id) || result.id || null;
      record.updatedAt = Date.now();
      await saveRecord(redis, username, record);
      return res.status(201).json({ success: true, inviteCode: publicRecord(record) });
    } catch (error) {
      let reconciled = null;
      try { reconciled = await findRemote(token, { kolName: username }); } catch (_lookupError) {}
      if (reconciled) {
        record = normalizeRemoteRecord(reconciled, username);
        if (!record.bookTitle) record.bookTitle = verifiedTitle;
        await saveRecord(redis, username, record);
        return res.status(200).json({ success: true, inviteCode: publicRecord(record), reconciled: true });
      }
      record.status = 'failed';
      record.lastError = error.message;
      record.updatedAt = Date.now();
      await saveRecord(redis, username, record);
      return res.status(502).json({
        error: 'Invite code creation failed. You can safely retry with the same book.',
        code: 'UPSTREAM_CREATE_FAILED',
        inviteCode: publicRecord(record),
      });
    }
  } catch (error) {
    console.error('[equity-code]', error.message);
    return res.status(502).json({ error: 'Invite code service unavailable', code: 'UPSTREAM_UNAVAILABLE' });
  } finally {
    await releaseLock(redis, key, lockToken);
  }
};
