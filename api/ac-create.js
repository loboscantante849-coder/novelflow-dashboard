/**
 * POST /api/ac-create
 * 创建AC视频任务
 */

const REELS_DAILY_LIMIT = 3;
const reelsDailyCounts = new Map(); // key: ip:date, value: count

function checkReelsDailyLimit(ip) {
  const today = new Date().toISOString().split('T')[0];
  const key = ip + ':' + today;
  const count = reelsDailyCounts.get(key) || 0;
  if (count >= REELS_DAILY_LIMIT) return { allowed: false, count };
  reelsDailyCounts.set(key, count + 1);
  // Clean up old entries (keep only today's)
  for (const [k] of reelsDailyCounts) {
    if (!k.endsWith(today)) reelsDailyCounts.delete(k);
  }
  return { allowed: true, count: count + 1 };
}

const AC_BASE = 'https://ac.beidou.win/api/v1';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ac-token, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Use server-stored AC token from env var
  const token = process.env.AC_TOKEN || req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', ''));
  if (!token) return res.status(401).json({ error: 'AC Token not configured on server' });

  const body = req.body || {};
  if (!body.book_id) return res.status(400).json({ error: 'book_id required' });

  // Server-side daily limit (3 per username per day, fallback to IP)
  const limitKey = req.body.username || req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || 'unknown';
  const limitCheck = checkReelsDailyLimit(limitKey);
  if (!limitCheck.allowed) return res.status(429).json({ error: 'Daily limit reached (3 reels/day). Try again tomorrow.', remaining: 0 });

  const payload = {
    template: body.template || 'PPT_Porn',
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
    ad_copy: body.ad_copy || '',
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

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('x-ac-token', newToken || '');
    return res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data, newToken: newToken || undefined });
  } catch (e) {
    return res.status(502).json({ error: 'AC API unreachable', detail: e.message });
  }
};
