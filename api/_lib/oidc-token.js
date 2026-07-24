/**
 * OIDC token lifecycle for bookstore APIs.
 *
 * The process cache is intentionally short-lived. Serverless instances may
 * survive credential rotations, so neither credentials nor access tokens are
 * trusted indefinitely.
 */
const OIDC_TOKEN_URL = 'https://sts.anystories.app/connect/token';
const OIDC_CLIENT_ID = 'AuthClient';
const REQUEST_TIMEOUT_MS = 8000;
const CREDENTIAL_CACHE_MS = 5 * 60 * 1000;

let cachedToken = null;
let cachedTokenExp = 0;
let cachedCreds = null;
let refreshPromise = null;

function timeoutPromise(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseJwtExpiry(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number.isFinite(Number(payload.exp)) ? Number(payload.exp) * 1000 : null;
  } catch (_) {
    return null;
  }
}

function cacheToken(token, expiresInSec) {
  const now = Date.now();
  const lifetimeMs = Number(expiresInSec) * 1000;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 30000) return false;

  const jwtExpiry = parseJwtExpiry(token);
  const absoluteExpiry = jwtExpiry ? Math.min(now + lifetimeMs, jwtExpiry) : now + lifetimeMs;
  const skewMs = Math.min(300000, Math.max(5000, Math.floor(lifetimeMs * 0.1)));
  if (absoluteExpiry <= now + skewMs) return false;

  cachedToken = token;
  cachedTokenExp = absoluteExpiry - skewMs;
  return true;
}

async function getCredentials() {
  if (cachedCreds && cachedCreds.expiresAt > Date.now()) return cachedCreds.value;

  let credentials = null;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const { Redis } = require('@upstash/redis');
      const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const [username, password] = await timeoutPromise(
        Promise.all([redis.get('oidc:username'), redis.get('oidc:password')]),
        REQUEST_TIMEOUT_MS,
        'OIDC credential lookup',
      );
      if (username && password) credentials = { username: String(username), password: String(password) };
    } catch (error) {
      console.error('[oidc] credential lookup failed:', error.message);
    }
  }

  // KV is the rotation source of truth. Environment variables remain only as
  // a resilient fallback for deployments without KV-backed credentials.
  if (!credentials && process.env.OIDC_USERNAME && process.env.OIDC_PASSWORD) {
    credentials = { username: process.env.OIDC_USERNAME, password: process.env.OIDC_PASSWORD };
  }
  if (credentials) cachedCreds = { value: credentials, expiresAt: Date.now() + CREDENTIAL_CACHE_MS };
  return credentials;
}

async function requestFreshToken(credentials) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(OIDC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: OIDC_CLIENT_ID,
        username: credentials.username,
        password: credentials.password,
        scope: 'openid profile roles email offline_access',
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error('[oidc] token refresh failed:', response.status);
      return null;
    }
    const data = await response.json();
    if (!data || typeof data.access_token !== 'string' || !cacheToken(data.access_token, data.expires_in)) {
      console.error('[oidc] token response was missing a usable access token or expiry');
      return null;
    }
    return cachedToken;
  } catch (error) {
    console.error('[oidc] token refresh error:', error.name === 'AbortError' ? 'timeout' : error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getFreshToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const credentials = await getCredentials();
    if (!credentials) return null;
    return requestFreshToken(credentials);
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function invalidateBookstoreToken() {
  cachedToken = null;
  cachedTokenExp = 0;
}

function getEnvironmentToken() {
  const token = process.env.NOVELSPA_TOKEN;
  const expiry = parseJwtExpiry(token);
  if (!token || !expiry || expiry <= Date.now() + 60000) return null;
  cachedToken = token;
  cachedTokenExp = expiry - 60000;
  return token;
}

async function getBookstoreToken({ forceRefresh = false } = {}) {
  if (forceRefresh) invalidateBookstoreToken();
  if (cachedToken && cachedTokenExp > Date.now()) return cachedToken;

  const credentials = await getCredentials();
  if (credentials) {
    // Do not fall back to a possibly expired env token when managed OIDC
    // credentials are present but refresh fails.
    return getFreshToken();
  }
  return getEnvironmentToken();
}

function _resetForTests() {
  cachedToken = null;
  cachedTokenExp = 0;
  cachedCreds = null;
  refreshPromise = null;
}

module.exports = {
  getBookstoreToken,
  getFreshToken,
  getCredentials,
  invalidateBookstoreToken,
  _resetForTests,
};
