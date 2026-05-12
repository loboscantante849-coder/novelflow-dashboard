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
    // Step 1: Get current submissions
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

    // Step 2: Create new submission with status "pending"
    const newSubmission = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      bookName: bookName.trim(),
      discordUsername: discordUsername.trim(),
      promotionMethod: promotionMethod || '',
      notes: notes || '',
      submittedAt: new Date().toISOString(),
      status: 'pending'
    };

    existingData.push(newSubmission);

    // Step 3: Save to GitHub
    const content = Buffer.from(JSON.stringify(existingData, null, 2)).toString('base64');
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

    // Return immediately - user sees "pending"
    res.status(200).json({ success: true, submission: newSubmission });

    // Step 4: Async create code + link
    if (!BOOKSTORE_TOKEN) return;
    autoCreateCodeAndLink(newSubmission.id, bookName.trim(), apiBase, GITHUB_TOKEN, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID)
      .catch(err => console.error('Auto-create failed:', err.message));

  } catch (error) {
    console.error('Submit error:', error);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
  }
};

// ============ Fuzzy Book Search ============

async function searchBook(bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  // Strategy 1: Full book name as-is
  let result = await doSearch(bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
  if (result) return result;

  // Strategy 2: Without leading "The"
  const withoutThe = bookName.replace(/^The\s+/i, '').trim();
  if (withoutThe !== bookName && withoutThe.length > 2) {
    result = await doSearch(withoutThe, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    if (result) return result;
  }

  // Strategy 3: First + last significant word (e.g. "Game Destiny" for "Game of Destiny")
  const words = bookName.split(/\s+/).filter(w => w.toLowerCase() !== 'the' && w.length > 2);
  if (words.length >= 3) {
    const firstLast = words[0] + ' ' + words[words.length - 1];
    result = await doSearch(firstLast, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    if (result) return result;
  }

  // Strategy 4: First significant word only
  if (words.length >= 1) {
    result = await doSearch(words[0], BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    if (result) return result;
  }

  return null;
}

async function doSearch(query, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  const url = `${BOOKSTORE_API_BASE}/book/booklist?current=1&pageSize=10&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&languageCode=en&bookStatus=1&title=${encodeURIComponent(query)}&bookName=${encodeURIComponent(query)}`;
  
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' }
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.code !== 200 || !data.data?.data?.length) return null;

  const book = data.data.data[0];
  return { bookId: book.bookId || book.bookSkuId, title: book.title || book.bookName };
}

// ============ Auto Create Code + Link ============

async function autoCreateCodeAndLink(submissionId, bookName, apiBase, GITHUB_TOKEN, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  const STARTING_CODE = 4545;

  // Step A: Fuzzy search book
  const book = await searchBook(bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
  if (!book) {
    await updateSubmission(submissionId, { status: 'failed', error: 'Book not found' }, apiBase, GITHUB_TOKEN);
    return;
  }

  console.log(`Matched: "${book.title}" (${book.bookId}) for query "${bookName}"`);

  // Step B: Create search code (increment on duplicate)
  let finalCode = null;
  for (let tryCode = STARTING_CODE; tryCode < STARTING_CODE + 100; tryCode++) {
    const codeResp = await fetch(`${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-OS': 'web', 'X-AppName': 'web-admin', 'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
      },
      body: JSON.stringify({ applicationId: BOOKSTORE_APP_ID, keyword: String(tryCode), bookId: book.bookId, channel: 'FB' })
    });

    if (codeResp.ok) {
      const codeData = await codeResp.json();
      if (codeData.code === 200 && codeData.data) {
        finalCode = tryCode;
        break;
      }
    }
  }

  if (!finalCode) {
    await updateSubmission(submissionId, { status: 'failed', bookId: book.bookId, matchedBookName: book.title, error: 'Code creation failed' }, apiBase, GITHUB_TOKEN);
    return;
  }

  // Step C: Create short link
  const linkName = `${finalCode}${book.title}-书籍详情页-FB`;
  const adGroupName = `${BOOKSTORE_APP_ID}_Android_SocialMedia_NovelFlow_SocialMedia_KOC__${linkName}_novelflow`;

  let shortUrl = null;
  const linkResp = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      linkName, applicationId: BOOKSTORE_APP_ID, mediaSource: 'SocialMedia', channelName: 'KOC',
      contentType: 1, contentTypeName: '小说', contentNameOrSku: `${book.title} (${book.bookId})`,
      languageCode: 'en', redirectPosition: '书籍详情页', contentRedirectSequence: 1,
      operatorName: 'novelflow', adGroupName, channelSource: 'SocialMedia(KOC)',
      isEnabled: true, probability: 100, isAutoRedirect: 0
    })
  });

  if (linkResp.ok) {
    const linkData = await linkResp.json();
    if (linkData.code === 200 && linkData.data) shortUrl = linkData.data.shortUrl;
  }

  // Step D: Update submission
  const fields = { code: String(finalCode), bookId: book.bookId, matchedBookName: book.title, status: 'completed' };
  if (shortUrl) { fields.link = `https://${shortUrl}`; fields.shortUrl = shortUrl; }
  await updateSubmission(submissionId, fields, apiBase, GITHUB_TOKEN);
  console.log(`Done: code=${finalCode}, link=${shortUrl}`);
}

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
  } catch (err) { console.error('Update failed:', err.message); }
}
