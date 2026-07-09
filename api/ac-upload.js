/**
 * POST /api/ac-upload
 * Upload reference images for AC video generation (已鉴权 + MIME白名单 + magic-byte校验)
 * Uses Vercel Blob storage (requires BLOB_READ_WRITE_TOKEN env var)
 */

const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload } = require('./_lib/security');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Allowed MIME types and their magic byte signatures
const ALLOWED_MIME = {
  'image/png':  { ext: 'png',  magic: [[0x89, 0x50, 0x4E, 0x47]] },
  'image/jpeg': { ext: 'jpeg', magic: [[0xFF, 0xD8, 0xFF]] },
  'image/gif':  { ext: 'gif',  magic: [[0x47, 0x49, 0x46, 0x38]] },
  'image/webp': { ext: 'webp', magic: [[0x52, 0x49, 0x46, 0x46]] }, // RIFF....WEBP
};

function detectMime(buf) {
  for (const [mime, info] of Object.entries(ALLOWED_MIME)) {
    for (const sig of info.magic) {
      if (buf.length >= sig.length && sig.every((b, i) => buf[i] === b)) {
        // webp extra check: bytes 8-11 should be 'WEBP'
        if (mime === 'image/webp' && !(buf.length >= 12 && buf.slice(8, 12).toString('ascii') === 'WEBP')) continue;
        return { mime, ext: info.ext };
      }
    }
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

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: 'Image upload is not configured', code: 'BLOB_NOT_CONFIGURED' });
  }

  try {
    const { put } = require('@vercel/blob');
    const contentType = req.headers['content-type'] || '';
    
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
    }

    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return res.status(400).json({ error: 'No boundary found' });

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    const boundaryBuf = Buffer.from('--' + boundary);
    const parts = [];
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

        const uniqueName = 'ref-img/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + detected.ext;

        const blob = await put(uniqueName, bodyData, {
          access: 'public',
          contentType: detected.mime,
        });

        parts.push({ url: blob.url, pathname: blob.pathname });
      }

      pos = nextBoundary;
    }

    if (parts.length === 0) {
      return res.status(400).json({ error: 'No file found in upload' });
    }

    return res.status(200).json({ url: parts[0].url, urls: parts.map(p => p.url) });
  } catch (e) {
    console.error('ac-upload error:', e);
    return res.status(500).json({ error: 'Upload failed', detail: e.message });
  }
};
