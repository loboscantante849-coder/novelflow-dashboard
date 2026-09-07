const https = require('https');

const DEFAULT_BASE = 'https://api.socialecho.net';

function pointsGuard() {
  try {
    const redis = require('./store').getRedis();
    const budget = require('./ac-budget');
    return redis && budget?.reserve ? { redis, budget } : null;
  } catch {
    return null;
  }
}

async function reserveSocialEchoRead(metadata = {}) {
  const guard = pointsGuard();
  if (!guard) return null;
  const reservation = await guard.budget.reserve(guard.redis, 'socialecho_read', {
    metadata: { source: 'socialecho.article.read', ...metadata }
  });
  if (!reservation.granted) throw guard.budget.budgetError(reservation, 'socialecho_read', reservation.cost);
  return { ...guard, reservation };
}

async function finishSocialEchoRead(entry, result, error) {
  if (!entry) return;
  await entry.budget.outcome(entry.redis, entry.reservation, {
    status: error ? 'provider_or_transport_error' : 'read_completed',
    providerCode: error?.code ? String(error.code) : '',
    externalId: result?.requestId || ''
  }).catch(() => {});
}

class SocialEchoError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SocialEchoError';
    this.status = Number(options.status || 502);
    this.code = Number(options.code || 0);
    this.requestId = String(options.requestId || '');
    this.data = options.data || null;
    this.ambiguous = options.ambiguous === true;
  }
}

function apiKey() {
  const value = String(process.env.SOCIALECHO_API_KEY || '').replace(/^Bearer\s+/i, '').trim();
  if (!value) throw new SocialEchoError('SocialEcho API is not configured', { status: 503 });
  return value;
}

function baseUrl() {
  const value = String(process.env.SOCIALECHO_API_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new SocialEchoError('SocialEcho API base URL must use HTTPS', { status: 503 });
  return parsed;
}

function ambiguousFailure(status, payload, requested) {
  if (!requested) return false;
  const value = Number(status || 0);
  if (value === 422 && String(payload?.error?.type || '') === 'invalid_request') return false;
  return [422, 500].includes(value) || value >= 502;
}

function requestJson(method, path, payload = {}, { timeoutMs = 30000, ambiguous = false, requestId = '' } = {}) {
  const base = baseUrl();
  const body = method === 'GET' ? '' : JSON.stringify(payload || {});
  const queryParameters = new URLSearchParams();
  if (method === 'GET') {
    for (const [key, value] of Object.entries(payload || {})) {
      if (Array.isArray(value)) value.forEach((item) => queryParameters.append(`${key}[]`, String(item)));
      else queryParameters.set(key, String(value));
    }
  }
  const query = queryParameters.toString();
  const id = requestId || cryptoRandomId();
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || 443,
      path: `${base.pathname.replace(/\/$/, '')}${path}${query ? `?${query}` : ''}`,
      method,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        'X-Lang': 'zh_CN',
        'X-Request-Id': id,
        'User-Agent': 'NovelFlow-Social-Console/1.0'
      }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) chunks.push(chunk);
        else req.destroy(new SocialEchoError('SocialEcho response exceeded the safety limit', { status: 502, requestId: id, ambiguous }));
      });
      response.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { return reject(new SocialEchoError('SocialEcho returned an invalid response', { status: response.statusCode, requestId: response.headers['x-request-id'] || id, ambiguous })); }
        const responseId = String(parsed.request_id || response.headers['x-request-id'] || id);
        if (response.statusCode < 200 || response.statusCode >= 300 || Number(parsed.code || 0) !== 0) {
          const detail = String(parsed.message || parsed.error?.reason || 'SocialEcho request failed').slice(0, 300);
          return reject(new SocialEchoError(detail, {
            status: response.statusCode,
            code: parsed.code,
            requestId: responseId,
            data: parsed.data,
            ambiguous: ambiguousFailure(response.statusCode, parsed, ambiguous)
          }));
        }
        return resolve({ data: parsed.data, meta: parsed.meta || null, requestId: responseId });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new SocialEchoError('SocialEcho request timed out', { status: 504, requestId: id, ambiguous })));
    req.on('error', (error) => reject(error instanceof SocialEchoError ? error : new SocialEchoError('SocialEcho request did not return a definitive result', { status: 502, requestId: id, ambiguous })));
    req.end(body || undefined);
  });
}

function cryptoRandomId() {
  return require('crypto').randomUUID();
}

function platformForAccount(account) {
  const app = String(account?.app?.title || account?.app?.name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (app.includes('instagram')) return 'instagram';
  if (app.includes('facebook')) return 'facebook';
  if (app.includes('youtube')) return 'youtube';
  if (app.includes('linkedin')) return 'linkedin';
  if (app.includes('tiktokshop')) return 'tiktokshop';
  if (app.includes('tiktok')) return 'tiktok';
  if (app === 'x' || app.includes('twitter')) return 'x';
  if (app.includes('pinterest')) return 'pinterest';
  if (app.includes('reddit')) return 'reddit';
  if (app.includes('telegram')) return 'telegram';
  return app;
}

function publishTypeFor(platform) {
  return ({ facebook: 'reels', instagram: 'reels', youtube: 'shorts', tiktok: 'video', linkedin: 'post', x: 'short_post', pinterest: 'post', reddit: 'media' })[platform] || '';
}

function publicAccount(account) {
  const platform = platformForAccount(account);
  return {
    id: Number(account?.id),
    title: String(account?.title || account?.account || '').slice(0, 300),
    account: String(account?.account || '').slice(0, 300),
    platform,
    platformTitle: String(account?.app?.title || '').slice(0, 100),
    status: Number(account?.status?.value ?? account?.status ?? 0),
    publishType: publishTypeFor(platform),
    supported: ['facebook', 'instagram', 'tiktok'].includes(platform)
  };
}

async function listAccounts() {
  const accounts = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await requestJson('GET', '/v1/account', { page, type: 1 });
    const items = Array.isArray(result.data) ? result.data : [];
    accounts.push(...items.map(publicAccount).filter((item) => Number.isSafeInteger(item.id) && item.id > 0));
    const lastPage = Number(result.meta?.last_page || result.meta?.lastPage || page);
    if (!items.length || page >= lastPage) break;
  }
  return accounts;
}

