/**
 * POST /api/ac-upload
 * Upload reference images for AC video generation (已鉴权 + MIME白名单 + magic-byte校验)
 * Uses Vercel Blob storage (requires BLOB_READ_WRITE_TOKEN env var)
 */

const { setCORSHeaders } = require('./_lib/cors');
const {
  checkRateLimit,
  getAuthPayload,
  getClientIp,
  getRedis,
  isDisabledUser,
} = require('./_lib/security');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_REQUEST_SIZE = MAX_FILE_SIZE + 512 * 1024;
const UPLOAD_USER_LIMIT_PER_DAY = 20;
const UPLOAD_IP_LIMIT_PER_DAY = 60;

function detectMime(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 24 &&
      buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) &&
      buf.subarray(12, 16).toString('ascii') === 'IHDR' &&
      buf.readUInt32BE(16) > 0 && buf.readUInt32BE(20) > 0) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 16 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF &&
      buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9) {
    return { mime: 'image/jpeg', ext: 'jpeg' };
  }
  const gifHeader = buf.length >= 13 ? buf.subarray(0, 6).toString('ascii') : '';
  if ((gifHeader === 'GIF87a' || gifHeader === 'GIF89a') &&
      buf.readUInt16LE(6) > 0 && buf.readUInt16LE(8) > 0) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  const webpChunk = buf.length >= 20 ? buf.subarray(12, 16).toString('ascii') : '';
  if (buf.length >= 20 && buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(webpChunk) &&
      buf.readUInt32LE(4) + 8 <= buf.length) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ---- AUTH ----
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  try {
    if (await isDisabledUser(redis, payload, { failClosed: true, allowSafeReadOnlyWalletConflict: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (e) {
    return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: 'Image upload is not configured', code: 'BLOB_NOT_CONFIGURED' });
  }

  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_SIZE) {
    return res.status(413).json({ error: 'Request too large' });
  }

  const username = String(payload.username || '').trim().toLowerCase();
  const day = new Date().toISOString().slice(0, 10);
  try {
    const [userAllowed, ipAllowed] = await Promise.all([
      checkRateLimit(redis, `nf_rate:ac_upload_user:${username}:${day}`, UPLOAD_USER_LIMIT_PER_DAY, 172800, { failClosed: true }),
      checkRateLimit(redis, `nf_rate:ac_upload_ip:${getClientIp(req)}:${day}`, UPLOAD_IP_LIMIT_PER_DAY, 172800, { failClosed: true }),
    ]);
    if (!userAllowed || !ipAllowed) {
      return res.status(429).json({ error: 'Daily upload limit reached', code: 'RATE_LIMITED' });
    }
  } catch (_error) {
    return res.status(503).json({ error: 'Upload service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
  }

  try {
    const { put } = require('@vercel/blob');
    const contentType = req.headers['content-type'] || '';
    
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
    }

    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
    const boundary = boundaryMatch && (boundaryMatch[1] || boundaryMatch[2]);
    if (!boundary || boundary.length > 200) return res.status(400).json({ error: 'Invalid multipart boundary' });

    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > MAX_REQUEST_SIZE) return res.status(413).json({ error: 'Request too large' });
      chunks.push(buffer);
    }
    const rawBody = Buffer.concat(chunks);

    const boundaryBuf = Buffer.from('--' + boundary);
    const fileParts = [];
    let pos = 0;

    while (pos < rawBody.length) {
      const boundaryStart = rawBody.indexOf(boundaryBuf, pos);
      if (boundaryStart === -1) break;
      
      pos = boundaryStart + boundaryBuf.length + 2;
      
      const nextBoundary = rawBody.indexOf(boundaryBuf, pos);
      if (nextBoundary === -1) break;

      const partData = rawBody.slice(pos, nextBoundary - 2);
      const headerEnd = partData.indexOf('\r\n\r\n');
      if (headerEnd === -1) { pos = nextBoundary; continue; }

      const header = partData.slice(0, headerEnd).toString('utf-8');
      const bodyData = partData.slice(headerEnd + 4);

      const nameMatch = header.match(/name="([^"]+)"/);
      const filenameMatch = header.match(/filename="([^"]+)"/);

      if (nameMatch && filenameMatch && nameMatch[1] === 'file') {
        if (bodyData.length > MAX_FILE_SIZE) {
          return res.status(413).json({ error: 'File too large (max 10MB)' });
        }

        // Magic-byte MIME detection (don't trust client Content-Type)
        const detected = detectMime(bodyData);
        if (!detected) {
          return res.status(400).json({ error: 'Invalid file type. Only PNG, JPEG, GIF, WebP images are allowed.' });
        }

        fileParts.push({ bodyData, detected });
      }

      pos = nextBoundary;
    }

    if (fileParts.length === 0) {
      return res.status(400).json({ error: 'No file found in upload' });
    }
    if (fileParts.length !== 1) {
      return res.status(400).json({ error: 'Upload exactly one image per request', code: 'ONE_FILE_REQUIRED' });
    }

    const [{ bodyData, detected }] = fileParts;
    const uniqueName = 'ref-img/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + detected.ext;
    const blob = await put(uniqueName, bodyData, {
      access: 'public',
      contentType: detected.mime,
    });

    return res.status(200).json({ url: blob.url, urls: [blob.url] });
  } catch (e) {
    console.error('[ac-upload] upload failed');
    return res.status(500).json({ error: 'Upload failed' });
  }
};
