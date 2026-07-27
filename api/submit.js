const { setCORSHeaders } = require('./_lib/cors')
const { bookstoreFetch } = require('./_lib/bookstore-fetch');

const SUBMIT_DEADLINE_MS = 24000;

async function withDeadline(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Bookstore search timed out');
      error.code = 'UPSTREAM_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { bookName, lang = 'en' } = req.body || {};
  if (typeof bookName !== 'string' || !bookName.trim() || bookName.length > 200) {
    return res.status(400).json({ error: 'bookName must be a non-empty string up to 200 characters' });
  }

  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  // NovelFlow - same appId for both English and Spanish, just different languageCode
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  const languageCode = lang === 'es' ? 'es' : 'en';

  try {
    // Only search for candidates - no data persistence here
    let candidates = [];
    candidates = await withDeadline(
      searchBooks(bookName.trim(), BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, languageCode, lang),
      SUBMIT_DEADLINE_MS,
    );

    console.log(`[v20250515] [${lang}] Search for "${bookName}" found ${candidates.length} candidates`);

    // Return candidates to frontend for user confirmation
    // Data will only be persisted when user confirms in /api/confirm
    return res.status(200).json({
      success: true,
      status: 'awaiting_confirmation',
      candidates: candidates,
      lang: lang,
      message: candidates.length > 0 
        ? `Found ${candidates.length} book(s). Please confirm the correct one.`
        : 'No matching books found. Please check the book name and try again.'
    });

  } catch (error) {
    console.error('Submit error:', error);
    const code = error && error.code;
    const status = code === 'UPSTREAM_AUTH_UNAVAILABLE' ? 503 : (code === 'UPSTREAM_TIMEOUT' ? 504 : 502);
    return res.status(status).json({
      error: code === 'UPSTREAM_AUTH_UNAVAILABLE'
        ? 'Bookstore authentication is temporarily unavailable'
        : (code === 'UPSTREAM_TIMEOUT' ? 'Bookstore search timed out' : 'Bookstore search is temporarily unavailable'),
      code: code || 'UPSTREAM_ERROR',
    });
  }
};

// ============ Language Configuration ============

const STOP_WORDS = {
  en: ['the', 'and', 'or', 'of', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with'],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'en', 'y', 'o', 'por', 'para', 'con', 'es', 'lo', 'su', 'se', 'que', 'no']
};

const ARTICLE_PREFIXES = {
  en: ['The', 'A', 'An'],
  es: ['El', 'La', 'Los', 'Las', 'Un', 'Una', 'Unos', 'Unas']
};

function getStopWords(lang) {
  return STOP_WORDS[lang] || STOP_WORDS.en;
}

function getArticlePrefixes(lang) {
  return ARTICLE_PREFIXES[lang] || ARTICLE_PREFIXES.en;
}

function isStopWord(word, lang) {
  return getStopWords(lang).includes(word.toLowerCase());
}

function createArticleRegex(lang) {
  const prefixes = getArticlePrefixes(lang);
  const pattern = '^(' + prefixes.join('|') + ')\\s+';
  return new RegExp(pattern, 'i');
}

// ============ Search Books (Returns Candidates) ============

// Calculate similarity between search query and book title
function similarity(query, title, lang = 'en') {
  const stopWords = getStopWords(lang);
  const stopWordPattern = new RegExp('^(' + stopWords.join('|') + ')$', 'i');
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWordPattern.test(w));
  const titleWords = title.toLowerCase().split(/\s+/);
  let matches = 0;
  for (const qw of queryWords) {
    if (titleWords.some(tw => tw.includes(qw) || qw.includes(tw))) {
      matches++;
    }
  }
  return queryWords.length > 0 ? matches / queryWords.length : 0;
}

// Search for multiple candidate books (returns array)
async function searchBooks(bookName, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, languageCode, lang = 'en') {
  const allCandidates = new Map(); // Use Map to deduplicate by bookId
  const queries = new Set([bookName]);

  // Strategy 2: Without leading article (The/A/An for English, El/La/Los/Las/Un/Una for Spanish)
  const articleRegex = createArticleRegex(lang);
  const withoutArticle = bookName.replace(articleRegex, '').trim();
  if (withoutArticle !== bookName && withoutArticle.length > 2) {
    queries.add(withoutArticle);
  }

  // Strategy 3: First + last significant word
  const stopWords = getStopWords(lang);
  const stopWordPattern = new RegExp('^(' + stopWords.join('|') + ')$', 'i');
  const words = bookName.split(/\s+/).filter(w => !stopWordPattern.test(w) && w.length > 2);
  if (words.length >= 3) {
    const firstLast = words[0] + ' ' + words[words.length - 1];
    queries.add(firstLast);
  }

  // Strategy 4: First significant word only
  if (words.length >= 1) {
    queries.add(words[0]);
  }

  // Search strategies are independent. Running them together keeps the route
  // inside its serverless budget even when the bookstore needs a token retry.
  const settled = await Promise.allSettled([...queries].map(query =>
    doSearch(query, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, bookName, languageCode, lang)
  ));
  const successful = settled.filter(result => result.status === 'fulfilled');
  if (!successful.length) throw settled[0].reason;
  successful.forEach(result => result.value.forEach(candidate => {
    const existing = allCandidates.get(candidate.bookId);
    if (!existing || candidate.score > existing.score) allCandidates.set(candidate.bookId, candidate);
  }));

  // Convert to array, sort by score, return top 5
  const result = Array.from(allCandidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return result;
}

// Single search query - returns all matches above threshold as candidates
async function doSearch(query, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, originalQuery, languageCode, lang = 'en') {
  const url = `${BOOKSTORE_API_BASE}/book/booklist?current=1&pageSize=10&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&languageCode=${languageCode}&bookStatus=1&title=${encodeURIComponent(query)}&bookName=${encodeURIComponent(query)}`;

  const { response: resp, authUnavailable } = await bookstoreFetch(url, {
    headers: { 'Content-Type': 'application/json' }
  }, { timeoutMs: 3500, authTimeoutMs: 4500 });

  if (authUnavailable || !resp) {
    const error = new Error('Bookstore authentication unavailable');
    error.code = 'UPSTREAM_AUTH_UNAVAILABLE';
    throw error;
  }
  if (!resp.ok) {
    const error = new Error(`Bookstore search failed with HTTP ${resp.status}`);
    error.code = 'UPSTREAM_ERROR';
    throw error;
  }
  let data;
  try { data = await resp.json(); }
  catch (cause) {
    const error = new Error('Bookstore search returned invalid JSON');
    error.code = 'UPSTREAM_ERROR';
    error.cause = cause;
    throw error;
  }
  if (data.code !== 200) {
    const error = new Error('Bookstore search returned an error');
    error.code = 'UPSTREAM_ERROR';
    throw error;
  }
  if (!data.data?.data?.length) return [];

  // Return all books above similarity threshold as candidates
  const books = data.data.data;
  const scored = books
    .map(book => {
      const title = book.title || book.bookName || '';
      const score = Math.max(
        similarity(originalQuery, title, lang),
        similarity(query, title, lang)
      );
      return {
        bookId: book.bookId || book.bookSkuId,
        title: title,
        author: book.authorName || book.author || '',
        coverImage: book.coverImageUrl || book.cover || '',
        score: score
      };
    })
    .filter(c => c.score >= 0.3) // Minimum similarity threshold
    .sort((a, b) => b.score - a.score);

  return scored;
}

