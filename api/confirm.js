// Simple in-memory rate limiter
const confirmCounts = new Map();
const RATE_LIMIT = 5; // max 5 confirms per IP per hour
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip) {
  const now = Date.now();
  const record = confirmCounts.get(ip);
  if (!record || now - record.start > RATE_WINDOW) {
    confirmCounts.set(ip, { start: now, count: 1 });
    return true;
  }
  if (record.count >= RATE_LIMIT) return false;
  record.count++;
  return true;
}

const { setCORSHeaders } = require('./_lib/cors');
const { getBookstoreToken } = require('./_lib/oidc-token');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit check
  const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN env var is missing');
    return res.status(500).json({ error: 'Server configuration error: GITHUB_TOKEN not set. Please contact admin.' });
  }

  const { bookName, discordUsername, promotionMethod, notes, bookId, bookTitle, bookAuthor, lang = 'en' } = req.body || {};
  if (!bookName || !bookId) {
    return res.status(400).json({ error: 'bookName and bookId are required' });
  }

  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const filePath = 'submissions.json';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
  const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
  const languageCode = lang === 'es' ? 'es' : 'en';
  // Get bookstore token (auto-refreshes via OIDC if expired)
  const BOOKSTORE_TOKEN = await getBookstoreToken();
  if (!BOOKSTORE_TOKEN) {
    console.warn('No bookstore token available - code creation will be skipped');
  }

  // Generate submission ID locally
  const submissionId = 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

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

    // Step 2: Create new submission with status "processing"
    const newSubmission = {
      id: submissionId,
      bookName: bookName.trim(),
      discordUsername: (discordUsername || 'Anonymous').trim(),
      promotionMethod: promotionMethod || '',
      notes: notes || '',
      bookId: bookId,
      matchedBookName: bookTitle || bookName,
      author: bookAuthor || '',
      lang: lang,
      submittedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      status: 'processing'
    };

    existingData.push(newSubmission);

    // Step 3: Save to GitHub FIRST (as processing)
    let content = Buffer.from(JSON.stringify(existingData, null, 2)).toString('base64');
    const putBody = { message: 'Add confirmed submission: ' + bookName, content };
    if (sha) putBody.sha = sha;

    const putResponse = await fetch(apiBase, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'NovelFlow-API' },
      body: JSON.stringify(putBody)
    });

    if (!putResponse.ok) {
      const putErrorBody = await putResponse.text().catch(() => 'N/A');
      console.error('GitHub save error:', putResponse.status, putErrorBody);
      return res.status(500).json({ 
        error: 'Failed to save submission', 
        details: `GitHub PUT ${putResponse.status}: ${putErrorBody.substring(0, 200)}`,
        githubTokenSet: !!GITHUB_TOKEN
      });
    }

    // Update SHA for subsequent updates
    const putResult = await putResponse.json();
    const newSha = putResult.content ? putResult.content.sha : sha;

    console.log(`Confirmed: "${bookTitle || bookName}" (${bookId}) for submission ${submissionId}`);

    // Step 4: Create search code (only if token available)
    let finalCode = null;
    if (BOOKSTORE_TOKEN) {
      finalCode = await createCode(bookId, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    } else {
      console.error('No BOOKSTORE_TOKEN available - cannot create code');
      console.error('OIDC_USERNAME set:', !!process.env.OIDC_USERNAME);
      console.error('OIDC_PASSWORD set:', !!process.env.OIDC_PASSWORD);
      console.error('NOVELSPA_TOKEN set:', !!process.env.NOVELSPA_TOKEN);
    }

    if (!finalCode) {
      // Update status to pending for manual processing
      await updateSubmission(submissionId, {
        status: 'pending',
        error: BOOKSTORE_TOKEN ? 'Code creation failed' : 'NOVELSPA_TOKEN not configured in Vercel env vars'
      }, apiBase, GITHUB_TOKEN, newSha);

      const diagInfo = {
        hasBookstoreToken: !!BOOKSTORE_TOKEN,
        hasOidcCreds: !!(process.env.OIDC_USERNAME && process.env.OIDC_PASSWORD),
        oidcUsername: process.env.OIDC_USERNAME || 'NOT_SET',
        githubTokenSet: !!GITHUB_TOKEN,
        envKeys: Object.keys(process.env).filter(k => !k.startsWith('VC_') && !k.startsWith('VERCEL')).sort()
      };
      return res.status(200).json({
        success: true,
        submissionId,
        status: 'pending',
        matchedBookName: bookTitle || bookName,
        message: 'Code creation failed. Diagnostics: ' + JSON.stringify(diagInfo),
        diagnostics: diagInfo
      });
    }

    console.log(`Created code: ${finalCode} for ${bookId}`);

    // Step 5: Create short link
    const linkResult = await createLink(bookId, bookTitle, finalCode, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, languageCode);

    // Step 6: Update submission to completed
    const fields = {
      code: String(finalCode),
      status: 'completed',
      completedAt: new Date().toISOString()
    };

    if (linkResult) {
      if (linkResult.shortUrl) {
        fields.link = `https://${linkResult.shortUrl}`;
        fields.shortUrl = linkResult.shortUrl;
      }
      if (linkResult.linkId) fields.linkId = linkResult.linkId;
      if (linkResult.campaignId) fields.campaignId = linkResult.campaignId;
    }

    await updateSubmission(submissionId, fields, apiBase, GITHUB_TOKEN, newSha);

    console.log(`Completed: ${submissionId} - code=${finalCode}, link=${linkResult?.shortUrl || 'none'}`);

    return res.status(200).json({
      success: true,
      submissionId,
      status: 'completed',
      code: finalCode,
      link: linkResult?.shortUrl ? `https://${linkResult.shortUrl}` : null,
      linkId: linkResult?.linkId || null,
      matchedBookName: bookTitle || bookName,
      message: 'Link and code created successfully!'
    });

  } catch (error) {
    console.error('Confirm error:', error);
    try {
      await updateSubmission(submissionId, {
        status: 'failed',
        error: error.message
      }, apiBase, GITHUB_TOKEN, null);
    } catch (e) {
      console.error('Failed to update submission status:', e.message);
    }

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
  const STARTING_CODE = 4670;

  for (let tryCode = STARTING_CODE; tryCode < STARTING_CODE + 200; tryCode++) {
    const codeResp = await fetch(`${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-OS': 'web', 'X-AppName': 'web-admin', 'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
      },
      body: JSON.stringify({ applicationId: BOOKSTORE_APP_ID, keyword: String(tryCode), bookId: bookId, channel: 'FB', isEnable: true })
    });

    // Bail early on auth failure - token expired
    if (codeResp.status === 401) {
      console.error('Bookstore API 401 - token expired, stopping retries');
      return null;
    }

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

const NOVELFLOW_CAMPAIGN_ID = '699ef7b8194eb218db3c2270';

async function createLink(bookId, bookTitle, code, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, languageCode) {
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
      languageCode: languageCode,
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
      const responseLinkId = linkData.data;
      if (typeof responseLinkId === 'string' && responseLinkId.length > 10) {
        let shortUrl = null;
        try {
          const detailResp = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig/${responseLinkId}`, {
            headers: { 'Authorization': `Bearer ${BOOKSTORE_TOKEN}`, 'Content-Type': 'application/json' }
          });
          if (detailResp.ok) {
            const detailData = await detailResp.json();
            if (detailData.code === 200 && detailData.data && detailData.data.shortUrl) {
              shortUrl = detailData.data.shortUrl;
            }
          }
        } catch (e) { console.error('Failed to fetch link details:', e.message); }
        return { shortUrl, linkId: responseLinkId, campaignId: NOVELFLOW_CAMPAIGN_ID };
      }
      if (typeof linkData.data === 'object' && linkData.data.shortUrl) {
        return { shortUrl: linkData.data.shortUrl, linkId: null, campaignId: NOVELFLOW_CAMPAIGN_ID };
      }
    }
  }

  console.error('Link creation failed:', linkResp.status);
  return null;
}

// ============ Update Submission ============

async function updateSubmission(submissionId, fields, apiBase, GITHUB_TOKEN, currentSha) {
  try {
    const getResp = await fetch(apiBase, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'NovelFlow-API' }
    });
    if (!getResp.ok) return;
    const data = await getResp.json();
    const latestSha = data.sha;
    const latest = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    
    const idx = latest.findIndex(s => s.id === submissionId);
    if (idx === -1) return;

    Object.assign(latest[idx], fields);
    const updateContent = Buffer.from(JSON.stringify(latest, null, 2)).toString('base64');

    await fetch(apiBase, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'NovelFlow-API' },
      body: JSON.stringify({ message: `Update ${submissionId}: ${fields.status || 'updated'}`, content: updateContent, sha: latestSha })
    });
  } catch (err) {
    console.error('Update failed:', err.message);
  }
}
