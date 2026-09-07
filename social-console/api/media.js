const BASE_ALLOWED_HOSTS = new Set([
  'auto-creative.oss-us-east-1.aliyuncs.com',
  'oss.novelago.app',
  'oss.novelago.com',
  'ai.iiit.cn'
]);

function allowedHosts() {
  const configured = String(process.env.IIIT_IMAGE_MEDIA_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter((host) => /^[a-z0-9.-]+$/.test(host));
  return new Set([...BASE_ALLOWED_HOSTS, ...configured]);
}

function allowedUrl(value, hosts) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' && hosts.has(parsed.hostname.toLowerCase()) ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchAllowedImage(source, hosts) {
  let current = source;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const upstream = await fetch(current.toString(), { headers: { Range: 'bytes=0-' }, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(upstream.status)) return upstream;
    const location = upstream.headers.get('location');
    const next = location ? allowedUrl(new URL(location, current).toString(), hosts) : null;
    if (!next) throw new Error('redirect_disallowed');
    current = next;
  }
  throw new Error('redirect_limit');
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const hosts = allowedHosts();
  const source = allowedUrl(req.query?.url, hosts);
  if (!source) return res.status(403).json({ error: 'Media host is not allowed' });
  // Do not redirect the browser to a signed provider URL. Some image CDNs
  // reject that second hop because of referrer/origin rules, which previously
  // created the misleading state “success + broken poster”. Stream only a
  // verified image from our allowlisted providers instead.
  let upstream;
  try { upstream = await fetchAllowedImage(source, hosts); }
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

module.exports.allowedUrl = allowedUrl;
module.exports.fetchAllowedImage = fetchAllowedImage;
