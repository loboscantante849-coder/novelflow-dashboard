/**
 * CORS helper - v2.6.2
 * 
 * Security fix: Vercel auto-injects Access-Control-Allow-Origin: * on API responses.
 * We MUST override this on every response with an explicit value (even for bad origins).
 * Empty string or no header gets replaced by *; "null" also might not work.
 * Use an invalid/unmatchable origin for non-whitelisted requests so browsers block cross-origin reads.
 */

const ALLOWED_ORIGINS = [
  'https://novelflow.top',
  'https://www.novelflow.top',
  'https://dash.novelflow.app',
  'https://novelflow.app',
  'https://novelflow-dashboard.vercel.app',
];

const LOCALHOST_RE = /^http:\/\/localhost:\d{1,5}$/;
const DENY_ORIGIN = 'https://deny.invalid';

function getAllowedOrigin(req) {
  const origin = (req.headers && req.headers.origin) || '';
  if (!origin) return null;
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return origin;
  if (LOCALHOST_RE.test(origin)) return origin;
  return null;
}

function setCORSHeaders(req, res, { methods = 'GET, POST, OPTIONS', credentials = false } = {}) {
  const origin = getAllowedOrigin(req);
  const effectiveOrigin = origin || DENY_ORIGIN;

  res.setHeader('Access-Control-Allow-Origin', effectiveOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');

  // Only emit credentials when origin is whitelisted
  if (credentials && origin) {
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
