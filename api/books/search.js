/**
 * Book search API - supports featured-books.json and novelspa API
 * When no keyword/class specified, returns featured books
 * When keyword provided, searches both API and featured-books.json
 */

const RATE_LIMIT = 30;
const RATE_WINDOW = 60 * 1000;
const rateLimits = new Map();
const fs = require('fs');
const path = require('path');

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record || now - record.start > RATE_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  if (record.count >= RATE_LIMIT) return { allowed: false, remaining: 0 };
  record.count++;
  return { allowed: true, remaining: RATE_LIMIT - record.count };
}

const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage/book';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';

// Load featured books from JSON file
function loadFeaturedBooks() {
  try {
    const filePath = path.join(__dirname, '..', '..', 'featured-books.json');
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.warn('Failed to load featured-books.json:', e.message);
    return null;
  }
}

// Search featured books by keyword across all categories + recommended
function searchFeaturedBooks(featured, keyword, lang) {
  if (!featured) return [];
  const keywordLower = keyword.toLowerCase();
  const allBooks = [];
  
  // Collect from recommended
  if (Array.isArray(featured.recommended)) {
    allBooks.push(...featured.recommended);
  }
  
  // Collect from all categories
  if (featured.categories) {
    Object.values(featured.categories).forEach(catBooks => {
      if (Array.isArray(catBooks)) allBooks.push(...catBooks);
    });
  }
  
  // Deduplicate by bookId
  const seen = new Set();
  const unique = allBooks.filter(b => {
    if (seen.has(b.bookId)) return false;
    seen.add(b.bookId);
    return true;
  });
  
  // Filter by keyword (match title, author, tags, description) and language
  return unique.filter(book => {
    // Language filter
    if (lang && book.languageCode && book.languageCode !== lang) return false;
    
    const title = (book.title || '').toLowerCase();
    const author = (book.author || '').toLowerCase();
    const desc = (book.description || '').toLowerCase();
    const tags = Array.isArray(book.tags) ? book.tags.map(t => typeof t === 'object' ? (t.tagName || t.name || '') : t).join(' ').toLowerCase() : '';
    const bookClass = (book.bookClassName || '').toLowerCase();
    
    return title.includes(keywordLower) || 
           author.includes(keywordLower) || 
           desc.includes(keywordLower) ||
           tags.includes(keywordLower) ||
           bookClass.includes(keywordLower);
  }).map(book => ({
    bookId: book.bookId || book.id,
    title: book.title,
    cover: book.cover || book.coverImage || '',
    author: Array.isArray(book.authors) ? book.authors.map(a => a.authorName || a).join(', ') : (book.author || ''),
    description: book.description,
    rating: book.rating || book.star || (book.bookScore > 0 ? book.bookScore : 4.5),
    tags: Array.isArray(book.tags) ? book.tags.map(t => typeof t === 'object' ? t.tagName || t.name || '' : t).filter(Boolean) : (book.genre || []),
    languageCode: book.languageCode || lang,
    bookClassName: book.bookClassName || ''
  }));
}

