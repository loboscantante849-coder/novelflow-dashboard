const crypto = require('crypto');
const { handlePreflight } = require('./_lib/cors');
const { getAuthPayload, getRedis, checkRateLimit, getClientIp } = require('./_lib/security');
const { bookstoreFetch } = require('./_lib/bookstore-fetch');
const {
  APPLICATION_ID,
  EQUITY_API_BASE,
  BOOK_API_BASE,
  VALIDITY_MS,
  RECREATE_COOLDOWN_MS,
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
const REQUEST_TIMEOUT_MS = 5000;
const OPERATION_DEADLINE_MS = 24000;
const MAX_CODE_ATTEMPTS = 8;

function recordKey(username) {
  return `nf_equity_code:${username}`;
}

function lockKey(username) {
  return `nf_equity_code_lock:${username}`;
}

function isRemoteEnabled(row) {
  return !row || ![false, 0, 'false', '0'].includes(row.isEnable);
}

async function loadRecord(redis, username) {
  return safeParse(await redis.get(recordKey(username)));
}

async function saveRecord(redis, username, record) {
  await redis.set(recordKey(username), JSON.stringify(record));
}

function remainingTimeout(deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining < 500) {
    const error = new Error('Invite code request timed out');
    error.code = 'UPSTREAM_TIMEOUT';
    throw error;
  }
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

async function fetchJson(url, options = {}, deadlineAt) {
  const { response, authUnavailable } = await bookstoreFetch(url, options, { timeoutMs: remainingTimeout(deadlineAt) });
  if (!response) {
    const error = new Error('Bookstore authentication unavailable');
    error.code = authUnavailable ? 'UPSTREAM_AUTH_UNAVAILABLE' : 'UPSTREAM_UNAVAILABLE';
    throw error;
  }
  const text = await response.text();
  const body = text ? safeParse(text, { raw: text.slice(0, 300) }) : {};
  return { response, body };
}

async function findRemote(filters, deadlineAt) {
  const query = new URLSearchParams({
    pageIndex: '1',
    pageSize: '100',
    applicationId: APPLICATION_ID,
  });
  if (filters.kolName) query.set('kolName', filters.kolName);
  if (filters.code) query.set('code', String(filters.code));
  if (typeof filters.isEnable === 'boolean') query.set('isEnable', String(filters.isEnable));

  const { response, body } = await fetchJson(`${EQUITY_API_BASE}/page?${query}`, {
    headers: { 'Content-Type': 'application/json' },
  }, deadlineAt);
  if (!response.ok) {
    const error = new Error(`Equity lookup failed (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return extractRows(body).find(row => {
    if (filters.kolName && canonicalUsername(row.kolName) !== canonicalUsername(filters.kolName)) return false;
    if (filters.code && String(row.code || '').toLowerCase() !== String(filters.code).toLowerCase()) return false;
    const rowEnabled = isRemoteEnabled(row);
    if (typeof filters.isEnable === 'boolean' && rowEnabled !== filters.isEnable) return false;
    return true;
  }) || null;
}

async function verifyBook(bookId, deadlineAt) {
  const query = new URLSearchParams({
    current: '1',
    pageIndex: '1',
    pageSize: '5',
    applicationId: APPLICATION_ID,
    bookStatus: '1',
    bookIds: bookId,
  });
  const { response, body } = await fetchJson(`${BOOK_API_BASE}/booklist?${query}`, {
    headers: { 'Content-Type': 'application/json' },
  }, deadlineAt);
  if (!response.ok) {
    const error = new Error(`Book lookup failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return extractBook(body, bookId);
}

async function allocateCode(redis, username, deadlineAt) {
  const counterKey = 'nf_equity_code_counter';
  await redis.set(counterKey, FIRST_CODE - 1, { nx: true });
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = String(await redis.incr(counterKey));
    const existing = await findRemote({ code }, deadlineAt);
    if (!existing) return code;
    if (canonicalUsername(existing.kolName) === username) return code;
  }
  throw new Error('No invite code is currently available');
}

async function createRemote(payload, deadlineAt) {
  const { response, body } = await fetchJson(`${EQUITY_API_BASE}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, deadlineAt);
  const applicationError = body && (body.success === false || (Number.isFinite(Number(body.code)) && ![0, 200].includes(Number(body.code))));
  if (!response.ok || applicationError) {
    const error = new Error(`Equity creation failed (${response.status})`);
    error.status = response.status;
    error.responseBody = body;
    throw error;
  }
  return body;
}

function disabledRemotePayload(remote, record, username) {
  return {
    id: remote.id,
    applicationId: remote.applicationId || APPLICATION_ID,
    channel: Number(remote.channel) || 5,
    kolName: remote.kolName || username,
    code: String(remote.code || record.code),
    startTime: Number(remote.startTime) || Number(record.startTime) || Date.now(),
    endTime: Number(remote.endTime) || Number(record.endTime) || Date.now(),
    relatedSkuId: String(remote.relatedSkuId || record.bookId || ''),
    rewardType: Number(remote.rewardType) || 1,
    rewardName: String(remote.rewardName || record.rewardName || '1-Day VIP'),
    rewardValue: Number(remote.rewardValue) || Number(record.rewardDays) || 1,
    isEnable: false,
  };
}

function markUnbound(record, now = Date.now()) {
  const audit = {
    code: record.code,
    bookId: record.bookId,
    bookTitle: record.bookTitle,
    startTime: record.startTime,
    endTime: record.endTime,
    remoteId: record.remoteId || null,
    unboundAt: now,
  };
  return {
    ...record,
    status: 'unbound',
    isEnable: false,
    unboundAt: now,
    cooldownUntil: now + RECREATE_COOLDOWN_MS,
    updatedAt: now,
    history: [...(Array.isArray(record.history) ? record.history : []), audit],
  };
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

  const action = String((req.body && req.body.action) || 'create');
  if (!['create', 'unbind'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action', code: 'INVALID_ACTION' });
  }
  const bookId = String((req.body && req.body.bookId) || '').trim();
  if (action === 'create' && !/^[a-f0-9]{24}$/i.test(bookId)) {
    return res.status(400).json({ error: 'Select a valid book from search results', code: 'INVALID_BOOK' });
  }

  const key = lockKey(username);
  const lockToken = crypto.randomUUID();
  const locked = await redis.set(key, lockToken, { nx: true, ex: LOCK_SECONDS });
  if (!locked) {
    const current = await loadRecord(redis, username);
    return res.status(409).json({
      error: 'An invite code update is already in progress',
      code: action === 'create' ? 'CREATION_IN_PROGRESS' : 'UPDATE_IN_PROGRESS',
      inviteCode: publicRecord(current),
    });
  }

  try {
    const deadlineAt = Date.now() + OPERATION_DEADLINE_MS;
    let record = await loadRecord(redis, username);
    if (action === 'unbind') {
      if (record && record.status === 'unbound') {
        return res.status(200).json({ success: true, inviteCode: publicRecord(record), existing: true });
      }
      if (!record) {
        const existing = await findRemote({ kolName: username, isEnable: true }, deadlineAt);
        if (!existing) return res.status(404).json({ error: 'No invite code to unbind', code: 'INVITE_NOT_FOUND' });
        record = normalizeRemoteRecord(existing, username);
      }

      const remote = await findRemote({ code: record.code }, deadlineAt);
      if (!remote) {
        return res.status(502).json({ error: 'Invite code could not be verified', code: 'UPSTREAM_RECORD_NOT_FOUND' });
      }
      const remoteEnabled = isRemoteEnabled(remote);
      if (remoteEnabled) {
        try {
          await createRemote(disabledRemotePayload(remote, record, username), deadlineAt);
        } catch (error) {
          let reconciled = null;
          try { reconciled = await findRemote({ code: record.code }, deadlineAt); } catch (_lookupError) {}
          const stillEnabled = isRemoteEnabled(reconciled);
          if (stillEnabled) {
            return res.status(502).json({ error: 'Unable to unbind invite code', code: 'UPSTREAM_UNBIND_FAILED' });
          }
        }
      }

      record = markUnbound(record);
      await saveRecord(redis, username, record);
      return res.status(200).json({ success: true, inviteCode: publicRecord(record) });
    }

    const now = Date.now();
    if (record && record.status === 'unbound' && Number(record.cooldownUntil) > now) {
      return res.status(429).json({
        error: 'You can create another invite code after the 7-day cooldown',
        code: 'RECREATE_COOLDOWN',
        cooldownUntil: Number(record.cooldownUntil),
        inviteCode: publicRecord(record),
      });
    }
    if (record && ['active', 'expired'].includes(publicRecord(record).status)) {
      return res.status(200).json({ success: true, inviteCode: publicRecord(record), existing: true });
    }
    if (record && record.status !== 'unbound' && record.bookId && record.bookId !== bookId) {
      return res.status(409).json({
        error: 'This account already has an invite code request for another book',
        code: 'BOOK_ALREADY_SELECTED',
        inviteCode: publicRecord(record),
      });
    }

    const remoteExisting = await findRemote({ kolName: username, isEnable: true }, deadlineAt);
    if (remoteExisting) {
      record = normalizeRemoteRecord(remoteExisting, username);
      await saveRecord(redis, username, record);
      return res.status(200).json({ success: true, inviteCode: publicRecord(record), existing: true });
    }

    const book = await verifyBook(bookId, deadlineAt);
    if (!book) return res.status(400).json({ error: 'The selected book no longer exists', code: 'BOOK_NOT_FOUND' });
    const verifiedTitle = String(book.title || book.bookName || '').trim();
    if (!verifiedTitle) return res.status(502).json({ error: 'Book data is incomplete', code: 'INVALID_BOOK_DATA' });

    let code = record && record.status !== 'unbound' && record.code ? String(record.code) : null;
    if (code) {
      const codeOwner = await findRemote({ code }, deadlineAt);
      if (codeOwner && canonicalUsername(codeOwner.kolName) !== username) code = null;
    }
    if (!code) code = await allocateCode(redis, username, deadlineAt);
    const history = record && Array.isArray(record.history) ? record.history : [];
    record = {
      status: 'processing', username, code, bookId, bookTitle: verifiedTitle,
      channel: 'Facebook', rewardName: '1-Day VIP', rewardDays: 1,
      startTime: now, endTime: now + VALIDITY_MS,
      createdAt: record && record.status !== 'unbound' && record.createdAt ? record.createdAt : now,
      updatedAt: now,
      history,
    };
    await saveRecord(redis, username, record);

    const payload = equityPayload({ username, code, bookId, now });
    try {
      const result = await createRemote(payload, deadlineAt);
      const data = result && result.data;
      record.status = 'active';
      record.remoteId = (data && data.id) || result.id || null;
      record.updatedAt = Date.now();
      await saveRecord(redis, username, record);
      return res.status(201).json({ success: true, inviteCode: publicRecord(record) });
    } catch (error) {
      let reconciled = null;
      try { reconciled = await findRemote({ kolName: username, isEnable: true }, deadlineAt); } catch (_lookupError) {}
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
    const status = error && error.code === 'UPSTREAM_TIMEOUT' ? 504 : (error && error.code === 'UPSTREAM_AUTH_UNAVAILABLE' ? 503 : 502);
    return res.status(status).json({
      error: status === 504 ? 'Invite code request timed out. Please retry.' : 'Invite code service unavailable',
      code: error && error.code ? error.code : 'UPSTREAM_UNAVAILABLE',
    });
  } finally {
    await releaseLock(redis, key, lockToken);
  }
};
