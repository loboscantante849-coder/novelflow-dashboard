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
  // These provider assets are already public and browser-readable. Redirecting
  // avoids buffering multi-megabyte posters inside a cross-region function.
  res.setHeader('Location', source.toString());
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  return res.status(307).end();
};
