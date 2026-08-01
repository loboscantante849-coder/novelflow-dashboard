/**
 * AC token storage. Token writes require x-admin-key; health reads also require
 * either that key or an authenticated Redis-backed admin account.
 */

'use strict';

const { setCORSHeaders } = require('./_lib/cors');
const {
  checkAdminKey,
  getAuthPayload,
  getRedis,
  isAdminUser,
  isDisabledUser,
} = require('./_lib/security');

async function authorizeRead(redis, payload) {
  const username = String(payload && payload.username || '').trim().toLowerCase();
  try {
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return { ok: false, status: 403, error: 'Account disabled', code: 'ACCOUNT_DISABLED' };
    }
    if (!await isAdminUser(redis, username, { failClosed: true })) {
      return { ok: false, status: 403, error: 'Admin access required' };
    }
    return { ok: true };
  } catch (_error) {
    return { ok: false, status: 503, error: 'Service temporarily unavailable' };
  }
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method === 'POST' && !checkAdminKey(req)) {
    return res.status(403).json({ error: 'Admin key required' });
  }

  const hasAdminKey = checkAdminKey(req);
  const payload = req.method === 'GET' && !hasAdminKey ? getAuthPayload(req) : null;
  const username = String(payload && payload.username || '').trim().toLowerCase();
  if (req.method === 'GET' && !hasAdminKey && !username) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Service temporarily unavailable' });

  if (req.method === 'GET') {
    const authorization = hasAdminKey ? { ok: true } : await authorizeRead(redis, payload);
    if (!authorization.ok) {
      return res.status(authorization.status).json({
        error: authorization.error,
        ...(authorization.code ? { code: authorization.code } : {}),
      });
    }
    try {
      const token = await redis.get('ac_token');
      return res.status(200).json({ configured: Boolean(token), status: 'ok' });
    } catch (_error) {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  }

  const { action, token } = req.body || {};
  if (action !== 'set' || typeof token !== 'string' || token.length < 1 || token.length > 8192) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    await redis.set('ac_token', token);
    return res.status(200).json({ success: true, message: 'Token saved' });
  } catch (_error) {
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }
};
