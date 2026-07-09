/**
 * 书籍详情API
 * 公开接口，无需鉴权
 * 频率限制：每IP每分钟20次
 */

const RATE_LIMIT = 20;
const RATE_WINDOW = 60 * 1000;
const rateLimits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  
  if (!record || now - record.start > RATE_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  
  if (record.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  
  record.count++;
  return { allowed: true, remaining: RATE_LIMIT - record.count };
}

const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage/book';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
// BOOKSTORE_TOKEN fetched via getBookstoreToken()

const { setCORSHeaders } = require('../_lib/cors')
const { getBookstoreToken } = require('../_lib/oidc-token');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  // CORS handled by setCORSHeaders;
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
  
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp);
  
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(rateCheck.remaining));
  
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded.', code: 'RATE_LIMIT_EXCEEDED', retryAfter: 60 });
  }
  
  const { bookId, lang = 'en' } = req.query || {};
  
  if (!bookId) {
    return res.status(400).json({ error: 'bookId is required', code: 'MISSING_PARAM' });
  }
  
  try {
    const BOOKSTORE_TOKEN = await getBookstoreToken();
    const apiUrl = `${BOOKSTORE_API_BASE}/booklist?current=1&pageSize=1&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&languageCode=${lang}&bookStatus=1&bookId=${encodeURIComponent(bookId)}`;
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      return res.status(502).json({ error: 'Upstream API error', code: 'UPSTREAM_ERROR' });
    }
    
    const data = await response.json();
    
    if (!data.data || data.data.length === 0) {
      return res.status(404).json({ error: 'Book not found', code: 'NOT_FOUND' });
    }
    
    const book = data.data[0];
    
    // Fallback logic: try description, intro, or synopsis
    const description = book.description || book.intro || book.synopsis || '';
    
    const result = {
      bookId: book.bookId || book.id,
      title: book.title,
      cover: book.cover || book.coverImage,
      author: book.author,
      description: description,
      rating: book.rating || book.star || 4.0,
      tags: book.tags || book.genre || [],
      languageCode: book.languageCode || lang
    };
    
    return res.status(200).json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('Detail API error:', error.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
};
