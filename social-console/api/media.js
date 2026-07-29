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
  // Do not redirect the browser to a signed provider URL. Some image CDNs
  // reject that second hop because of referrer/origin rules, which previously
  // created the misleading state “success + broken poster”. Stream only a
  // verified image from our allowlisted providers instead.
  let upstream;
  try { upstream = await fetch(source.toString(), { headers: { Range: 'bytes=0-' }, redirect: 'follow' }); }
  catch { return res.status(502).json({ error: 'Poster source is temporarily unreachable' }); }
  const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
  if (!upstream.ok || !contentType.startsWith('image/')) return res.status(502).json({ error: 'Poster source did not return a readable image' });
  const declaredLength = Number(upstream.headers.get('content-length') || 0);
  if (declaredLength > 12 * 1024 * 1024) return res.status(413).json({ error: 'Poster is too large to preview safely' });
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=300, s-maxage=900');
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) res.setHeader('Content-Length', contentLength);
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'Poster is too large to preview safely' });
  return res.status(200).send(bytes);
};
