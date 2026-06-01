/**
 * POST /api/ac-upload
 * Upload reference images for AC video generation
 * Uses Vercel Blob storage (requires BLOB_READ_WRITE_TOKEN env var)
 */

const { setCORSHeaders } = require('./_lib/cors');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Check if Vercel Blob is configured
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ 
      error: 'Image upload is not configured. Admin needs to set BLOB_READ_WRITE_TOKEN in Vercel environment variables. Go to Vercel Dashboard > Project > Storage > Create Blob Store.',
      code: 'BLOB_NOT_CONFIGURED'
    });
  }

  try {
    const { put } = require('@vercel/blob');
    const contentType = req.headers['content-type'] || '';
    
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
    }

    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return res.status(400).json({ error: 'No boundary found' });

    // Collect raw body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    // Parse multipart manually
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

        const filename = filenameMatch[1];
        const ext = filename.split('.').pop() || 'png';
        const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5);
        const uniqueName = 'ref-img/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + safeExt;

        const ctMatch = header.match(/Content-Type:\s*([^\r\n]+)/i);
        const fileContentType = ctMatch ? ctMatch[1].trim() : 'image/png';

        const blob = await put(uniqueName, bodyData, {
          access: 'public',
          contentType: fileContentType,
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
