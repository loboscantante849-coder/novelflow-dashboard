/**
 * GET /api/submissions
 * Returns submission list from KV.
 * Admin key → full data. No key → public-safe fields only.
 */
const { setCORSHeaders } = require('./_lib/cors');
const { checkAdminKey } = require('./_lib/security');
const { Redis } = require('@upstash/redis');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  try {
    const allEntries = await redis.hgetall('nf_subs');
    if (!allEntries || typeof allEntries !== 'object') {
      return res.status(200).json([]);
    }

    let submissions = [];
    for (const [key, v] of Object.entries(allEntries)) {
      if (v) {
        try { submissions.push(typeof v === 'string' ? JSON.parse(v) : v); }
        catch (e) { /* skip */ }
      }
    }

    // Check admin key (timing-safe, header only)
    const isAdmin = checkAdminKey(req);

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
