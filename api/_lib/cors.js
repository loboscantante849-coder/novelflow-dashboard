/**
 * CORS helper - v2.6.2 security hardening
 * 
 * Problem: Vercel edge layer forces "Access-Control-Allow-Origin: *" on all 
 * Serverless Function responses, creating a dangerous "*" + "credentials:true" combo.
 *
 * Solution (defense in depth):
 * 1. For non-whitelisted origins: return 403 immediately, blocking any data leak.
 *    This is more reliable than CORS headers because Vercel overrides them.
 * 2. For same-origin/no-origin requests (normal browser use): allow normally.
 * 3. For whitelisted cross-origin: set proper CORS headers + credentials.
 * 4. Explicitly set Allow-Origin to override Vercel's * as best-effort.
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
  if (!origin) return null;  // No Origin = same-origin (safe)
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return origin;
  if (LOCALHOST_RE.test(origin)) return origin;
  return 'DENY';  // Explicit origin but not whitelisted
}

function setCORSHeaders(req, res, { methods = 'GET, POST, OPTIONS', credentials = false } = {}) {
  const origin = getAllowedOrigin(req);

  // Best-effort: set proper Allow-Origin (may be overridden by Vercel edge, but works for same-origin)
  if (origin && origin !== 'DENY') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (origin === 'DENY') {
    res.setHeader('Access-Control-Allow-Origin', 'https://_blocked_.invalid');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');

  if (credentials && origin && origin !== 'DENY') {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
}

/**
 * Handle CORS preflight + origin validation.
 * Returns true if caller should end the response (either OPTIONS handled, or 403 for bad origin).
 */
function handlePreflight(req, res, opts) {
  setCORSHeaders(req, res, opts);

  const origin = getAllowedOrigin(req);

  // Block non-whitelisted cross-origin requests immediately
  if (origin === 'DENY') {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return true;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

module.exports = { setCORSHeaders, handlePreflight, getAllowedOrigin, ALLOWED_ORIGINS };
