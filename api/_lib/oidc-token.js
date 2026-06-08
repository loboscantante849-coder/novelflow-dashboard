/**
 * OIDC Token Auto-Refresh Module
 * Uses password grant to get fresh tokens.
 * Credentials source priority: KV store > env vars
 */
const OIDC_TOKEN_URL = 'https://sts.anystories.app/connect/token';
const OIDC_CLIENT_ID = 'AuthClient';

let cachedToken = null;
let cachedTokenExp = 0;
let cachedCreds = null; // Cache credentials from KV

async function getCredentials() {
  // Check cache first
  if (cachedCreds) return cachedCreds;
  
  // Check env vars
  const envUsername = process.env.OIDC_USERNAME;
  const envPassword = process.env.OIDC_PASSWORD;
  if (envUsername && envPassword) {
    cachedCreds = { username: envUsername, password: envPassword };
    return cachedCreds;
  }
  
  // Try KV store
  try {
    const { Redis } = require('@upstash/redis');
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const [username, password] = await Promise.all([
        redis.get('oidc:username'),
        redis.get('oidc:password')
      ]);
      if (username && password) {
        cachedCreds = { username, password };
        return cachedCreds;
      }
    }
  } catch (e) {
    console.error('KV credential read error:', e.message);
  }
  
  return null;
}

async function getFreshToken() {
  const creds = await getCredentials();
  if (!creds) {
    console.error('No OIDC credentials available (env vars or KV)');
    return null;
  }

  try {
    const resp = await fetch(OIDC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: OIDC_CLIENT_ID,
        username: creds.username,
        password: creds.password,
        scope: 'openid profile roles email offline_access'
      })
    });

    if (!resp.ok) {
      console.error('OIDC token refresh failed:', resp.status);
      return null;
    }

    const data = await resp.json();
    cachedToken = data.access_token;
    cachedTokenExp = Date.now() + (data.expires_in - 300) * 1000;
    console.log('OIDC token refreshed, expires in', Math.floor(data.expires_in / 3600), 'hours');
    return cachedToken;
  } catch (e) {
    console.error('OIDC token refresh error:', e.message);
    return null;
  }
}

async function getBookstoreToken() {
  if (cachedToken && Date.now() < cachedTokenExp) {
    return cachedToken;
  }

  const envToken = process.env.NOVELSPA_TOKEN;
  if (envToken) {
    try {
      const parts = envToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        if (payload.exp && payload.exp * 1000 > Date.now() + 300000) {
          cachedToken = envToken;
          cachedTokenExp = payload.exp * 1000 - 300000;
          return envToken;
        }
      }
    } catch (e) {
      // Can't decode, try using it anyway
    }
  }

  const freshToken = await getFreshToken();
  if (freshToken) return freshToken;

  return envToken || null;
}

module.exports = { getBookstoreToken, getFreshToken, getCredentials };
