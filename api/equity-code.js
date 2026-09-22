const crypto = require('crypto');
const { handlePreflight } = require('./_lib/cors');
const { getAuthPayload, getRedis, checkRateLimit, getClientIp, isDisabledUser } = require('./_lib/security');
const { bookstoreFetch } = require('./_lib/bookstore-fetch');
const { canonicalizeLocalSessionPayload, localLoginCredentialCandidates } = require('./_lib/login-identity');
const {
  APPLICATION_ID,
  EQUITY_API_BASE,
  BOOK_API_BASE,
  VALIDITY_MS,
  REWARD_DAYS,
  MAX_ACTIVE_CODES,
  CREATE_WINDOW_MS,
  MAX_CREATES_PER_WINDOW,
  FIRST_CODE,
  activeCodes,
  canonicalUsername,
  codeStatus,
  normalizeAccountRecord,
  publicAccount,
  publicCode,
  safeParse,
  extractRows,
  extractBook,
  normalizeRemoteRecord,
  equityPayload,
} = require('./_lib/equity-code');

const LOCK_SECONDS = 45;
const REQUEST_TIMEOUT_MS = 5000;
const OPERATION_DEADLINE_MS = 24000;
const MAX_CODE_ATTEMPTS = 8;

function recordKey(username) {
  return `nf_equity_code:${username}`;
}

function recordKeys(username) {
  const canonical = canonicalUsername(username);
  const verified = localLoginCredentialCandidates(canonical).usernames || [];
  const candidates = canonical === 'cons_espher'
    ? [canonical, ...verified, '@cons espher', 'cons espher', '@cons_espher']
    : [canonical, ...verified];
  return Array.from(new Set(candidates.filter(Boolean))).map(recordKey);
}

function lockKey(username) {
  return `nf_equity_code_lock:${username}`;
}

function isRemoteEnabled(row) {
  return !row || ![false, 0, 'false', '0'].includes(row.isEnable);
}

async function loadRecordState(redis, username) {
  const canonicalKey = recordKey(canonicalUsername(username));
  const keys = recordKeys(username);
  const values = typeof redis.mget === 'function'
    ? await redis.mget(...keys)
    : await Promise.all(keys.map(key => redis.get(key)));
  const matches = [];
  for (let index = 0; index < keys.length; index += 1) {
    const raw = values[index];
    if (raw === null || raw === undefined) continue;
    const record = safeParse(raw);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      const error = new Error('Invite code record is invalid');
      error.code = 'INVITE_RECORD_INVALID';
      throw error;
    }
    matches.push({ key: keys[index], raw: typeof raw === 'string' ? raw : JSON.stringify(raw), record });
  }
  if (matches.length > 1) {
    const distinct = new Set(matches.map(match => JSON.stringify(match.record)));
    if (distinct.size > 1) {
      const error = new Error('Multiple invite code records resolve to this account');
      error.code = 'INVITE_IDENTITY_CONFLICT';
      error.matches = matches;
      throw error;
    }
  }
  const selected = matches.find(match => match.key === canonicalKey) || matches[0] || null;
  return {
    canonicalKey,
    storageKey: selected && selected.key || canonicalKey,
    raw: selected && selected.raw || null,
    record: selected && selected.record || null,
  };
}

async function loadRecord(redis, username) {
  return (await loadRecordState(redis, username)).record;
}

async function migrateLegacyRecord(redis, state) {
  if (!state || !state.record || state.storageKey === state.canonicalKey) return state;
  const script = [
    '-- NF_EQUITY_IDENTITY_MIGRATE_V1',
    "if redis.call('exists', KEYS[1]) ~= 0 then return -1 end",
    "if redis.call('get', KEYS[2]) ~= ARGV[1] then return -2 end",
    "redis.call('set', KEYS[1], ARGV[1])",
    "redis.call('del', KEYS[2])",
    'return 1',
  ].join('\n');
  const result = Number(await redis.eval(script, [state.canonicalKey, state.storageKey], [state.raw]));
  if (result !== 1) {
    const error = new Error('Invite code identity changed during recovery');
    error.code = 'INVITE_IDENTITY_CHANGED';
    throw error;
  }
  return { ...state, storageKey: state.canonicalKey };
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

async function releaseLock(redis, key, token) {
  try {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [key],
      [token],
    );
  } catch (_error) {
    // The lock expires automatically.
  }
}

