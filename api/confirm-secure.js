/**
 * 确认推广API - 安全版
 * 需要登录鉴权
 * 频率限制：每IP每分钟10次
 */

const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || 'novelflow-secret-2026';

// 频率限制配置
const RATE_LIMIT = 10;
const RATE_WINDOW = 60 * 1000;
const rateLimits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  
  if (!record || now - record.start > RATE_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  
  if (record.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  
  record.count++;
  return { allowed: true, remaining: RATE_LIMIT - record.count };
}

// Verify JWT token (same format as register.js)
function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [encodedHeader, encodedPayload, signature] = parts;
    
    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    
    if (signature !== expectedSignature) return null;
    
    // Decode payload
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
    
    // Check expiration (30 days max)
    const maxAge = 2592000;
    if (payload.iat && (Date.now() / 1000 - payload.iat) > maxAge) {
      return null;
    }
    
    return { username: payload.username, novelFlowId: payload.novelFlowId };
  } catch (e) {
    return null;
  }
}

// 验证用户认证
function verifyAuth(req) {
  // 1. Check nf_token cookie (JWT)
  const cookies = req.headers.cookie || '';
  const tokenMatch = cookies.match(/nf_token=([^;]+)/);
  if (tokenMatch) {
    const result = verifyJWT(tokenMatch[1]);
    if (result) return result;
  }
  
  // 2. Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const result = verifyJWT(token);
    if (result) return result;
  }
  
  return null;
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage/book';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
const BOOKSTORE_TOKEN = process.env.NOVELSPA_TOKEN;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
  
  // 鉴权检查
  const user = verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
  }
  
  // 频率限制
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp);
  
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(rateCheck.remaining));
  
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded.', code: 'RATE_LIMIT_EXCEEDED', retryAfter: 60 });
  }
  
  const { bookId, bookTitle, bookAuthor, lang = 'en' } = req.body || {};
  
  if (!bookId || !bookTitle) {
    return res.status(400).json({ error: 'bookId and bookTitle are required', code: 'MISSING_PARAM' });
  }
  
  const owner = 'loboscantante849-coder';
  const repo = 'novelflow-dashboard';
  const filePath = 'submissions.json';
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  
  const submissionId = 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const languageCode = lang === 'es' ? 'es' : 'en';
  
  try {
    // 获取当前提交记录
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
    
    // 创建新提交
    const newSubmission = {
      id: submissionId,
      bookName: bookTitle.trim(),
      discordUsername: user.username,
      bookId: bookId,
      matchedBookName: bookTitle,
      author: bookAuthor || '',
      lang: languageCode,
      submittedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      status: 'processing',
      userId: user.novelFlowId
    };
    
    existingData.push(newSubmission);
    
    // 保存到GitHub
    let content = Buffer.from(JSON.stringify(existingData, null, 2)).toString('base64');
    const putBody = { message: 'Add confirmed submission: ' + bookTitle, content };
    if (sha) putBody.sha = sha;
    
    const putResponse = await fetch(apiBase, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'NovelFlow-API' },
      body: JSON.stringify(putBody)
    });
    
    if (!putResponse.ok) {
      console.error('GitHub save error');
      return res.status(500).json({ error: 'Failed to save submission', code: 'SAVE_ERROR' });
    }
    
    // 生成推广码和链接
    const code = await createCode(bookId, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID);
    const link = await createLink(bookId, bookTitle, code, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, languageCode);
    
    // 生成NF码用于前端显示
    const displayCode = 'NF' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const displayLink = `https://novelflow.app/book/${bookId}?ref=${displayCode}&lang=${languageCode}`;
    
    // 更新提交状态
    await updateSubmission(submissionId, {
      status: link ? 'completed' : 'completed_no_link',
      promotionCode: code || displayCode,
      promotionLink: link || displayLink,
      completedAt: new Date().toISOString()
    }, apiBase, GITHUB_TOKEN, sha);
    
    return res.status(200).json({
      success: true,
      submissionId,
      code: code || displayCode,
      link: link || displayLink
    });
    
  } catch (error) {
    console.error('Confirm API error:', error.message);
    
    return res.status(500).json({
      success: false,
      submissionId,
      status: 'failed',
      error: 'Internal server error'
    });
  }
};

async function createCode(bookId, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID) {
  const STARTING_CODE = 4544;
  
  for (let tryCode = STARTING_CODE; tryCode < STARTING_CODE + 100; tryCode++) {
    const codeResp = await fetch(`${BOOKSTORE_API_BASE}/savebookpromotionkeywords`, {
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

async function createLink(bookId, bookTitle, code, BOOKSTORE_TOKEN, BOOKSTORE_API_BASE, BOOKSTORE_APP_ID, languageCode) {
  const linkName = `${code}${bookTitle}-书籍详情页-FB`;
  
  const linkResp = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
      'Content-Type': 'application/json',
      'X-OS': 'web', 'X-AppName': 'web-admin', 'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
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
      }
    }
  }
  
  return null;
}

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
