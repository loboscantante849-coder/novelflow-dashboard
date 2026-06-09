/**
 * GET /api/submissions
 * Returns submission list from KV.
 * Admin key → full data. No key → public-safe fields only.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { Redis } = require('@upstash/redis');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  try {
    const allFields = await redis.hkeys('nf_subs');
    if (!allFields || allFields.length === 0) {
      return res.status(200).json([]);
    }

    // Batch-get all submissions
    const BATCH = 50;
    let submissions = [];
    for (let i = 0; i < allFields.length; i += BATCH) {
      const batch = allFields.slice(i, i + BATCH);
      const values = await redis.hmget('nf_subs', ...batch);
      for (const v of values) {
        if (v) {
          try { submissions.push(typeof v === 'string' ? JSON.parse(v) : v); }
          catch (e) { /* skip */ }
        }
      }
    }

    // Check admin key
    const adminKey = process.env.ADMIN_KEY;
    const providedKey = req.headers['x-admin-key'] || req.query.adminKey;
    const isAdmin = adminKey && providedKey === adminKey;

    if (isAdmin) {
      return res.status(200).json(submissions);
    }

    // Public: safe fields only
    const safe = submissions.map(s => ({
      bookName: s.bookName,
      matchedBookName: s.matchedBookName,
      status: s.status,
      submittedAt: s.submittedAt,
      link: s.link,
      lang: s.lang
    }));
    return res.status(200).json(safe);

  } catch (error) {
    console.error('[submissions] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
