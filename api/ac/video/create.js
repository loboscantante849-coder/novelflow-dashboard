/**
 * POST /api/ac/video/create
 * 创建AC视频任务
 */
const AC_BASE = 'https://ac.beidou.win/api/v1';

function getToken(req) {
  return req.headers['x-ac-token'] ||
    (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', '')) ||
    (req.body && req.body.token) || null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ac-token, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Token required' });

  const body = req.body || {};
  if (!body.book_id) return res.status(400).json({ error: 'book_id required' });

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
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('x-ac-token', newToken || '');
  res.status(r.status).json({ success: r.status >= 200 && r.status < 300, data, newToken: newToken || undefined });
}
