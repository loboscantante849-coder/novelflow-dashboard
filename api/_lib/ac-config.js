'use strict';

/**
 * Shared Auto Creative (天机) connection configuration.
 *
 * The public page is served from /generate/video, while the API is rooted at
 * /api/v1.  Keep that distinction in one place so every server endpoint uses
 * the same upstream and project headers.
 */

const DEFAULT_AC_API_BASE_URL = 'https://ac.anynovel.app/api/v1';
const DEFAULT_AC_PROJECT_ID = '1006';
const AC_CLIENT = 'beidou-web';
const RETIRED_AC_HOSTS = new Set(['ac.beidou.win']);
const MAX_BASE_URL_LENGTH = 512;
const MAX_PROJECT_ID_LENGTH = 128;

function stripOuterQuotes(value) {
  let normalized = String(value).trim();
  for (let i = 0; i < 2; i += 1) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if (normalized.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
      normalized = normalized.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return normalized;
}

function isPrivateIpLiteral(hostname) {
  // URL.hostname includes brackets for IPv6 in some runtimes; strip them
  // before testing.  Hostnames are otherwise left to normal DNS resolution.
  const host = String(hostname || '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  // IPv6 loopback, unspecified, link-local, and unique-local ranges.
  return host === '::' || host === '::1' || host.startsWith('::ffff:') ||
    host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') ||
    host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
}

/**
 * Validate and canonicalize an AC API base URL.
 *
 * Only HTTPS origins without credentials, ports, query strings, fragments, or
 * private IP literals are accepted.  The path is constrained to /api/v1 (with
 * an optional trailing slash), preventing an environment typo from changing
 * the endpoint namespace unexpectedly.
 */
function normalizeAcBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = stripOuterQuotes(value);
  if (!raw || raw.length > MAX_BASE_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!hostname || RETIRED_AC_HOSTS.has(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || isPrivateIpLiteral(hostname)) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== '/api/v1') return null;
  return `https://${hostname}/api/v1`;
}

function getAcBaseUrl() {
  // AC_API_BASE_URL is the new name.  AC_BASE_URL remains accepted for
  // deployments that already provisioned the old variable.
  const candidates = [process.env.AC_API_BASE_URL, process.env.AC_BASE_URL];
  for (const candidate of candidates) {
    const normalized = normalizeAcBaseUrl(candidate);
    if (normalized) return normalized;
  }
  return DEFAULT_AC_API_BASE_URL;
}

function normalizeAcProjectId(value) {
  if (value === undefined || value === null) return null;
  const normalized = stripOuterQuotes(value);
  if (!normalized || normalized.length > MAX_PROJECT_ID_LENGTH || /[\u0000-\u001F\u007F]/.test(normalized)) return null;
  // Tianji project IDs are numeric today, but accepting a bounded opaque ID
  // keeps this helper compatible with future project identifier formats.
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) return null;
  return normalized;
}

function getAcProjectId() {
  return normalizeAcProjectId(process.env.AC_PROJECT_ID) || DEFAULT_AC_PROJECT_ID;
}

function normalizeAcToken(value) {
  if (typeof value !== 'string') return null;
  // Redis/env values are occasionally stored as JSON/string-literal values.
  // Remove only matching outer quote pairs, never punctuation inside a JWT.
  let normalized = stripOuterQuotes(value);
  if (!normalized) return null;
  // Accept either a raw token or a value copied from an Authorization header.
  // Canonicalize the latter so callers never emit `Bearer Bearer …`.
  normalized = normalized.replace(/^Bearer\s+/i, '').trim();
  normalized = stripOuterQuotes(normalized);
  if (!normalized || /[\u0000-\u001F\u007F]/.test(normalized)) return null;
  return normalized;
}

function getAcHeaders(token, extraHeaders = {}) {
  const normalizedToken = normalizeAcToken(token);
  if (!normalizedToken) throw new Error('AC token is required');
  const safeExtras = {};
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [name, value] of Object.entries(extraHeaders)) {
      const lowerName = String(name).toLowerCase();
      if (lowerName === 'authorization' || lowerName === 'x-client' || lowerName === 'x-project-id') continue;
      safeExtras[name] = value;
    }
  }
  return {
    ...safeExtras,
    Authorization: `Bearer ${normalizedToken}`,
    'x-client': AC_CLIENT,
    'X-Project-Id': getAcProjectId(),
  };
}

function getAcPagedListUrl(pageSize, pageIndex, type = 'video') {
  const params = new URLSearchParams({
    PageSize: String(pageSize),
    PageIndex: String(pageIndex),
  });
  if (type) params.set('type', String(type));
  return `${getAcBaseUrl()}/creative/paged-list?${params.toString()}`;
}

async function readAcToken(redis) {
  let token = null;
  if (redis) token = normalizeAcToken(await redis.get('ac_token'));
  if (!token) token = normalizeAcToken(process.env.AC_TOKEN);
  return token;
}

function getResponseAccessToken(response) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return null;
  return normalizeAcToken(response.headers.get('accesstoken'));
}

/** Persist a rotated upstream token, returning the normalized value. */
async function rotateAcToken(redis, responseOrToken) {
  const nextToken = typeof responseOrToken === 'string'
    ? normalizeAcToken(responseOrToken)
    : getResponseAccessToken(responseOrToken);
  if (nextToken && redis) await redis.set('ac_token', nextToken);
  return nextToken;
}

module.exports = {
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
};
