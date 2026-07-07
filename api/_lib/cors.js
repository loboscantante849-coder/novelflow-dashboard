/**
 * CORS helper - restricts API access to known origins only.
 *
 * v2.6.2 security fix:
 *   Vercel auto-injects Access-Control-Allow-Origin: * on all API responses.
 *   We MUST explicitly set Allow-Origin on EVERY response to override this default,
 *   otherwise the dangerous '*' + 'credentials:true' combo leaks to evil origins.
 *
 *   Strategy:
 *   - Whitelisted origin → reflect it back + allow credentials
 *   - Non-whitelisted origin / no origin → set "null" (opaque origin, browsers block cross-origin reads)
 *   - The vercel.json also pre-sets Allow-Origin to "" for /api/* as defense-in-depth
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
  const origin = getAllowedOrigin(req);

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    // Explicitly set to "null" to override Vercel's default "*"
    // Browsers treat the string "null" as an opaque origin that doesn't match any real site
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');

  // Remove any previously-set credentials header, then add only if origin is whitelisted
  res.removeHeader('Access-Control-Allow-Credentials');
  if (credentials && origin) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
}

/**
 * Handle CORS preflight. Returns true if caller should end the response.
 */
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
