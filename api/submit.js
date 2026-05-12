module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set in Vercel environment variables' });
  }

  const { bookName, discordUsername, promotionMethod, notes } = req.body || {};

  // Validation
  if (!bookName || !discordUsername) {
    return res.status(400).json({ error: 'bookName and discordUsername are required' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const path = 'submissions.json';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // Bookstore API config
  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  const BOOKSTORE_TOKEN = process.env.BOOKSTORE_TOKEN;

  try {
    // Step 1: Get current file SHA and existing data
    const getResponse = await fetch(apiBase, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'NovelFlow-API'
      }
    });

    let sha = null;
    let existingData = [];
    if (getResponse.ok) {
      const data = await getResponse.json();
      sha = data.sha;
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      try {
        existingData = JSON.parse(content);
        if (!Array.isArray(existingData)) existingData = [];
      } catch (e) {
        existingData = [];
      }
    }

    // Step 2: Add new submission with status "pending"
    const newSubmission = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      bookName: bookName.trim(),
      discordUsername: discordUsername.trim(),
      promotionMethod: promotionMethod || '',
      notes: notes || '',
      submittedAt: new Date().toISOString(),
      status: 'pending'  // pending -> processing -> completed / failed
    };

    existingData.push(newSubmission);

    // Step 3: Save to GitHub immediately (fast response to user)
    const content = Buffer.from(JSON.stringify(existingData, null, 2)).toString('base64');
    const putBody = { message: 'Add new book submission: ' + bookName, content: content };
    if (sha) putBody.sha = sha;

    const putResponse = await fetch(apiBase, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'NovelFlow-API'
      },
      body: JSON.stringify(putBody)
    });

    if (!putResponse.ok) {
      const error = await putResponse.json();
      console.error('GitHub API error:', error);
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    // Return success immediately - code/link will be created async
    res.status(200).json({ success: true, submission: newSubmission });

    // Step 4: Async - auto create code and link (after response sent)
    if (!BOOKSTORE_TOKEN) {
      console.log('BOOKSTORE_TOKEN not set, skipping auto code/link creation');
      return;
    }

    try {
      await autoCreateCodeAndLink(newSubmission, existingData, apiBase, GITHUB_TOKEN, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    } catch (autoError) {
      console.error('Auto-create code/link failed:', autoError.message);
    }

  } catch (error) {
    console.error('Submit error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
};

async function autoCreateCodeAndLink(submission, existingData, apiBase, GITHUB_TOKEN, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  const bookName = submission.bookName;
  const STARTING_CODE = 4545;

  // 4a: Search for book by name to get bookId (skuid)
  // Must pass: applicationId=NovelFlow, languageCode=en, bookStatus=1, title+bookName for fuzzy match
  const searchResponse = await fetch(
    `${BOOKSTORE_API_BASE}/book/booklist?current=1&pageSize=10&pageIndex=1&applicationId=${BOOKSTORE_APP_ID}&languageCode=en&bookStatus=1&title=${encodeURIComponent(bookName.trim())}&bookName=${encodeURIComponent(bookName.trim())}`,
    {
      headers: {
        'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );

  let bookId = null;
  let matchedBookName = null;

  if (searchResponse.ok) {
    const searchData = await searchResponse.json();
    if (searchData.code === 200 && searchData.data?.data?.length > 0) {
      const book = searchData.data.data[0];
      bookId = book.bookId || book.skuId || book.id;
      matchedBookName = book.bookName || book.title || bookName;
      console.log(`Book found: ${matchedBookName}, bookId: ${bookId}`);
    }
  }

  if (!bookId) {
    console.warn(`Book not found for: ${bookName}, marking as failed`);
    await updateSubmissionStatus(submission.id, 'failed', { error: 'Book not found in bookstore' }, apiBase, GITHUB_TOKEN);
    return;
  }

  // 4b: Create the search code (try from STARTING_CODE, increment on duplicate)
  let codeResult = null;
  let finalCode = null;

  for (let tryCode = STARTING_CODE; tryCode < STARTING_CODE + 100; tryCode++) {
    const codeResponse = await fetch(`${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-OS': 'web',
        'X-AppName': 'web-admin',
        'X-AppIdentifier': 'web',
        'X-AppVersion': '1.0.0,1'
      },
      body: JSON.stringify({
        applicationId: BOOKSTORE_APP_ID,
        keyword: String(tryCode),
        bookId: bookId,
        channel: 'FB'
      })
    });

    if (codeResponse.ok) {
      const codeData = await codeResponse.json();
      if (codeData.code === 200 && codeData.data) {
        codeResult = codeData.data;
        finalCode = tryCode;
        console.log(`Search code created: ${finalCode}`);
        break;
      }
    }
    // If not 200, code likely exists, try next
  }

  if (!codeResult) {
    console.error('Failed to create search code after 100 attempts');
    await updateSubmissionStatus(submission.id, 'failed', { bookId, error: 'Code creation failed' }, apiBase, GITHUB_TOKEN);
    return;
  }

  // 4c: Create the short link (not passing channelCode)
  const linkName = `${finalCode}${matchedBookName}-书籍详情页-FB`;
  const adGroupName = `${BOOKSTORE_APP_ID}_Android_SocialMedia_NovelFlow_SocialMedia_KOC__${linkName}_novelflow`;

  const linkResponse = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      linkName: linkName,
      applicationId: BOOKSTORE_APP_ID,
      mediaSource: 'SocialMedia',
      channelName: 'KOC',
      contentType: 1,
      contentTypeName: '小说',
      contentNameOrSku: `${matchedBookName} (${bookId})`,
      languageCode: 'en',
      redirectPosition: '书籍详情页',
      contentRedirectSequence: 1,
      operatorName: 'novelflow',
      adGroupName: adGroupName,
      channelSource: 'SocialMedia(KOC)',
      isEnabled: true,
      probability: 100,
      isAutoRedirect: 0
    })
  });

  let shortUrl = null;
  if (linkResponse.ok) {
    const linkData = await linkResponse.json();
    if (linkData.code === 200 && linkData.data) {
      shortUrl = linkData.data.shortUrl || linkData.shortUrl;
      console.log(`Short link created: ${shortUrl}`);
    }
  }

  // 4d: Update submission with code and link
  const updateData = {
    code: String(finalCode),
    bookId: bookId,
    status: 'completed'
  };
  if (shortUrl) {
    updateData.link = `https://${shortUrl}`;
    updateData.shortUrl = shortUrl;
  }

  await updateSubmissionStatus(submission.id, 'completed', updateData, apiBase, GITHUB_TOKEN);
  console.log(`Submission ${submission.id} completed: code=${finalCode}, link=${shortUrl}`);
}

async function updateSubmissionStatus(submissionId, status, updateFields, apiBase, GITHUB_TOKEN) {
  // Re-fetch latest data
  const getResponse = await fetch(apiBase, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'NovelFlow-API'
    }
  });

  if (!getResponse.ok) return;

  const data = await getResponse.json();
  const latestSha = data.sha;
  const latestContent = Buffer.from(data.content, 'base64').toString('utf-8');
  let latestData = JSON.parse(latestContent);

  // Find and update the submission
  const idx = latestData.findIndex(s => s.id === submissionId);
  if (idx === -1) return;

  latestData[idx].status = status;
  Object.assign(latestData[idx], updateFields);

  // Write back
  const updateContent = Buffer.from(JSON.stringify(latestData, null, 2)).toString('base64');
  await fetch(apiBase, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'NovelFlow-API'
    },
    body: JSON.stringify({
      message: `Update submission ${submissionId}: ${status}`,
      content: updateContent,
      sha: latestSha
    })
  });
}
