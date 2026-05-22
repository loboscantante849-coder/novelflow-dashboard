/**
 * GET /api/trending-books
 * Fetches weekly top books from novelspa API, sorted by UV desc
 * Cached in Upstash Redis for 24 hours
 * 
 * Query params:
 * - mode: 'trending' (default) | 'browse' | 'category'
 * - category: bookClassName filter (Werewolf, Romance, Billionaire, etc.)
 * - lang: language code (default: en)
 * - limit: number of books (default: 20, max: 50)
 */

const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage/book';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
const BOOKSTORE_TOKEN = process.env.NOVELSPA_TOKEN || process.env.BOOKSTORE_TOKEN || '';

const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;

const CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { mode = 'trending', category, lang = 'en', limit = 20 } = req.query || {};
  
  // Refresh mode: clear all trending cache and re-fetch
  if (mode === 'refresh') {
    if (KV_REST_API_URL && KV_REST_API_TOKEN) {
      try {
        // Clear all trending:* keys by setting new data
        const categories = ['all', 'Romance', 'Werewolf', 'Billionaire', 'Teenfiction/Young Adult', 'Fantasy', 'Mafia', 'LGBT'];
        for (const cat of categories) {
          const key = 'trending:trending:' + cat + ':en:50';
          await fetch(KV_REST_API_URL + '/del/' + key, {
            headers: { 'Authorization': 'Bearer ' + KV_REST_API_TOKEN }
          });
        }
      } catch (e) { console.warn('Cache clear failed:', e.message); }
    }
    // Pre-warm cache for trending
    const prewarmUrl = BOOKSTORE_API_BASE + '/booklist?current=1&pageSize=50&pageIndex=1&applicationId=' + BOOKSTORE_APP_ID + '&languageCode=en&bookStatus=1&orderBy=uv&orderType=desc';
    try {
      await fetch(prewarmUrl, {
        headers: { 'Authorization': 'Bearer ' + BOOKSTORE_TOKEN, 'Content-Type': 'application/json' }
      });
    } catch(e) { console.warn('Pre-warm failed:', e.message); }
    return res.status(200).json({ success: true, message: 'Trending cache refreshed' });
  }
  const effectiveLimit = Math.min(parseInt(limit) || 20, 50);
  
  // Build cache key
  const cacheKey = `trending:v2:${mode}:${category || 'all'}:${lang}:${effectiveLimit}`;

  try {
    // Try cache first
    if (KV_REST_API_URL && KV_REST_API_TOKEN) {
      try {
        const cacheResp = await fetch(`${KV_REST_API_URL}/get/${cacheKey}`, {
          headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` }
        });
        if (cacheResp.ok) {
          const cacheData = await cacheResp.json();
          if (cacheData.result) {
            const cached = JSON.parse(cacheData.result);
            return res.status(200).json({ ...cached, cached: true });
          }
        }
      } catch (e) {
        console.warn('Cache read failed:', e.message);
      }
    }

    // Fetch from novelspa API
    if (!BOOKSTORE_TOKEN) {
      return res.status(500).json({ error: 'No bookstore token configured' });
    }

    let apiUrl = `${BOOKSTORE_API_BASE}/booklist?current=1&pageSize=${effectiveLimit}&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&languageCode=${lang}&bookStatus=1&orderBy=uv&orderType=desc`;
    
    if (category) {
      apiUrl += `&bookClassName=${encodeURIComponent(category)}`;
    }

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 
        'Content-Type': 'application/json' 
      }
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('Bookstore API error:', response.status, errText);
      return res.status(502).json({ error: 'Upstream API error', status: response.status });
    }

    const data = await response.json();
    const rawBooks = (data.data && data.data.data) || data.data || [];
    if (rawBooks.length > 0) {
      const sample = rawBooks[0];
      console.log('[trending] Sample book raw keys:', Object.keys(sample).join(', '));
      // Log all fields that might be cover-related
      const coverFields = Object.entries(sample).filter(([k, v]) => {
        const kl = k.toLowerCase();
        return (kl.includes('cover') || kl.includes('pic') || kl.includes('img') || kl.includes('url') || kl.includes('image')) && typeof v === 'string' && v.length > 0;
      });
      console.log('[trending] Cover-related fields:', JSON.stringify(Object.fromEntries(coverFields)));
      console.log('[trending] First 3 books titles:', rawBooks.slice(0, 3).map(b => b.title).join(' | '));
    }

    const books = rawBooks.map(book => ({
      bookId: book.bookId || book.id,
      title: book.title,
      cover: book.cover || book.coverImage || book.coverUrl || book.picUrl || book.bookCover || book.imgUrl || book.pic || '',
      author: Array.isArray(book.authors) ? book.authors.map(a => a.authorName || a).join(', ') : (book.author || ''),
      description: book.description ? book.description.substring(0, 200) : '',
      rating: book.bookScore > 0 ? book.bookScore : 4.5,
      tags: Array.isArray(book.tags) ? book.tags.map(t => typeof t === 'object' ? t.tagName || t.name || '' : t).filter(Boolean) : [],
      bookClassName: book.bookClassName || '',
      languageCode: book.languageCode || lang,
      words: book.words || 0,
      chapterCount: book.chapterCount || 0,
      uv: book.uv || book.bookUv || book.readCount || 0
    }));

    // Safeguard: sort by UV descending in case API returns wrong order
    books.sort((a, b) => (b.uv || 0) - (a.uv || 0));

    // For browse mode, group by category
    let result;
    if (mode === 'browse' && !category) {
      const categories = {};
      books.forEach(book => {
        const cat = book.bookClassName || 'Other';
        if (!categories[cat]) categories[cat] = [];
        if (categories[cat].length < 10) categories[cat].push(book);
      });
      result = {
        success: true,
        mode: 'browse',
        categories,
        total: books.length,
        source: 'novelspa-uv',
        updated: new Date().toISOString()
      };
    } else if (mode === 'category' || category) {
      result = {
        success: true,
        mode: 'category',
        data: books,
        total: (data.data && data.data.total) || books.length,
        category: category || 'all',
        source: 'novelspa-uv',
        updated: new Date().toISOString()
      };
    } else {
      // trending mode
      result = {
        success: true,
        mode: 'trending',
        data: books,
        total: (data.data && data.data.total) || books.length,
        source: 'novelspa-uv',
        updated: new Date().toISOString()
      };
    }

    // Cache the result
    if (KV_REST_API_URL && KV_REST_API_TOKEN) {
      try {
        await fetch(`${KV_REST_API_URL}/set/${cacheKey}`, {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${KV_REST_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ value: JSON.stringify(result), expirein: CACHE_TTL })
        });
      } catch (e) {
        console.warn('Cache write failed:', e.message);
      }
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error('Trending books API error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
