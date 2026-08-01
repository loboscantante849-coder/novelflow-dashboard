/**
 * GET /api/submissions
 * Administrative export of submission records from Redis.
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

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const hasAdminKey = checkAdminKey(req);
  const payload = hasAdminKey ? null : getAuthPayload(req);
  const username = String(payload && payload.username || '').trim().toLowerCase();
  if (!hasAdminKey && !username) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Service temporarily unavailable' });

  if (!hasAdminKey) {
    try {
      if (await isDisabledUser(redis, payload, { failClosed: true })) {
        return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
      }
      if (!await isAdminUser(redis, username, { failClosed: true })) {
        return res.status(403).json({ error: 'Admin access required' });
      }
    } catch (_error) {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  }

  try {
    const allEntries = await redis.hgetall('nf_subs');
    if (!allEntries || typeof allEntries !== 'object') {
      return res.status(200).json([]);
    }

    const submissions = [];
    for (const value of Object.values(allEntries)) {
      if (!value) continue;
      try {
        submissions.push(typeof value === 'string' ? JSON.parse(value) : value);
      } catch (_error) {
        // Skip malformed legacy rows without preventing an administrative export.
      }
    }
    return res.status(200).json(submissions);
  } catch (_error) {
    console.error('[submissions] Redis read failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
};
