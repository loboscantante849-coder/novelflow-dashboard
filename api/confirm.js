/**
 * POST /api/confirm
 * 
 * Create promotion link for a book.
 * Data stored in Upstash KV (no GitHub API dependency).
 * 
 * KV schema:
 *   nf_subs               → Hash: field=code (or _lid_{linkId} for codeless), value=JSON
 *   nf_user_subs:{user}   → Set of hash-field keys belonging to user
 *   nf_next_code          → String: next code hint for sequential allocation
 *   nf_rate:{ip}          → String with TTL: rate limit counter
 */
const { setCORSHeaders } = require('./_lib/cors');
const { getBookstoreToken } = require('./_lib/oidc-token');
const { Redis } = require('@upstash/redis');

const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
const NOVELFLOW_CAMPAIGN_ID = '699ef7b8194eb218db3c2270';
const STARTING_CODE = 4900;
const CODE_RANGE = 3000;
const RATE_LIMIT = 5;
const RATE_WINDOW = 3600; // 1 hour in seconds

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

/** Strip HTML tags to prevent XSS */
function sanitizeUsername(username) {
  if (!username) return 'Anonymous';
  const cleaned = username.replace(/<[^>]*>/g, '').trim().substring(0, 50);
  return cleaned || 'Anonymous';
}

/** Sanitize general text input */
function sanitizeText(text, maxLen = 500) {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, '').trim().substring(0, maxLen);
}

