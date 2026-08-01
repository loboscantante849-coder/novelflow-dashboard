const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_TIMEOUT_MS = 8000;
const VERCEL_BLOB_SUFFIX = '.public.blob.vercel-storage.com';

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

module.exports = {
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  normalizeReferenceUrl,
  parseThreadId,
};
