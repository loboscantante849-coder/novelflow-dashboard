const { resolveLocalLoginUsername } = require('./login-identity');

const APPLICATION_ID = '642fc1ace309494378a774a6';
const EQUITY_API_BASE = 'https://admin.novelflow.app/api/v1/welfaremanage/equitycode';
const BOOK_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage/book';
const VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const FIRST_CODE = 90032;
// Gift codes are a new-reader reward: three VIP days, five books at a time.
const REWARD_DAYS = 3;
const MAX_ACTIVE_CODES = 5;
// Replacing a book no longer freezes the account for a week. Churn is bounded
// by a rolling window instead, so a mistake never locks the feature.
const CREATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CREATES_PER_WINDOW = 10;

function canonicalUsername(value) {
  return resolveLocalLoginUsername(value);
}

function safeParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function extractRows(payload) {
  const candidates = [
    payload,
    payload && payload.data,
    payload && payload.data && payload.data.data,
    payload && payload.data && payload.data.records,
    payload && payload.data && payload.data.list,
    payload && payload.records,
    payload && payload.list,
    payload && payload.items,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function extractBook(payload, bookId) {
  const rows = extractRows(payload);
  return rows.find(row => String(row && (row.bookId || row.id || row.skuId)) === String(bookId)) || null;
}

function normalizeRemoteRecord(row, username, now = Date.now()) {
  if (!row) return null;
  const endTime = Number(row.endTime) || null;
  return {
    status: endTime && endTime <= now ? 'expired' : 'active',
    username: canonicalUsername(username || row.kolName),
    code: String(row.code || ''),
    bookId: String(row.relatedSkuId || ''),
    bookTitle: String(row.bookTitle || row.relatedBookName || ''),
    channel: Number(row.channel) === 5 ? 'Facebook' : String(row.channelName || 'Facebook'),
    rewardName: String(row.rewardName || '1-Day VIP'),
    rewardDays: Number(row.rewardValue) || 1,
    startTime: Number(row.startTime) || null,
    endTime,
    remoteId: row.id || null,
    createdAt: Number(row.createTime) || now,
    updatedAt: now,
  };
}

function publicRecord(record, now = Date.now()) {
  if (!record) return null;
  const copy = { ...record };
  if (copy.status === 'active' && Number(copy.endTime) > 0 && Number(copy.endTime) <= now) {
    copy.status = 'expired';
  }
  delete copy.lastError;
  delete copy.lockToken;
  delete copy.history;
  return copy;
}

function equityPayload({ username, code, bookId, now = Date.now(), days = REWARD_DAYS }) {
  const rewardDays = Number(days) > 0 ? Number(days) : REWARD_DAYS;
  return {
    applicationId: APPLICATION_ID,
    channel: 5,
    kolName: canonicalUsername(username),
    code: String(code),
    startTime: now,
    endTime: now + VALIDITY_MS,
    relatedSkuId: String(bookId),
    rewardType: 1,
    rewardName: `${rewardDays}-Day VIP`,
    rewardValue: rewardDays,
    isEnable: true,
  };
}

/** One code inside the account document. */
function publicCode(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  const copy = { ...entry };
  if (copy.status === 'active' && Number(copy.endTime) > 0 && Number(copy.endTime) <= now) {
    copy.status = 'expired';
  }
  delete copy.lastError;
  return copy;
}

function codeStatus(entry, now = Date.now()) {
  if (!entry) return 'unknown';
  if (entry.status === 'stopped') return 'stopped';
  if (Number(entry.endTime) > 0 && Number(entry.endTime) <= now) return 'expired';
  return entry.status || 'active';
}

/**
 * Account document. Version 1 stored a single code at the top level; fold it
 * into the version 2 list so no history is lost.
 */
function normalizeAccountRecord(raw, username) {
  const now = Date.now();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 2, username: canonicalUsername(username), codes: [], createLog: [], updatedAt: now };
  }
  if (Array.isArray(raw.codes)) {
    return {
      version: 2,
      username: canonicalUsername(raw.username || username),
      codes: raw.codes.filter(entry => entry && typeof entry === 'object'),
      createLog: Array.isArray(raw.createLog) ? raw.createLog.filter(value => Number(value) > 0) : [],
      history: Array.isArray(raw.history) ? raw.history : [],
      updatedAt: Number(raw.updatedAt) || now,
    };
  }
  if (raw.code) {
    const { history, ...entry } = raw;
    return {
      version: 2,
      username: canonicalUsername(raw.username || username),
      codes: [entry],
      createLog: [Number(raw.createdAt) || now],
      history: Array.isArray(history) ? history : [],
      updatedAt: now,
    };
  }
  return { version: 2, username: canonicalUsername(username), codes: [], createLog: [], updatedAt: now };
}

function activeCodes(account, now = Date.now()) {
  return (account && Array.isArray(account.codes) ? account.codes : [])
    .filter(entry => codeStatus(entry, now) === 'active');
}

function publicAccount(account, now = Date.now()) {
  const codes = (account && Array.isArray(account.codes) ? account.codes : [])
    .map(entry => publicCode(entry, now))
    .filter(Boolean)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const windowStart = now - CREATE_WINDOW_MS;
  const log = (account && Array.isArray(account.createLog) ? account.createLog : [])
    .map(Number).filter(value => Number.isFinite(value) && value > 0);
  const inWindow = log.filter(value => value > windowStart);
  const oldestInWindow = inWindow.length ? Math.min(...inWindow) : null;
  return {
    version: 2,
    codes,
    active: codes.filter(entry => entry.status === 'active').length,
    quota: {
      max_active: MAX_ACTIVE_CODES,
      window_days: Math.round(CREATE_WINDOW_MS / 86400000),
      creates_in_window: inWindow.length,
      max_creates_in_window: MAX_CREATES_PER_WINDOW,
      next_slot_at: inWindow.length >= MAX_CREATES_PER_WINDOW && oldestInWindow
        ? oldestInWindow + CREATE_WINDOW_MS
        : null,
    },
  };
}

module.exports = {
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
  codeStatus,
  normalizeAccountRecord,
  publicAccount,
  publicCode,
  canonicalUsername,
  safeParse,
  extractRows,
  extractBook,
  normalizeRemoteRecord,
  publicRecord,
  equityPayload,
};
