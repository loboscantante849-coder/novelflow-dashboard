/**
 * POST /api/confirm
 *
 * v2.5.1 - Security P0 fixes 2026-07-06 (C-02, H-04, M-05)
 *  - JWT required (401 if not logged in); discordUsername is taken from JWT, body value ignored.
 *  - Strict schema validation: bookName/bookId/bookTitle/lang must be strings with length caps.
 *  - Per (username, bookId) dedup against nf_subs + nf_user_data:<u>.myBooks.
 *  - Per-user daily creation cap (50) + IP rate limit (anon 5/h, logged-in 50/h).
 *  - All text inputs stripped of HTML tags before storage.
 *  - Disabled accounts (nf_user_data:<u>.disabled) rejected.
 */
const { handlePreflight } = require('./_lib/cors');
const { getBookstoreToken } = require('./_lib/oidc-token');
const {
  getRedis, getClientIp, getAuthPayload, checkRateLimit,
  validateString, stripHtml, isAdminUser,
} = require('./_lib/security');
const { Redis } = require('@upstash/redis');

const BOOKSTORE_API_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
const BOOKSTORE_APP_ID = '642fc1ace309494378a774a6';
const DEFAULT_CHANNEL_NAME = 'NovelFlow_SocialMedia_Facebook-grounp_Facebook_xujt';
const DEFAULT_CHANNEL_NAME_ID = '699ef7b8194eb218db3c2270';
const STARTING_CODE = 4900;
const MAX_CODE = 99999;

// Rate limits
const ANON_IP_LIMIT = 5;
const AUTH_IP_LIMIT = 50;
const USER_DAILY_LIMIT = 50;
const RATE_WINDOW = 3600; // 1h for IP
const DAILY_WINDOW = 86400; // 24h for per-user daily cap

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

/**
 * Look up CPS channel config for a user from KV.
 */
async function getCpsChannel(redis, username) {
  if (!redis || !username) return null;
  const raw = await redis.hget('nf_cps_channels', username.toLowerCase());
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function ensureCpsChannel(redis, username, bookstoreToken) {
  if (!username || username === 'Anonymous') return null;
  const existing = await getCpsChannel(redis, username);
  if (existing) return existing;

  let channelCode = username.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 50);
  if (!channelCode) {
    console.warn(`[ensureCpsChannel] Non-ASCII username "${username}" - fallback default`);
    return null;
  }
  const fullChannelCode = `NovelFlow_SocialMedia_CPS_${channelCode}`;

  if (bookstoreToken) {
    try {
      const listResp = await fetch(
        `https://admin.novelspa.app/api/v1/novelmanage/SocialMediaChannelConfig?productLine=NovelFlow&channelSource=CPS&channelNumber=${encodeURIComponent(channelCode)}&page=1&pageSize=10`,
        {
          headers: {
            'Authorization': `Bearer ${bookstoreToken}`,
            'X-OS': 'web', 'X-AppName': 'web-admin',
            'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1',
            'Origin': 'https://admin.novelspa.app'
          }
        }
      );
      if (listResp.ok) {
        const listData = await listResp.json();
        if (listData.data?.data?.length > 0) {
          const existingCh = listData.data.data.find(ch => ch.channelCode === channelCode);
          if (existingCh) {
            const info = {
              channelCode: existingCh.channelCode,
              channelNameId: existingCh.id,
              fullChannelCode: existingCh.fullChannelCode
            };
            await redis.hset('nf_cps_channels', { [username.toLowerCase()]: JSON.stringify(info) });
            return info;
          }
        }
      }
    } catch (e) { console.error('[ensureCpsChannel] List lookup failed:', e.message); }

    try {
      const createResp = await fetch('https://admin.novelspa.app/api/v1/novelmanage/SocialMediaLinkConfig', { method: 'POST' });
      // Note: SocialMediaChannelConfig endpoint 404s in some envs; the main SocialMediaLinkConfig still works.
      // We'll create via the link flow which auto-provisions; skip explicit channel create here.
    } catch {}
  }
  return null;
}

/**
 * Find an existing submission for (username, bookId) from nf_subs + nf_user_data:<u>.myBooks.
 * Returns {code, link, linkId} or null.
 */
