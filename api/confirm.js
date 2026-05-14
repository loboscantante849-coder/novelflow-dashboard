module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  }

  const { submissionId, bookId, bookTitle, bookAuthor } = req.body || {};
  if (!submissionId || !bookId) {
    return res.status(400).json({ error: 'submissionId and bookId are required' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const filePath = 'submissions.json';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  const BOOKSTORE_TOKEN = process.env.BOOKSTORE_TOKEN;

  if (!BOOKSTORE_TOKEN) {
    // No token - just update status to pending for manual processing
    await updateSubmission(submissionId, {
      status: 'pending',
      bookId: bookId,
      matchedBookName: bookTitle || 'Unknown',
      confirmedAt: new Date().toISOString(),
      note: 'BOOKSTORE_TOKEN not available - pending manual processing'
    }, apiBase, GITHUB_TOKEN);

    return res.status(200).json({
      success: true,
      submissionId,
      status: 'pending',
      message: 'Book confirmed but token unavailable. Will be processed shortly.'
    });
  }

  try {
    // Step 1: Update submission status to 'processing'
    await updateSubmission(submissionId, {
      status: 'processing',
      bookId: bookId,
      matchedBookName: bookTitle || 'Unknown',
      author: bookAuthor || '',
      confirmedAt: new Date().toISOString()
    }, apiBase, GITHUB_TOKEN);

    console.log(`Confirmed: "${bookTitle}" (${bookId}) for submission ${submissionId}`);

    // Step 2: Create search code
    const finalCode = await createCode(bookId, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);

    if (!finalCode) {
      await updateSubmission(submissionId, {
        status: 'failed',
        error: 'Code creation failed'
      }, apiBase, GITHUB_TOKEN);

      return res.status(200).json({
        success: false,
        submissionId,
        status: 'failed',
        message: 'Failed to create search code. Please try again.'
      });
    }

    console.log(`Created code: ${finalCode} for ${bookId}`);

    // Step 3: Create short link
    const shortUrl = await createLink(bookId, bookTitle, finalCode, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);

    // Step 4: Update submission to completed
    const fields = {
      code: String(finalCode),
      status: 'completed',
      completedAt: new Date().toISOString()
    };

    if (shortUrl) {
      fields.link = `https://${shortUrl}`;
      fields.shortUrl = shortUrl;
    }

    await updateSubmission(submissionId, fields, apiBase, GITHUB_TOKEN);

    console.log(`Completed: ${submissionId} - code=${finalCode}, link=${shortUrl}`);

    return res.status(200).json({
      success: true,
      submissionId,
      status: 'completed',
      code: finalCode,
      link: shortUrl ? `https://${shortUrl}` : null,
      matchedBookName: bookTitle,
      message: 'Link and code created successfully!'
    });

  } catch (error) {
    console.error('Confirm error:', error);

    // Update status to failed
    await updateSubmission(submissionId, {
      status: 'failed',
      error: error.message
    }, apiBase, GITHUB_TOKEN);

    return res.status(500).json({
      success: false,
      submissionId,
      status: 'failed',
      error: 'Internal server error: ' + error.message
    });
  }
};

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
      if (codeData.data) {
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