/** KV-based rate limiter (persists across cold starts) */
async function checkRateLimit(redis, ip) {
  if (!redis) return true;
  const key = `nf_rate:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, RATE_WINDOW);
  }
  return count <= RATE_LIMIT;
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const redis = getRedis();

  // Rate limit
  const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
  if (!await checkRateLimit(redis, clientIp)) {
    return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
  }

  const { bookName, discordUsername, promotionMethod, notes, bookId, bookTitle, bookAuthor, lang = 'en' } = req.body || {};
  if (!bookName || !bookId) {
    return res.status(400).json({ error: 'bookName and bookId are required' });
  }

  // Input sanitization
  const cleanUsername = sanitizeUsername(discordUsername);
  const cleanBookName = sanitizeText(bookName, 200);
  const cleanBookTitle = sanitizeText(bookTitle, 200);
  const cleanBookAuthor = sanitizeText(bookAuthor, 100);
  const languageCode = lang === 'es' ? 'es' : 'en';
  const submissionId = 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  // Get bookstore token
  const BOOKSTORE_TOKEN = await getBookstoreToken();
  if (!BOOKSTORE_TOKEN) {
    console.error('No bookstore token available');
  }

  try {
    // Step 1: Create promotion code via bookstore API
    let finalCode = null;
    if (BOOKSTORE_TOKEN) {
      // Get next code hint from KV
      let startCode = STARTING_CODE;
      if (redis) {
        const hint = await redis.get('nf_next_code');
        if (hint) startCode = Math.max(STARTING_CODE, parseInt(hint) || STARTING_CODE);
      }

      for (let tryCode = startCode; tryCode < STARTING_CODE + CODE_RANGE; tryCode++) {
        const codeResp = await fetch(`${BOOKSTORE_API_BASE}/book/savebookpromotionkeywords`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
            'Content-Type': 'application/json;charset=UTF-8',
            'X-OS': 'web', 'X-AppName': 'web-admin',
            'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
          },
          body: JSON.stringify({
            applicationId: BOOKSTORE_APP_ID,
            keyword: String(tryCode),
            bookId: bookId,
            channel: 'FB',
            isEnable: true
          })
        });

        if (codeResp.status === 401) {
          console.error('Bookstore API 401 - token expired');
          break;
        }

        if (codeResp.ok) {
          const codeData = await codeResp.json();
          if (codeData.data) {
            finalCode = tryCode;
            // Update next code hint
            if (redis) await redis.set('nf_next_code', tryCode + 1);
            break;
          }
        }
      }
    }

    if (!finalCode) {
      // Save as pending to KV
      if (redis) {
        const pendingSub = {
          id: submissionId,
          bookName: cleanBookName,
          discordUsername: cleanUsername,
          promotionMethod: sanitizeText(promotionMethod, 200),
          notes: sanitizeText(notes, 500),
          bookId, matchedBookName: cleanBookTitle || cleanBookName,
          author: cleanBookAuthor, lang,
          submittedAt: new Date().toISOString(),
          status: 'pending',
          error: BOOKSTORE_TOKEN ? 'Code creation failed' : 'No bookstore token'
        };
        await redis.hset('nf_subs', { [`_pending_${submissionId}`]: JSON.stringify(pendingSub) });
        await redis.sadd(`nf_user_subs:${cleanUsername.toLowerCase()}`, `_pending_${submissionId}`);
      }

      return res.status(200).json({
        success: true, submissionId, status: 'pending',
        matchedBookName: cleanBookTitle || cleanBookName,
        message: 'Code creation failed'
      });
    }

    // Step 2: Create short link
    let linkResult = null;
    if (BOOKSTORE_TOKEN) {
      linkResult = await createLink(bookId, cleanBookTitle || cleanBookName, finalCode, BOOKSTORE_TOKEN, languageCode);
    }

    // Step 3: Save completed submission to KV
    const completedSub = {
      id: submissionId,
      bookName: cleanBookName,
      discordUsername: cleanUsername,
      promotionMethod: sanitizeText(promotionMethod, 200),
      notes: sanitizeText(notes, 500),
      bookId,
      matchedBookName: cleanBookTitle || cleanBookName,
      author: cleanBookAuthor,
      lang,
      submittedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      status: 'completed',
      code: String(finalCode),
      completedAt: new Date().toISOString()
    };

    if (linkResult) {
      if (linkResult.shortUrl) {
        completedSub.link = `https://${linkResult.shortUrl}`;
        completedSub.shortUrl = linkResult.shortUrl;
      }
      if (linkResult.linkId) completedSub.linkId = linkResult.linkId;
      if (linkResult.campaignId) completedSub.campaignId = linkResult.campaignId;
    }

    if (redis) {
      // HSET is atomic per field — no read-modify-write race condition
      await redis.hset('nf_subs', { [String(finalCode)]: JSON.stringify(completedSub) });
      await redis.sadd(`nf_user_subs:${cleanUsername.toLowerCase()}`, String(finalCode));
    }

    console.log(`[confirm] OK: code=${finalCode}, user=${cleanUsername}, book=${cleanBookTitle || cleanBookName}`);

    return res.status(200).json({
      success: true, submissionId, status: 'completed',
      code: finalCode,
      link: linkResult?.shortUrl ? `https://${linkResult.shortUrl}` : null,
      linkId: linkResult?.linkId || null,
      matchedBookName: cleanBookTitle || cleanBookName,
      message: 'Link and code created successfully!'
    });

  } catch (error) {
    console.error('[confirm] Error:', error);
    return res.status(500).json({
      success: false, submissionId, status: 'failed',
      error: 'Internal server error: ' + error.message
    });
  }
};

// ============ Create Short Link ============

async function createLink(bookId, bookTitle, code, BOOKSTORE_TOKEN, languageCode) {
  const linkName = `${code}${bookTitle}-书籍详情页-FB`;

  const linkResp = await fetch(`${BOOKSTORE_API_BASE}/SocialMediaLinkConfig`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BOOKSTORE_TOKEN}`,
      'Content-Type': 'application/json',
      'X-OS': 'web', 'X-AppName': 'web-admin',
      'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
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
      languageCode,
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
            if (detailData.code === 200 && detailData.data?.shortUrl) {
              shortUrl = detailData.data.shortUrl;
            }
          }
        } catch (e) { console.error('Link detail fetch failed:', e.message); }
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
