const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { bookName, lang = 'en' } = req.body || {};
  if (!bookName) {
    return res.status(400).json({ error: 'bookName is required' });
  }

  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  // NovelFlow - same appId for both English and Spanish, just different languageCode
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  // OIDC token for novelspa API (env var preferred, fallback to hardcoded)
  const BOOKSTORE_TOKEN = process.env.NOVELSPA_TOKEN || process.env.BOOKSTORE_TOKEN;

  const languageCode = lang === 'es' ? 'es' : 'en';

  try {
    // Only search for candidates - no data persistence here
    let candidates = [];
    if (BOOKSTORE_TOKEN) {
      candidates = await searchBooks(bookName.trim(), BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, languageCode, lang);
    }

    console.log(`[v20250515] [${lang}] Search for "${bookName}" found ${candidates.length} candidates, token=${BOOKSTORE_TOKEN ? 'yes' : 'NO'}`);

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
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
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
async function searchBooks(bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, languageCode, lang = 'en') {
  const allCandidates = new Map(); // Use Map to deduplicate by bookId

  // Strategy 1: Full book name as-is
  const candidates1 = await doSearch(bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, bookName, languageCode, lang);
  candidates1.forEach(c => allCandidates.set(c.bookId, c));

  // Strategy 2: Without leading article (The/A/An for English, El/La/Los/Las/Un/Una for Spanish)
  const articleRegex = createArticleRegex(lang);
  const withoutArticle = bookName.replace(articleRegex, '').trim();
  if (withoutArticle !== bookName && withoutArticle.length > 2) {
    const candidates2 = await doSearch(withoutArticle, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, bookName, languageCode, lang);
    candidates2.forEach(c => {
      if (!allCandidates.has(c.bookId)) allCandidates.set(c.bookId, c);
    });
  }

  // Strategy 3: First + last significant word
  const stopWords = getStopWords(lang);
  const stopWordPattern = new RegExp('^(' + stopWords.join('|') + ')$', 'i');
  const words = bookName.split(/\s+/).filter(w => !stopWordPattern.test(w) && w.length > 2);
  if (words.length >= 3) {
    const firstLast = words[0] + ' ' + words[words.length - 1];
    const candidates3 = await doSearch(firstLast, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, bookName, languageCode, lang);
    candidates3.forEach(c => {
      if (!allCandidates.has(c.bookId)) allCandidates.set(c.bookId, c);
    });
  }

  // Strategy 4: First significant word only
  if (words.length >= 1) {
    const candidates4 = await doSearch(words[0], BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, bookName, languageCode, lang);
    candidates4.forEach(c => {
      if (!allCandidates.has(c.bookId)) allCandidates.set(c.bookId, c);
    });
  }

  // Convert to array, sort by score, return top 5
  const result = Array.from(allCandidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return result;
}

// Single search query - returns all matches above threshold as candidates
async function doSearch(query, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, originalQuery, languageCode, lang = 'en') {
  const url = `${BOOKSTORE_API_BASE}/book/booklist?current=1&pageSize=10&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&languageCode=${languageCode}&bookStatus=1&title=${encodeURIComponent(query)}&bookName=${encodeURIComponent(query)}`;

  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' }
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  if (data.code !== 200 || !data.data?.data?.length) return [];

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

