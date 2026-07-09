/**
 * POST /api/admin-bulk-assign — Bulk assign Anonymous entries to users
 * Body: { assignments: [{ username: "xxx", codes: ["1234","5678"] }] }
 * Admin only (verified via Redis nf_user_data:<u>.accountType === 'admin' OR x-admin-key)
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser, checkAdminKey } = require('./_lib/security');
const { Redis } = require('@upstash/redis');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: JWT admin or x-admin-key header
  let isAdm = checkAdminKey(req);
  const payload = getAuthPayload(req);
  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  if (!isAdm && payload) {
    isAdm = await isAdminUser(redis, payload.username);
  }
  if (!isAdm) return res.status(403).json({ error: 'Admin only' });

  const username = payload?.username || 'admin';

  const { assignments } = req.body;
  if (!assignments || !Array.isArray(assignments)) {
    return res.status(400).json({ error: 'Missing assignments array' });
  }

  try {
    const allCodes = assignments.flatMap(a => a.codes.map(c => String(c)));
    const values = await Promise.all(allCodes.map(c => redis.hget('nf_subs', c)));

    let totalAssigned = 0;
    const results = [];
    const updates = {};
    const setOps = [];

    for (const { username: targetUser, codes } of assignments) {
      let assigned = 0;
      for (const code of codes) {
        const idx = allCodes.indexOf(String(code));
        const raw = idx >= 0 ? values[idx] : null;
        if (!raw) continue;
        const sub = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if ((sub.discordUsername || '').toLowerCase() === 'anonymous') {
          sub.discordUsername = targetUser;
          updates[String(code)] = JSON.stringify(sub);
          setOps.push({ type: 'sadd', key: `nf_user_subs:${targetUser.toLowerCase()}`, member: String(code) });
          setOps.push({ type: 'srem', key: 'nf_user_subs:anonymous', member: String(code) });
          assigned++;
          totalAssigned++;
        }
      }
      results.push({ username: targetUser, assigned, total: codes.length });
    }

    if (totalAssigned === 0) {
      return res.status(200).json({ success: true, assigned: 0, message: 'No new assignments needed', results });
    }

    await redis.hset('nf_subs', updates);
    for (const op of setOps) {
      if (op.type === 'sadd') await redis.sadd(op.key, op.member);
      else await redis.srem(op.key, op.member);
    }

    return res.status(200).json({ success: true, assigned: totalAssigned, results });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
