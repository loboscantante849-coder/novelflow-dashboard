const { getBookstoreToken, invalidateBookstoreToken } = require('./oidc-token');

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromCaller = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) error.code = 'UPSTREAM_TIMEOUT';
    throw error;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', abortFromCaller);
  }
}

async function isAuthFailureResponse(response) {
  if (!response) return false;
  if (response.status === 401 || response.status === 403) return true;
  if (response.status !== 400 || typeof response.clone !== 'function') return false;
  try {
    const data = await response.clone().json();
    const code = String(data?.code ?? data?.status ?? data?.errorCode ?? '').toLowerCase();
    const message = String(data?.message ?? data?.msg ?? data?.error ?? '').toLowerCase();
    if (code === '401' || code === '403' || code.includes('unauthorized')) return true;
    return /(token|jwt|credential|authoriz|login|认证|登录)/i.test(message) &&
      /(expired|invalid|unauthorized|失效|过期|无效)/i.test(message);
  } catch (_) {
    return false;
  }
}

/**
 * Make an authenticated bookstore request. An upstream 401 invalidates the
 * cached OIDC token and receives exactly one fresh-token retry.
 */
async function bookstoreFetch(url, options = {}, { timeoutMs = 8000, authTimeoutMs = timeoutMs } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getBookstoreToken({ forceRefresh: attempt > 0, timeoutMs: authTimeoutMs });
    if (!token) return { response: null, authUnavailable: true };
    const response = await fetchWithTimeout(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    }, timeoutMs);
    const authFailure = await isAuthFailureResponse(response);
    if (!authFailure || attempt === 1) return { response, authUnavailable: authFailure };
    invalidateBookstoreToken();
  }
  return { response: null, authUnavailable: true };
}

module.exports = { fetchWithTimeout, bookstoreFetch, isAuthFailureResponse };
