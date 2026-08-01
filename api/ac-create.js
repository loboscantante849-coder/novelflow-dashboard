/**
 * POST /api/ac-create
 * 创建AC视频任务（已鉴权）
 */

const REELS_DAILY_LIMIT = 7;
const REELS_IP_DAILY_LIMIT = 30;
const REELS_COUNTER_TTL_SECONDS = 172800;
const ALLOWED_TEMPLATES = new Set([
  'Ad_Plot_Video_V3', 'PPT_Porn', 'Ad_Plot_Video_V2', 'Dialogue',
  'PPT_Multi', 'Comic', 'PPT_Porn_Loop_Video', 'Ad_Plot_Seedance',
  'Digital', 'Extract',
]);
const ALLOWED_LANGUAGES = new Set(['English', 'Spanish']);
const ALLOWED_ASPECT_RATIOS = new Set(['9:16']);

function getLADateString() {
  const now = new Date();
  const laNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const y = laNow.getFullYear();
  const m = String(laNow.getMonth() + 1).padStart(2, '0');
  const d = String(laNow.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

async function reserveDailySlots(redis, key, amount) {
  const count = await redis.incrby(key, amount);
  if (count === amount) await redis.expire(key, REELS_COUNTER_TTL_SECONDS);
  return count;
}

const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, getClientIp, getRedis, isDisabledUser } = require('./_lib/security');
const { fetchWithTimeout, normalizeReferenceUrl } = require('./_lib/ac-request');

function parseInteger(value, fallback, min, max) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^\d+$/.test(String(raw))) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseAcRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const bookId = typeof body.book_id === 'string' ? body.book_id.trim() : '';
  const template = body.template === undefined ? 'Ad_Plot_Video_V3' : body.template;
  const language = body.language === undefined ? 'English' : body.language;
  const aspectRatio = body.aspect_ratio === undefined ? '9:16' : body.aspect_ratio;
  const num = parseInteger(body.num, 1, 1, 3);
  const startChapter = parseInteger(body.start_chapter, 1, 1, 10000);
  const endChapter = parseInteger(body.end_chapter, 5, 1, 10000);
  const adCopy = body.ad_copy === undefined ? (body.prompt || '') : body.ad_copy;
  const buildRequirement = body.build_requirement || '';
  const references = body.reference_picture_list === undefined ? [] : body.reference_picture_list;

  if (!bookId || bookId.length > 128 || typeof template !== 'string' || !ALLOWED_TEMPLATES.has(template)) return null;
  if (typeof language !== 'string' || !ALLOWED_LANGUAGES.has(language)) return null;
  if (typeof aspectRatio !== 'string' || !ALLOWED_ASPECT_RATIOS.has(aspectRatio)) return null;
  if (num === null || startChapter === null || endChapter === null || endChapter < startChapter || endChapter - startChapter > 100) return null;
  if (typeof adCopy !== 'string' || adCopy.length > 4000) return null;
  if (typeof buildRequirement !== 'string' || buildRequirement.length > 1000) return null;
  if (!Array.isArray(references) || references.length > 4) return null;

  const referenceUrls = [];
  for (const value of references) {
    const normalizedUrl = normalizeReferenceUrl(value);
    if (!normalizedUrl) return null;
    referenceUrls.push(normalizedUrl);
  }

  return {
    bookId, template, language, aspectRatio, num, startChapter, endChapter,
    adCopy, buildRequirement, referenceUrls,
  };
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ---- AUTH ----
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const username = String(payload.username || '').trim().toLowerCase();
  if (!username) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });

  const redis = getRedis();

  if (!redis) return res.status(503).json({ error: 'Account status unavailable', code: 'ACCOUNT_STATUS_UNAVAILABLE' });
  try {
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (e) {
    return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  // Use server-stored AC token: KV first → env var; never accept token from client
  let token = null;
  try {
    token = await redis.get('ac_token');
  } catch (_error) {
    return res.status(503).json({ error: 'AC credentials are temporarily unavailable', code: 'AC_TOKEN_UNAVAILABLE' });
  }
  if (!token) token = process.env.AC_TOKEN;
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  const parsed = parseAcRequest(req.body || {});
  if (!parsed) return res.status(400).json({ error: 'Invalid reel request', code: 'INVALID_REQUEST' });

  // Reserve quotas atomically before the expensive upstream call. Failed
  // attempts remain counted so repeated invalid upstream work cannot drain AC.
  const today = getLADateString();
  let currentCount;
  try {
    const userKey = 'reels_count_v2:' + username + ':' + today;
    const ipKey = 'reels_ip_count_v2:' + getClientIp(req) + ':' + today;
    const counts = await Promise.all([
      reserveDailySlots(redis, userKey, parsed.num),
      reserveDailySlots(redis, ipKey, parsed.num),
    ]);
    currentCount = counts[0];
    if (currentCount > REELS_DAILY_LIMIT || counts[1] > REELS_IP_DAILY_LIMIT) {
      return res.status(429).json({ error: 'Daily limit reached. Try again tomorrow.', remaining: 0 });
    }
  } catch (_error) {
    return res.status(503).json({ error: 'AC usage status is temporarily unavailable', code: 'AC_USAGE_UNAVAILABLE' });
  }

  const acPayload = {
    template: parsed.template,
    relatedBook: { book_id: parsed.bookId },
    num: parsed.num,
    language: parsed.language,
    country: 'US',
    ad_platform: 'Facebook',
    start_chapter: String(parsed.startChapter),
    end_chapter: String(parsed.endChapter),
    tts_audio_voice: 'Female_cur1',
    aspect_ratio: parsed.aspectRatio,
    is_generate_img: 'true',
    copy_type: '原创',
    build_requirement: parsed.buildRequirement,
    ad_copy: parsed.adCopy,
    word_count: '200词',
    reference_picture_list: parsed.referenceUrls,
    remark: 'nf_' + username + '_' + Date.now(),
  };

  try {
    const r = await fetchWithTimeout(AC_BASE + '/creative/by-user', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'x-client': 'beidou-web',
        'X-Project-Id': '1006',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(acPayload),
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    // Auto-rotate token server-side only; never leak to client
    if (newToken && redis) {
      try {
        await redis.set('ac_token', newToken);
      } catch(e) { console.warn('Redis token save failed:', e.message); }
    }

    // Track threadId → owner mapping so result/interrupt/retry can enforce ownership
    if (r.status >= 200 && r.status < 300 && redis && data) {
      const threadId = data.threadId || (data.data && data.data.threadId) || (data.creative && data.creative.threadId);
      if (threadId) {
        try {
          await redis.set('ac_thread_owner:' + threadId, username, { ex: 180 * 86400 });
          await redis.del(`nf_ac_list_cache:${username}`);
        } catch(e) { /* non-fatal */ }
      }
    }

    const remaining = Math.max(0, REELS_DAILY_LIMIT - currentCount);

    if (r.status === 401) {
      return res.status(502).json({ success: false, error: 'Video service authentication failed' });
    }

    if (r.status < 200 || r.status >= 300) {
      return res.status(502).json({ success: false, error: 'Video service request failed' });
    }
    return res.status(200).json({ success: true, data, remaining });
  } catch (e) {
    return res.status(e && e.name === 'AbortError' ? 504 : 502).json({
      error: e && e.name === 'AbortError' ? 'Video service timed out' : 'Video service unavailable',
    });
  }
};