async function findExistingForBook(redis, username, bookId) {
  if (!redis) return null;
  const u = username.toLowerCase();
  try {
    // 1. Scan nf_user_subs set
    const members = await redis.smembers(`nf_user_subs:${u}`);
    if (members && members.length) {
      for (const key of members) {
        if (key.startsWith('_pending_')) continue;
        const raw = await redis.hget('nf_subs', key);
        if (!raw) continue;
        let sub;
        try { sub = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
        if (sub && String(sub.bookId) === String(bookId) && sub.code && sub.status !== 'failed') {
          return { code: String(sub.code), link: sub.link || null, linkId: sub.linkId || null };
        }
      }
    }
    // 2. Check nf_user_data:<u>.myBooks
    const rawUd = await redis.get(`nf_user_data:${u}`);
    if (rawUd) {
      let ud;
      try { ud = typeof rawUd === 'string' ? JSON.parse(rawUd) : rawUd; } catch { ud = null; }
      if (ud && Array.isArray(ud.myBooks)) {
        for (const b of ud.myBooks) {
          if (b && String(b.bookId || b.id) === String(bookId) && (b.code || b.link)) {
            return { code: b.code ? String(b.code) : null, link: b.link || null, linkId: b.linkId || null };
          }
        }
      }
    }
  } catch (e) {
    console.error('[confirm] findExistingForBook error:', e.message);
  }
  return null;
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const redis = redisClient();

  // -------- AUTH (C-02) --------
  const payload = getAuthPayload(req);
  let username = null;
  let isAdmin = false;
  const clientIp = getClientIp(req);

  if (payload) {
    username = payload.username;
    isAdmin = await isAdminUser(redis, username);
  }

  // IP-based rate limit (H-04)
  const ipKey = `nf_rate:confirm_ip:${clientIp}`;
  const ipLimit = payload ? AUTH_IP_LIMIT : ANON_IP_LIMIT;
  if (!await checkRateLimit(redis, ipKey, ipLimit, RATE_WINDOW)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' });
  }

  if (!payload) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }

  // Disabled account check
  if (redis) {
    try {
      const selfData = await redis.get('nf_user_data:' + String(username).toLowerCase());
      if (selfData) {
        const parsed = typeof selfData === 'string' ? JSON.parse(selfData) : selfData;
        if (parsed && parsed.disabled) {
          return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        }
      }
    } catch {}
  }

  // -------- SCHEMA VALIDATION (M-05) --------
  const body = req.body || {};
  // IGNORE body.discordUsername — use JWT username
  const vBookName = validateString(body.bookName, { name: 'bookName', maxLen: 200, required: true });
  if (!vBookName.ok) return res.status(vBookName.status).json({ error: vBookName.error });
  const vBookId = validateString(body.bookId, { name: 'bookId', maxLen: 64, required: true });
  if (!vBookId.ok) return res.status(vBookId.status).json({ error: vBookId.error });
  const vBookTitle = validateString(body.bookTitle, { name: 'bookTitle', maxLen: 200 });
  if (!vBookTitle.ok) return res.status(vBookTitle.status).json({ error: vBookTitle.error });
  const vLang = validateString(body.lang, { name: 'lang', maxLen: 8 });
  if (!vLang.ok) return res.status(vLang.status).json({ error: vLang.error });
  const vNotes = validateString(body.notes, { name: 'notes', maxLen: 500 });
  if (!vNotes.ok) return res.status(vNotes.status).json({ error: vNotes.error });
  const vPromo = validateString(body.promotionMethod, { name: 'promotionMethod', maxLen: 200 });
  if (!vPromo.ok) return res.status(vPromo.status).json({ error: vPromo.error });

  // Strip HTML from all text fields
  const cleanUsername = stripHtml(username).substring(0, 50) || 'Anonymous';
  const cleanBookName = stripHtml(vBookName.value).substring(0, 200);
  const cleanBookTitle = stripHtml(vBookTitle.value).substring(0, 200);
  const lang = vLang.value || 'en';
  const languageCode = (lang === 'es' ? 'es' : 'en');
  const bookId = vBookId.value; // already validated as string ≤64

  // Per-user daily cap
  if (redis) {
    const userDailyKey = `nf_rate:confirm_user:${cleanUsername.toLowerCase()}:${new Date().toISOString().slice(0,10)}`;
    if (!await checkRateLimit(redis, userDailyKey, USER_DAILY_LIMIT, DAILY_WINDOW)) {
      return res.status(429).json({ error: 'Daily limit reached (50/day)', code: 'DAILY_LIMIT' });
    }
  }

  // Dedup check
  const existing = await findExistingForBook(redis, cleanUsername, bookId);
  if (existing) {
    return res.status(200).json({
      success: true,
      status: 'existing',
      code: existing.code,
      link: existing.link,
      linkId: existing.linkId,
      message: 'Link already exists for this book'
    });
  }

  const submissionId = 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  const BOOKSTORE_TOKEN = await getBookstoreToken();
  if (!BOOKSTORE_TOKEN) {
    console.error('[confirm] No bookstore token available');
  }

  try {
    let finalCode = null;
    if (BOOKSTORE_TOKEN) {
      let startCode = STARTING_CODE;
      if (redis) {
        const hint = await redis.get('nf_next_code');
        if (hint) startCode = Math.max(STARTING_CODE, parseInt(hint) || STARTING_CODE);
      }

      const MAX_ATTEMPTS = 50;
      for (let tryCode = startCode, attempts = 0; tryCode < MAX_CODE && attempts < MAX_ATTEMPTS; tryCode++, attempts++) {
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
            channel: 'CPS',
            isEnable: true
          }),
          signal: AbortSignal.timeout(8000)
        });

        if (codeResp.status === 401) {
          console.error('[confirm] Bookstore API 401');
          break;
        }

        if (codeResp.ok) {
          const codeData = await codeResp.json();
          if (codeData.data) {
            finalCode = tryCode;
            if (redis) await redis.set('nf_next_code', tryCode + 1);
            break;
          }
        }
      }
    }

    if (!finalCode) {
      if (redis) {
        const pendingSub = {
          id: submissionId,
          bookName: cleanBookName,
          discordUsername: cleanUsername,
          promotionMethod: stripHtml(vPromo.value).substring(0, 200),
          notes: stripHtml(vNotes.value).substring(0, 500),
          bookId, matchedBookName: cleanBookTitle || cleanBookName,
          lang: languageCode,
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

    const cpsChannel = await ensureCpsChannel(redis, cleanUsername, BOOKSTORE_TOKEN);
    let linkResult = null;
    if (BOOKSTORE_TOKEN) {
      linkResult = await createLink(bookId, cleanBookTitle || cleanBookName, finalCode, BOOKSTORE_TOKEN, languageCode, cpsChannel);
    }

    const completedSub = {
      id: submissionId,
      bookName: cleanBookName,
      discordUsername: cleanUsername,
      promotionMethod: stripHtml(vPromo.value).substring(0, 200),
      notes: stripHtml(vNotes.value).substring(0, 500),
      bookId,
      matchedBookName: cleanBookTitle || cleanBookName,
      lang: languageCode,
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
      if (cpsChannel) completedSub.cpsChannelCode = cpsChannel.channelCode;
    }

    if (redis) {
      await redis.hset('nf_subs', { [String(finalCode)]: JSON.stringify(completedSub) });
      await redis.sadd(`nf_user_subs:${cleanUsername.toLowerCase()}`, String(finalCode));
      // Also add to nf_user_data:<u>.myBooks if we can merge
      try {
        const rawUd = await redis.get(`nf_user_data:${cleanUsername.toLowerCase()}`);
        let ud = rawUd ? (typeof rawUd === 'string' ? JSON.parse(rawUd) : rawUd) : null;
        if (!ud) ud = { myBooks: [] };
        if (!Array.isArray(ud.myBooks)) ud.myBooks = [];
        ud.myBooks.push({
          bookId,
          title: cleanBookTitle || cleanBookName,
          bookName: cleanBookName,
          code: String(finalCode),
          link: completedSub.link || null,
          linkId: completedSub.linkId || null,
          cover: '',
          submittedAt: completedSub.submittedAt,
        });
        ud.lastSyncAt = Date.now();
        await redis.set(`nf_user_data:${cleanUsername.toLowerCase()}`, JSON.stringify(ud));
      } catch (e) {
        console.error('[confirm] myBooks merge failed:', e.message);
      }
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
      error: 'Internal server error'
    });
  }
};

// ============ Create Short Link ============
async function createLink(bookId, bookTitle, code, BOOKSTORE_TOKEN, languageCode, cpsChannel) {
  const linkName = `${code}${bookTitle}-书籍详情页-CPS`;
  const channelName = cpsChannel ? cpsChannel.fullChannelCode : DEFAULT_CHANNEL_NAME;
  const channelNameId = cpsChannel ? cpsChannel.channelNameId : DEFAULT_CHANNEL_NAME_ID;

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
      mediaSource: cpsChannel ? cpsChannel.fullChannelCode : 'SocialMedia',
      channelName,
      channelNameId,
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
        return { shortUrl, linkId: responseLinkId, campaignId: channelNameId };
      }
      if (typeof linkData.data === 'object' && linkData.data.shortUrl) {
        return { shortUrl: linkData.data.shortUrl, linkId: null, campaignId: channelNameId };
      }
    }
  }
  console.error('Link creation failed:', linkResp.status);
  return null;
}
