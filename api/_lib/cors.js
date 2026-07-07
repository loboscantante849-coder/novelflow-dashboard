/**
 * CORS helper - restricts API access to known origins only.
 *
 * v2.6.2 security fix:
 *   - Explicitly set Access-Control-Allow-Origin on every response (even non-whitelisted origins)
 *     to override Vercel's default '*' header, which would otherwise create the dangerous
 *     '*' + credentials:true combination.
 *   - Non-whitelisted origins get Allow-Origin: null and NO credentials header.
 *   - OPTIONS preflight ends the response after headers are set.
 */

const ALLOWED_ORIGINS = [
  'https://novelflow.top',
  'https://www.novelflow.top',
  'https://dash.novelflow.app',
  'https://novelflow.app',
  'https://novelflow-dashboard.vercel.app',
];

// Dev origins (any http://localhost:xxxx)
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
    // Whitelisted origin: reflect it back + Vary
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    // Non-whitelisted / no origin: explicitly deny to override Vercel default '*'
    // Browsers treat "null" as a non-wildcard opaque origin that doesn't match any real site
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');

  // Credentials ONLY when BOTH requested AND origin is whitelisted
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
