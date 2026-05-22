/**
 * GET /api/trending-books
 * Fetches weekly top books from novelspa API, sorted by UV desc
 * Cached in Upstash Redis for 24 hours
 * 
 * Query params:
 * - mode: 'trending' (default) | 'browse' | 'category' | 'refresh'
 * - category: bookClassName filter
 * - lang: language code (default: en)
 * - limit: number of books (default: 20, max: 50)
 */

const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage/book';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
const BOOKSTORE_TOKEN = process.env.NOVELSPA_TOKEN || process.env.BOOKSTORE_TOKEN || '';

const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;

const CACHE_TTL = 24 * 60 * 60; // 24 hours

async function kvGet(key) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return null;
  try {
    const resp = await fetch(`${KV_REST_API_URL}/get/${key}`, {
      headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.result) return JSON.parse(data.result);
    }
  } catch (e) { console.warn('Cache read failed:', e.message); }
  return null;
}

async function kvSet(key, value, ttl) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return;
  try {
    await fetch(`${KV_REST_API_URL}/set/${key}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value), expirein: ttl })
    });
  } catch (e) { console.warn('Cache write failed:', e.message); }
}

async function kvDel(key) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return;
  try {
    await fetch(`${KV_REST_API_URL}/del/${key}`, {
      headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` }
    });
  } catch (e) { console.warn('Cache delete failed:', e.message); }
}

async function fetchBooksFromAPI(lang, category, limit) {
  if (!BOOKSTORE_TOKEN) {
    console.error('[trending] No BOOKSTORE_TOKEN configured');
    return [];
  }

  // Build API URL - try with languageCode first
  let apiUrl = `${BOOKSTORE_API_BASE}/booklist?current=1&pageSize=${limit}&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&bookStatus=1&orderBy=uv&orderType=desc`;
  if (lang) apiUrl += `&languageCode=${lang}`;
  if (category) apiUrl += `&bookClassName=${encodeURIComponent(category)}`;

  console.log(`[trending] Fetching: lang=${lang}, category=${category}, limit=${limit}`);

  let response;
  try {
    response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[trending] API fetch error:', e.message);
    return [];
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error('[trending] API error:', response.status, errText);
    return [];
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    console.error('[trending] JSON parse error:', e.message);
    return [];
  }

  let rawBooks = (data.data && data.data.data) || data.data || [];
  console.log(`[trending] API returned ${rawBooks.length} books with lang=${lang}`);

  // If languageCode filter returned 0 books, retry without it
  if (rawBooks.length === 0 && lang) {
    console.log('[trending] Retrying without languageCode filter...');
    const fallbackUrl = `${BOOKSTORE_API_BASE}/booklist?current=1&pageSize=${limit}&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&bookStatus=1&orderBy=uv&orderType=desc`;
    try {
      const fallbackResp = await fetch(fallbackUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' }
      });
      if (fallbackResp.ok) {
        const fallbackData = await fallbackResp.json();
        rawBooks = (fallbackData.data && fallbackData.data.data) || fallbackData.data || [];
        console.log(`[trending] Without lang filter: ${rawBooks.length} books`);
      }
    } catch (e) {
      console.warn('[trending] Fallback fetch failed:', e.message);
    }
  }

  if (rawBooks.length === 0) return [];

  // Log sample for debugging
  const sample = rawBooks[0];
  const coverFields = Object.entries(sample).filter(([k, v]) => {
    const kl = k.toLowerCase();
    return (kl.includes('cover') || kl.includes('pic') || kl.includes('img') || kl.includes('image')) && typeof v === 'string' && v.length > 0;
  });
  console.log('[trending] Cover-related fields:', JSON.stringify(Object.fromEntries(coverFields)));
  console.log('[trending] Top 3:', rawBooks.slice(0, 3).map(b => b.title + ' (uv:' + (b.uv || b.bookUv || 0) + ')').join(' | '));

  const books = rawBooks.map(book => ({
    bookId: book.bookId || book.id,
    title: book.title,
    cover: book.cover || book.coverImage || book.coverUrl || book.picUrl || book.bookCover || book.imgUrl || book.pic || '',
    author: Array.isArray(book.authors) ? book.authors.map(a => a.authorName || a).join(', ') : (book.author || ''),
    description: book.description ? book.description.substring(0, 200) : '',
    rating: book.bookScore > 0 ? book.bookScore : 4.5,
    tags: Array.isArray(book.tags) ? book.tags.map(t => typeof t === 'object' ? t.tagName || t.name || '' : t).filter(Boolean) : [],
    bookClassName: book.bookClassName || '',
    languageCode: book.languageCode || lang || 'en',
    words: book.words || 0,
    chapterCount: book.chapterCount || 0,
    uv: book.uv || book.bookUv || book.readCount || 0
  }));

  // Safeguard: sort by UV descending
  books.sort((a, b) => (b.uv || 0) - (a.uv || 0));
  return books;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { mode = 'trending', category, lang = 'en', limit = 20 } = req.query || {};
  const effectiveLimit = Math.min(parseInt(limit) || 20, 50);
  
  // Refresh mode: clear cache for this lang/category and re-fetch
  if (mode === 'refresh') {
    const patterns = ['all', 'Romance', 'Werewolf', 'Billionaire', 'Teenfiction/Young Adult', 'Fantasy', 'Mafia', 'LGBT'];
    const langs = ['en', 'es', ''];
    for (const cat of patterns) {
      for (const l of langs) {
        await kvDel(`trending:v3:trending:${cat}:${l}:${effectiveLimit}`);
        await kvDel(`trending:v2:trending:${cat}:${l}:${effectiveLimit}`);
      }
    }
    // Re-fetch and cache
    const freshBooks = await fetchBooksFromAPI(lang, category, effectiveLimit);
    const result = {
      success: true,
      mode: 'trending',
      data: freshBooks,
      total: freshBooks.length,
      source: 'novelspa-uv-refreshed',
      updated: new Date().toISOString()
    };
    if (freshBooks.length > 0) {
      const cacheKey = `trending:v3:trending:${category || 'all'}:${lang}:${effectiveLimit}`;
      await kvSet(cacheKey, result, CACHE_TTL);
    }
    return res.status(200).json(result);
  }

  const cacheKey = `trending:v3:${mode}:${category || 'all'}:${lang}:${effectiveLimit}`;

  // Try cache first
  const cached = await kvGet(cacheKey);
  if (cached && cached.data && cached.data.length > 0) {
    return res.status(200).json({ ...cached, cached: true });
  }

  // Fetch from API
  const books = await fetchBooksFromAPI(lang, category, effectiveLimit);

  let result;
  if (mode === 'browse' && !category) {
    const categories = {};
    books.forEach(book => {
      const cat = book.bookClassName || 'Other';
      if (!categories[cat]) categories[cat] = [];
      if (categories[cat].length < 10) categories[cat].push(book);
    });
    result = { success: true, mode: 'browse', categories, total: books.length, source: 'novelspa-uv', updated: new Date().toISOString() };
  } else if (mode === 'category' || category) {
    result = { success: true, mode: 'category', data: books, total: books.length, category: category || 'all', source: 'novelspa-uv', updated: new Date().toISOString() };
  } else {
    result = { success: true, mode: 'trending', data: books, total: books.length, source: 'novelspa-uv', updated: new Date().toISOString() };
  }

  // Only cache non-empty results
  if (books.length > 0) {
    await kvSet(cacheKey, result, CACHE_TTL);
  } else {
    console.warn('[trending] Not caching empty result');
  }

  return res.status(200).json(result);
};
