const APPLICATION_ID = '642fc1ace309494378a774a6';
const EQUITY_API_BASE = 'https://admin.novelflow.app/api/v1/welfaremanage/equitycode';
const BOOK_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage/book';
const VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const RECREATE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_CODE = 90032;

function canonicalUsername(value) {
  return String(value || '').trim().toLowerCase();
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

function equityPayload({ username, code, bookId, now = Date.now() }) {
  return {
    applicationId: APPLICATION_ID,
    channel: 5,
    kolName: canonicalUsername(username),
    code: String(code),
    startTime: now,
    endTime: now + VALIDITY_MS,
    relatedSkuId: String(bookId),
    rewardType: 1,
    rewardName: '1-Day VIP',
    rewardValue: 1,
    isEnable: true,
  };
}

module.exports = {
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
};
