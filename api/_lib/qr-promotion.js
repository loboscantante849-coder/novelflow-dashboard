const crypto = require('crypto');

const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,80}$/;
const QR_TOKEN_TTL_SECONDS = 180 * 86400;

function createQrToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function normalizePublicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.href;
  } catch (_error) {
    return null;
  }
}

function qrAssetKey(username, code) {
  return `nf_qr_asset:${String(username || '').toLowerCase()}:${String(code || '')}`;
}

function qrTokenKey(token) {
  return `nf_qr_token:${token}`;
}

function parseStored(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

module.exports = {
  QR_TOKEN_PATTERN,
  QR_TOKEN_TTL_SECONDS,
  createQrToken,
  normalizePublicUrl,
  qrAssetKey,
  qrTokenKey,
  parseStored,
};