const { setCORSHeaders } = require('../_lib/cors')
const { getBookstoreToken } = require('../_lib/oidc-token');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  // CORS handled by setCORSHeaders;
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(rateCheck.remaining));
  if (!rateCheck.allowed) return res.status(429).json({ error: 'Rate limit exceeded.' });
  
  const BOOKSTORE_TOKEN = await getBookstoreToken();
  const { keyword = '', lang = 'en', page = 1, pageSize = 20, bookClassName = '' } = req.query || {};
  
  try {
    // If no keyword and no bookClassName, return featured books
    if (!keyword && !bookClassName) {
      const featured = loadFeaturedBooks();
      if (featured) {
        const books = featured.recommended || [];
        const start = (parseInt(page) - 1) * parseInt(pageSize);
        const end = start + parseInt(pageSize);
        return res.status(200).json({
          success: true,
          data: books.slice(start, end),
          total: books.length,
          page: parseInt(page),
          pageSize: parseInt(pageSize),
          source: 'featured'
        });
      }
    }
    
    // If bookClassName specified, return featured books for that category
    if (bookClassName && !keyword) {
      const featured = loadFeaturedBooks();
      if (featured && featured.categories && featured.categories[bookClassName]) {
        const books = featured.categories[bookClassName];
        const start = (parseInt(page) - 1) * parseInt(pageSize);
        const end = start + parseInt(pageSize);
        return res.status(200).json({
          success: true,
          data: books.slice(start, end),
          total: books.length,
          page: parseInt(pageSize),
          pageSize: parseInt(pageSize),
          source: 'featured',
          bookClassName: bookClassName
        });
      }
    }
    
    // When keyword is provided, try API first, then fall back to featured books
    if (keyword) {
      const keywordLower = keyword.toLowerCase();
      let apiBooks = [];
      let apiSucceeded = false;
      
      // Try bookstore API
      if (BOOKSTORE_TOKEN) {
        try {
          const apiUrl = `${BOOKSTORE_API_BASE}/booklist?current=1&pageSize=100&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&languageCode=${lang}&bookStatus=1&bookName=${encodeURIComponent(keyword)}${bookClassName ? `&bookClassName=${encodeURIComponent(bookClassName)}` : ''}`;
          
          const response = await fetch(apiUrl, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' }
          });
          
          if (response.ok) {
            const data = await response.json();
            const rawBooks = ((data.data && data.data.data) || data.data || []);
            
            // Filter: keep books whose title contains the keyword
            const filtered = rawBooks.filter(book => {
              const t = (book.title || '').toLowerCase();
              return t.includes(keywordLower);
            });
            
            apiBooks = filtered.map(book => ({
              bookId: book.bookId || book.id,
              title: book.title,
              cover: book.cover || book.coverImage || '',
              author: Array.isArray(book.authors) ? book.authors.map(a => a.authorName || a).join(', ') : (book.author || ''),
              description: book.description,
              rating: book.rating || book.star || (book.bookScore > 0 ? book.bookScore : 4.5),
              tags: Array.isArray(book.tags) ? book.tags.map(t => typeof t === 'object' ? t.tagName || t.name || '' : t).filter(Boolean) : (book.genre || []),
              languageCode: book.languageCode || lang,
              bookClassName: book.bookClassName || ''
            }));
            apiSucceeded = true;
          }
        } catch (e) {
          console.warn('Bookstore API failed for keyword search:', e.message);
        }
      }
      
      // Also search featured books
      const featured = loadFeaturedBooks();
      const featuredResults = searchFeaturedBooks(featured, keyword, lang);
      
      // Merge: API results first, then featured results (dedup by bookId)
      const seenIds = new Set();
      const mergedBooks = [];
      
      apiBooks.forEach(b => {
        if (!seenIds.has(b.bookId)) {
          seenIds.add(b.bookId);
          mergedBooks.push(b);
        }
      });
      
      featuredResults.forEach(b => {
        if (!seenIds.has(b.bookId)) {
          seenIds.add(b.bookId);
          mergedBooks.push(b);
        }
      });
      
      if (mergedBooks.length > 0 || apiSucceeded) {
        return res.status(200).json({
          success: true,
          data: mergedBooks.slice(0, parseInt(pageSize)),
          total: mergedBooks.length,
          page: parseInt(page),
          pageSize: parseInt(pageSize),
          source: apiSucceeded ? 'api+featured' : 'featured-fallback'
        });
      }
      
      // Complete fallback: if nothing found at all
      return res.status(200).json({
        success: true,
        data: [],
        total: 0,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        source: 'empty'
      });
    }
    
    // No keyword, no bookClassName — fallback to API
    const apiUrl = `${BOOKSTORE_API_BASE}/booklist?current=${page}&pageSize=${pageSize}&pageIndex=${page}&applicationId=${BOOKSTORE_APP_ID}&languageCode=${lang}&bookStatus=1${bookClassName ? `&bookClassName=${encodeURIComponent(bookClassName)}` : ''}`;
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) return res.status(502).json({ error: 'Upstream API error' });
    
    const data = await response.json();
    const rawBooks = ((data.data && data.data.data) || data.data || []);
    
    const books = rawBooks.map(book => ({
      bookId: book.bookId || book.id,
      title: book.title,
      cover: book.cover || book.coverImage || '',
      author: Array.isArray(book.authors) ? book.authors.map(a => a.authorName || a).join(', ') : (book.author || ''),
      description: book.description,
      rating: book.rating || book.star || (book.bookScore > 0 ? book.bookScore : 4.5),
      tags: Array.isArray(book.tags) ? book.tags.map(t => typeof t === 'object' ? t.tagName || t.name || '' : t).filter(Boolean) : (book.genre || []),
      languageCode: book.languageCode || lang,
      bookClassName: book.bookClassName || ''
    }));
    
    return res.status(200).json({
      success: true,
      data: books,
      total: (data.data && data.data.total) || data.total || books.length,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      source: 'api'
    });
    
   } catch (error) {
    console.error('Search API error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
