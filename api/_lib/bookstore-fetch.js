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

/**
 * Make an authenticated bookstore request. An upstream 401 invalidates the
 * cached OIDC token and receives exactly one fresh-token retry.
 */
async function bookstoreFetch(url, options = {}, { timeoutMs = 8000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getBookstoreToken({ forceRefresh: attempt > 0 });
    if (!token) return { response: null, authUnavailable: true };
    const response = await fetchWithTimeout(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    }, timeoutMs);
    if (response.status !== 401 || attempt === 1) return { response, authUnavailable: false };
    invalidateBookstoreToken();
  }
  return { response: null, authUnavailable: true };
}

module.exports = { fetchWithTimeout, bookstoreFetch };
