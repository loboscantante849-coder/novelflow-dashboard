/**
 * CORS helper - restricts API access to known origins only.
 *
 * v2.5.1 security fix:
 *   - Removed wildcard '*' origin.
 *   - Removed 'Access-Control-Allow-Credentials: true' default (same-origin site doesn't need it;
 *     auth endpoints that truly need it set it explicitly and only for approved origins).
 *   - Only allow GET,POST,OPTIONS; only allow Content-Type, Authorization headers by default.
 *   - OPTIONS pre-flight returns 204 with correct Vary header.
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
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (credentials && origin) {
    // Only emit credentials when explicitly requested AND origin is whitelisted
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
