const ALLOWED_HOSTS = new Set([
  'assets.laoye.chat',
  'auto-creative.oss-us-east-1.aliyuncs.com',
  'oss.novelago.app',
  'oss.novelago.com'
]);

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  let source;
  try { source = new URL(String(req.query?.url || '')); } catch { return res.status(400).json({ error: 'A valid media URL is required' }); }
  if (source.protocol !== 'https:' || !ALLOWED_HOSTS.has(source.hostname)) return res.status(403).json({ error: 'Media host is not allowed' });
  try {
    const response = await fetch(source, { headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', 'User-Agent': 'NovelFlow-Social-Console/1.0' }, redirect: 'follow' });
    const type = String(response.headers.get('content-type') || '');
    if (!response.ok || !type.startsWith('image/')) return res.status(502).json({ error: 'Image source did not return media' });
    const body = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    res.setHeader('Content-Length', String(body.length));
    return res.status(200).send(body);
  } catch {
    return res.status(502).json({ error: 'Image source is temporarily unavailable' });
  }
};
