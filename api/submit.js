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

    // Step 3: Save to GitHub FIRST (as pending)
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

    // Step 4: If no BOOKSTORE_TOKEN, return pending immediately
    if (!BOOKSTORE_TOKEN) {
      return res.status(200).json({ 
        success: true, 
        submission: newSubmission,
        message: 'Submission saved. Link creation pending - will be processed shortly.'
      });
    }

    // Step 5: SYNC execute - Search book
    const book = await searchBook(bookName.trim(), BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    
    if (!book) {
      // Book not found - keep pending for retry
      return res.status(200).json({ 
        success: true, 
        submission: newSubmission,
        status: 'pending',
        message: 'Book not found in system. Will retry automatically.'
      });
    }

    console.log(`Matched: "${book.title}" (${book.bookId}) for query "${bookName}"`);

    // Step 6: SYNC execute - Create search code
    const finalCode = await createCode(book.bookId, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    
    if (!finalCode) {
      // Code creation failed - keep pending for retry
      return res.status(200).json({ 
        success: true, 
        submission: newSubmission,
        status: 'pending',
        matchedBookName: book.title,
        bookId: book.bookId,
        message: 'Code creation failed. Will retry automatically.'
      });
    }

    // Step 7: SYNC execute - Create short link (no channelCode)
    const shortUrl = await createLink(book.bookId, book.title, finalCode, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);

    // Step 8: Update submission to completed
    const fields = { 
      code: String(finalCode), 
      bookId: book.bookId, 
      matchedBookName: book.title, 
      status: 'completed'
    };
    if (shortUrl) { 
      fields.link = `https://${shortUrl}`; 
      fields.shortUrl = shortUrl; 
    }

    await updateSubmission(newSubmission.id, fields, apiBase, GITHUB_TOKEN);

    console.log(`Done: code=${finalCode}, link=${shortUrl}`);

    // Return success
    return res.status(200).json({ 
      success: true, 
      submission: { ...newSubmission, ...fields },
      status: 'completed',
      message: 'Submission complete! Your referral link is ready.'
    });

  } catch (error) {
    console.error('Submit error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
};

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

  // Strategy 3: First + last significant word (e.g. "Game Destiny" for "Game of Destiny")
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

// ============ Create Short Link (no channelCode) ============

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
      // API returns linkId, need to fetch details to get shortUrl
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
        // If detail fetch fails, return the linkId so we can at least save it
        return null;
      }
      // If data is an object with shortUrl
      if (typeof linkData.data === 'object' && linkData.data.shortUrl) {
        return linkData.data.shortUrl;
      }
    }
  }

  // Log error for debugging
  const errorText = await linkResp.text().catch(() => 'unknown');
  console.error('Link creation failed:', linkResp.status, errorText);
  return null;
}

// ============ Update Submission ============

async function updateSubmission(submissionId, fields, apiBase, GITHUB_TOKEN) {
  try {
    // Get latest SHA
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
