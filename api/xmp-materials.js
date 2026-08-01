/**
 * GET /api/xmp-materials
 * Authenticated proxy for the XMP (Mobvista) creative library.
 */

'use strict';

const crypto = require('crypto');

const { setCORSHeaders } = require('./_lib/cors');
const {
  checkRateLimit,
  getAuthPayload,
  getClientIp,
  getRedis,
  isDisabledUser,
} = require('./_lib/security');

const XMP_API_BASE = 'https://xmp-open.mobvista.com';
const XMP_TIMEOUT_MS = 10000;
const XMP_USER_LIMIT_PER_MINUTE = 30;
const XMP_IP_LIMIT_PER_MINUTE = 60;
const MAX_PAGE = 1000;
const MAX_PAGE_SIZE = 50;
const MAX_FOLDER_IDS = 20;
const MAX_KEYWORD_LENGTH = 100;
const MATERIAL_TYPES = new Set(['video', 'image']);

function generateSign(secret, timestamp) {
  return crypto.createHash('md5').update(secret + String(timestamp)).digest('hex');
}

function parseBoundedInteger(value, { defaultValue, max }) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if ((typeof value !== 'string' && typeof value !== 'number') || Array.isArray(value)) return null;
  const raw = String(value);
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > max) return null;
  return parsed;
}

function parseFolderIds(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > MAX_FOLDER_IDS) return null;

  const ids = [];
  for (const item of values) {
    if ((typeof item !== 'string' && typeof item !== 'number') || !/^[1-9][0-9]*$/.test(String(item))) {
      return null;
    }
    const id = Number(item);
    if (!Number.isSafeInteger(id)) return null;
    ids.push(id);
  }
  return ids;
}

function validateQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return { ok: false, error: 'Invalid query parameters' };
  }

  const rawAction = query.action === undefined ? 'list' : query.action;
  if (typeof rawAction !== 'string' || Array.isArray(rawAction)) {
    return { ok: false, error: 'Invalid action' };
  }
  const action = rawAction.trim().toLowerCase();
  if (action !== 'list' && action !== 'folders') {
    return { ok: false, error: 'Invalid action' };
  }

  const page = parseBoundedInteger(query.page, { defaultValue: 1, max: MAX_PAGE });
  if (page === null) return { ok: false, error: 'Invalid page' };

  const pageSize = parseBoundedInteger(query.page_size, { defaultValue: 20, max: MAX_PAGE_SIZE });
  if (pageSize === null) return { ok: false, error: 'Invalid page_size' };

  const folderIds = parseFolderIds(query.folder_id);
  if (folderIds === null) return { ok: false, error: 'Invalid folder_id' };

  let keyword = '';
  if (query.keyword !== undefined && query.keyword !== null) {
    if (typeof query.keyword !== 'string' || Array.isArray(query.keyword)) {
      return { ok: false, error: 'Invalid keyword' };
    }
    keyword = query.keyword.trim();
    if (keyword.length > MAX_KEYWORD_LENGTH) {
      return { ok: false, error: 'Invalid keyword' };
    }
  }

  let materialType = '';
  if (query.material_type !== undefined && query.material_type !== null && query.material_type !== '') {
    if (typeof query.material_type !== 'string' || Array.isArray(query.material_type)) {
      return { ok: false, error: 'Invalid material_type' };
    }
    materialType = query.material_type.trim().toLowerCase();
    if (!MATERIAL_TYPES.has(materialType)) {
      return { ok: false, error: 'Invalid material_type' };
    }
  }

  return { ok: true, action, page, pageSize, folderIds, keyword, materialType };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), XMP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const payload = getAuthPayload(req);
  const username = String(payload && payload.username || '').trim().toLowerCase();
  if (!username) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  }
  try {
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  const parsed = validateQuery(req.query || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const clientId = process.env.XMP_CLIENT_ID;
  const clientSecret = process.env.XMP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).json({ error: 'Asset service unavailable' });
  }

  try {
    const ip = getClientIp(req);
    const [userAllowed, ipAllowed] = await Promise.all([
      checkRateLimit(redis, `nf_rate:xmp_user:${username}`, XMP_USER_LIMIT_PER_MINUTE, 60, { failClosed: true }),
      checkRateLimit(redis, `nf_rate:xmp_ip:${ip}`, XMP_IP_LIMIT_PER_MINUTE, 60, { failClosed: true }),
    ]);
    if (!userAllowed || !ipAllowed) {
      return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
    }
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(clientSecret, timestamp);

  try {
    let xmpRes;
    if (parsed.action === 'folders') {
      xmpRes = await fetchWithTimeout(`${XMP_API_BASE}/v1/media/folder/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          timestamp,
          sign,
          folder_type: 2,
        }),
      });
    } else {
      const body = {
        client_id: clientId,
        timestamp,
        sign,
        page: parsed.page,
        page_size: parsed.pageSize,
        is_deleted: 0,
      };
      if (parsed.folderIds.length > 0) {
        body.folder_id = parsed.folderIds;
      } else {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
        body.start_date = thirtyDaysAgo.toISOString().split('T')[0];
        body.end_date = now.toISOString().split('T')[0];
      }

      xmpRes = await fetchWithTimeout(`${XMP_API_BASE}/v2/media/material/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    if (!xmpRes.ok) {
      console.error('[xmp-materials] upstream request failed with status', xmpRes.status);
      return res.status(502).json({ error: 'Asset service unavailable' });
    }

    const data = await xmpRes.json();
    if (!data || data.code !== 0 || !Array.isArray(data.data)) {
      console.error('[xmp-materials] upstream returned an invalid response');
      return res.status(502).json({ error: 'Asset service unavailable' });
    }

    let materials = data.data;
    if (parsed.action === 'list' && parsed.keyword) {
      const keyword = parsed.keyword.toLowerCase();
      materials = materials.filter((material) => {
        const name = String(material && material.material_name || '').toLowerCase();
        const tags = Array.isArray(material && material.tag)
          ? material.tag.map(tag => String(tag && tag.name || '').toLowerCase()).join(' ')
          : '';
        const folder = String(material && material.folder_name || '').toLowerCase();
        return name.includes(keyword) || tags.includes(keyword) || folder.includes(keyword);
      });
    }

    if (parsed.action === 'list' && parsed.materialType) {
      materials = materials.filter(material => material && material.material_type === parsed.materialType);
    }

    return res.status(200).json({
      success: true,
      data: materials,
      total: materials.length,
      page: parsed.page,
      page_size: parsed.pageSize,
      source: 'xmp',
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return res.status(504).json({ error: 'Asset service timed out' });
    }
    console.error('[xmp-materials] upstream request failed');
    return res.status(502).json({ error: 'Asset service unavailable' });
  }
};
