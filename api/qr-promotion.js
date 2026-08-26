/**
 * QR promotion asset API. The redirect destination is always derived from a
 * server-owned submission, never from client input.
 */
const { getAuthPayload, getRedis, isDisabledUser, checkRateLimit, validateString } = require('./_lib/security');
const QRCode = require('qrcode');
const { loadSubmissions } = require('./_lib/stats-data');
const {
  QR_TOKEN_TTL_SECONDS, createQrToken, normalizePublicUrl,
  qrAssetKey, qrTokenKey, parseStored,
} = require('./_lib/qr-promotion');

const USER_LIMIT = 30;
const USER_WINDOW_SECONDS = 3600;
const PUBLIC_ORIGIN = 'https://novelflow.top';

function json(res, status, body) {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(status).json(body);
}

async function assetResponse(res, status, asset, scans, existing) {
  const url = `${PUBLIC_ORIGIN}/api/qr/${asset.token}`;
  const qrDataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M', margin: 1, width: 512,
    color: { dark: '#111827', light: '#FFFFFFFF' },
  });
  return json(res, status, {
    success: true, token: asset.token, url, qrDataUrl, scans,
    createdAt: asset.createdAt, existing: Boolean(existing),
  });
}

async function findOwnedPromotion(redis, username, code) {
  const submissions = await loadSubmissions(redis, username, false, []);
  return submissions.find(submission => String(submission && submission.code || '') === String(code)) || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const payload = getAuthPayload(req);
  const username = String(payload?.username || '').trim().toLowerCase();
  if (!payload || !username) return json(res, 401, { error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const redis = getRedis();
  if (!redis) return json(res, 503, { error: 'QR promotion service is temporarily unavailable', code: 'STORAGE_UNAVAILABLE' });

  try {
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return json(res, 403, { error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (_error) {
    return json(res, 503, { error: 'QR promotion service is temporarily unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  const source = req.method === 'GET' ? req.query : req.body || {};
  const parsedCode = validateString(source.code, { name: 'code', required: true, maxLen: 32, minLen: 1 });
  if (!parsedCode.ok || !/^[0-9A-Za-z_-]+$/.test(parsedCode.value)) return json(res, 400, { error: 'Invalid promotion code', code: 'INVALID_CODE' });
  const code = parsedCode.value;
  const assetKey = qrAssetKey(username, code);

  try {
    const existing = parseStored(await redis.get(assetKey));
    if (existing?.token) {
      const scans = Number(await redis.get(`${qrTokenKey(existing.token)}:scans`)) || 0;
      return assetResponse(res, 200, existing, scans, true);
    }
  } catch (_error) {
    return json(res, 503, { error: 'QR promotion service is temporarily unavailable', code: 'QR_READ_UNAVAILABLE' });
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'QR promotion card not created yet', code: 'QR_NOT_FOUND' });
  try {
    if (!await checkRateLimit(redis, `nf_rate:qr_promotion:${username}`, USER_LIMIT, USER_WINDOW_SECONDS, { failClosed: true })) {
      return json(res, 429, { error: 'Too many QR requests. Try again later.', code: 'RATE_LIMITED' });
    }
  } catch (_error) {
    return json(res, 503, { error: 'QR promotion service is temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
  }

  let promotion;
  try {
    promotion = await findOwnedPromotion(redis, username, code);
  } catch (_error) {
    return json(res, 503, { error: 'Promotion ownership is temporarily unavailable', code: 'PROMOTION_LOOKUP_UNAVAILABLE' });
  }
  if (!promotion) return json(res, 404, { error: 'Promotion not found for this account', code: 'PROMOTION_NOT_FOUND' });

  const destination = normalizePublicUrl(promotion.link);
  if (!destination) return json(res, 409, { error: 'This promotion has no valid destination', code: 'PROMOTION_DESTINATION_INVALID' });

  const token = createQrToken();
  const now = new Date().toISOString();
  const record = {
    token, destination, code: String(promotion.code), bookId: String(promotion.bookId || ''),
    title: String(promotion.matchedBookName || promotion.bookName || '').slice(0, 200),
    owner: username, createdAt: now,
  };
  try {
    const current = parseStored(await redis.get(assetKey));
    if (current?.token) {
      const scans = Number(await redis.get(`${qrTokenKey(current.token)}:scans`)) || 0;
      return assetResponse(res, 200, current, scans, true);
    }
    await redis.set(qrTokenKey(token), JSON.stringify(record), { ex: QR_TOKEN_TTL_SECONDS });
    await redis.set(assetKey, JSON.stringify({ token, createdAt: now }), { ex: QR_TOKEN_TTL_SECONDS });
  } catch (_error) {
    return json(res, 503, { error: 'QR promotion service is temporarily unavailable', code: 'QR_WRITE_UNAVAILABLE' });
  }
  return assetResponse(res, 201, { token, createdAt: now }, 0, false);
};
