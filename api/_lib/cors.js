/**
 * CORS helper - restricts API access to known origins only.
 *
 * v2.6.2: Vercel edge layer may inject a fallback '*' Allow-Origin on responses that don't set one.
 * To avoid the dangerous '*' + 'credentials:true' combo, we explicitly set Allow-Origin
 * on every response. Non-whitelisted origins get a fake opaque origin that browsers won't match.
 * We also never emit 'credentials:true' for non-whitelisted origins.
 */

const ALLOWED_ORIGINS = [
  'https://novelflow.top',
  'https://www.novelflow.top',
  'https://dash.novelflow.app',
  'https://novelflow.app',
  'https://novelflow-dashboard.vercel.app',
];

const LOCALHOST_RE = /^http:\/\/localhost:\d{1,5}$/;

function getAllowedOrigin(req) {
  const origin = (req.headers && req.headers.origin) || '';
  if (!origin) return null;
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return origin;
  if (LOCALHOST_RE.test(origin)) return origin;
  return null;
}

function setCORSHeaders(req, res, { methods = 'GET, POST, OPTIONS', credentials = false } = {}) {
  const clientOrigin = getAllowedOrigin(req);

  // IMPORTANT: Always set Allow-Origin explicitly to prevent Vercel/edge from injecting '*'.
  // Vercel edge injects '*' on responses without Allow-Origin, which combined with credentials:true
  // is a critical CORS misconfiguration.
  if (clientOrigin) {
    res.setHeader('Access-Control-Allow-Origin', clientOrigin);
    res.setHeader('Vary', 'Origin');
  } else {
    // For non-whitelisted origins, set an unmatchable origin. Browsers will block the cross-origin read.
    // Using a non-wildcard, non-null value prevents edge layers from injecting '*'.
    res.setHeader('Access-Control-Allow-Origin', 'https://_cors_deny_.invalid');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');

  // CRITICAL: Only emit credentials for whitelisted origins. Never combine '*' with credentials.
  if (credentials && clientOrigin) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
}

function handlePreflight(req, res, opts) {
  setCORSHeaders(req, res, opts);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

module.exports = { setCORSHeaders, handlePreflight, getAllowedOrigin, ALLOWED_ORIGINS };
