/**
 * GET /api/trending-books
 * Resolves weekly top promotion books from NovelFlow's measured campaign
 * performance, then enriches them with the authorised NovelSpa catalogue.
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
const promotionPerformance = require('../ad_id_details.json');
const { rankBooks, cleanTitle } = require('./_lib/social-performance');
// BOOKSTORE_TOKEN fetched via getBookstoreToken() inside handler

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

function mapCatalogBook(book, lang, promotion = null) {
  return {
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
    // This is deliberately not presented as reader count. It is only used
    // as the measured seven-day campaign visit metric on Top Promotions.
    promotionVisits7d: Number(promotion?.pullUv) || 0,
    promotionRank: Number(promotion?.rank) || 0,
    promotionScore: Number(promotion?.score) || 0
  };
}

async function getCatalogBooks(url) {
  try {
    const { response } = await bookstoreFetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!response || !response.ok) return [];
    const data = await response.json();
    return (data.data && data.data.data) || data.data || [];
  } catch (error) {
    console.warn('[trending] Catalogue request failed:', error.message);
    return [];
  }
}

async function fetchBooksFromAPI(lang, category, limit) {
  // This endpoint is a catalogue fallback only. Upstream sorting is ignored,
  // so no ranking claims are made from it.
  let apiUrl = `${BOOKSTORE_API_BASE}/booklist?current=1&pageSize=${limit}&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&bookStatus=1`;
  if (lang) apiUrl += `&languageCode=${lang}`;
  if (category) apiUrl += `&bookClassName=${encodeURIComponent(category)}`;

  console.log(`[trending] Fetching: lang=${lang}, category=${category}, limit=${limit}`);

  let rawBooks = await getCatalogBooks(apiUrl);
  console.log(`[trending] API returned ${rawBooks.length} books with lang=${lang}`);

  // Never drop the requested language for Spanish. An English fallback would
  // leak the wrong catalogue into the Spanish UI; English may use the
  // unfiltered endpoint because the default catalogue is English.
  if (rawBooks.length === 0 && lang === 'en') {
    console.log('[trending] Retrying without languageCode filter...');
    const fallbackUrl = `${BOOKSTORE_API_BASE}/booklist?current=1&pageSize=${limit}&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&bookStatus=1`;
    rawBooks = await getCatalogBooks(fallbackUrl);
    console.log(`[trending] Without lang filter: ${rawBooks.length} books`);
  }

  if (rawBooks.length === 0) return [];

  return rawBooks.map(book => mapCatalogBook(book, lang));
}

async function fetchTopPromotionBooks(lang, limit) {
  const ranking = rankBooks(promotionPerformance, 7);
  const language = String(lang || 'en').toLowerCase();
  // Search more candidates than the requested result because some historical
  // campaign titles may no longer be authorised in the current catalogue.
  const candidates = ranking.books.slice(0, 18);
  const resolved = await Promise.all(candidates.map(async (promotion) => {
    const url = `${BOOKSTORE_API_BASE}/booklist?current=1&pageSize=10&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&bookStatus=1&languageCode=${encodeURIComponent(language)}&bookName=${encodeURIComponent(promotion.title)}`;
    const matches = await getCatalogBooks(url);
    const expected = cleanTitle(promotion.title).toLowerCase();
    const exact = matches.find(book => (
      String(book.languageCode || '').toLowerCase() === language &&
      cleanTitle(book.title).toLowerCase() === expected
    ));
    return exact ? mapCatalogBook(exact, language, promotion) : null;
  }));
  const seen = new Set();
  const measuredBooks = resolved.filter(Boolean).filter(book => {
    if (seen.has(book.bookId)) return false;
    seen.add(book.bookId);
    return true;
  }).sort((left, right) => left.promotionRank - right.promotionRank).slice(0, limit);
  // Fill the discovery grid with catalogue books, but keep the measured Top
  // books first and never give fallback books a rank metric.
  const catalogueBooks = measuredBooks.length < limit
    ? await fetchBooksFromAPI(language, undefined, limit)
    : [];
  const books = measuredBooks.concat(catalogueBooks.filter(book => !seen.has(book.bookId))).slice(0, limit);
  return { books, window: ranking.window };
}

const { setCORSHeaders } = require('./_lib/cors')
const { bookstoreFetch } = require('./_lib/bookstore-fetch');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  // CORS handled by setCORSHeaders;
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { mode = 'trending', category, lang = 'en', limit = 20 } = req.query || {};
  const effectiveLimit = Math.min(parseInt(limit) || 20, 50);
  
  // Refresh mode: clear cache and re-fetch (admin or Vercel cron only)
  if (mode === 'refresh') {
    // Allow Vercel cron (x-vercel-cron header) or x-admin-key
    const isCron = req.headers['x-vercel-cron'] === '1';
    const { checkAdminKey } = require('./_lib/security');
    const isAdm = checkAdminKey(req);
    if (!isCron && !isAdm) {
      return res.status(403).json({ error: 'Admin key or cron trigger required' });
    }
    const patterns = ['all', 'Romance', 'Werewolf', 'Billionaire', 'Teenfiction/Young Adult', 'Fantasy', 'Mafia', 'LGBT'];
    const langs = ['en', 'es', ''];
    for (const cat of patterns) {
      for (const l of langs) {
        await kvDel(`trending:v4:trending:${cat}:${l}:${effectiveLimit}`);
        await kvDel(`trending:v3:trending:${cat}:${l}:${effectiveLimit}`);
        await kvDel(`trending:v2:trending:${cat}:${l}:${effectiveLimit}`);
      }
    }
    // Re-fetch and cache
    const ranked = !category && mode === 'refresh' ? await fetchTopPromotionBooks(lang, effectiveLimit) : { books: await fetchBooksFromAPI(lang, category, effectiveLimit) };
    const freshBooks = ranked.books;
    const result = {
      success: true,
      mode: 'trending',
      data: freshBooks,
      total: freshBooks.length,
      source: freshBooks.some(book => book.promotionVisits7d > 0) ? 'novelflow-promotion-performance' : 'novelspa-catalog',
      ranking: ranked.window ? { metric: 'campaign_visits_7d', ...ranked.window } : null,
      updated: new Date().toISOString()
    };
    if (freshBooks.length > 0) {
      const cacheKey = `trending:v4:trending:${category || 'all'}:${lang}:${effectiveLimit}`;
      await kvSet(cacheKey, result, CACHE_TTL);
    }
    return res.status(200).json(result);
  }

  const cacheKey = `trending:v4:${mode}:${category || 'all'}:${lang}:${effectiveLimit}`;

  // Try cache first
  const cached = await kvGet(cacheKey);
  if (cached && cached.data && cached.data.length > 0) {
    return res.status(200).json({ ...cached, cached: true });
  }

  // Fetch from API
  const ranked = mode === 'trending' && !category
    ? await fetchTopPromotionBooks(lang, effectiveLimit)
    : { books: await fetchBooksFromAPI(lang, category, effectiveLimit) };
  const books = ranked.books;

  let result;
  if (mode === 'browse' && !category) {
    const categories = {};
    books.forEach(book => {
      const cat = book.bookClassName || 'Other';
      if (!categories[cat]) categories[cat] = [];
      if (categories[cat].length < 10) categories[cat].push(book);
    });
    result = { success: true, mode: 'browse', categories, total: books.length, source: 'novelspa-catalog', updated: new Date().toISOString() };
  } else if (mode === 'category' || category) {
    result = { success: true, mode: 'category', data: books, total: books.length, category: category || 'all', source: 'novelspa-catalog', updated: new Date().toISOString() };
  } else {
    result = {
      success: true,
      mode: 'trending',
      data: books,
      total: books.length,
      source: books.some(book => book.promotionVisits7d > 0) ? 'novelflow-promotion-performance' : 'novelspa-catalog',
      ranking: ranked.window ? { metric: 'campaign_visits_7d', ...ranked.window } : null,
      updated: new Date().toISOString()
    };
  }

  // Only cache non-empty results
  if (books.length > 0) {
    await kvSet(cacheKey, result, CACHE_TTL);
  } else {
    console.warn('[trending] Not caching empty result');
  }

  return res.status(200).json(result);
};
