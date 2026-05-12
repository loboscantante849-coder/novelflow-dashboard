module.exports = async (req, res) => {
  // Support both POST and GET (for easier testing)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const filePath = 'submissions.json';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  const BOOKSTORE_TOKEN = process.env.BOOKSTORE_TOKEN;

  if (!BOOKSTORE_TOKEN) {
    return res.status(500).json({ error: 'BOOKSTORE_TOKEN not set' });
  }

  try {
    // Step 1: Get current submissions
    const getResponse = await fetch(apiBase, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'NovelFlow-API' }
    });

    if (!getResponse.ok) {
      return res.status(500).json({ error: 'Failed to fetch submissions' });
    }

    const data = await getResponse.json();
    const sha = data.sha;
    let submissions = [];
    try {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      submissions = JSON.parse(content);
      if (!Array.isArray(submissions)) submissions = [];
    } catch (e) {
      submissions = [];
    }

    // Step 2: Find FIRST pending or failed submission (process ONE at a time)
    const toRetry = submissions.find(sub => sub.status === 'pending' || sub.status === 'failed');
    
    if (!toRetry) {
      return res.status(200).json({ 
        success: true, 
        message: 'No pending or failed submissions to retry',
        retried: 0,
        remaining: 0
      });
    }

    console.log(`Retrying: ${toRetry.id} - ${toRetry.bookName}`);

    try {
      // Search book
      const book = await searchBook(toRetry.bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
      if (!book) {
        await updateSubmission(toRetry.id, { status: 'failed', error: 'Book not found during retry' }, apiBase, GITHUB_TOKEN);
        return res.status(200).json({ 
          success: true, 
          id: toRetry.id, 
          bookName: toRetry.bookName, 
          status: 'failed', 
          reason: 'Book not found',
          remaining: countPending(submissions, toRetry.id)
        });
      }

      console.log(`Matched: "${book.title}" (${book.bookId}) for query "${toRetry.bookName}"`);

      // Create code
      const finalCode = await createCode(book.bookId, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
      if (!finalCode) {
        await updateSubmission(toRetry.id, { status: 'failed', bookId: book.bookId, matchedBookName: book.title, error: 'Code creation failed during retry' }, apiBase, GITHUB_TOKEN);
        return res.status(200).json({ 
          success: true, 
          id: toRetry.id, 
          bookName: toRetry.bookName, 
          status: 'failed', 
          reason: 'Code creation failed',
          remaining: countPending(submissions, toRetry.id)
        });
      }

      // Create link
      const shortUrl = await createLink(book.bookId, book.title, finalCode, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);

      // Update submission
      const fields = { code: String(finalCode), bookId: book.bookId, matchedBookName: book.title, status: 'completed' };
      if (shortUrl) { fields.link = `https://${shortUrl}`; fields.shortUrl = shortUrl; }
      await updateSubmission(toRetry.id, fields, apiBase, GITHUB_TOKEN);

      console.log(`Retry succeeded: ${toRetry.id} - code=${finalCode}, link=${shortUrl}`);

      return res.status(200).json({ 
        success: true, 
        id: toRetry.id,
        bookName: toRetry.bookName,
        status: 'completed', 
        code: finalCode, 
        link: shortUrl,
        remaining: countPending(submissions, toRetry.id)
      });

    } catch (err) {
      console.error(`Retry error for ${toRetry.id}:`, err.message);
      await updateSubmission(toRetry.id, { status: 'failed', error: err.message }, apiBase, GITHUB_TOKEN);
      return res.status(200).json({ 
        success: true, 
        id: toRetry.id,
        bookName: toRetry.bookName,
        status: 'failed', 
        reason: err.message,
        remaining: countPending(submissions, toRetry.id)
      });
    }

  } catch (error) {
    console.error('Retry-pending error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

// Count remaining pending/failed submissions (excluding the one just processed)
function countPending(submissions, excludeId) {
  return submissions.filter(sub => (sub.status === 'pending' || sub.status === 'failed') && sub.id !== excludeId).length;
}

// ============ Fuzzy Book Search ============

async function searchBook(bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  // Strategy 1: Full book name as-is
  let result = await doSearch(bookName, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
  if (result) return result;

  // Strategy 2: Without leading "The", "A", "An"
  const withoutArticle = bookName.replace(/^(The|A|An)\s+/i, '').trim();
  if (withoutArticle !== bookName && withoutArticle.length > 2) {
    result = await doSearch(withoutArticle, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    if (result) return result;
  }

  // Strategy 3: First + last significant word
  const words = bookName.split(/\s+/).filter(w => !/^(the|a|an)$/i.test(w) && w.length > 2);
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
      body: JSON.stringify({ applicationId: BOOKSTORE_APP_ID, keyword: String(tryCode), bookId: bookId, channel: 'FB' })
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

// ============ Create Short Link (no channelCode) ============

async function createLink(bookId, bookTitle, code, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  const linkName = `${code}${bookTitle}-书籍详情页-FB`;
  const adGroupName = `${BOOKSTORE_APP_ID}_Android_SocialMedia_NovelFlow_SocialMedia_KOC__${linkName}_novelflow`;

  const linkResp = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      linkName, 
      applicationId: BOOKSTORE_APP_ID, 
      mediaSource: 'SocialMedia', 
      channelName: 'KOC',
      // NOTE: NOT passing channelCode
      contentType: 1, 
      contentTypeName: '小说', 
      contentNameOrSku: `${bookTitle} (${bookId})`,
      languageCode: 'en', 
      redirectPosition: '书籍详情页', 
      contentRedirectSequence: 1,
      operatorName: 'novelflow', 
      adGroupName, 
      channelSource: 'SocialMedia(KOC)',
      isEnabled: true, 
      probability: 100, 
      isAutoRedirect: 0
    })
  });

  if (linkResp.ok) {
    const linkData = await linkResp.json();
    if (linkData.code === 200 && linkData.data) {
      return linkData.data.shortUrl;
    }
  }

  const errorText = await linkResp.text().catch(() => 'unknown');
  console.error('Link creation failed:', linkResp.status, errorText);
  return null;
}

// ============ Update Submission ============

async function updateSubmission(submissionId, fields, apiBase, GITHUB_TOKEN) {
  try {
    // Re-fetch to get latest sha
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
      body: JSON.stringify({ message: `Retry update ${submissionId}: ${fields.status || 'updated'}`, content: updateContent, sha: data.sha })
    });
  } catch (err) { console.error('Update failed:', err.message); }
}
