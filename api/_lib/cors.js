/**
 * CORS helper - restricts API access to known domains only
 */

const ALLOWED_ORIGINS = [
  'https://novelflow-dashboard.vercel.app',
  'https://loboscantante849-coder.github.io',
  'https://dash.novelflow.app',
  'https://novelflow.app',
  'http://localhost:3000',
  'http://localhost:8080'
];

function getCORSOrigin(req) {
  const origin = req.headers.origin || req.headers.referer?.split('/').slice(0, 3).join('/') || '';
  // Check if origin matches any allowed pattern
  if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
    return origin;
  }
  // Also allow any novelflow.app subdomain
  if (origin.match(/^https:\/\/[a-z0-9-]+\.novelflow\.app/)) {
    return origin;
  }
  // For requests without origin (same-origin, curl, etc.), allow
  if (!req.headers.origin) return null; // will not set CORS header
  return '';
}

function setCORSHeaders(req, res, methods = 'GET, POST, OPTIONS') {
  const origin = getCORSOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ac-token, x-admin-key, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

module.exports = { setCORSHeaders, getCORSOrigin };
