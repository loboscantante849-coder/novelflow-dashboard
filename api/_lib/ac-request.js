const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_TIMEOUT_MS = 8000;
const VERCEL_BLOB_SUFFIX = '.public.blob.vercel-storage.com';

// Keep AC transport/configuration helpers together for endpoint consumers.
// The implementation lives in ac-config.js so it can also be imported directly
// by tooling and tests without pulling in request-specific code.
const {
  AC_CLIENT,
  DEFAULT_AC_API_BASE_URL,
  DEFAULT_AC_PROJECT_ID,
  getAcBaseUrl,
  getAcHeaders,
  getAcPagedListUrl,
  getAcProjectId,
  getResponseAccessToken,
  isPrivateIpLiteral,
  normalizeAcBaseUrl,
  normalizeAcProjectId,
  normalizeAcToken,
  readAcToken,
  rotateAcToken,
} = require('./ac-config');

function parseThreadId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return THREAD_ID_RE.test(normalized) ? normalized : null;
}

function normalizeReferenceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const hostname = url.hostname.toLowerCase();
    const configuredHosts = String(process.env.AC_REFERENCE_ALLOWED_HOSTS || '')
      .split(',')
      .map(host => host.trim().toLowerCase())
      .filter(Boolean);
    const allowed = hostname.endsWith(VERCEL_BLOB_SUFFIX) || configuredHosts.includes(hostname);
    if (!allowed) return null;
    url.hash = '';
    return url.href;
  } catch (_error) {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function headersToObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return typeof headers === 'object' ? { ...headers } : {};
}

// Keep an upstream AC authentication failure separate from the site's own
// session authentication.  The frontend treats HTTP 401 as a NovelFlow
// session expiry, so proxy calls must surface Tianji auth failures as 502.
function getAcProxyStatus(status) {
  return Number(status) === 401 ? 502 : status;
}

/**
 * Send one upstream request with the stored token, then recover once from a
 * conclusively rejected legacy Redis token using AC_TOKEN. A 401 is safe to
 * retry because the upstream did not accept the request; timeouts and other
 * ambiguous outcomes are never retried here.
 */
async function fetchAcWithTokenFallback(redis, token, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const primaryToken = normalizeAcToken(token);
  if (!primaryToken) throw new Error('AC token is required');
  const environmentToken = normalizeAcToken(process.env.AC_TOKEN);
  const deadlineAt = Date.now() + Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const requestWithToken = (candidateToken) => fetchWithTimeout(url, {
    ...options,
    headers: getAcHeaders(candidateToken, headersToObject(options.headers)),
  }, Math.max(1, deadlineAt - Date.now()));

  const primaryResponse = await requestWithToken(primaryToken);
  if (primaryResponse.status !== 401 || !environmentToken || environmentToken === primaryToken) {
    return primaryResponse;
  }

  const fallbackResponse = await requestWithToken(environmentToken);
  // A non-401 response proves this token was accepted far enough to handle
  // the request. Persist it so the next request avoids the failed attempt.
  if (fallbackResponse.status !== 401 && redis) {
    try {
      await redis.set('ac_token', environmentToken);
    } catch (_error) {
      // The caller still receives the upstream response and handles its own
      // token rotation. A Redis write failure must not conceal that response.
    }
  }
  return fallbackResponse;
}

module.exports = {
  AC_CLIENT,
  DEFAULT_AC_API_BASE_URL,
  DEFAULT_AC_PROJECT_ID,
  DEFAULT_TIMEOUT_MS,
  fetchAcWithTokenFallback,
  fetchWithTimeout,
  getAcProxyStatus,
  getAcBaseUrl,
  getAcHeaders,
  getAcPagedListUrl,
  getAcProjectId,
  getResponseAccessToken,
  isPrivateIpLiteral,
  normalizeReferenceUrl,
  normalizeAcBaseUrl,
  normalizeAcProjectId,
  normalizeAcToken,
  parseThreadId,
  readAcToken,
  rotateAcToken,
};
