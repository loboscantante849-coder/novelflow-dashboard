module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { bookName } = req.body || {};
  if (!bookName) {
    return res.status(400).json({ error: 'bookName is required' });
  }

  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  const BOOKSTORE_TOKEN = process.env.BOOKSTORE_TOKEN;

  try {
    // Only search for candidates - no data persistence here
    let candidates = [];
    if (BOOKSTORE_TOKEN) {
      candidates = await searchBooks(bookName.trim(), BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    }

    console.log(`Search for "${bookName}" found ${candidates.length} candidates`);

    // Return candidates to frontend for user confirmation
    // Data will only be persisted when user confirms in /api/confirm
    return res.status(200).json({
      success: true,
      status: 'awaiting_confirmation',
      candidates: candidates,
      message: candidates.length > 0 
        ? `Found ${candidates.length} book(s). Please confirm the correct one.`
        : 'No matching books found. Please check the book name and try again.'
    });

  } catch (error) {
    console.error('Submit error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
};

// ============ Search Books (Returns Candidates) ============

// Calculate similarity between search query and book title
function similarity(query, title) {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !/^(the|and|or|of|a|an|in|on|at|to|for|with)/.test(w));
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
async function searchBooks(bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  const allCandidates = new Map(); // Use Map to deduplicate by bookId

  // Strategy 1: Full book name as-is
  const candidates1 = await doSearch(bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, bookName);
  candidates1.forEach(c => allCandidates.set(c.bookId, c));

  // Strategy 2: Without leading "The", "A", "An"
  const withoutArticle = bookName.replace(/^(The|A|An)\s+/i, '').trim();
  if (withoutArticle !== bookName && withoutArticle.length > 2) {
    const candidates2 = await doSearch(withoutArticle, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, bookName);
    candidates2.forEach(c => {
      if (!allCandidates.has(c.bookId)) allCandidates.set(c.bookId, c);
    });
  }

  // Strategy 3: First + last significant word
  const words = bookName.split(/\s+/).filter(w => !/^(the|a|an)$/i.test(w) && w.length > 2);
  if (words.length >= 3) {
    const firstLast = words[0] + ' ' + words[words.length - 1];
    const candidates3 = await doSearch(firstLast, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, bookName);
    candidates3.forEach(c => {
      if (!allCandidates.has(c.bookId)) allCandidates.set(c.bookId, c);
    });
  }

  // Strategy 4: First significant word only
  if (words.length >= 1) {
    const candidates4 = await doSearch(words[0], BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, bookName);
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
async function doSearch(query, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, originalQuery) {
  const url = `${BOOKSTORE_API_BASE}/book/booklist?current=1&pageSize=10&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&languageCode=en&bookStatus=1&title=${encodeURIComponent(query)}&bookName=${encodeURIComponent(query)}`;

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
        similarity(originalQuery, title),
        similarity(query, title)
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

