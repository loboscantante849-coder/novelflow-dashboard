'use strict';

const { getAcBaseUrl, getAcHeaders, getAcPagedListUrl, getResponseAccessToken, normalizeAcToken, readAcToken, rotateAcToken } = require('./ac-config');
const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function parseThreadId(value) {
  const text = String(value ?? '').trim();
  return THREAD_ID_RE.test(text) ? text : null;
}

function getAcProxyStatus(status) { return Number(status) === 401 ? 502 : Number(status); }

function headersObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return typeof headers === 'object' ? { ...headers } : {};
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 8000));
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchAcWithTokenFallback(redis, token, url, options = {}, timeoutMs = 8000) {
  const primary = normalizeAcToken(token);
  if (!primary) throw new Error('AC token is required');
  const fallback = normalizeAcToken(process.env.AC_TOKEN) || normalizeAcToken(process.env.NOVELFLOW_AC_TOKEN);
  const request = (candidate) => fetchWithTimeout(url, {
    ...options,
    headers: getAcHeaders(candidate, headersObject(options.headers))
  }, timeoutMs);
  const response = await request(primary);
  if (response.status !== 401 || !fallback || fallback === primary) return response;
  const retry = await request(fallback);
  if (retry.status !== 401 && redis) await redis.set('ac_token', fallback).catch(() => {});
  return retry;
}

module.exports = { fetchAcWithTokenFallback, fetchWithTimeout, getAcBaseUrl, getAcHeaders, getAcPagedListUrl, getAcProxyStatus, getResponseAccessToken, normalizeAcToken, parseThreadId, readAcToken, rotateAcToken };