// Gift codes are back on. Set EQUITY_CODE_ENABLED=false to take the feature
// down again without a code change.
function equityCodeEnabled() {
  return String(process.env.EQUITY_CODE_ENABLED || 'true').trim().toLowerCase() !== 'false';
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
  if (!equityCodeEnabled()) {
    return res.status(503).json({
      error: 'Gift codes are temporarily unavailable while we rework this feature.',
      code: 'EQUITY_CODE_OFFLINE',
    });
  }

  const auth = canonicalizeLocalSessionPayload(getAuthPayload(req));
  const username = canonicalUsername(auth && auth.username);
  if (!username) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });

  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Storage unavailable', code: 'STORAGE_UNAVAILABLE' });
  try {
    if (await isDisabledUser(redis, auth, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  async function loadAccount() {
    const state = await migrateLegacyRecord(redis, await loadRecordState(redis, username));
    return normalizeAccountRecord(state.record, username);
  }

  function newestCode(account) {
    const codes = (account && Array.isArray(account.codes) ? account.codes : [])
      .slice()
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    return codes.length ? publicCode(codes[0]) : null;
  }

  async function saveAccount(account) {
    account.updatedAt = Date.now();
    await saveRecord(redis, username, account);
    return account;
  }

  if (req.method === 'GET') {
    try {
      // Reads stay read-only: a legacy spelling is migrated when the member
      // next changes something, not while they are just looking at the page.
      const state = await loadRecordState(redis, username);
      const account = normalizeAccountRecord(state.record, username);
      const active = activeCodes(account);
      return res.status(200).json({
        success: true,
        account: publicAccount(account),
        // Kept for older clients that still read a single record.
        inviteCode: newestCode(account),
      });
    } catch (error) {
      if (error && ['INVITE_IDENTITY_CONFLICT', 'INVITE_RECORD_INVALID'].includes(error.code)) {
        // A legacy alias conflict should be self-healing when the upstream
        // record can authoritatively identify the account. Rebuild only the
        // canonical gift-code record; wallet and payout identity stay untouched.
        try {
          const aliases = recordKeys(username).map(key => key.slice('nf_equity_code:'.length));
          let remote = null;
          for (const alias of aliases) {
            remote = await findRemote({ kolName: alias, isEnable: true }, Date.now() + REQUEST_TIMEOUT_MS);
            if (remote) break;
          }
          if (remote) {
            const recovered = normalizeAccountRecord(normalizeRemoteRecord(remote, username), username);
            recovered.createLog = [Date.now()];
            await saveAccount(recovered);
            return res.status(200).json({ success: true, account: publicAccount(recovered), recovered: true });
          }
        } catch (_recoveryError) {
          // Keep the explicit conflict response below when upstream is unavailable.
        }
        return res.status(409).json({ error: 'Gift code identity recovery is required', code: error.code });
      }
      return res.status(503).json({ error: 'Storage temporarily unavailable', code: 'STORAGE_UNAVAILABLE' });
    }
  }

  let allowed;
  try {
    allowed = await checkRateLimit(redis, `nf_rate:equity:${username}`, 20, 3600, { failClosed: true }) &&
      await checkRateLimit(redis, `nf_rate:equity_ip:${getClientIp(req)}`, 60, 3600, { failClosed: true });
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
  }
  if (!allowed) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });

  const action = String((req.body && req.body.action) || 'create');
  if (!['create', 'stop', 'unbind'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action', code: 'INVALID_ACTION' });
  }
  const bookId = String((req.body && req.body.bookId) || '').trim();
  const targetCode = String((req.body && req.body.code) || '').trim();
  if (action === 'create' && !/^[a-f0-9]{24}$/i.test(bookId)) {
    return res.status(400).json({ error: 'Select a valid book from search results', code: 'INVALID_BOOK' });
  }

  const key = lockKey(username);
  const lockToken = crypto.randomUUID();
  let locked;
  try {
    locked = await redis.set(key, lockToken, { nx: true, ex: LOCK_SECONDS });
  } catch (_error) {
    return res.status(503).json({ error: 'Storage temporarily unavailable', code: 'STORAGE_UNAVAILABLE' });
  }
  if (!locked) {
    try {
      const account = await loadAccount();
      return res.status(409).json({
        error: 'A gift code update is already in progress',
        code: action === 'create' ? 'CREATION_IN_PROGRESS' : 'UPDATE_IN_PROGRESS',
        account: publicAccount(account),
      });
    } catch (_error) {
      return res.status(503).json({ error: 'Storage temporarily unavailable', code: 'STORAGE_UNAVAILABLE' });
    }
  }

  try {
    const deadlineAt = Date.now() + OPERATION_DEADLINE_MS;
    const account = await loadAccount();
    const now = Date.now();

    // ---------- stop one code (no cooldown, other codes keep running) ----------
    if (action === 'stop' || action === 'unbind') {
      const running = activeCodes(account, now);
      const entry = targetCode
        ? account.codes.find(item => String(item.code) === targetCode)
        : running[0];
      if (!entry) return res.status(404).json({ error: 'No gift code to stop', code: 'INVITE_NOT_FOUND' });
      if (entry.status === 'stopped') {
        return res.status(200).json({ success: true, account: publicAccount(account), stopped: entry.code, existing: true });
      }
      const remote = await findRemote({ code: entry.code }, deadlineAt);
      if (!remote) {
        return res.status(502).json({ error: 'Gift code could not be verified', code: 'UPSTREAM_RECORD_NOT_FOUND' });
      }
      if (isRemoteEnabled(remote)) {
        try {
          await createRemote(disabledRemotePayload(remote, entry, username), deadlineAt);
        } catch (error) {
          let reconciled = null;
          try { reconciled = await findRemote({ code: entry.code }, deadlineAt); } catch (_lookupError) {}
          if (isRemoteEnabled(reconciled)) {
            return res.status(502).json({ error: 'Unable to stop gift code', code: 'UPSTREAM_UNBIND_FAILED' });
          }
        }
      }
      entry.status = 'stopped';
      entry.isEnable = false;
      entry.stoppedAt = now;
      entry.updatedAt = now;
      await saveAccount(account);
      return res.status(200).json({ success: true, account: publicAccount(account), stopped: entry.code });
    }

    // ---------- create a code for another book ----------
    const running = activeCodes(account, now);
    if (running.length >= MAX_ACTIVE_CODES) {
      return res.status(409).json({
        error: `You can keep ${MAX_ACTIVE_CODES} gift codes at the same time. Stop one before adding another.`,
        code: 'ACTIVE_LIMIT',
        account: publicAccount(account),
      });
    }
    const inWindow = account.createLog.filter(value => value > now - CREATE_WINDOW_MS);
    if (inWindow.length >= MAX_CREATES_PER_WINDOW) {
      const nextSlotAt = Math.min(...inWindow) + CREATE_WINDOW_MS;
      return res.status(429).json({
        error: 'You have created the maximum number of gift codes for this week.',
        code: 'CREATE_QUOTA',
        next_slot_at: nextSlotAt,
        account: publicAccount(account),
      });
    }
    const sameBook = running.find(entry => String(entry.bookId) === bookId);
    if (sameBook) {
      return res.status(200).json({ success: true, account: publicAccount(account), inviteCode: publicCode(sameBook), existing: true });
    }

    // Reconcile with upstream before allocating a new number: an earlier attempt
    // may have succeeded without us recording it.
    const remoteExisting = await findRemote({ kolName: username, isEnable: true }, deadlineAt);
    if (remoteExisting) {
      const remoteCode = String(remoteExisting.code || '');
      const known = account.codes.find(entry => String(entry.code) === remoteCode);
      if (known) {
        known.status = codeStatus(normalizeRemoteRecord(remoteExisting, username), now);
        known.endTime = Number(remoteExisting.endTime) || known.endTime;
        known.updatedAt = now;
        await saveAccount(account);
        return res.status(200).json({ success: true, account: publicAccount(account), inviteCode: publicCode(known), existing: true });
      }
      const adopted = normalizeRemoteRecord(remoteExisting, username);
      account.codes.push(adopted);
      account.createLog.push(now);
      await saveAccount(account);
      return res.status(200).json({ success: true, account: publicAccount(account), inviteCode: publicCode(adopted), existing: true });
    }

    const book = await verifyBook(bookId, deadlineAt);
    if (!book) return res.status(400).json({ error: 'The selected book no longer exists', code: 'BOOK_NOT_FOUND' });
    const verifiedTitle = String(book.title || book.bookName || '').trim();
    if (!verifiedTitle) return res.status(502).json({ error: 'Book data is incomplete', code: 'INVALID_BOOK_DATA' });

    // A previous attempt for this book may have reserved a number already; a
    // retry must reuse it instead of burning a second code.
    let entry = account.codes.find(item => String(item.bookId) === bookId
      && ['failed', 'processing'].includes(String(item.status)));
    let code;
    if (entry && entry.code) {
      code = String(entry.code);
      entry.status = 'processing';
      entry.updatedAt = now;
    } else {
      code = await allocateCode(redis, username, deadlineAt);
      entry = {
        code,
        username,
        bookId,
        bookTitle: verifiedTitle,
        channel: 'Facebook',
        rewardName: `${REWARD_DAYS}-Day VIP`,
        rewardDays: REWARD_DAYS,
        status: 'processing',
        startTime: now,
        endTime: now + VALIDITY_MS,
        createdAt: now,
        updatedAt: now,
      };
      account.codes.push(entry);
      account.createLog.push(now);
    }
    await saveAccount(account);

    const payload = equityPayload({ username, code, bookId, now, days: REWARD_DAYS });
    try {
      const result = await createRemote(payload, deadlineAt);
      const data = result && result.data;
      entry.status = 'active';
      entry.remoteId = (data && data.id) || result.id || null;
      entry.updatedAt = Date.now();
      await saveAccount(account);
      return res.status(201).json({ success: true, account: publicAccount(account), inviteCode: publicCode(entry) });
    } catch (error) {
      let reconciled = null;
      try { reconciled = await findRemote({ code }, deadlineAt); } catch (_lookupError) {}
      if (!reconciled) {
        // The submit may have landed even though the response was lost; the
        // account-level lookup is the authoritative check.
        try { reconciled = await findRemote({ kolName: username, isEnable: true }, deadlineAt); } catch (_lookupError) {}
      }
      if (reconciled) {
        const adopted = normalizeRemoteRecord(reconciled, username);
        Object.assign(entry, adopted, { status: 'active', updatedAt: Date.now() });
        await saveAccount(account);
        return res.status(200).json({ success: true, account: publicAccount(account), inviteCode: publicCode(entry), reconciled: true });
      }
      entry.status = 'failed';
      entry.lastError = error.message;
      entry.updatedAt = Date.now();
      await saveAccount(account);
      return res.status(502).json({
        error: 'Gift code creation failed. You can safely retry with the same book.',
        code: 'UPSTREAM_CREATE_FAILED',
        account: publicAccount(account),
        inviteCode: publicCode(entry),
      });
    }
  } catch (error) {
    console.error('[equity-code]', error.message);
    const status = error && error.code === 'UPSTREAM_TIMEOUT' ? 504 : (error && error.code === 'UPSTREAM_AUTH_UNAVAILABLE' ? 503 : 502);
    return res.status(status).json({
      error: status === 504 ? 'Gift code request timed out. Please retry.' : 'Gift code service unavailable',
      code: error && error.code ? error.code : 'UPSTREAM_UNAVAILABLE',
    });
  } finally {
    await releaseLock(redis, key, lockToken);
  }
};
