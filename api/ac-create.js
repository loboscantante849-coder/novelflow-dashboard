/**
 * POST /api/ac-create
 * 创建AC视频任务
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
  // TTL: 48 hours (2 days) to auto-expire old counts
  await redis.set(key, count, { ex: 172800 });
}

const AC_BASE = 'https://ac.beidou.win/api/v1';

const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let redis = null;
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL) {
      redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    }
  } catch(e) {}

  // Use server-stored AC token: KV first → env var → header
  let token = null;
  try {
    if (redis) token = await redis.get('ac_token');
  } catch(e) {}
  if (!token) token = process.env.AC_TOKEN || req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', ''));
  if (!token) return res.status(401).json({ error: 'AC Token not configured. Set via /api/ac-kv' });

  const body = req.body || {};
  if (!body.book_id) return res.status(400).json({ error: 'book_id required' });

  // Server-side daily limit (5 per username per day, LA timezone, KV-persisted)
  const username = body.username || req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || 'unknown';
  const today = getLADateString();
  let currentCount = 0;
  if (redis) {
    currentCount = await getReelsCount(redis, username, today);
  }
  if (currentCount >= REELS_DAILY_LIMIT) {
    return res.status(429).json({ error: 'Daily limit reached (5 reels/day). Try again tomorrow.', remaining: 0 });
  }

  // Use prompt as fallback for ad_copy (advanced mode sends prompt field)
  const adCopy = body.ad_copy || body.prompt || '';

  const payload = {
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
    remark: body.remark || '',
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
      body: JSON.stringify(payload),
    });
    const newToken = r.headers.get('accesstoken') || null;
    const data = await r.json().catch(() => null);

    // Auto-rotate: save new token to Upstash Redis for next request
    if (newToken && redis) {
      try {
        await redis.set('ac_token', newToken);
        console.log('AC token rotated in Upstash');
      } catch(e) { console.warn('Redis save failed:', e.message); }
    }

    // Only increment daily count if creation succeeded
    let remaining = REELS_DAILY_LIMIT - currentCount;
    if (r.status >= 200 && r.status < 300) {
      currentCount++;
      if (redis) {
        await setReelsCount(redis, username, today, currentCount);
      }
      remaining = REELS_DAILY_LIMIT - currentCount;
    }

    res.setHeader('x-ac-token', newToken || '');
    
    // Better error propagation
    if (r.status === 401) {
      return res.status(401).json({ 
        success: false, 
        error: 'AC Token expired or invalid. Please re-login to ac.beidou.win and update the token.',
        data 
      });
    }
    
    return res.status(r.status).json({ 
      success: r.status >= 200 && r.status < 300, 
      data, 
      newToken: newToken || undefined,
      remaining 
    });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
