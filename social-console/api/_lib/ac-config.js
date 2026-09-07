'use strict';

const DEFAULT_AC_API_BASE_URL = 'https://ac.anynovel.app/api/v1';
const DEFAULT_AC_PROJECT_ID = '1006';
const AC_CLIENT = 'beidou-web';
const RETIRED_HOSTS = new Set(['ac.beidou.win']);

function stripQuotes(value) {
  let out = String(value ?? '').trim();
  for (let i = 0; i < 2 && out.length >= 2; i += 1) {
    const a = out[0], b = out[out.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) out = out.slice(1, -1).trim();
    else break;
  }
  return out;
}

function normalizeAcToken(value) {
  const out = stripQuotes(value).replace(/^Bearer\s+/i, '').trim();
  return out && !/[\u0000-\u001f\u007f]/.test(out) ? out : null;
}

function normalizeAcBaseUrl(value) {
  const raw = stripQuotes(value);
  if (!raw || raw.length > 512) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  const path = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || !host || RETIRED_HOSTS.has(host) || url.username || url.password || url.port || url.search || url.hash || path !== '/api/v1') return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return null;
  return `https://${host}/api/v1`;
}

function getAcBaseUrl() {
  return normalizeAcBaseUrl(process.env.AC_API_BASE_URL)
    || normalizeAcBaseUrl(process.env.AC_BASE_URL)
    || DEFAULT_AC_API_BASE_URL;
}

function getAcProjectId() {
  const value = stripQuotes(process.env.AC_PROJECT_ID || DEFAULT_AC_PROJECT_ID);
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : DEFAULT_AC_PROJECT_ID;
}

function getAcHeaders(token, extra = {}) {
  const normalized = normalizeAcToken(token);
  if (!normalized) throw new Error('AC token is required');
  const headers = {};
  for (const [key, value] of Object.entries(extra || {})) {
    const lower = String(key).toLowerCase();
    if (!['authorization', 'x-client', 'x-project-id'].includes(lower)) headers[key] = value;
  }
  return { Accept: 'application/json', ...headers, Authorization: `Bearer ${normalized}`, 'x-client': AC_CLIENT, 'X-Project-Id': getAcProjectId() };
}

function getAcPagedListUrl(pageSize, pageIndex, type = 'video') {
  const params = new URLSearchParams({ PageSize: String(pageSize), PageIndex: String(pageIndex) });
  if (type) params.set('type', type);
  return `${getAcBaseUrl()}/creative/paged-list?${params}`;
}

function getResponseAccessToken(response) {
  if (!response?.headers?.get) return null;
  return normalizeAcToken(response.headers.get('accesstoken'));
}

async function readAcToken(redis) {
  let token = null;
  if (redis) {
    try { token = normalizeAcToken(await redis.get('ac_token')); } catch { token = null; }
  }
  return token || normalizeAcToken(process.env.AC_TOKEN) || normalizeAcToken(process.env.NOVELFLOW_AC_TOKEN);
}

async function rotateAcToken(redis, responseOrToken) {
  const token = normalizeAcToken(typeof responseOrToken === 'string' ? responseOrToken : responseOrToken?.headers?.get?.('accesstoken'));
  if (token && redis) await redis.set('ac_token', token);
  return token;
}

module.exports = { AC_CLIENT, DEFAULT_AC_API_BASE_URL, DEFAULT_AC_PROJECT_ID, getAcBaseUrl, getAcHeaders, getAcPagedListUrl, getAcProjectId, getResponseAccessToken, normalizeAcBaseUrl, normalizeAcToken, readAcToken, rotateAcToken };
