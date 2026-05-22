/**
 * GET /api/xmp-materials
 * Proxy for XMP (Mobvista) creative library - fetches video/image assets
 * Auth: client_id + timestamp + md5(secret+timestamp)
 * 
 * IMPORTANT: XMP_CLIENT_ID and XMP_CLIENT_SECRET must be set as Vercel env vars
 */

const XMP_CLIENT_ID = process.env.XMP_CLIENT_ID;
const XMP_CLIENT_SECRET = process.env.XMP_CLIENT_SECRET;
const XMP_API_BASE = 'https://xmp-open.mobvista.com';

const crypto = require('crypto');

function generateSign(secret, timestamp) {
  return crypto.createHash('md5').update(secret + String(timestamp)).digest('hex');
}

const { setCORSHeaders } = require('../_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  // CORS handled by setCORSHeaders;
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!XMP_CLIENT_ID || !XMP_CLIENT_SECRET) {
    return res.status(503).json({ error: 'XMP API not configured. Set XMP_CLIENT_ID and XMP_CLIENT_SECRET env vars.' });
  }

  const { action = 'list', folder_id, keyword, page = 1, page_size = 20, material_type } = req.query || {};

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(XMP_CLIENT_SECRET, timestamp);

  try {
    let xmpRes;

    if (action === 'folders') {
      xmpRes = await fetch(XMP_API_BASE + '/v1/media/folder/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: XMP_CLIENT_ID,
          timestamp,
          sign,
          folder_type: 2,
        })
      });
    } else if (action === 'list') {
      const body = {
        client_id: XMP_CLIENT_ID,
        timestamp,
        sign,
        page: parseInt(page),
        page_size: parseInt(page_size),
        is_deleted: 0,
      };
      if (folder_id) {
        body.folder_id = Array.isArray(folder_id) ? folder_id.map(Number) : [Number(folder_id)];
      }
      if (!folder_id) {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
        body.start_date = thirtyDaysAgo.toISOString().split('T')[0];
        body.end_date = now.toISOString().split('T')[0];
      }

      xmpRes = await fetch(XMP_API_BASE + '/v2/media/material/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } else {
      return res.status(400).json({ error: 'Invalid action. Use "list" or "folders".' });
    }

    if (!xmpRes.ok) {
      const errText = await xmpRes.text().catch(() => '');
      console.error('XMP API error:', xmpRes.status, errText);
      return res.status(502).json({ error: 'XMP API error', status: xmpRes.status });
    }

    const data = await xmpRes.json();

    if (data.code !== 0) {
      console.error('XMP API returned error:', data.msg);
      return res.status(200).json({ success: false, error: data.msg, code: data.code });
    }

    let materials = data.data || [];
    if (action === 'list' && keyword) {
      const kw = keyword.toLowerCase();
      materials = materials.filter(m => {
        const name = (m.material_name || '').toLowerCase();
        const tags = Array.isArray(m.tag) ? m.tag.map(t => (t.name || '').toLowerCase()).join(' ') : '';
        const folder = (m.folder_name || '').toLowerCase();
        return name.includes(kw) || tags.includes(kw) || folder.includes(kw);
      });
    }

    if (action === 'list' && material_type) {
      materials = materials.filter(m => m.material_type === material_type);
    }

    return res.status(200).json({
      success: true,
      data: materials,
      total: materials.length,
      page: parseInt(page),
      page_size: parseInt(page_size),
      source: 'xmp'
    });

  } catch (error) {
    console.error('XMP proxy error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
