/**
 * POST /api/ac-create
 * 创建AC视频任务（已鉴权）
 */

const REELS_DAILY_LIMIT = 7;

function getLADateString() {
  const now = new Date();
  const laNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const y = laNow.getFullYear();
  const m = String(laNow.getMonth() + 1).padStart(2, '0');
  const d = String(laNow.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

async function getReelsCount(redis, username, today) {
  try {
    const key = 'reels_count_v2:' + username + ':' + today;
    const val = await redis.get(key);
    return parseInt(val) || 0;
  } catch(e) { return 0; }
}

async function setReelsCount(redis, username, today, count) {
  const key = 'reels_count_v2:' + username + ':' + today;
  await redis.set(key, count, { ex: 172800 });
}

const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');
const { getAuthPayload, isAdminUser } = require('./_lib/security');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ---- AUTH ----
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const username = payload.username;

  let redis = null;
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    }
  } catch(e) {}

  // Use server-stored AC token: KV first → env var; never accept token from client
  let token = null;
  try {
    if (redis) token = await redis.get('ac_token');
  } catch(e) {}
  if (!token) token = process.env.AC_TOKEN;
  if (!token) return res.status(503).json({ error: 'AC Token not configured on server' });

  const body = req.body || {};
  if (!body.book_id) return res.status(400).json({ error: 'book_id required' });

  // Server-side daily limit using JWT username (not client-controlled)
  const today = getLADateString();
  let currentCount = 0;
  if (redis) {
    currentCount = await getReelsCount(redis, username, today);
  }
  if (currentCount >= REELS_DAILY_LIMIT) {
    return res.status(429).json({ error: 'Daily limit reached (7 reels/day). Try again tomorrow.', remaining: 0 });
  }

  // Use prompt as fallback for ad_copy
  const adCopy = body.ad_copy || body.prompt || '';

  const acPayload = {
    template: body.template || 'Ad_Plot_Video_V3',
    relatedBook: { book_id: body.book_id },
    num: body.num || 3,
    language: body.language || 'English',
    country: body.country || 'US',
    ad_platform: body.ad_platform || 'Facebook',
    start_chapter: String(body.start_chapter || '1'),
    end_chapter: String(body.end_chapter || '5'),
    tts_audio_voice: body.tts_audio_voice || 'Female_cur1',
    aspect_ratio: body.aspect_ratio || '9:16',
    is_generate_img: String(body.is_generate_img ?? 'true'),
    copy_type: body.copy_type || '原创',
    build_requirement: body.build_requirement || '',
    ad_copy: adCopy,
    word_count: body.word_count || '200词',
    reference_picture_list: body.reference_picture_list || [],
    remark: 'nf_' + username + '_' + Date.now(),
  };

  try {
    const r = await fetch(AC_BASE + '/creative/by-user', {
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
          await redis.set('ac_thread_owner:' + threadId, username, { ex: 7 * 86400 });
        } catch(e) { /* non-fatal */ }
      }
    }

    let remaining = REELS_DAILY_LIMIT - currentCount;
    if (r.status >= 200 && r.status < 300) {
      currentCount++;
      if (redis) {
        await setReelsCount(redis, username, today, currentCount);
      }
      remaining = REELS_DAILY_LIMIT - currentCount;
    }

    if (r.status === 401) {
      return res.status(401).json({ success: false, error: 'AC service authentication failed', data });
    }

    return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data, remaining });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
