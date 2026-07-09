/**
 * GET /api/book-covers?bookIds=id1,id2,id3
 * Returns cover URLs for given bookIds, cached in KV
 */
const { setCORSHeaders } = require('./_lib/cors');
const { checkAdminKey } = require('./_lib/security');
const { getBookstoreToken } = require('./_lib/oidc-token');
const { Redis } = require('@upstash/redis');

const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage/book';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = getRedis();
  const token = await getBookstoreToken();

  // POST /api/book-covers — backfill all covers (admin only, with cooldown lock)
  if (req.method === 'POST') {
    if (!checkAdminKey(req)) return res.status(403).json({ error: 'Admin key required' });
    if (!token || !redis) return res.status(500).json({ error: 'Missing token or KV' });

    // Cooldown lock: one backfill per 5 minutes max
    const lockKey = 'cover_backfill_lock';
    const locked = await redis.set(lockKey, '1', { nx: true, ex: 300 });
    if (!locked) {
      return res.status(429).json({ error: 'Backfill already running or ran recently (5min cooldown)' });
    }
    
    // Get all bookIds from nf_subs
    const allEntries = await redis.hgetall('nf_subs');
    const bookIds = new Set();
    if (allEntries && typeof allEntries === 'object') {
      for (const val of Object.values(allEntries)) {
        try {
          const entry = typeof val === 'string' ? JSON.parse(val) : val;
          const bid = entry.bookId;
          if (bid && String(bid) !== 'None' && String(bid).length > 10) {
            bookIds.add(String(bid));
          }
        } catch {}
      }
    }

    // Check existing covers in KV
    let coversMap = {};
    try {
      const raw = await redis.get('nf_book_covers');
      if (raw) coversMap = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {}

    const missingIds = [...bookIds].filter(id => !coversMap[id]);
    
    // Fetch covers from bookstore API (search by bookId using keyword)
    let fetched = 0;
    for (const bid of missingIds) {
      try {
        const searchUrl = `${BOOKSTORE_API_BASE}/booklist?current=1&pageSize=3&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&bookStatus=1&keyword=${bid}`;
        const resp = await fetch(searchUrl, {
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        if (resp.ok) {
          const data = await resp.json();
          const books = data?.data?.data || [];
          const match = books.find(b => b.bookId === bid);
          if (match?.cover) {
            coversMap[bid] = { cover: match.cover, title: match.title || '' };
            fetched++;
          }
        }
      } catch {}
    }

    // Save updated covers map
    await redis.set('nf_book_covers', JSON.stringify(coversMap));

    return res.json({ 
      totalBookIds: bookIds.size, 
      previouslyCached: bookIds.size - missingIds.length,
      newlyFetched: fetched,
      totalCovers: Object.keys(coversMap).length
    });
  }

  // GET /api/book-covers?bookIds=id1,id2 — lookup specific covers
  if (req.method === 'GET') {
    const ids = (req.query.bookIds || '').split(',').filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'bookIds query param required' });
    
    let coversMap = {};
    try {
      const raw = redis ? await redis.get('nf_book_covers') : null;
      if (raw) coversMap = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {}

    const result = {};
    for (const id of ids) {
      if (coversMap[id]) result[id] = coversMap[id];
    }
    return res.json({ covers: result, found: Object.keys(result).length, requested: ids.length });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
