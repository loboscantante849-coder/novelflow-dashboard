/**
 * POST /api/ac-upload
 * Upload reference images to Vercel Blob for AI video generation
 */

const { put } = require('@vercel/blob');
const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Vercel serverless functions don't natively parse multipart/form-data
    // We use the raw body approach
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
    }

    // Parse multipart using busboy or simple boundary parsing
    // For simplicity, use the built-in approach with @vercel/blob client upload
    // Actually, server-side: we need to parse the file from the request
    // Vercel provides req.body as parsed when using formidable/multiparty
    // But in Node.js API routes, we need to handle it manually

    // Simple approach: use the buffer from raw body
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return res.status(400).json({ error: 'No boundary found' });

    // Collect raw body chunks
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    // Find file data in multipart
    const boundaryStr = '--' + boundary;
    const parts = [];
    let start = rawBody.indexOf(boundaryStr) + boundaryStr.length;

    while (start < rawBody.length) {
      // Skip \r\n after boundary
      start += 2;
      // Find next boundary
      const nextBoundary = rawBody.indexOf(boundaryStr, start);
      if (nextBoundary === -1) break;

      const partData = rawBody.slice(start, nextBoundary - 2); // -2 for \r\n before boundary
      const headerEnd = partData.indexOf('\r\n\r\n');
      if (headerEnd === -1) { start = nextBoundary + boundaryStr.length; continue; }

      const header = partData.slice(0, headerEnd).toString();
      const bodyData = partData.slice(headerEnd + 4);

      // Check if this part is a file
      const nameMatch = header.match(/name="([^"]+)"/);
      const filenameMatch = header.match(/filename="([^"]+)"/);

      if (nameMatch && filenameMatch && nameMatch[1] === 'file') {
        const filename = filenameMatch[1];
        // Generate unique path
        const ext = filename.split('.').pop() || 'png';
        const uniqueName = 'ref-img/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;

        // Upload to Vercel Blob
        const blob = await put(uniqueName, bodyData, {
          access: 'public',
          contentType: header.match(/Content-Type:\s*([^\r\n]+)/)?.[1] || 'image/png',
        });

        parts.push({ url: blob.url, pathname: blob.pathname });
      }

      start = nextBoundary + boundaryStr.length;
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
