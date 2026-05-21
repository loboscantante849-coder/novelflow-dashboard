/**
 * POST /api/ac/video/create
 * 创建AC视频任务
 * 
 * Body: {
 *   "token": "JWT token (可选，也可通过x-ac-token header传)",
 *   "template": "PPT_Porn",
 *   "book_id": "68e8ece70c0497c677852304",
 *   "start_chapter": "1",
 *   "end_chapter": "5",
 *   "num": 3,
 *   "language": "English",
 *   "country": "US",
 *   "ad_platform": "Facebook",
 *   "tts_audio_voice": "Female_cur1",
 *   "aspect_ratio": "9:16",
 *   "copy_type": "原创",
 *   "build_requirement": "",
 *   "ad_copy": "",
 *   "word_count": "200词",
 *   "reference_picture_list": [],
 *   "remark": ""
 * }
 */
const { proxyRequest, buildResponse, extractToken } = require('../_lib');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Token required' });
  }

  const body = req.body || {};
  
  // 构建AC API请求体
  const acPayload = {
    template: body.template || 'PPT_Porn',
    relatedBook: {
      book_id: body.book_id,
    },
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

  if (!acPayload.relatedBook.book_id) {
    return res.status(400).json({ success: false, error: 'book_id required' });
  }

  const result = await proxyRequest('/creative/by-user', {
    method: 'POST',
    body: JSON.stringify(acPayload),
  }, token);

  const resp = buildResponse(result.status, result.data, result.newToken);
  res.status(resp.status);
  Object.entries(resp.headers).forEach(([k, v]) => res.setHeader(k, v));
  res.end(resp.body);
};
