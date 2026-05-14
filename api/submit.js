module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  }

  const { bookName, discordUsername, promotionMethod, notes } = req.body || {};
  if (!bookName || !discordUsername) {
    return res.status(400).json({ error: 'bookName and discordUsername are required' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const filePath = 'submissions.json';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  const BOOKSTORE_TOKEN = process.env.BOOKSTORE_TOKEN;

  try {
    // Step 1: Get current submissions and SHA
    const getResponse = await fetch(apiBase, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'NovelFlow-API' }
    });

    let sha = null;
    let existingData = [];
    if (getResponse.ok) {
      const data = await getResponse.json();
      sha = data.sha;
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      try { existingData = JSON.parse(content); if (!Array.isArray(existingData)) existingData = []; } catch (e) { existingData = []; }
    }

    // Step 2: Create new submission with status "awaiting_confirmation"
    const newSubmission = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      bookName: bookName.trim(),
      discordUsername: discordUsername.trim(),
      promotionMethod: promotionMethod || '',
      notes: notes || '',
      submittedAt: new Date().toISOString(),
      status: 'awaiting_confirmation'
    };

    existingData.push(newSubmission);

    // Step 3: Save to GitHub FIRST (as awaiting_confirmation)
    let content = Buffer.from(JSON.stringify(existingData, null, 2)).toString('base64');
    const putBody = { message: 'Add submission: ' + bookName, content };
    if (sha) putBody.sha = sha;

    const putResponse = await fetch(apiBase, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'NovelFlow-API' },
      body: JSON.stringify(putBody)
    });

    if (!putResponse.ok) {
      console.error('GitHub save error');
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    // Update SHA for subsequent updates
    const newSha = sha ? sha : (await putResponse.json()).content.sha;

    // Step 4: Search for candidates
    let candidates = [];
    if (BOOKSTORE_TOKEN) {
      candidates = await searchBooks(bookName.trim(), BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    }

    console.log(`Search for "${bookName}" found ${candidates.length} candidates`);

    // Step 5: Return candidates to frontend for user confirmation
    return res.status(200).json({
      success: true,
      submission: newSubmission,
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

// Export functions for use by confirm.js
module.exports.searchBooks = searchBooks;
module.exports.createCode = createCode;
module.exports.createLink = createLink;

// ============ Create Promotion Code ============

async function createCode(bookId, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  const STARTING_CODE = 4544;

  for (let tryCode = STARTING_CODE; tryCode < STARTING_CODE + 100; tryCode++) {
    const codeResp = await fetch(`${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-OS': 'web', 'X-AppName': 'web-admin', 'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
      },
      body: JSON.stringify({ applicationId: BOOKSTORE_APP_ID, keyword: String(tryCode), bookId: bookId, channel: 'FB', isEnable: true })
    });

    if (codeResp.ok) {
      const codeData = await codeResp.json();
      if (codeData.code === 200 && codeData.data) {
        return tryCode;
      }
    }
  }

  return null;
}

// ============ Create Short Link ============

async function createLink(bookId, bookTitle, code, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  const linkName = `${code}${bookTitle}-书籍详情页-FB`;

  const linkResp = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
      'Content-Type': 'application/json',
      'X-OS': 'web',
      'X-AppName': 'web-admin',
      'X-AppIdentifier': 'web',
      'X-AppVersion': '1.0.0,1'
    },
    body: JSON.stringify({
      linkName,
      applicationId: BOOKSTORE_APP_ID,
      mediaSource: 'SocialMedia',
      channelName: 'NovelFlow_SocialMedia_Facebook-grounp_Facebook_xujt',
      channelNameId: '699ef7b8194eb218db3c2270',
      contentType: 1,
      contentNameOrSku: bookId,
      contentName: bookTitle,
      languageCode: 'en',
      redirectConfigId: '68fecf8b3a29f6eff435fd3b',
      redirectPosition: '书籍详情页',
      redirectProtocol: 'novelflow:///book',
      contentRedirectSequence: 1,
      operatorName: '徐敬涛',
      templateId: '6a01499261118c6285dff7dd',
      isEnabled: true,
      landingPageTemplates: [{
        templateId: '6a01499261118c6285dff7dd',
        templateName: linkName,
        templateWeight: 100,
        isDeleted: false
      }]
    })
  });

  if (linkResp.ok) {
    const linkData = await linkResp.json();
    if (linkData.code === 200 && linkData.data) {
      const linkId = linkData.data;
      if (typeof linkId === 'string' && linkId.length > 10) {
        try {
          const detailResp = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig/${linkId}`, {
            headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' }
          });
          if (detailResp.ok) {
            const detailData = await detailResp.json();
            if (detailData.code === 200 && detailData.data && detailData.data.shortUrl) {
              return detailData.data.shortUrl;
            }
          }
        } catch (e) { console.error('Failed to fetch link details:', e.message); }
        return null;
      }
      if (typeof linkData.data === 'object' && linkData.data.shortUrl) {
        return linkData.data.shortUrl;
      }
    }
  }

  const errorText = await linkResp.text().catch(() => 'unknown');
  console.error('Link creation failed:', linkResp.status, errorText);
  return null;
}

// ============ Update Submission ============

async function updateSubmission(submissionId, fields, apiBase, GITHUB_TOKEN) {
  try {
    const getResp = await fetch(apiBase, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'NovelFlow-API' }
    });
    if (!getResp.ok) return;
    const data = await getResp.json();
    
    const latest = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    const idx = latest.findIndex(s => s.id === submissionId);
    if (idx === -1) return;
    
    Object.assign(latest[idx], fields);
    const updateContent = Buffer.from(JSON.stringify(latest, null, 2)).toString('base64');
    
    await fetch(apiBase, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'NovelFlow-API' },
      body: JSON.stringify({ message: `Update ${submissionId}: ${fields.status || 'updated'}`, content: updateContent, sha: data.sha })
    });
  } catch (err) { 
    console.error('Update failed:', err.message); 
  }
}

module.exports.updateSubmission = updateSubmission;
