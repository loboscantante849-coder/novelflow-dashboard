/**
 * OIDC Token Auto-Refresh Module
 * Uses password grant to get fresh tokens when NOVELSPA_TOKEN is missing or expired.
 * Credentials from OIDC_USERNAME / OIDC_PASSWORD env vars.
 */
const OIDC_TOKEN_URL = 'https://sts.anystories.app/connect/token';
const OIDC_CLIENT_ID = 'AuthClient';

// Cache token in memory for the lifetime of the serverless instance
let cachedToken = null;
let cachedTokenExp = 0;

async function getFreshToken() {
  const username = process.env.OIDC_USERNAME;
  const password = process.env.OIDC_PASSWORD;

  if (!username || !password) {
    console.error('OIDC_USERNAME or OIDC_PASSWORD not set in env vars');
    return null;
  }

  try {
    const resp = await fetch(OIDC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: OIDC_CLIENT_ID,
        username,
        password,
        scope: 'openid profile roles email offline_access'
      })
    });

    if (!resp.ok) {
      console.error('OIDC token refresh failed:', resp.status);
      return null;
    }

    const data = await resp.json();
    cachedToken = data.access_token;
    // Set expiry to 5 minutes before actual expiry for safety
    cachedTokenExp = Date.now() + (data.expires_in - 300) * 1000;
    console.log('OIDC token refreshed, expires in', Math.floor(data.expires_in / 3600), 'hours');
    return cachedToken;
  } catch (e) {
    console.error('OIDC token refresh error:', e.message);
    return null;
  }
}

/**
 * Get a valid bookstore token. Tries in order:
 * 1. Cached token (still valid)
 * 2. NOVELSPA_TOKEN env var
 * 3. Fresh token via OIDC password grant
 */
async function getBookstoreToken() {
  // Check cached token first
  if (cachedToken && Date.now() < cachedTokenExp) {
    return cachedToken;
  }

  // Check env var
  const envToken = process.env.NOVELSPA_TOKEN;
  if (envToken) {
    // Decode to check expiration
    try {
      const parts = envToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        if (payload.exp && payload.exp * 1000 > Date.now() + 300000) {
          // Token still valid for 5+ minutes, cache it
          cachedToken = envToken;
          cachedTokenExp = payload.exp * 1000 - 300000;
          return envToken;
        }
      }
    } catch (e) {
      // Can't decode, try using it anyway
      return envToken;
    }
  }

  // Try to get fresh token via OIDC
  const freshToken = await getFreshToken();
  if (freshToken) return freshToken;

  // Last resort: return env token even if expired (might still work)
  return envToken || null;
}

module.exports = { getBookstoreToken, getFreshToken };