async function getAccount(accountId) {
  const accounts = await listAccounts();
  return accounts.find((account) => account.id === Number(accountId)) || null;
}

async function createUpload(contentType, title, requestId = '') {
  const result = await requestJson('GET', '/v1/upload/url', { content_type: contentType, title: String(title || 'novelflow-video.mp4').slice(0, 255) }, { requestId });
  const data = result.data || {};
  const uploadUrl = String(data.upload_url || data.uploadUrl || '');
  const publicUrl = String(data.public_url || data.publicUrl || data.url || '');
  if (!uploadUrl || !publicUrl) throw new SocialEchoError('SocialEcho upload response omitted a required URL', { status: 502, requestId: result.requestId });
  return {
    uploadUrl,
    publicUrl,
    fileId: String(data.id || data.file_id || data.file?.id || ''),
    requestId: result.requestId
  };
}

function assertSafeRemoteUrl(value, label) {
  const parsed = new URL(String(value || ''));
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new SocialEchoError(`${label} URL is not allowed`, { status: 400 });
  }
  return parsed.toString();
}

async function inspectVideo(sourceUrl) {
  const url = assertSafeRemoteUrl(sourceUrl, 'Video');
  const path = new URL(url).pathname.toLowerCase();
  const contentType = path.endsWith('.mov') ? 'video/quicktime' : path.endsWith('.webm') ? 'video/webm' : 'video/mp4';
  return { url, contentType, length: 0 };
}

async function putVideo(uploadUrl, source) {
  const target = assertSafeRemoteUrl(uploadUrl, 'Upload');
  const response = await fetch(source.url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw new SocialEchoError(`Unable to download the generated video (HTTP ${response.status})`, { status: 502 });
  const uploaded = await fetch(target, {
    method: 'PUT',
    headers: { 'Content-Type': source.contentType, ...(source.length ? { 'Content-Length': String(source.length) } : {}) },
    body: response.body,
    duplex: 'half',
    redirect: 'follow',
    signal: AbortSignal.timeout(5 * 60 * 1000)
  });
  if (!uploaded.ok) throw new SocialEchoError(`Video upload failed with HTTP ${uploaded.status}`, { status: 502 });
}

async function verifyUploadedVideo(publicUrl) {
  const url = assertSafeRemoteUrl(publicUrl, 'Uploaded video');
  // Explicit reconciliation is read-only. Do not follow redirects here: the
  // public URL is provider-controlled and a redirect must not turn this into
  // a server-side request to an unrelated host.
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });
  return response.ok;
}

async function publishArticle(payload, requestId) {
  const result = await requestJson('POST', '/v1/publish/article', payload, { timeoutMs: 60000, ambiguous: true, requestId });
  const externalDraftId = String(result.data?.id ?? '').trim();
  // A 2xx envelope alone does not prove that SocialEcho created a draft or a
  // schedule. Treat a missing provider ID as ambiguous and reconcile it from
  // the article list rather than ever claiming P7 completion.
  if (!externalDraftId) {
    throw new SocialEchoError('SocialEcho publish response omitted data.id; outcome requires reconciliation', {
      status: 502,
      requestId: result.requestId,
      data: result.data,
      ambiguous: true
    });
  }
  return { ...result, data: { ...result.data, id: externalDraftId } };
}

async function listArticles(accountId, options = {}) {
  const requested = typeof options === 'number' ? { page: options, pages: 1 } : (options || {});
  const startPage = Math.max(1, Math.min(Number(requested.page) || 1, 100));
  const maxPages = Math.max(1, Math.min(Number(requested.pages) || 5, 20));
  const articles = [];
  const requestIds = [];
  for (let page = startPage; page < startPage + maxPages; page += 1) {
    const guard = await reserveSocialEchoRead({ accountId: Number(accountId), page });
    try {
      const result = await requestJson('GET', '/v1/article', { page, account_ids: [Number(accountId)] });
      const items = Array.isArray(result.data) ? result.data : [];
      articles.push(...items);
      requestIds.push(result.requestId);
      await finishSocialEchoRead(guard, result, null);
      const lastPage = Number(result.meta?.last_page || result.meta?.lastPage || page);
      if (!items.length || page >= lastPage) break;
    } catch (error) {
      await finishSocialEchoRead(guard, null, error);
      throw error;
    }
  }
  const unique = new Map();
  for (const article of articles) {
    const key = String(article?.id || article?.uuid || '');
    if (key && !unique.has(key)) unique.set(key, article);
  }
  return { articles: [...unique.values()], requestId: requestIds.at(-1) || '', requestIds };
}

module.exports = {
  SocialEchoError, requestJson, listAccounts, getAccount, platformForAccount, publishTypeFor,
  createUpload, inspectVideo, putVideo, verifyUploadedVideo, publishArticle, listArticles, publicAccount, ambiguousFailure
};
