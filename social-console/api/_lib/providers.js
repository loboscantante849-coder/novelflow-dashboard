const crypto = require('crypto');
const https = require('https');

function cleanTitle(value) {
  return String(value || '').replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, '&').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim();
}

function titleKey(value) { return cleanTitle(value).normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase(); }

function creativeLanguage(book = {}) {
  const value = `${book.title || ''} ${book.description || ''} ${(book.tags || []).join(' ')}`.toLowerCase();
  if (/[ñ¿¡]|\b(el|la|esposa|heredero|olvidado|alfa|contraataca|regreso)\b/.test(value)) return 'es';
  if (/[ãõáéíóúç]|\b(sem|segunda|chance|despreocupada|próspera|amor|lobisomem)\b/.test(value)) return 'pt';
  return 'en';
}

const APPLICATION_ID = process.env.NOVELFLOW_APPLICATION_ID || '642fc1ace309494378a774a6';
const ADMIN_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
const BOOK_API = `${ADMIN_BASE}/book/booklist`;
const CHAPTER_LIST_API = `${ADMIN_BASE}/book/bookchapterlist`;
const CHAPTER_CONTENT_API = `${ADMIN_BASE}/book/bookchaptercontentdetail`;
const KEYWORD_API = `${ADMIN_BASE}/book/bookpromotionkeywords`;
const KEYWORD_SAVE_API = `${ADMIN_BASE}/book/savebookpromotionkeywords`;
const LINK_API = `${ADMIN_BASE}/SocialMediaLinkConfig`;
const {
  fetchAcWithTokenFallback,
  getAcBaseUrl,
  getAcHeaders,
  getAcPagedListUrl,
  getAcProxyStatus,
  normalizeAcToken,
  readAcToken,
  rotateAcToken
} = require('./ac-request');
const AC_BASE = getAcBaseUrl();
// Writer Admin moved the performance ranking surface to v2. The v1 endpoint
// now returns a generic 500 for otherwise valid product-line requests.
const CONTENT_DASHBOARD_API = 'https://admin.novelsnack.com/api/v1/authorstationmanage/contentmiddleground/report/v2/list';

class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.ambiguous = Boolean(options.ambiguous);
    this.status = options.status || 502;
    this.code = String(options.code || '');
  }
}

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function applicationIdFor(options = {}) {
  return String(options?.applicationId || APPLICATION_ID).trim();
}

function secretToken(name) {
  let value = env(name);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
  }
  return String(value || '').replace(/^Bearer\s+/i, '').trim();
}

const TOKENDANCE_MODELS = new Set([
  'glm-5.3-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-0731', 'ling-3.0-flash', 'seed-2.1-turbo', 'seed-2.0-mini', 'qwen3.7-max', 'minimax-m2.7', 'hy3', 'kimi-k2.7-code',
  // Existing runs may still reference the prior presets.
  'qwen3.5-flash', 'glm-4.5-air', 'kimi-k2.5', 'minimax-m2.5',
  // Preserve routing for runs created with the previous presets.
  'qwen3.7-max', 'glm-5.2', 'kimi-k3', 'minimax-m3'
]);
const TOKENDANCE_BASE_URL = 'https://tokendance.space/gateway/v1';
const TOKENDANCE_GLM_MODEL = env('NOVELFLOW_LLM_MODEL_GLM_5_3_FLASH', 'glm-5.3-flash');
const TOKENDANCE_DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const TOKENDANCE_DEEPSEEK_MODEL_ALIASES = new Map([
  // "Preview" was the console's historical display name. It is not a
  // TokenDance provider model ID, so never put it on the upstream wire.
  ['deepseek-v4-flash-preview', TOKENDANCE_DEEPSEEK_DEFAULT_MODEL]
]);

function normalizeTokenDanceDeepSeekModel(value) {
  const requested = String(value || '').trim().toLowerCase();
  if (!requested) return TOKENDANCE_DEEPSEEK_DEFAULT_MODEL;
  return TOKENDANCE_DEEPSEEK_MODEL_ALIASES.get(requested) || requested;
}

function tokenDanceDeepSeekModel() {
  // Keep the established environment key so existing deployments continue to
  // work, but make an explicit legacy Preview value safe as well.
  return normalizeTokenDanceDeepSeekModel(env('NOVELFLOW_LLM_MODEL_DEEPSEEK_V4_FLASH_PREVIEW', TOKENDANCE_DEEPSEEK_DEFAULT_MODEL));
}

const TOKENDANCE_LING_MODEL = 'ling-3.0-flash';
const LONG_RUNNING_MODELS = new Set(['glm-5.3-flash', 'deepseek-v4-flash-preview', 'deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek', 'ling-3.0-flash', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'kimi-k2.7-code']);
function isLongRunningModel(choice) { return LONG_RUNNING_MODELS.has(String(choice || '').toLowerCase()); }
function modelTemperature(model, preferred) {
  return /kimi[-_]?k2\.7[-_]?code/i.test(String(model || '')) ? 1 : preferred;
}
function operationsTimeoutForModel(modelChoice) {
  return ({
    // HY3 is intentionally the fast route. Every user-selected quality model
    // gets a real server-side completion window before any reserve is used.
    hy3: 30000,
    // GLM 5.3 Flash routinely needs more than two minutes for the full
    // evidence-bound campaign schema. Keep the serverless request alive long
    // enough to receive that result instead of manufacturing timeout retries.
    'glm-5.3-flash': 300000,
    'deepseek-v4-flash-preview': 150000,
    'deepseek-v4-flash': 150000,
    'deepseek-v4-flash-0731': 150000,
    'seed-2.1-turbo': 120000,
    deepseek: 150000,
    'ling-3.0-flash': 90000,
    'qwen3.7-max': 150000,
    'minimax-m2.7': 150000,
    'kimi-k2.7-code': 150000
  })[String(modelChoice || '').toLowerCase()] || 90000;
}

function creativeWireUsesResponses(modelChoice, config = {}) {
  // Respect the verified provider capability. The caller keeps this helper
  // explicit so a wire decision is unit-tested instead of being inferred from
  // the base URL at each creative section.
  return config.responsesApi === true;
}

function modelEnvelopeDiagnostic(body, extracted = '') {
  const output = Array.isArray(body?.output) ? body.output : [];
  const contentTypes = output.flatMap((item) => Array.isArray(item?.content)
    ? item.content.map((content) => String(content?.type || '')).filter(Boolean)
    : []);
  return [
    `status=${String(body?.status || '') || 'unknown'}`,
    `incomplete=${String(body?.incomplete_details?.reason || '') || 'none'}`,
    `envelope=${structuredShape(body)}`,
    `outputTypes=${output.map((item) => String(item?.type || '')).filter(Boolean).slice(0, 6).join('|') || 'none'}`,
    `contentTypes=${contentTypes.slice(0, 8).join('|') || 'none'}`,
    `extractedLength=${String(extracted || '').length}`
  ].join(', ');
}

// A task may have one clearly declared reserve, never an invisible model carousel.
function reserveModelFor(modelChoice) {
  const choice = String(modelChoice || '').toLowerCase();
  // GLM occasionally returns a prose envelope instead of the required
  // structured creative object. Use the configured TokenDance DeepSeek
  // preview as the single reserve so a failed parse can make progress without
  // cycling back into the same malformed response.
  if (choice === 'glm-5.3-flash') return 'deepseek-v4-flash-preview';
  if (choice === 'deepseek-v4-flash-preview') return 'hy3';
  if (String(modelChoice || '').toLowerCase() !== 'hy3') return 'hy3';
  if (!secretToken('NOVELFLOW_COPY_LLM_API_KEY') && secretToken('NOVELFLOW_TOKENDANCE_API_KEY')) return 'seed-2.1-turbo';
  return 'deepseek';
}

function copyModelConfig(profile = {}) {
  const choice = String(profile.modelChoice || 'hy3').trim().toLowerCase();
  if (choice === 'glm-5.3-flash') {
    const apiKey = secretToken('NOVELFLOW_TOKENDANCE_API_KEY');
    if (!apiKey) throw new ProviderError('TokenDance model is not configured', { status: 503 });
    return { apiKey, baseUrl: TOKENDANCE_BASE_URL, model: TOKENDANCE_GLM_MODEL, responsesApi: false };
  }
  if (choice === 'deepseek' || choice === 'deepseek-v4-flash-preview' || choice === 'ling-3.0-flash') {
    const apiKey = secretToken('NOVELFLOW_TOKENDANCE_API_KEY');
    if (!apiKey) throw new ProviderError('TokenDance model is not configured', { status: 503 });
    return { apiKey, baseUrl: TOKENDANCE_BASE_URL, model: choice === 'ling-3.0-flash' ? TOKENDANCE_LING_MODEL : tokenDanceDeepSeekModel(), responsesApi: false };
  }
  if (TOKENDANCE_MODELS.has(choice)) {
    const apiKey = secretToken('NOVELFLOW_TOKENDANCE_API_KEY');
    if (!apiKey) throw new ProviderError('The selected TokenDance premium model is not configured', { status: 503 });
    return { apiKey, baseUrl: TOKENDANCE_BASE_URL, model: choice, responsesApi: false };
  }
  const apiKey = secretToken('NOVELFLOW_COPY_LLM_API_KEY') || secretToken('NOVELFLOW_LLM_API_KEY');
  if (!apiKey) throw new ProviderError('DeepSeek copy model is not configured', { status: 503 });
  const baseUrl = env('NOVELFLOW_COPY_LLM_BASE_URL', 'https://api.deepseek.com').replace(/\/$/, '');
  const model = env('NOVELFLOW_COPY_LLM_MODEL', 'deepseek-chat');
  const configuredWire = env('NOVELFLOW_COPY_LLM_WIRE_API').toLowerCase();
  const responsesApi = configuredWire === 'responses' || (!configuredWire && /\/\/(?:[^/]*\.)?max\.jojocode\.com(?:[:/]|$)/i.test(baseUrl));
  return { apiKey, baseUrl, model, responsesApi };
}

function absoluteUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `https://${text.replace(/^\/+/, '')}`;
}

function coverUrl(value) {
  const url = absoluteUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'oss.novelago.app' && !parsed.searchParams.has('x-oss-process')) {
      return `${url}${parsed.search ? '&' : '?'}x-oss-process=image/resize,w_320/quality,q_78/format,webp`;
    }
  } catch {}
  return url;
}

function pageItems(body) {
  let value = body?.data ?? body;
  if (value?.data && typeof value.data === 'object' && !Array.isArray(value.data)) value = value.data;
  const items = value?.items || value?.list || value?.records || value?.dataSource || (Array.isArray(value?.data) ? value.data : []);
  const numericMeta = (candidate) => Number.isFinite(Number(candidate)) && Number(candidate) > 0;
  const hasTotal = numericMeta(value?.total) || numericMeta(value?.totalCount);
  const hasPages = numericMeta(value?.pages) || numericMeta(value?.pageCount) || numericMeta(value?.totalPages);
  const total = Number(value?.total || value?.totalCount || items?.length || 0);
  const pages = Number(value?.pages || value?.pageCount || value?.totalPages || 1);
  return { items: Array.isArray(items) ? items : [], total, pages, hasTotal, hasPages };
}

async function request(url, options = {}, label = 'Provider request', timeoutMs = 30000) {
  const controller = new AbortController();
  const { ambiguousOnInvalidJson = false, ...fetchOptions } = options;
  let timer;
  let response;
  try {
    const pending = fetch(url, { ...fetchOptions, signal: controller.signal });
    // Some serverless fetch implementations do not reject promptly after an
    // AbortController signal. Race it so a provider stall can never consume
    // the whole worker and leave a persisted stage stranded as "running".
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`, { status: 504, code: 'provider_timeout', ambiguous: fetchOptions.method && fetchOptions.method !== 'GET' && fetchOptions.method !== 'HEAD' }));
      }, timeoutMs);
    });
    response = await Promise.race([pending, timeout]);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const ambiguous = fetchOptions.method && fetchOptions.method !== 'GET' && fetchOptions.method !== 'HEAD';
    throw new ProviderError(`${label} did not return a definitive response`, { status: 502, code: 'provider_transport', ambiguous });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { throw new ProviderError(`${label} returned invalid JSON`, { status: 502, code: 'provider_invalid_json', ambiguous: Boolean(ambiguousOnInvalidJson) }); }
  }
  const protocolFailure = response.ok && ![undefined, null, 0, 200].includes(body?.code);
  if (!response.ok || protocolFailure) {
    const detail = String(body?.msg || body?.message || body?.error || '').slice(0, 240);
    throw new ProviderError(`${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`, {
      status: protocolFailure ? 502 : response.status,
      code: protocolFailure ? 'provider_protocol' : 'provider_http'
    });
  }
  return { response, body };
}

let refreshedToken = '';
let tokenRefreshPromise = null;
async function oidcToken(forceRefresh = false) {
  if (tokenRefreshPromise) return tokenRefreshPromise;
  if (!forceRefresh && refreshedToken) return refreshedToken;
  const configured = secretToken('NOVELFLOW_OIDC_TOKEN');
  if (!forceRefresh && configured) return configured;
  tokenRefreshPromise = (async () => {
    const username = env('NOVELFLOW_OIDC_USERNAME');
    const password = env('NOVELFLOW_OIDC_PASSWORD');
    if (!username || !password) {
      if (configured) return configured;
      throw new ProviderError('NovelFlow OIDC authentication is not configured', { status: 503 });
    }
    const form = new URLSearchParams({
      // Match the Writer Admin password-grant contract exactly. This endpoint
      // issues the necessary access token without an explicit scope parameter;
      // requesting offline_access here can be rejected as invalid_grant.
      grant_type: 'password', client_id: 'AuthClient', username, password
    });
    const { body } = await request('https://sts.anystories.app/connect/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, body: form
    }, 'OIDC authentication', 25000);
    refreshedToken = String(body.access_token || '').trim();
    if (!refreshedToken) throw new ProviderError('OIDC response contained no access token');
    return refreshedToken;
  })();
  try {
    return await tokenRefreshPromise;
  } finally {
    tokenRefreshPromise = null;
  }
}

async function adminRequest(url, options = {}, label = 'NovelFlow admin request') {
  const perform = async (token) => request(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', ...(options.headers || {}) }
  }, label, options.timeoutMs || 35000);
  const attemptedToken = await oidcToken(false);
  try {
    return await perform(attemptedToken);
  } catch (error) {
    // The content-dashboard sometimes masks an expired bearer token as its
    // generic 500 "oops" response. This is a read-only request, so make one
    // credential refresh attempt when explicitly requested by that caller.
    const retryAfterRefresh = error.status === 401
      || (options.retryCredentialOn500 && error.code === 'provider_http' && Number(error.status) >= 500);
    if (!retryAfterRefresh || (!env('NOVELFLOW_OIDC_USERNAME') || !env('NOVELFLOW_OIDC_PASSWORD'))) throw error;
    if (refreshedToken && refreshedToken !== attemptedToken) return perform(refreshedToken);
    return perform(await oidcToken(true));
  }
}

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== '')).toString();
}

async function findExactBook(title, sku, options = {}) {
  const applicationId = applicationIdFor(options);
  if (sku) {
    try {
      return await findExactBookBySku(sku, { ...options, applicationId });
    } catch (error) {
      // Some Writer Admin application partitions ignore both bookId and the
      // legacy SKU keyword filter even though an exact title query returns
      // the active record. One read-only title fallback is safe only when
      // both normalized title and returned SKU independently match.
      if (String(error?.code || '') !== 'exact_not_found' || !titleKey(title)) throw error;
      const byTitle = await findExactBook(title, '', { ...options, applicationId });
      if (String(byTitle.bookSkuId || '') !== String(sku || '')) {
        throw new ProviderError('Exact title fallback returned a different SKU', { status: 409, code: 'exact_mismatch' });
      }
      return byTitle;
    }
  }
  const { body } = await adminRequest(`${BOOK_API}?${qs({ current: 1, pageIndex: 1, pageSize: 50, applicationId, bookStatus: 1, bookName: title })}`, {}, 'Exact active book lookup');
  const items = pageItems(body).items;
  const candidates = items.filter((item) => titleKey(item.title) === titleKey(title));
  const itemSku = (item) => String(item?.bookSkuId || item?.bookId || item?.skuId || '');
  const match = candidates.length === 1 ? candidates[0] : items.length === 1 ? items[0] : null;
  if (!match) throw new ProviderError(`Could not resolve one exact bookstore record for “${cleanTitle(title)}”`, { status: 404, code: 'exact_not_found' });
  if (titleKey(match.title) !== titleKey(title)) throw new ProviderError('Book title search returned a different record', { status: 409, code: 'exact_mismatch' });
  if (!itemSku(match)) throw new ProviderError('Book title search returned a record without an exact SKU', { status: 409, code: 'exact_mismatch' });
  return normalizeExactActiveBook(match, applicationId);
}

function normalizeBookRecord(match) {
  const category = match.aiCategory || {};
  return {
    bookSkuId: String(match?.bookSkuId || match?.bookId || match?.skuId || ''), cityBookId: String(match.id || ''), title: String(match.title || ''),
    cover: coverUrl(match.cover), category: typeof category === 'object' ? String(category.categoryName || '') : String(category),
    tags: (match.aiTags || match.tags || []).map((item) => typeof item === 'object' ? String(item.tagName || '') : String(item)).filter(Boolean),
    description: String(match.description || match.bookDescription || match.introduction || match.blurb || ''),
    chapterCount: Number(match.chapterCount || 0), words: Number(match.words || 0), payPoint: Number(match.payPoint || 0)
  };
}

function normalizeExactActiveBook(match, applicationId) {
  const normalized = normalizeBookRecord(match || {});
  const explicitApplicationId = String(match?.applicationId || match?.application?.id || '').trim();
  const explicitStatus = Object.prototype.hasOwnProperty.call(match || {}, 'bookStatus') ? String(match.bookStatus).trim().toLowerCase() : '';
  if (explicitApplicationId && explicitApplicationId !== String(applicationId || '')) {
    throw new ProviderError('Exact bookstore lookup returned a record from another application', { status: 409, code: 'exact_mismatch' });
  }
  if (explicitStatus && !['1', 'active', 'online', '上架'].includes(explicitStatus)) {
    throw new ProviderError('Exact bookstore lookup returned an inactive record', { status: 409, code: 'exact_mismatch' });
  }
  if (!titleKey(normalized.title) || !normalized.cityBookId || !normalized.bookSkuId) {
    throw new ProviderError('Exact bookstore lookup returned an incomplete active record', { status: 409, code: 'exact_mismatch' });
  }
  return normalized;
}

// Writer Admin's per-application book index is occasionally behind the
// operational bookstore catalogue.  The latter is the authority for a SKU's
// explicit distribution rights, so a logged-in operator may supply the exact
// row they just read there.  This is deliberately a narrow fallback: it is
// accepted only after the target index has returned an exact-not-found result,
// and it still requires the exact title, exact SKU, active status, and the
// target application's name in the catalogue's authorization list.
function exactBookFromCatalog(record, expected = {}) {
  const source = record && typeof record === 'object' ? record : {};
  const requestedSku = String(expected.sku || '').trim();
  const requestedTitle = cleanTitle(expected.title || '');
  const applicationName = String(expected.applicationName || '').trim().toLowerCase();
  const sku = String(source.Id || source.bookSkuId || source.bookId || '').trim();
  const title = cleanTitle(source.Title || source.title || '');
  const active = String(source.Status ?? source.bookStatus ?? '').trim().toLowerCase();
  const authorizedApps = String(source.AuthApp || source.authorizedApps || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!requestedSku || sku !== requestedSku || !requestedTitle || titleKey(title) !== titleKey(requestedTitle)) {
    throw new ProviderError('Bookstore catalogue record does not match the requested exact title and SKU', { status: 409, code: 'exact_mismatch' });
  }
  if (!['1', 'active', 'online', '上架'].includes(active)) {
    throw new ProviderError('Bookstore catalogue record is not active', { status: 409, code: 'exact_mismatch' });
  }
  if (!applicationName || !authorizedApps.includes(applicationName)) {
    throw new ProviderError('Bookstore catalogue record is not authorized for the target application', { status: 409, code: 'exact_mismatch' });
  }
  return {
    bookSkuId: sku,
    cityBookId: String(source.SrcBookId || source.Id || ''),
    title,
    cover: coverUrl(source.Cover || source.cover),
    category: Array.isArray(source.BookClasses) ? String(source.BookClasses[0] || '') : String(source.category || ''),
    tags: (Array.isArray(source.Tags) ? source.Tags : []).map(String).filter(Boolean),
    description: String(source.Description || source.description || ''),
    chapterCount: Number(source.ChapterCount || source.chapterCount || 0),
    words: Number(source.Words || source.words || 0),
    payPoint: Number(source.PayPoint || source.payPoint || 0),
    catalogueVerification: { source: 'bookstore.anynovel.app', authorizedApps, verifiedAt: new Date().toISOString() }
  };
}

// The relaxed content-dashboard path may return a global Top 200 whose target
// application books sit far below the first page. Verify those rows with the
// bookstore's direct SKU filter: one read-only request per candidate, exact
// identifier equality, and no title fallback that could accept another book.
async function findExactBookBySku(sku, options = {}) {
  const requestedSku = String(sku || '').trim();
  if (!requestedSku) throw new ProviderError('Exact book SKU is required', { status: 400 });
  const applicationId = applicationIdFor(options);
  const itemSku = (item) => String(item?.bookSkuId || item?.bookId || item?.skuId || '');
  const { body } = await adminRequest(`${BOOK_API}?${qs({ current: 1, pageIndex: 1, pageSize: 3, applicationId, bookStatus: 1, bookId: requestedSku })}`, {}, 'Exact active book SKU lookup');
  let match = pageItems(body).items.find((item) => itemSku(item) === requestedSku);
  // A legacy Writer Admin deployment may ignore bookId but still supports the
  // keyword route. It is safe only with exact identifier equality.
  if (!match) {
    const { body: keywordBody } = await adminRequest(`${BOOK_API}?${qs({ current: 1, pageIndex: 1, pageSize: 3, applicationId, bookStatus: 1, keyword: requestedSku })}`, {}, 'Exact active book SKU keyword lookup');
    match = pageItems(keywordBody).items.find((item) => itemSku(item) === requestedSku);
  }
  if (!match) throw new ProviderError('Could not resolve the exact SKU in the target application', { status: 404, code: 'exact_not_found' });
  return normalizeExactActiveBook(match, applicationId);
}

async function performanceBooks(days) {
  const endpoint = env('NOVELFLOW_PERFORMANCE_RANKING_API', 'https://novelflow.top/api/social-performance-rankings');
  const { body } = await request(`${endpoint}?${qs({ days })}`, { method: 'GET', headers: { Accept: 'application/json' } }, 'Unified funnel performance ranking', 25000);
  return body;
}

async function contentDashboardBooks({ startDate, endDate, sortField = 'baseReadUnt', sortIsAsc = false, minReadUnt = 0, filters = {}, maxPages = 10, deadlineMs = 14000 }) {
  const startedAt = Date.now();
  const omitServerProductLine = filters.omitServerProductLine === true;
  const requireProductLineEcho = filters.requireProductLineEcho === true;
  const allowMissingProductLineEcho = filters.allowMissingProductLineEcho === true;
  const allowUnmatchedProductLine = filters.allowUnmatchedProductLine === true;
  const payload = {
    pageIndex: 1,
    // Rate-based rankings need a broader candidate set before low-volume
    // books are filtered out; keep the complete Top 200 candidate universe.
    pageSize: 20,
    current: 1,
    ...(filters.minimalContract === true ? {} : { groupings: ['productTp', 'productLine', 'isVip'] }),
    // Writer Admin sends these fields from its sortable table. Server-side
    // ordering is essential when the source contains tens of thousands of
    // rows; local sorting remains as a deterministic tie-breaker.
    sortField,
    sortIsAsc,
    readStartTime: startDate,
    readEndTime: endDate,
    readTime: [startDate, endDate],
    billStartTime: startDate,
    billEndTime: endDate,
    billTime: [startDate, endDate]
  };
  if (filters.language) payload.language = filters.language;
  if (Array.isArray(filters.skuIds) && filters.skuIds.length) payload.skuIds = [...new Set(filters.skuIds.map(String).filter(Boolean))].slice(0, 1000);
  if (filters.completeSts) payload.completeSts = filters.completeSts;
  if (filters.status) payload.status = filters.status;
  if ([0, 1].includes(Number(filters.isShort))) payload.isShort = Number(filters.isShort);
  if (!omitServerProductLine && Array.isArray(filters.productLine) && filters.productLine.length) payload.productLine = filters.productLine;
  if (Array.isArray(filters.productTp) && filters.productTp.length) payload.productTp = filters.productTp;
  const pages = [];
  let total = 0;
  let partial = false;
  const boundedPages = Math.max(1, Math.min(Number(maxPages) || 10, 10));
  const boundedDeadline = Math.max(4000, Math.min(Number(deadlineMs) || 14000, 105000));
  for (let pageIndex = 1; pageIndex <= boundedPages; pageIndex += 1) {
    const remainingMs = boundedDeadline - (Date.now() - startedAt);
    if (remainingMs < 1200) { partial = true; break; }
    const pagePayload = { ...payload, pageIndex, current: pageIndex };
    const { body } = await adminRequest(CONTENT_DASHBOARD_API, {
      method: 'POST',
      // These mirror the Writer Admin request contract. The service returns a
      // generic 500 when the browser client marker or charset is omitted.
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-OS': 'web' },
      // The live dashboard occasionally needs 12-15s on a cold upstream
      // connection. Keep the overall deadline bounded, but do not turn a
      // valid real-time response into a false outage at eight seconds.
      body: JSON.stringify(pagePayload), timeoutMs: Math.min(15000, remainingMs),
      // Writer Admin v2 can mask an expired bearer token as a generic 500,
      // including requests with a valid product-line filter. This endpoint is
      // read-only, so one password-grant refresh is safe before fallback.
      retryCredentialOn500: true
    }, `Content dashboard ranking page ${pageIndex}`);
    const page = body?.data;
    if (!page || !Array.isArray(page.data)) throw new ProviderError(`Content dashboard ranking page ${pageIndex} returned an invalid response shape`);
    const items = page.data;
    if (pageIndex === 1) total = Number(page.total || items.length);
    pages.push(...items);
    if (!items.length || items.length < payload.pageSize || pages.length >= 200 || (total > 0 && pages.length >= total)) break;
    if (pageIndex === boundedPages) partial = pages.length < Math.min(200, total || 200);
  }
  const shortValue = (value) => value === true || value === 1 || ['1', 'true', 'yes', '是'].includes(String(value || '').toLowerCase());
  const requestedProductLine = String(filters.productLine?.[0] || '').trim();
  const requestedSkus = new Set((Array.isArray(filters.skuIds) ? filters.skuIds : []).map(String));
  const productLineKey = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const records = pages.map((item) => {
    const echoedProductLine = String(item.productLine || item.productTp || '').trim();
    const rowSku = String(item.skuId || item.bookId || '');
    const targetProductLineVerified = requestedSkus.has(rowSku)
      || Boolean(requestedProductLine && echoedProductLine && productLineKey(echoedProductLine) === productLineKey(requestedProductLine));
    return {
      bookSkuId: rowSku,
      title: cleanTitle(item.title),
      cover: coverUrl(item.cover || item.coverImage || item.coverUrl || item.bookCover || ''),
      author: String(item.authorName || ''),
      category: String(item.channelNm || ''),
      // In the relaxed retry path, a missing product-line echo is not enough
      // to assign the row to the requested application.
      productLine: echoedProductLine || (requireProductLineEcho ? '' : requestedProductLine),
      productLineEchoPresent: Boolean(echoedProductLine),
      productLineVerified: targetProductLineVerified,
      baseReadUnt: Number(item.baseReadUnt || 0),
      exposureUV: Number(item.exposureUV || 0),
      bookDetailUV: Number(item.bookDetailUV || 0),
      firstReadUntRate: Number(item.firstReadUntRate || 0),
      gt2FirstReadUntRate: Number(item.gt2FirstReadUntRate || 0),
      readEndRate: Number(item.readEndRate || 0),
      read10wRate: Number(item.read10wRate || 0),
      read20wRate: Number(item.read20wRate || 0),
      ttProfit: Number(item.ttProfit || 0),
      avgSpend: Number(item.avgSpend || 0),
      // This report endpoint applies isShort but does not always echo the field
      // in each row. Keep the server-applied value so the UI does not filter a
      // correctly returned short-book list back to zero cards.
      isShort: [0, 1].includes(Number(filters.isShort)) ? Number(filters.isShort) === 1 : shortValue(item.isShort ?? item.shortStory ?? item.shortBook),
      source: 'content_dashboard'
    };
  }).filter((book) => book.title && book.bookSkuId
    && (!requestedProductLine
      || requestedSkus.has(book.bookSkuId)
      || productLineKey(book.productLine) === productLineKey(requestedProductLine)
      // A relaxed recovery may carry an unlabelled row forward, but only the
      // target application's exact bookstore lookup can make it actionable.
      || (requireProductLineEcho && allowMissingProductLineEcho && !book.productLine)
      // Some application brands are represented by a different upstream
      // product-line label. Keep those rows provisional; enrichment must still
      // prove the exact SKU belongs to the requested application.
      || (requireProductLineEcho && allowUnmatchedProductLine && Boolean(book.productLine))));
  const normalizedRate = (value) => {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return Math.min(numeric > 1 ? numeric / 100 : numeric, 1);
  };
  const maxUv = Math.max(...records.map((book) => Number(book.baseReadUnt || 0)), 1);
  const maxProfit = Math.max(...records.map((book) => Number(book.ttProfit || 0)), 0);
  const scoredRecords = records.map((book) => {
    const uvScore = Math.log1p(Math.max(0, Number(book.baseReadUnt || 0))) / Math.log1p(maxUv);
    const firstReadScore = normalizedRate(book.firstReadUntRate);
    const longReadScore = Math.max(normalizedRate(book.read20wRate), normalizedRate(book.read10wRate));
    const profitScore = maxProfit > 0 ? Math.max(0, Number(book.ttProfit || 0)) / maxProfit : 0;
    return { ...book, promotionScore: Number((100 * (uvScore * .45 + firstReadScore * .25 + longReadScore * .25 + profitScore * .05)).toFixed(2)) };
  });
  const books = scoredRecords
    .filter((book) => book.baseReadUnt >= minReadUnt)
    .sort((left, right) => Number(right[sortField] || 0) - Number(left[sortField] || 0) || right.baseReadUnt - left.baseReadUnt)
    .slice(0, 200)
    .map((book, index) => ({ ...book, rank: index + 1 }));
  return {
    books,
    total: Number(total || records.length),
    candidateTotal: records.length,
    qualifiedTotal: books.length,
    observedTopUv: Math.max(...records.map((book) => Number(book.baseReadUnt || 0)), 0),
    minReadUnt,
    payload,
    partial,
    fetched: records.length
  };
}

async function topBooks(limit = 200, options = {}) {
  const requested = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const applicationId = applicationIdFor(options);
  const startedAt = Date.now();
  const deadlineMs = Math.max(4000, Math.min(Number(options.deadlineMs) || 35000, 105000));
  const load = async (languageCode) => {
    const all = [];
    for (let pageIndex = 1; pageIndex <= Math.ceil(requested / 50); pageIndex += 1) {
      const remainingMs = deadlineMs - (Date.now() - startedAt);
      if (remainingMs < 1200) break;
      const { body } = await adminRequest(`${BOOK_API}?${qs({
        current: pageIndex, pageIndex, pageSize: 50, applicationId, bookStatus: 1,
        orderBy: 'uv', orderType: 'desc', languageCode
      })}`, { timeoutMs: Math.min(8000, remainingMs) }, 'Top books lookup');
      const page = pageItems(body);
      all.push(...page.items);
      // This endpoint often omits `pages`; do not mistake that for a one-page
      // catalogue or the Top 200 cover map silently collapses to the first 50.
      if (!page.items.length || all.length >= requested) break;
    }
    return all.slice(0, requested);
  };
  let items = await load('en');
  if (!items.length) items = await load('');
  return items.map((item, index) => {
    const category = item.aiCategory || {};
    return {
      rank: index + 1,
    bookSkuId: String(item.bookSkuId || item.bookId || ''),
    cityBookId: String(item.id || ''),
    title: String(item.title || ''),
      cover: coverUrl(item.cover || item.coverImage || item.coverUrl || ''),
      author: Array.isArray(item.authors) ? item.authors.map((author) => String(author.authorName || author)).filter(Boolean).join(', ') : String(item.author || ''),
      category: typeof category === 'object' ? String(category.categoryName || item.bookClassName || '') : String(category || item.bookClassName || ''),
      tags: (item.aiTags || item.tags || []).map((tag) => typeof tag === 'object' ? String(tag.tagName || tag.name || '') : String(tag)).filter(Boolean).slice(0, 3),
      description: String(item.description || item.bookDescription || item.introduction || item.blurb || '').replace(/\s+/g, ' ').trim(),
    uv: Number(item.uv || item.bookUv || item.readCount || 0),
    words: Number(item.words || 0),
    chapterCount: Number(item.chapterCount || 0), payPoint: Number(item.payPoint || 0)
    };
  }).filter((book) => book.title && book.bookSkuId);
}

// The bookstore search endpoint is the full-catalog recall layer. It is not
// limited to the daily ranking, so rare OCR phrases can reach long-tail books.
async function searchBooks(keywords, limit = 12, options = {}) {
  const applicationId = applicationIdFor(options);
  const terms = [...new Set((Array.isArray(keywords) ? keywords : [keywords])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter((value) => value.length >= 4))].slice(0, 8);
  const rows = await Promise.all(terms.map(async (keyword) => {
    const { body } = await adminRequest(`${BOOK_API}?${qs({ current: 1, pageIndex: 1, pageSize: Math.min(50, Math.max(limit, 12)), applicationId, bookName: keyword, languageCode: 'en' })}`, {}, 'Book evidence search');
    return pageItems(body).items;
  }));
  const merged = new Map();
  for (const items of rows) for (const item of items) {
    const sku = String(item.bookSkuId || item.bookId || '');
    if (!sku || !item.title) continue;
    const category = item.aiCategory || {};
    const current = merged.get(sku) || {
      bookSkuId: sku, cityBookId: String(item.id || ''), title: String(item.title || ''),
      cover: coverUrl(item.cover || item.coverImage || item.coverUrl || ''),
      author: Array.isArray(item.authors) ? item.authors.map((author) => String(author.authorName || author)).filter(Boolean).join(', ') : String(item.author || ''),
      category: typeof category === 'object' ? String(category.categoryName || item.bookClassName || '') : String(category || item.bookClassName || ''),
      tags: (item.aiTags || item.tags || []).map((tag) => typeof tag === 'object' ? String(tag.tagName || tag.name || '') : String(tag)).filter(Boolean).slice(0, 8),
      description: String(item.description || item.bookDescription || item.introduction || item.blurb || '').replace(/\s+/g, ' ').trim(),
      evidenceKeywords: []
    };
    current.evidenceKeywords = [...new Set([...current.evidenceKeywords, ...terms.filter((term) => String(item.title || '').toLowerCase().includes(term.toLowerCase()))])];
    merged.set(sku, current);
  }
  return [...merged.values()].slice(0, Math.max(1, limit));
}

async function listChapters(cityBookId) {
  const pageSize = 200;
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const { body } = await adminRequest(`${CHAPTER_LIST_API}?${qs({ pageIndex: page, pageSize, cityBookId })}`, {}, 'Chapter list');
    const result = pageItems(body);
    all.push(...result.items);
    if (!result.items.length
      || (result.hasPages && page >= result.pages)
      || (result.hasTotal && all.length >= result.total)
      // Some Admin deployments omit both pagination counters. Continue when a
      // full page was returned and stop on the first short/empty page instead
      // of silently truncating long books at chapter 200.
      || (!result.hasPages && !result.hasTotal && result.items.length < pageSize)) break;
  }
  const unique = new Map(all.filter((item) => item.id).map((item) => [String(item.id), item]));
  return [...unique.values()].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

async function chapterContent(id, options = {}) {
  const { body } = await adminRequest(`${CHAPTER_CONTENT_API}?${qs({ id, applicationId: applicationIdFor(options) })}`, {}, 'Chapter content');
  const content = String(body?.data?.content || '');
  if (!content.trim()) throw new ProviderError(`Chapter ${id} returned empty content`);
  return content;
}

async function keywordRecord(code, options = {}) {
  const { body } = await adminRequest(`${KEYWORD_API}?${qs({ applicationId: applicationIdFor(options), keyword: code, pageIndex: 1, pageSize: 100 })}`, {}, 'Promotion code lookup');
  return pageItems(body).items.find((item) => String(item.keyword || '') === String(code)) || null;
}

async function createKeyword(sku, code, options = {}) {
  const payload = { applicationId: applicationIdFor(options), keyword: String(code), bookId: String(sku), channel: String(options.channel || env('NOVELFLOW_CHANNEL_CODE', 'FB')), isEnable: true };
  await adminRequest(KEYWORD_SAVE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 'Promotion code creation');
  return payload;
}

function enabled(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

async function linkDetail(id) {
  const { body } = await adminRequest(`${LINK_API}/${encodeURIComponent(id)}`, {}, 'Short-link detail');
  const detail = body?.data || {};
  if (detail.shortUrl) detail.shortUrl = absoluteUrl(detail.shortUrl);
  return detail;
}

async function findLink(sku, promoter, code, options = {}) {
  const { body } = await adminRequest(`${LINK_API}?${qs({ pageIndex: 1, pageSize: 100, linkName: code })}`, {}, 'Short-link lookup');
  for (const item of pageItems(body).items) {
    if (!String(item.linkName || '').startsWith(String(code))) continue;
    const detail = item.id ? await linkDetail(String(item.id)) : item;
    const sourceSku = String(detail.contentNameOrSku || item.contentNameOrSku || '');
    const operator = String(detail.operatorName || item.operatorName || '');
    const creator = String(detail.creator || item.creator || '');
    const applicationId = String(detail.applicationId || item.applicationId || '');
    const channelSource = String(detail.channelSource || item.channelSource || '');
    const channelNameId = String(detail.channelNameId || item.channelNameId || '');
    const expectedOperator = String(options.operatorName || promoter).toLowerCase();
    const operatorMatches = [operator, creator].some((value) => [expectedOperator, String(promoter).toLowerCase()].includes(String(value).toLowerCase()));
    const applicationMatches = !options.applicationId || applicationId === String(options.applicationId);
    const channelMatches = options.channelNameId
      ? channelNameId === String(options.channelNameId)
      : !options.channelSource || channelSource.toLowerCase().includes(String(options.channelSource).toLowerCase());
    const templates = Array.isArray(detail.landingPageTemplates) ? detail.landingPageTemplates : [];
    const templateMatches = !options.landingTemplateId || templates.some((template) => String(template.templateId || '') === String(options.landingTemplateId));
    if ((sourceSku === String(sku) || sourceSku.includes(String(sku))) && operatorMatches && applicationMatches && channelMatches && templateMatches && enabled(detail.isEnabled ?? item.isEnabled)) {
      return { ...item, ...detail, shortUrl: absoluteUrl(detail.shortUrl || item.shortUrl) };
    }
  }
  return null;
}

async function createLink(book, promoter, code, options = {}) {
  const discord = String(options.channel || '').toUpperCase() === 'DISCORD';
  const applicationId = applicationIdFor(options);
  const brandName = String(options.brandName || 'NovelFlow');
  const channelSource = String(options.channelSource || (discord ? env('NOVELFLOW_DISCORD_CHANNEL_SOURCE', 'Discord') : env('NOVELFLOW_CHANNEL_SOURCE', 'Facebook-grounp')));
  const channelNameId = discord
    ? env('NOVELFLOW_DISCORD_CHANNEL_NAME_ID', env('NOVELFLOW_CHANNEL_NAME_ID', '699ef7b8194eb218db3c2270'))
    : String(options.channelNameId || env('NOVELFLOW_CHANNEL_NAME_ID', '699ef7b8194eb218db3c2270'));
  if (!channelNameId) throw new ProviderError('Discord attribution channel is not configured', { status: 503 });
  const suffix = discord ? 'Discord' : 'FB';
  const channelName = discord
    ? `NovelFlow_SocialMedia_Discord_${String(options.guildId || 'direct')}_${promoter}`
    : options.channelName || (brandName === 'NovelFlow' ? `NovelFlow_SocialMedia_Facebook-grounp_Facebook_${promoter}` : `${brandName}_SocialMedia_${channelSource}_${promoter}`);
  const title = String(book.title || '').slice(0, 180);
  const payload = {
    linkName: `${code}${title}-Book-Detail-${suffix}`, applicationId, mediaSource: 'SocialMedia',
    channelSource, channelNameId,
    channelName, contentType: 1, contentNameOrSku: book.bookSkuId, languageCode: String(options.languageCode || 'en'),
    redirectConfigId: String(options.redirectConfigId || env('NOVELFLOW_REDIRECT_CONFIG_ID', '68fecf8b3a29f6eff435fd3b')), contentRedirectSequence: 1,
    adGroupName: `${channelName}_${code}${title}-Book-Detail-${suffix}_${promoter}`, operatorName: String(options.operatorName || promoter),
    landingPageTemplates: [{ templateId: String(options.landingTemplateId || env('NOVELFLOW_LANDING_TEMPLATE_ID', '6a01499261118c6285dff7dd')), templateName: String(options.landingTemplateName || env('NOVELFLOW_LANDING_TEMPLATE_NAME', 'Book Detail FB')), templateWeight: 100, isDeleted: false }],
    isEnabled: true, contentName: title,
    customConfig: JSON.stringify({ appName: brandName, languageConfig: { h5_read_more: 'Read More for Free', h5_open_app: 'Open APP' } })
  };
  const { body } = await adminRequest(LINK_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 40000 }, 'Short-link creation');
  const data = body?.data || {};
  return {
    payload,
    id: typeof data === 'string' ? data : String(data.id || data.linkId || ''),
    shortUrl: absoluteUrl(typeof data === 'object' ? (data.shortUrl || data.url || data.linkUrl || '') : '')
  };
}

function modelValueText(value, depth = 0) {
  if (value == null || depth > 5) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => modelValueText(item, depth + 1)).filter(Boolean).join('');
  if (typeof value !== 'object') return '';
  // OpenAI-compatible Responses gateways differ on whether JSON-mode output
  // lives in `text`, `parsed`, `json`, `arguments`, or `content`. Prefer the
  // actual value and serialize object JSON rather than turning it into the
  // lossy string "[object Object]".
  for (const key of ['output_text', 'parsed', 'json', 'arguments', 'text', 'value']) {
    if (value[key] == null || value[key] === value) continue;
    const nested = modelValueText(value[key], depth + 1);
    if (nested) return nested;
  }
  if (value.content != null && value.content !== value) {
    const nested = modelValueText(value.content, depth + 1);
    if (nested) return nested;
  }
  return JSON.stringify(value);
}

function extractModelText(body) {
  // Some Responses-compatible gateways expose a small numeric `output_parsed`
  // metadata array alongside the real message in `output[].content`. It is
  // not creative JSON. Do not let `[1,2]` short-circuit the actual content
  // channel just because it appears earlier in the envelope.
  const usableText = (value) => {
    if (Array.isArray(value) && value.length && value.every((item) => Number.isFinite(Number(item)))) return '';
    const extracted = modelValueText(value);
    if (!extracted) return '';
    const compact = extracted.trim();
    if (/^\[\s*\d+(?:\s*,\s*\d+)*\s*\]$/.test(compact) || /^\d+(?:\.\d+)?$/.test(compact)) return '';
    return extracted;
  };
  for (const value of [body.output_text, body.output_parsed, body.response?.output_text, body.response?.output_parsed, body.data?.output_text, body.data?.output_parsed]) {
    const extracted = usableText(value);
    if (extracted) return extracted;
  }
  const message = body.choices?.[0]?.message || body.data?.choices?.[0]?.message || {};
  const choice = message.content;
  const choiceValue = modelValueText(choice);
  if (choiceValue) return choiceValue;
  const choiceText = body.choices?.[0]?.text || body.data?.choices?.[0]?.text;
  const choiceTextValue = modelValueText(choiceText);
  if (choiceTextValue) return choiceTextValue;
  if (message.reasoning_content) return String(message.reasoning_content);
  const parts = [];
  const outputs = body.output || body.response?.output || body.data?.output || [];
  for (const output of Array.isArray(outputs) ? outputs : [outputs]) {
    if (typeof output === 'string') { parts.push(output); continue; }
    const content = output?.content || output?.message?.content || [];
    for (const item of Array.isArray(content) ? content : [content]) {
      const value = modelValueText(item);
      if (value) parts.push(value);
    }
  }
  return parts.join('');
}

function buildEvidenceBank(evidence = []) {
  const bank = [];
  for (const item of evidence) {
    const chapter = Number(item?.order || item?.chapter || 0);
    const words = String(item?.content || item?.excerpt || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!chapter || words.length < 4) continue;
    const offsets = [...new Set([0, Math.max(0, Math.floor(words.length / 2) - 8), Math.max(0, words.length - 16)])];
    let index = 0;
    for (const offset of offsets) {
      const quote = words.slice(offset, offset + 16).join(' ').trim();
      if (quote.length < 24 || bank.some((entry) => entry.chapter === chapter && entry.quote === quote)) continue;
      index += 1;
      bank.push({ evidenceId: `C${chapter}Q${index}`, chapter, quote });
    }
  }
  return bank;
}

function hydrateCreativeEvidence(value, section, evidenceBank = []) {
  const byId = new Map((evidenceBank || []).map((item) => [String(item.evidenceId || ''), item]));
  const hydrateList = (items) => (Array.isArray(items) ? items : []).map((item) => {
    const match = byId.get(String(item?.evidenceId || ''));
    return match ? { ...item, chapter: match.chapter, quote: match.quote } : item;
  });
  if (section === 'posts') {
    if (Array.isArray(value)) return value.map((post) => ({ ...post, evidence: hydrateList(post?.evidence) }));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, post]) => [key,
        post && typeof post === 'object' ? { ...post, evidence: hydrateList(post.evidence) } : post]));
    }
  }
  if (section === 'videoPrompt' && value && typeof value === 'object') {
    return { ...value, sourceEvidence: hydrateList(value.sourceEvidence || value.source_evidence) };
  }
  return value;
}

function balancedJsonCandidates(value) {
  const text = String(value || '');
  const candidates = [];
  let start = -1;
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') quote = false;
      continue;
    }
    if (character === '"') { quote = true; continue; }
    if (character === '{' || character === '[') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    if (!depth) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      candidates.push(text.slice(start, index + 1));
      start = -1;
    }
  }
  return candidates;
}

function parseModelJson(raw, model = 'selected AI model') {
  let cleaned = String(raw || '').trim();
  // Some reasoning-capable gateways prepend a private reasoning block even
  // when json_object was requested. It is not part of the model result.
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [cleaned, ...balancedJsonCandidates(cleaned)];
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const normalized = escapeJsonControlCharacters(candidate).replace(/,\s*([}\]])/g, '$1');
    try {
      const parsed = JSON.parse(candidate);
      return typeof parsed === 'string' && /^[\[{]/.test(parsed.trim()) ? JSON.parse(parsed) : parsed;
    } catch {}
    if (normalized !== candidate) try {
      const parsed = JSON.parse(normalized);
      return typeof parsed === 'string' && /^[\[{]/.test(parsed.trim()) ? JSON.parse(parsed) : parsed;
    } catch {}
  }
  throw new ProviderError(`${model} returned invalid structured output`);
}

function requestedCreativeSection(value, section) {
  if (Array.isArray(value)) {
    if (['posts', 'posterPrompts'].includes(section)) return value;
    if (section === 'videoPrompt') {
      // TokenDance Responses envelopes can nest the requested object inside
      // one or more arrays (`[{ videoPrompt: [...] }]`). Flatten only known
      // video wrappers into candidate objects; exact field/evidence checks
      // below remain the acceptance gate.
      const candidates = [];
      const collect = (item, depth = 0) => {
        if (depth > 5 || item == null) return;
        if (Array.isArray(item)) {
          item.forEach((entry) => collect(entry, depth + 1));
          return;
        }
        if (typeof item !== 'object') return;
        candidates.push(item);
        for (const nested of [item.videoPrompt, item.video_prompt, item.video, item.data, item.result, item.payload, item.response, item.output]) {
          if (nested && nested !== item) collect(nested, depth + 1);
        }
      };
      collect(value);
      const direct = candidates.find((item) => item && typeof item === 'object' && !Array.isArray(item)
        && Object.prototype.hasOwnProperty.call(item, 'hook')
        && ['adCopy', 'ad_copy'].some((key) => Object.prototype.hasOwnProperty.call(item, key))
        && ['buildRequirement', 'build_requirement'].some((key) => Object.prototype.hasOwnProperty.call(item, key)));
      if (direct) return requestedCreativeSection(direct, 'videoPrompt');
      // A few Responses-compatible gateways serialize a single video package
      // as two complementary objects (beats + director contract). Merge only
      // non-conflicting fields, then send it through the normal exact-evidence
      // validator. If the parts conflict or remain incomplete, leave it
      // undefined so P3 remains fail-closed.
      const parts = candidates.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
      if (parts.length >= 2) {
        const merged = {};
        let conflict = false;
        for (const part of parts) {
          for (const [key, item] of Object.entries(part)) {
            if (Object.prototype.hasOwnProperty.call(merged, key) && JSON.stringify(merged[key]) !== JSON.stringify(item)) { conflict = true; break; }
            merged[key] = item;
          }
          if (conflict) break;
        }
        const meaningful = ['hook', 'valuePromise', 'value_promise', 'adCopy', 'ad_copy', 'buildRequirement', 'build_requirement']
          .filter((key) => Object.prototype.hasOwnProperty.call(merged, key)).length;
        if (!conflict && meaningful >= 2) return requestedCreativeSection(merged, 'videoPrompt');
      }
      const partial = candidates.find((item) => item && typeof item === 'object' && !Array.isArray(item)
        && ['hook', 'valuePromise', 'value_promise', 'adCopy', 'ad_copy', 'buildRequirement', 'build_requirement']
          .filter((key) => Object.prototype.hasOwnProperty.call(item, key)).length >= 2);
      if (partial) return requestedCreativeSection(partial, 'videoPrompt');
    }
    return undefined;
  }
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  // TokenDance V4 occasionally returns an otherwise valid JSON-mode result
  // under a sole `code` envelope. Never accept `code` as creative content by
  // itself: unwrap only when its value is another object/array or a complete
  // JSON string, then run the normal section extraction and downstream
  // evidence validation unchanged.
  if (Object.keys(result).length === 1 && Object.prototype.hasOwnProperty.call(result, 'code')) {
    let nested = result.code;
    if (typeof nested === 'string' && /^[\s`]*(?:json\s*)?[\[{]/i.test(nested)) {
      try { nested = parseModelJson(nested, 'creative code envelope'); } catch { nested = null; }
    }
    if (nested && typeof nested === 'object') {
      const unwrapped = requestedCreativeSection(nested, section);
      if (unwrapped !== undefined) return unwrapped;
    }
  }
  if (Object.prototype.hasOwnProperty.call(result, section)) {
    const direct = result[section];
    // Responses gateways may wrap a valid complementary two-part video
    // package under the expected `videoPrompt` root. Re-enter the array
    // normalizer so it can merge and validate the pieces instead of passing
    // the raw array to P3 as an invalid prompt object.
    if (section === 'videoPrompt' && Array.isArray(direct)) return requestedCreativeSection(direct, section);
    // The V4 Flash endpoint tends to truncate an array-shaped posts schema
    // to its first item.  It follows named-object fields reliably, so accept
    // the explicit `{ hook, escalation }` wire contract and normalize it
    // through the existing strict two-post path below.
    if (section === 'posts' && direct && typeof direct === 'object' && !Array.isArray(direct)) return requestedCreativeSection(direct, section);
    return direct;
  }
  for (const container of [result.creative, result.result, result.data, result.response, result.payload, result.output]) {
    if (container && typeof container === 'object' && container !== result) {
      const nested = requestedCreativeSection(container, section);
      if (nested !== undefined) return nested;
    }
  }
  const aliases = {
    posts: ['socialPosts', 'social_posts', 'postList', 'post_list', 'socialPostList', 'social_post_list', 'copy'],
    videoPrompt: ['video', 'video_prompt', 'videoPackage', 'video_package'],
    posterPrompts: ['posters', 'poster_prompts', 'imagePrompts', 'image_prompts'],
    qualityReview: ['review', 'quality_review', 'qa']
  }[section] || [];
  for (const alias of aliases) if (Object.prototype.hasOwnProperty.call(result, alias)) return result[alias];
  if (section === 'posts') {
    const hook = result.hookPost || result.hook_post || result.post1 || result.post_1;
    const escalation = result.escalationPost || result.escalation_post || result.post2 || result.post_2;
    if (hook && escalation && typeof hook === 'object' && typeof escalation === 'object') {
      return [{ type: 'hook', ...hook }, { type: 'escalation', ...escalation }];
    }
  }
  if (section === 'posts' && result.hook && result.escalation && typeof result.hook === 'object' && typeof result.escalation === 'object') {
    return [{ type: 'hook', ...result.hook }, { type: 'escalation', ...result.escalation }];
  }
  if (section === 'posterPrompts' && result.luminous_cinema && result.editorial_romance) {
    const poster = (variant, value) => typeof value === 'string' ? { variant, prompt: value } : { variant, ...(value || {}) };
    return [poster('luminous_cinema', result.luminous_cinema), poster('editorial_romance', result.editorial_romance)];
  }
  if (section === 'posts' && ['hook', 'escalation'].includes(String(result.type || ''))) return [result];
  if (section === 'qualityReview' && ['recommendation', 'conclusion', 'why', 'target'].some((key) => Object.prototype.hasOwnProperty.call(result, key))) return result;
  // Some compatible JSON-mode gateways flatten a one-section schema. Accept
  // that video-only response shape, then leave the existing evidence and
  // field validation to the caller.
  if (section === 'videoPrompt' && ['valuePromise', 'adCopy', 'buildRequirement'].some((key) => Object.prototype.hasOwnProperty.call(result, key))) return result;
  if (section === 'videoPrompt' && ['value_promise', 'ad_copy', 'build_requirement', 'source_evidence', 'evidence_chapters'].some((key) => Object.prototype.hasOwnProperty.call(result, key))) {
    return {
      ...result,
      valuePromise: result.valuePromise || result.value_promise,
      adCopy: result.adCopy || result.ad_copy,
      buildRequirement: result.buildRequirement || result.build_requirement,
      sourceEvidence: result.sourceEvidence || result.source_evidence,
      evidenceChapters: result.evidenceChapters || result.evidence_chapters
    };
  }
  return undefined;
}

function creativeWireKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function normalizeCreativeWireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const aliases = {
    type: ['posttype', 'contenttype'],
    formatId: ['formatid', 'format', 'creativeform', 'formid'],
    openingGrammar: ['openinggrammar', 'opening', 'hookgrammar'],
    sixSteps: ['sixsteps', 'sixstep', 'steps'],
    zhContent: ['zhcontent', 'chinesecontent', 'translationzh', 'zhtranslation'],
    valuePromise: ['valuepromise'],
    sourceEvidence: ['sourceevidence'],
    evidenceChapters: ['evidencechapters'],
    adCopy: ['adcopy'],
    buildRequirement: ['buildrequirement'],
    zhHook: ['zhhook'],
    zhValuePromise: ['zhvaluepromise'],
    zhEscalation: ['zhescalation'],
    zhReversal: ['zhreversal'],
    zhCliffhanger: ['zhcliffhanger'],
    zhAdCopy: ['zhadcopy'],
    zhBuildRequirement: ['zhbuildrequirement'],
    zhPrompt: ['zhprompt']
  };
  const normalized = { ...value };
  const entries = Object.entries(value);
  for (const [canonical, keys] of Object.entries(aliases)) {
    if (normalized[canonical] !== undefined) continue;
    const match = entries.find(([key]) => keys.includes(creativeWireKey(key)));
    if (match) normalized[canonical] = match[1];
  }
  if (normalized.sixSteps && typeof normalized.sixSteps === 'object' && !Array.isArray(normalized.sixSteps)) {
    const sixAliases = {
      hook: ['hook'], pain: ['pain'], sensory: ['sensory', 'sensorydetail'], contrast: ['contrast'],
      deepDesire: ['deepdesire', 'desire'], emotionalCta: ['emotionalcta', 'cta']
    };
    const sixEntries = Object.entries(normalized.sixSteps);
    normalized.sixSteps = { ...normalized.sixSteps };
    for (const [canonical, keys] of Object.entries(sixAliases)) {
      if (normalized.sixSteps[canonical] !== undefined) continue;
      const match = sixEntries.find(([key]) => keys.includes(creativeWireKey(key)));
      if (match) normalized.sixSteps[canonical] = match[1];
    }
  }
  return normalized;
}

function normalizeCreativeWireSection(section, value) {
  if (section === 'posts') {
    const posts = Array.isArray(value) ? value : [];
    return posts.map((post) => normalizeCreativeWireObject(post));
  }
  if (section === 'videoPrompt' || section === 'qualityReview') return normalizeCreativeWireObject(value);
  if (section === 'posterPrompts') return (Array.isArray(value) ? value : []).map((item) => normalizeCreativeWireObject(item));
  return value;
}

function structuredShape(value) {
  // Diagnostics deliberately expose only bounded structural keys. This is
  // enough to distinguish gateway envelopes (for example five beat objects)
  // without persisting prose, source excerpts, URLs, or credentials.
  if (Array.isArray(value)) {
    const members = value.slice(0, 5).map((item) => structuredShape(item)).join(';');
    return `array(${value.length}${members ? `:${members}` : ''})`;
  }
  if (!value || typeof value !== 'object') return typeof value;
  return `object(${Object.keys(value).map((key) => String(key).replace(/[^A-Za-z0-9_]/g, '').slice(0, 50)).filter(Boolean).slice(0, 16).join(',')})`;
}

function normalizedStrategyPlan(value) {
  let plan = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const key of ['plan', 'strategy', 'creativeStrategy', 'creative_strategy', 'result', 'data']) {
    if (plan[key] && typeof plan[key] === 'object' && !Array.isArray(plan[key])) { plan = plan[key]; break; }
  }
  const profile = plan.recommendedProfile || plan.recommended_profile || plan.profile || {};
  const pick = (...keys) => keys.map((key) => plan[key]).find((item) => item != null && String(item).trim());
  return {
    ...plan,
    editorialThesis: pick('editorialThesis', 'editorial_thesis', 'thesis'),
    recommendedProfile: {
      ...profile,
      copyStyle: profile.copyStyle || profile.copy_style,
      ctaStyle: profile.ctaStyle || profile.cta_style,
      videoStyle: profile.videoStyle || profile.video_style,
      posterStyle: profile.posterStyle || profile.poster_style
    },
    storySignals: plan.storySignals || plan.story_signals || [],
    copyBlueprint: plan.copyBlueprint || plan.copy_blueprint || {},
    videoBlueprint: plan.videoBlueprint || plan.video_blueprint || {},
    posterBlueprint: plan.posterBlueprint || plan.poster_blueprint || {}
  };
}

function escapeJsonControlCharacters(value) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (const character of String(value || '')) {
    if (escaped) { result += character; escaped = false; continue; }
    if (character === '\\' && inString) { result += character; escaped = true; continue; }
    if (character === '"') { result += character; inString = !inString; continue; }
    if (inString && character === '\n') { result += '\\n'; continue; }
    if (inString && character === '\r') { result += '\\r'; continue; }
    if (inString && character === '\t') { result += '\\t'; continue; }
    result += character;
  }
  return result;
}

function sampledChapterStructure(chapters, limit = 80) {
  const normalized = chapterStructureItems(chapters);
  if (normalized.length <= limit) return normalized;
  const head = normalized.slice(0, 20);
  const tail = normalized.slice(-20);
  const middle = [];
  const middleCount = Math.max(0, limit - head.length - tail.length);
  for (let index = 1; index <= middleCount; index += 1) {
    const at = Math.round((normalized.length - 1) * index / (middleCount + 1));
    middle.push(normalized[at]);
  }
  return [...new Map([...head, ...middle, ...tail].map((item) => [item.chapter, item])).values()]
    .sort((a, b) => a.chapter - b.chapter);
}

function chapterStructureItems(chapters) {
  return chapters
    .map((item) => ({ chapter: Number(item.order || 0), title: String(item.title || '').slice(0, 120) }))
    .filter((item) => item.chapter > 0);
}

function creativeProfileGuidance(profile = {}) {
  const copy = {
    system_best: 'Choose the strongest evidence-supported emotional engine, not a preset trope.',
    revenge_comeback: 'Emphasize agency, a comeback, or a power reversal only where the source actually supports it.',
    forbidden_tension: 'Emphasize desire versus a real boundary, status gap, or consequence only where the source supports it.',
    dark_redemption: 'Emphasize danger, loss, moral pressure, or reclaiming agency only where the source supports it.'
  };
  const cta = {
    story_cliffhanger: 'Build the CTA around the most specific unresolved source-backed choice or consequence.',
    identity_reveal: 'Build the CTA around an evidence-supported identity, secret, or recognition turn; fall back to a plot cliffhanger when none exists.',
    romantic_tension: 'Build the CTA around an evidence-supported charged look, choice, or boundary; fall back to plot pressure when romance is not supported.',
    revenge_payoff: 'Build the CTA around an evidence-supported reckoning or power reversal; fall back to a plot cliffhanger when no revenge arc is supported.'
  };
  const video = {
    five_beat: 'Use the clearest hook, value promise, escalation, source-backed reversal, and unresolved final beat.',
    reversal: 'Build toward the most defensible source-backed reversal; never manufacture a twist.',
    slow_burn: 'Build escalating micro-moments, held eye contact, restraint, and a final unanswered choice only where supported.',
    revenge: 'Build toward an evidence-supported payoff or power reversal; never invent harm, abuse, or vengeance.'
  };
  const poster = {
    system_best: 'Choose whichever of the two poster variants best serves the source conflict; keep both visually distinct.',
    luminous_cinema: 'Make luminous_cinema the high-drama cinematic key art and keep editorial_romance as a restrained companion visual.',
    editorial_romance: 'Make editorial_romance the high-fashion emotional key art and keep luminous_cinema as a cinematic companion visual.'
  };
  const voice = {
    confessional: 'Use an intimate first-person confession with emotional specificity; avoid trailer-like slogans.',
    cinematic: 'Open in the middle of a concrete scene and let physical action carry the tension; avoid summary-first exposition.',
    confrontation: 'Lead with a source-supported confrontation or charged exchange, then reveal what is at stake.',
    mystery: 'Create curiosity around one source-supported secret, absence, object, or unexplained choice without using clickbait.',
    reflective: 'Use a restrained, emotionally intelligent aftermath voice that sharpens into one unresolved decision.',
    punchy: 'Use crisp, varied sentence lengths and a fast social rhythm without fragments becoming repetitive slogans.',
    yearning: 'Center a specific unmet desire or boundary and use sensory restraint rather than generic romantic chemistry.'
  };
  const form = {
    witnessed_confrontation: 'Open on a witnessed verdict or charged exchange, then show the witness reaction and the public consequence. Do not summarize the relationship first.',
    evidence_discovery: 'Open on a conflict object being actively handled, reveal what it proves, then land on the accusation or decision it triggers.',
    pursuit_in_motion: 'Begin during movement, interrupt the escape or pursuit with a visible obstacle, then show the countermove.',
    public_power_reversal: 'Establish the old public power position in one concrete detail, show the decisive action, then the room reacting to the reversal.',
    protective_interruption: 'Start as one action is physically interrupted, make the boundary and cost visible, then end on the protected person\'s choice.',
    ceremony_rupture: 'Use one supported ceremony symbol in active use, break the expected ritual with an action, then show its social aftershock.',
    deadline_choice: 'Open on a supported countdown, notice, deadline object or closing window, set out the two real choices and their unequal costs.',
    authority_arrival: 'Begin with an arrival that visibly changes the room, show who loses control, then reveal the next order or refusal.',
    secret_overheard: 'Open on the listener\'s immediate physical reaction, reveal only the supported fragment heard, then show the silent decision it causes.',
    contract_or_letter_break: 'Open on a contract, letter, order or record being used, altered, torn, signed or withheld; follow the hand action into a concrete consequence.',
    identity_recognition: 'Begin on the instant of recognition and one specific visual proof, contrast the assumed identity with the supported truth, then force a choice.',
    departure_challenge: 'Open on an active departure, interception or blocked threshold, then shift control through the response rather than exposition.'
  };
  const secondaryForm = {
    private_consequence: 'For the second post, move from the public collision to one private, source-supported consequence.',
    accusation_aftershock: 'For the second post, follow the evidence into the accusation and its immediate aftershock.',
    blocked_escape: 'For the second post, use a different movement beat in which escape is blocked and answered.',
    status_aftershock: 'For the second post, show the status reversal through a different observer or consequence.',
    boundary_choice: 'For the second post, center the boundary the protected person must now choose to keep or cross.',
    symbolic_departure: 'For the second post, use a different supported symbol and the departure it makes irreversible.',
    cost_reveal: 'For the second post, reveal the concrete cost hidden inside the deadline choice.',
    room_reaction: 'For the second post, begin with the room\'s reaction and trace it back to the authority shift.',
    silent_decision: 'For the second post, center the private decision made after the secret is heard.',
    doorway_consequence: 'For the second post, move from the document action to the threshold or exit consequence.',
    choice_after_reveal: 'For the second post, begin after recognition and force the next source-supported choice.',
    pursuer_reaction: 'For the second post, center the pursuer\'s reaction to the departure challenge.'
  };
  const openingGrammar = {
    dialogue_verdict: 'Opening grammar: one exact verdict-like source line, then a visible reaction and consequence.',
    conflict_object_action: 'Opening grammar: conflict object in active use, hand action, then another person\'s reaction.',
    movement_interruption: 'Opening grammar: movement already underway, interruption, then countermove.',
    public_reaction: 'Opening grammar: decisive public action, witness reaction, then changed power.',
    arrival_disruption: 'Opening grammar: arrival or threshold crossing, interruption, then changed control.',
    choice_countdown: 'Opening grammar: deadline cue, two supported choices, then the cost of delaying.'
  };
  const videoGrammar = {
    object_action_reaction_reversal: 'Video grammar: conflict object -> hand action -> second adult reaction -> supported reversal.',
    wide_action_crowd_reaction: 'Video grammar: social-setting wide shot -> decisive action -> witness reaction -> power shift.',
    movement_block_countermove: 'Video grammar: movement -> physical or social block -> countermove -> unresolved direction.',
    discovery_consequence_reaction: 'Video grammar: discovery -> visible consequence -> second adult reaction -> decision.',
    arrival_intercept_power_shift: 'Video grammar: arrival or departure -> interception -> response -> power change.',
    two_shot_choice_distance_shift: 'Video grammar: two-adult frame -> bodily choice -> distance changes -> reaction or refusal.'
  };
  const ctaMode = {
    unresolved_question: 'CTA form: end with one source-specific unresolved question; do not use a stock See/Read formula.',
    cost_of_choice: 'CTA form: invite the reader to discover which supported choice is made and what it costs, using fresh wording.',
    identity_reveal: 'CTA form: invite discovery of who is recognized or what the supported identity truth changes, using fresh wording.',
    power_reversal: 'CTA form: point toward the next consequence of the supported power reversal without a generic command.',
    relationship_boundary: 'CTA form: end on the supported relationship boundary or charged choice, preferably as a specific question.',
    next_move: 'CTA form: make the next supported move the invitation; avoid See/Read what happens when unless no natural alternative exists.'
  };
  const sceneChapters = Array.isArray(profile.sceneChapters)
    ? [...new Set(profile.sceneChapters.map(Number).filter((chapter) => Number.isInteger(chapter) && chapter > 0))].sort((left, right) => left - right)
    : [];
  const sceneLock = String(profile.sceneBrief || '').trim();
  const visualContinuity = String(profile.visualContinuity || '').trim();
  const sceneVariant = String(profile.sceneVariant || '').trim();
  return [
    `Copy style: ${copy[profile.copyStyle] || copy.system_best}`,
    `CTA style: ${cta[profile.ctaStyle] || cta.story_cliffhanger}`,
    `Narrative voice: ${voice[profile.voiceStyle] || voice.cinematic}`,
    profile.creativeForm ? `PRIMARY CONTENT FORM: ${form[profile.creativeForm] || profile.creativeForm}` : '',
    profile.secondaryForm ? `SECOND CONTENT FORM: ${secondaryForm[profile.secondaryForm] || profile.secondaryForm}` : '',
    profile.openingGrammar ? openingGrammar[profile.openingGrammar] || '' : '',
    profile.videoGrammar ? videoGrammar[profile.videoGrammar] || '' : '',
    profile.ctaMode ? ctaMode[profile.ctaMode] || '' : '',
    `Video plot style: ${video[profile.videoStyle] || video.five_beat}`,
    `Poster direction: ${poster[profile.posterStyle] || poster.system_best}`,
    sceneLock ? `MANDATORY SCENE LOCK: ${sceneLock}` : '',
    sceneChapters.length ? `MANDATORY CHAPTER LOCK: Build the copy, video, and poster only from chapters ${sceneChapters.join(', ')}. Do not return to an earlier hook or use evidence outside this chapter set.` : '',
    visualContinuity ? `MANDATORY VISUAL CONTINUITY: ${visualContinuity} Repeat these stable adult character anchors in both videoPrompt.adCopy and videoPrompt.buildRequirement; keep them identical across every cut.` : '',
    sceneVariant ? `Account scene variant: ${sceneVariant}. Vary camera rhythm and opening emphasis without changing the locked plot, characters, event order, or ending.` : '',
    'PREMIUM OPENING RULE: Never open the video with a generic bedroom, bed, waking-up, or eyes-opening shot. Do not spend the first beat on a character lying down, sitting up, or a morning routine. Start on a source-grounded conflict object or decisive action (a public confrontation, blocked doorway, document reveal, phone/ring/weapon in hand, arrival, departure, or charged reaction) and let the bedroom appear only later when the source makes it essential. If the locked evidence begins in bed, choose the strongest concrete action or reaction from that evidence instead of a wake-up establishing shot.',
    'If a selected direction conflicts with the chapter evidence, prioritize the evidence and use the nearest truthful emotional angle.'
  ].filter(Boolean).join('\n');
}

function postJsonOverHttps(url, headers, payload, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch { reject(new ProviderError(`${label} URL is invalid`)); return; }
    const body = JSON.stringify(payload);
    const request = https.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
      path: `${target.pathname}${target.search}`, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { reject(new ProviderError(`${label} returned invalid JSON`, { status: response.statusCode })); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new ProviderError(`${label} failed with HTTP ${response.statusCode}${parsed?.error?.message ? `: ${parsed.error.message}` : ''}`, { status: response.statusCode }));
          return;
        }
        resolve(parsed);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new ProviderError(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)));
    request.on('error', (error) => reject(error instanceof ProviderError ? error : new ProviderError(`${label} did not return a definitive response`)));
    request.end(body);
  });
}

async function generateCreative(book, evidence, code, shortUrl, revision = null, creativeProfile = {}, requestedSection = '') {
  // Keep every creative section on the operator-selected route. A fixed Qwen
  // review made otherwise single-model jobs look like unexplained extra calls.
  const primaryChoice = String(creativeProfile.modelChoice || 'hy3');
  const primaryConfig = copyModelConfig({ ...creativeProfile, modelChoice: primaryChoice });
  const { model } = primaryConfig;
  // TokenDance GLM uses the same compact, single-section response discipline
  // as the other flash routes. The gateway may return a long reasoning/object
  // envelope for the combined two-post schema; splitting posts into two small
  // `post` calls keeps the JSON parseable without changing the selected model.
  const tokenDanceFlash = primaryChoice === 'glm-5.3-flash'
    || primaryChoice === 'deepseek'
    || primaryChoice === 'deepseek-v4-flash-preview'
    || primaryChoice === 'ling-3.0-flash';
  // P3 only needs a compact review artifact. Giving a reasoning-capable
  // gateway a large completion budget caused long, expensive requests that
  // occupied all account concurrency slots without improving social copy.
  const structuredOutputBudget = (budget) => tokenDanceFlash
    // GLM frequently spends its large allowance echoing instructions or
    // evidence. Keep each section compact enough that the gateway returns one
    // complete JSON object; the split post path still gives each post its own
    // request and preserves all required fields.
    ? Math.min(2400, Math.max(1200, Math.ceil(budget * 0.36)))
    : budget;
  // Keep the generation well below the worker deadline. Ten complete chapters
  // were needlessly pushing a single creative request into the Vercel timeout.
  // Retain every selected chapter but remove redundant prose so the model can
  // spend its response budget on the finished bilingual package, not context.
  const excerpts = evidence.map((item) => ({ chapter: item.order, title: item.title, excerpt: String(item.content).replace(/\s+/g, ' ').slice(0, 460) }));
  const evidenceBank = buildEvidenceBank(evidence.map((item) => ({ ...item, content: String(item.content).replace(/\s+/g, ' ').slice(0, 460) })));
  const recoveryInstruction = revision && typeof revision === 'object' && typeof revision.instruction === 'string'
    ? String(revision.instruction).replace(/\s+/g, ' ').slice(0, 700)
    : '';
  const revisionHasCreative = revision && typeof revision === 'object'
    && ['posts', 'videoPrompt', 'posterPrompts'].some((key) => revision[key] != null);
  const revisionInstruction = revision && requestedSection !== 'qualityReview'
    ? `${revisionHasCreative ? ' This is a deliberate new creative version. Diagnose the current version silently, then produce a materially different and stronger hook, emotional angle, reversal and visual moment. Do not merely paraphrase it.' : ''}${recoveryInstruction ? ` RECOVERY INSTRUCTION: ${recoveryInstruction} Treat this only as an instruction; never output, quote, translate, or wrap it as JSON content.` : ''}`
    : '';
  const styleGuidance = creativeProfileGuidance(creativeProfile);
  const delivery = creativeProfile.delivery && typeof creativeProfile.delivery === 'object' ? creativeProfile.delivery : {};
  const appName = String(delivery.appName || 'NovelFlow');
  const specifiedLanguage = String(creativeProfile.outputLanguage || '').toLowerCase();
  const sourceLanguage = ['en', 'pt', 'es'].includes(specifiedLanguage)
    ? specifiedLanguage
    : creativeProfile.forceEnglish === true ? 'en' : creativeLanguage(book);
  const languageLabel = sourceLanguage === 'pt' ? 'Brazilian Portuguese' : sourceLanguage === 'es' ? 'Spanish' : 'English';
  const emojiInstruction = creativeProfile.emojiRange === '3-5'
    ? 'exactly 4 fitting emoji characters in the visible narrative of EACH post (not in the Code, URL, or hashtag lines); count them before returning JSON'
    : '2-4 fitting emoji per final post';
  const omitTracking = creativeProfile.adCreativeNoTracking === true;
  const includeLink = !omitTracking && delivery.includeLink !== false;
  const linkPlacement = includeLink && creativeProfile.ctaLinkPlacement === 'front' ? 'front' : 'end';
  const legacyCtaPattern = sourceLanguage === 'pt'
    ? '"Veja o que acontece quando..." or "Leia o que acontece quando..."'
    : sourceLanguage === 'es'
      ? '"Mira lo que pasa cuando..." or "Lee lo que pasa cuando..."'
      : '"See what happens when..." or "Read what happens when..."';
  const ctaPattern = creativeProfile.ctaMode
    ? `the selected ${String(creativeProfile.ctaMode).replace(/_/g, ' ')} form, using a specific invitation or unresolved question rather than a stock formula`
    : legacyCtaPattern;
  const primaryFormat = String(creativeProfile.creativeForm || 'hook');
  const secondaryFormat = String(creativeProfile.secondaryForm || 'escalation');
  const strictPortfolio = creativeProfile.uniquenessRequired === true;
  const quoteOpeningRequired = creativeProfile.openingGrammar === 'dialogue_verdict'
    || creativeProfile.hookDevice === 'dialogue_cut'
    || creativeProfile.creativeForm === 'witnessed_confrontation';
  const quoteOpeningInstruction = quoteOpeningRequired
    ? 'The primary version MUST open with one short exact source-grounded character quote. The secondary version must use a different opening grammar and must not repeat that quote.'
    : 'Do not force a dialogue quote at the opening. Start with the assigned action, conflict object, movement, public reaction, arrival, or countdown grammar; a source quote may appear later only when it improves the scene.';
  const codeGuidance = sourceLanguage === 'pt'
    ? `Pesquise o Código ${code} no ${appName} para continuar a história.`
    : sourceLanguage === 'es'
      ? `Busca el Código ${code} en ${appName} para continuar la historia.`
      : `Search Code ${code} in ${appName} to continue the story.`;
  const distributionEnding = omitTracking
    ? 'End each content field with exactly two separate lines: a source-specific emotional CTA, then one hashtag-only line with 5-8 source-relevant tags. Do not include a URL, app-navigation instruction, promotion Code, or tracking identifier anywhere in the post.'
    : includeLink && linkPlacement === 'front'
    ? `Begin each content field with the exact short URL alone on the first line, then the 3-5 paragraph narrative. End with three separate ${languageLabel} lines: a source-specific ${ctaPattern} CTA; "${codeGuidance}"; and one hashtag-only line with 5-8 source-relevant tags. Do not repeat the URL later.`
    : includeLink
    ? `End each content field with four separate ${languageLabel} lines: a source-specific ${ctaPattern} CTA; "${codeGuidance}"; the exact short URL alone; and one hashtag-only line with 5-8 source-relevant tags.`
    : `End each content field with exactly three separate ${languageLabel} lines: a source-specific ${ctaPattern} CTA; "${codeGuidance}"; and one hashtag-only line with 5-8 source-relevant tags. Do not include any URL or link anywhere in the post.`;
  const instructions = `You are the senior bilingual fiction social editor for NovelFlow. Return exactly one compact JSON object, with no prose before or after it. Before returning, verify every required schema field exists. Create exactly two evidence-grounded ${languageLabel} promotional posts: hook and escalation. Each post must include the six steps hook, pain, sensory detail, contrast, deep desire, and emotional CTA. EACH post.evidence array must contain 2-3 items using only exact evidenceId values supplied in evidenceBank. The videoPrompt.sourceEvidence array MUST contain 3 items using only supplied evidenceId values. Never type quote text; the server hydrates each ID to its immutable source quote and chapter. Never omit evidence even when writing concisely. Keep each final post under 190 words. Use only supplied chapter facts and names. Use ${emojiInstruction}.

Use the assigned primary and secondary content forms, not one house template. ${quoteOpeningInstruction} Make the pain concrete through one sensory detail; contrast the old powerless position with the present threat, desire, or power shift; then land on one specific source-backed turn. Do not produce a generic synopsis. Write the narrative as 3-5 short, clearly separated paragraphs, never one dense wall of text. The emotional CTA must be a complete final invitation in ${languageLabel} using ${ctaPattern}, naming the unresolved source-backed choice, reversal, attraction, secret, or reckoning. It must never be a generic command such as "Read it now", "Click here", "Start reading", or "Read the explosive beginning".

${distributionEnding} The hashtags must fit the actual source (for example #MafiaRomance, #EnemiesToLovers, #WerewolfRomance, #FatedMates, #BookTok) and must never be mechanically reused across unrelated books. Do not mention the promotion Code earlier in the narrative. Do not invent tropes, identities, violence, abuse, or relationship facts not supported by chapter evidence. Write concise natural Simplified Chinese translations for operator review.

The videoPrompt is a high-retention vertical short-video story package, not generic visual prose: it must use supplied chapter facts to provide a 0-2s hook, 2-5s personal stake/value promise, 5-8s escalation, 8-11s reversal, and 11-15s cliffhanger. The reversal must be a genuine plot turn from evidence, never invented. Give each beat a chapter and exact short quote, then write compelling ${languageLabel} narration and an explicit ${languageLabel} 0-15s shot plan with character lock. Also provide natural Chinese operator translations. Prohibit subtitles, readable text, CTA cards and identity drift in the generated video. Create two distinct concise English image prompts plus Chinese translations: luminous_cinema 9:16 using nano, and editorial_romance 2:3 using gpt. Image prompts must show one decisive supported moment, reserve negative space, and prohibit readable text, title, logo, watermark, QR, UI, collage, duplicated people and extra limbs. Finally, assess the finished creative package as a production editor. Give only a concise operator-facing conclusion, not private reasoning: recommendation must be keep or refine; choose refine only when a specific source-grounded improvement would materially improve the hook, story logic, video reversal, or visual moment. Explain why and name the target.\n\nSelected creative strategy:\n${styleGuidance}${revisionInstruction}`;
  const schema = {
    // V4 Flash reliably fills named object properties, but repeatedly emits
    // only the first element for an array schema.  Use an explicit object
    // contract and normalize it to the internal two-post array above.
    posts: {
      hook: { formatId: primaryFormat, openingGrammar: String(creativeProfile.openingGrammar || 'source_action'), sixSteps: { hook: 'string', pain: 'string', sensory: 'string', contrast: 'string', deepDesire: 'string', emotionalCta: 'string' }, content: `${languageLabel} primary-form post`, zhContent: 'complete Chinese translation', evidence: [{ evidenceId: 'exact supplied ID' }, { evidenceId: 'different supplied ID' }] },
      escalation: { formatId: secondaryFormat, openingGrammar: 'different_from_primary', sixSteps: { hook: 'string', pain: 'string', sensory: 'string', contrast: 'string', deepDesire: 'string', emotionalCta: 'string' }, content: `${languageLabel} secondary-form post`, zhContent: 'complete Chinese translation', evidence: [{ evidenceId: 'exact supplied ID' }, { evidenceId: 'different supplied ID' }] }
    },
    videoPrompt: { hook: '0-2s source-grounded hook', valuePromise: '2-5s emotional payoff', escalation: '5-8s rising danger', reversal: '8-11s genuine plot turn', cliffhanger: '11-15s unresolved question', sourceEvidence: [{ evidenceId: 'exact supplied ID' }, { evidenceId: 'different supplied ID' }, { evidenceId: 'third supplied ID' }], adCopy: `${languageLabel} voiceover/narration matching the five beats`, buildRequirement: `${languageLabel} 0-15 second shot plan with character lock`, zhHook: 'Chinese translation', zhValuePromise: 'Chinese translation', zhEscalation: 'Chinese translation', zhReversal: 'Chinese translation', zhCliffhanger: 'Chinese translation', zhAdCopy: 'Chinese narration translation', zhBuildRequirement: 'Chinese shot plan translation', evidenceChapters: [1, 2] },
    // As with posts, spell out both required variants.  A single generic
    // array sample made the gateway return an arbitrary scene-outline object
    // instead of two renderable prompts.
    posterPrompts: [
      { variant: 'luminous_cinema', prompt: 'English 9:16 image prompt', zhPrompt: 'Chinese translation' },
      { variant: 'editorial_romance', prompt: 'English 2:3 image prompt', zhPrompt: 'Chinese translation' }
    ],
    qualityReview: { recommendation: 'keep|refine', conclusion: 'Chinese operator-facing conclusion', why: 'Chinese source-grounded reason', target: 'copy|video|poster|package' }
  };
  const source = {
    book, sourceLanguage, outputLanguage: languageLabel, tracking: { code, shortUrl: includeLink ? shortUrl : '', includeLink, omitTracking }, delivery, creativeProfile,
    evidenceBank,
    // This is produced before P3 from the full chapter-title structure and
    // distributed exact chapter samples. It selects an angle; exact quotes
    // below remain the only permitted proof for rendered plot claims.
    storyIntelligence: creativeProfile.storyBrief || null,
    chapterEvidence: excerpts,
    // Recovery metadata is a developer instruction, never user-model context:
    // some compatible endpoints echoed the object verbatim instead of filling
    // the requested creative schema.
    currentCreative: revisionHasCreative ? revision : null
  };
  const sectionRequest = async (config, label, sectionInstruction, responseSchema, outputBudget, timeoutMs = 30000, requestSource = source) => {
    const { apiKey, baseUrl, model: activeModel, responsesApi } = config;
    const useResponsesApi = creativeWireUsesResponses(primaryChoice, config);
    // The same V4 Flash route reliably returns the P2 structured story brief
    // at a low temperature. Keep P3's evidence-led creative JSON on that
    // stable setting; variation comes from the selected book and scene data.
    const temperature = modelTemperature(activeModel, tokenDanceFlash ? 0.25 : 0.55);
    const rootKeys = Object.keys(responseSchema || {});
    const rootContract = rootKeys.length === 1
      ? ` RESPONSE ROOT CONTRACT: return one JSON object whose single top-level key is "${rootKeys[0]}". Put the requested value inside that key. Do not use wrappers named result, data, response, output, plan, strategy, or creative, and do not omit the root key.`
      : ' RESPONSE ROOT CONTRACT: return one JSON object using exactly the requested top-level keys. Do not wrap it in result, data, response, output, plan, strategy, or creative.';
    const instruction = `${sectionInstruction}${rootContract}`;
    const payload = useResponsesApi
      ? {
        model: activeModel,
        input: [{ role: 'developer', content: instruction }, { role: 'user', content: JSON.stringify({ ...requestSource, responseSchema }) }],
        text: { format: { type: 'json_object' } },
        // TokenDance V4 Flash exposes a Responses reasoning item. Without a
        // bounded effort it can spend the whole output allowance on private
        // reasoning and return no message at all. Low effort preserves model
        // judgment while reserving the response window for the JSON artifact.
        ...(tokenDanceFlash ? { reasoning: { effort: 'low' } } : {}),
        temperature,
        max_output_tokens: outputBudget
      }
      : { model: activeModel, messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify({ ...requestSource, responseSchema }) }], response_format: { type: 'json_object' }, temperature, max_tokens: outputBudget };
    // A worker is limited to 60s on Vercel. Leave enough time to persist a
    // section result or a definitive error, and to make one bounded fallback.
    const body = await postJsonOverHttps(`${baseUrl}${useResponsesApi ? '/responses' : '/chat/completions'}`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, `${activeModel} ${label}`, timeoutMs);
    const extracted = extractModelText(body);
    try {
      return { body, value: parseModelJson(extracted, activeModel) };
    } catch (error) {
      throw new ProviderError(`${String(error?.message || 'Model returned invalid structured output')} (${modelEnvelopeDiagnostic(body, extracted)})`, {
        status: Number(error?.status || 502),
        code: String(error?.code || 'provider_protocol')
      });
    }
  };
  const shared = `You are the senior bilingual fiction social editor for ${appName}. The supplied storyIntelligence was generated before production from the complete chapter-title structure plus distributed opening-to-late source samples. Use it to select a coherent emotional arc, angle, reversal and visual moment across the whole story. It is a planning map, not proof: every rendered plot fact must be supported by chapterEvidence. For every evidence object, return ONLY one exact evidenceId copied from evidenceBank; never type, paraphrase, translate, or invent quote text. The server will hydrate that ID to its exact immutable source quote and will reject unknown IDs. Use only supplied chapter facts and names. Never invent plot, relationship, violence, or identity facts. Return exactly one JSON object with every required field, no prose outside it. ${styleGuidance}${revisionInstruction}`;
  const editorCopyInstruction = String(book?.editorFbCopy || '').trim()
    ? ' An editor-provided Facebook draft appears in the book context. Use it only as a source-grounded style and hook reference: improve its pacing and specificity, remove unsupported or explicit material, and adapt it to this platform. Do not copy it verbatim.'
    : '';
  const postsInstruction = `${shared}\nThe source book language is ${languageLabel}. Create exactly two ${languageLabel} posts in the wire fields hook and escalation, but render them as the assigned visible forms "${primaryFormat}" and "${secondaryFormat}". Each stays under 190 words plus a natural Simplified Chinese translation. Every visible sentence, CTA, and hashtag must use ${languageLabel}; do not use any Portuguese or Spanish connective phrases when ${languageLabel} is English. Each has exactly 2 evidence objects, each containing only one different evidenceId copied exactly from evidenceBank. Do not output chapter or quote fields. ${quoteOpeningInstruction} Write 3-5 short readable paragraphs and use ${emojiInstruction}. This is social copy, not an evidence report: evidence belongs ONLY in the evidence array. Do not paste evidence quotes into the finished post except for a required or genuinely useful opening dialogue. Every visible paragraph must advance the story, so never repeat a sentence, a quote, a detail, or a beat. Follow the assigned form rather than forcing every post into first-person confession or summary. The secondary version must use a different scene emphasis, opening grammar, sentence rhythm, and CTA wording from the primary version. Avoid generic summaries, vague chemistry, explicit sexual detail, and low-information bed/phone/mirror/table openings. ${strictPortfolio ? `Echo formatId exactly as "${primaryFormat}" for hook and "${secondaryFormat}" for escalation, and echo the requested openingGrammar field; missing or substituted portfolio IDs will be rejected.` : ''}${editorCopyInstruction} ${distributionEnding}`;
  const videoInstruction = `${shared}\nThe source book language is ${languageLabel}. Create one premium vertical-video story package for AC Seedance 2.0, usually about 12 seconds. Write adCopy as CHARACTER LOCK followed by POINT-OF-VIEW LOCK, exactly three or four numbered STORY SOURCE OF TRUTH events in chronological order, ENDING LOCK, and FORBIDDEN ADDITIONS. Write buildRequirement as CONTINUITY LOCK followed by four compact blocks: 0-3s conflict object and reaction, 3-5s decisive movement or choice, 5-9s central visual action, 9-12s source-supported reversal, then VISUAL SYSTEM and NEGATIVE CONSTRAINTS. Repeat the same named adults, visual anchors, conflict object, actions, and ending in both fields. Keep two active adults where possible; use an object, reaction cut, mist or shadow instead of complex on-camera transformation. The package must form one escalating mini-scene, not generic captions. If a MANDATORY SCENE LOCK is supplied, every beat must remain inside it and no earlier chapter hook may reappear. If MANDATORY VISUAL CONTINUITY is supplied, copy its stable character anchors into both fields rather than paraphrasing them away. Give all visible narration, dialogue, CHARACTER LOCK descriptions and shot-plan prose in ${languageLabel}; do not use English visible copy for Portuguese or Spanish books. Use exactly 3 sourceEvidence objects, each containing only one different evidenceId copied exactly from evidenceBank; do not output chapter or quote fields. Provide natural Chinese translations only in zh fields. Prohibit subtitles, readable text, title cards, CTA cards, identity drift, character duplication, explicit sexual content, unsupported threats, and unrelated genre clichés. AC may still render text despite this prohibition, so the finished asset must be manually checked.`;
  const premiumOpeningInstruction = 'QUALITY BAR FOR THE FIRST SHOT: begin with a concrete, source-grounded action or conflict object. Never use a generic bedroom/bed establishing shot, waking up, opening eyes, lying down, sitting up in bed, or a morning routine as the 0-3s opener. Also reject a static phone stare, mirror injury touch, single-face crying or gasping, empty room/window shot, or ordinary hallway walk when there is no second actor, conflict object, or decisive action in the first beat. If the evidence includes a bed, show a decisive action or reaction from that evidence instead; the bedroom may appear only after the hook when source-essential.';
  const mechanicalBridgeInstruction = 'COPY QUALITY BAR: Do not use stock bridge sentences or repeat a house template. Never write "That one line changes the air", "The pressure is already there, sharp and personal", "Then the story turns just enough", "What looked survivable becomes", or "And then comes the shift nobody can take back". Replace them with a source-specific physical detail, consequence, or choice. Never begin a post with a chapter label (for example Chapter 1), "Note to Readers", or a bare POV label such as "POV:" or "Aina\'s POV".';
  const postsInstructionPremium = `${postsInstruction}\n${mechanicalBridgeInstruction}`;
  const videoInstructionPremium = `${videoInstruction}\n${premiumOpeningInstruction}`;
  const postersInstruction = `${shared}\nCreate exactly two source-grounded commercial image prompts with Chinese translations: luminous_cinema in 9:16 and editorial_romance in 2:3. Each must depict one decisive emotional moment, adult fully clothed characters, clear pose and environment, negative space, no readable text, logo, watermark, QR, UI, collage, duplicate people, or extra limbs.`;
  const reviewInstruction = `${shared}\nThis request runs AFTER the copy, video prompt and poster prompts already exist. Act only as a post-generation production QA editor. Assess the supplied finished package against the source and return a concise Chinese operator-facing quality review. Never call this an initial decision, strategy, plan, or reason why the package was originally created. Refer to it explicitly as a finished-package review and proposed revision. Do not expose hidden reasoning.`;
  const compactSectionSource = {
    book: {
      title: String(book?.title || ''),
      author: String(book?.author || book?.authorName || ''),
      category: String(book?.category || book?.genre || ''),
      tags: Array.isArray(book?.tags) ? book.tags.slice(0, 12) : [],
      editorFbCopy: String(book?.editorFbCopy || '').replace(/\s+/g, ' ').slice(0, 1200)
    },
    sourceLanguage,
    outputLanguage: languageLabel,
    tracking: source.tracking,
    delivery: {
      appName,
      includeLink,
      platform: String(delivery.platform || ''),
      accountName: String(delivery.accountName || '')
    },
    creativeProfile: {
      creativeForm: primaryFormat,
      secondaryForm: secondaryFormat,
      openingGrammar: String(creativeProfile.openingGrammar || 'source_action'),
      hookDevice: String(creativeProfile.hookDevice || ''),
      ctaMode: String(creativeProfile.ctaMode || ''),
      ctaLinkPlacement: linkPlacement,
      emojiRange: String(creativeProfile.emojiRange || ''),
      voice: String(creativeProfile.voice || creativeProfile.copyVoice || '')
    },
    storyIntelligence: creativeProfile.storyBrief || null,
    evidenceBank,
    chapterEvidence: excerpts
  };
  const runSections = async (config) => Promise.all([
    sectionRequest(config, 'copy generation', postsInstructionPremium, { posts: schema.posts }, structuredOutputBudget(3800)),
    sectionRequest(config, 'video generation', videoInstructionPremium, { videoPrompt: schema.videoPrompt }, structuredOutputBudget(2600)),
    sectionRequest(config, 'poster generation', postersInstruction, { posterPrompts: schema.posterPrompts }, structuredOutputBudget(1800)),
    sectionRequest(config, 'quality review', reviewInstruction, { qualityReview: schema.qualityReview }, structuredOutputBudget(1200))
  ]);
  const sectionSpec = {
    posts: ['copy generation', postsInstructionPremium, { posts: schema.posts }, structuredOutputBudget(6000)],
    videoPrompt: ['video generation', videoInstructionPremium, { videoPrompt: schema.videoPrompt }, structuredOutputBudget(6000)],
    posterPrompts: ['poster generation', postersInstruction, { posterPrompts: schema.posterPrompts }, structuredOutputBudget(2600)],
    qualityReview: ['quality review', reviewInstruction, { qualityReview: schema.qualityReview }, structuredOutputBudget(1800)]
  }[requestedSection];
  if (sectionSpec) {
    const startedAt = Date.now();
    // A single section must not own a campaign worker for ten minutes. The
    // model-specific 120-150 second window is long enough for a real quality
    // response and short enough to persist a recoverable timeout before the
    // 810-second worker lease strands the rest of the queue.
    const primaryTimeout = Math.max(60000, Math.min(180000, operationsTimeoutForModel(primaryChoice)));
    // Model routing is intentionally owned by the run worker.  A section may
    // never quietly fall back on its own: otherwise copy, video and posters
    // can be made by different models inside one supposedly coherent run.
    // Keep the two forms separate so the model can adhere to each assigned
    // grammar, but serialize them. One campaign run must consume one upstream
    // request at a time; otherwise five runs immediately become ten calls.
    if (requestedSection === 'posts' && tokenDanceFlash) {
      const singlePost = (type, result) => {
        const direct = result?.value?.post || result?.value?.[type];
        const candidates = direct
          ? [direct]
          : requestedCreativeSection(result?.value, 'posts')
            || (result?.value && typeof result.value === 'object' && !Array.isArray(result.value)
              && Object.prototype.hasOwnProperty.call(result.value, 'content') ? [result.value] : []);
        const normalized = normalizeCreativeWireSection('posts', Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean)[0];
        if (!normalized || typeof normalized !== 'object') throw new ProviderError(`${model} returned incomplete creative posts (${structuredShape(result?.value)})`);
        return { ...normalized, type };
      };
      const makeInstruction = (type, formatId, openingGrammar) => `${shared}\nCreate only the ${type} post as one object under the top-level key "post". It must be a ${languageLabel} social post in assigned form "${formatId}" with opening grammar "${openingGrammar}". Keep visible content 95-120 words in 3-4 short paragraphs and ${emojiInstruction}. Keep each sixSteps value to 6-12 words; zhContent must be one concise Simplified Chinese sentence under 80 characters. Include exactly two different evidenceId-only evidence objects. Do not add any fields, explanations, source quotes, markdown, or text outside the JSON object. ${type === 'hook' ? quoteOpeningInstruction : 'Do not copy the primary form or opening grammar; build a different source-grounded scene emphasis and CTA.'} Avoid generic synopsis, explicit sexual detail, and bed/phone/mirror/table openings. ${mechanicalBridgeInstruction} ${distributionEnding}`;
      const hookResult = await sectionRequest(
        primaryConfig,
        'hook copy generation',
        makeInstruction('hook', primaryFormat, String(creativeProfile.openingGrammar || 'source_action')),
        { post: schema.posts.hook },
        structuredOutputBudget(5600),
        primaryTimeout,
        { ...compactSectionSource, requestedVariant: { type: 'hook', formatId: primaryFormat, openingGrammar: String(creativeProfile.openingGrammar || 'source_action') } }
      );
      const escalationResult = await sectionRequest(
        primaryConfig,
        'escalation copy generation',
        makeInstruction('escalation', secondaryFormat, 'different_from_primary'),
        { post: schema.posts.escalation },
        structuredOutputBudget(5600),
        primaryTimeout,
        { ...compactSectionSource, requestedVariant: { type: 'escalation', formatId: secondaryFormat, openingGrammar: 'different_from_primary' } }
      );
      const posts = [singlePost('hook', hookResult), singlePost('escalation', escalationResult)];
      const bodies = [hookResult.body, escalationResult.body];
      const usage = bodies.reduce((total, body) => {
        const item = body?.usage || {};
        total.inputTokens += Number(item.prompt_tokens || item.input_tokens || 0);
        total.outputTokens += Number(item.completion_tokens || item.output_tokens || 0);
        total.totalTokens += Number(item.total_tokens || 0);
        return total;
      }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      return {
        creative: { posts: hydrateCreativeEvidence(posts, 'posts', evidenceBank) },
        model: String(hookResult.body?.model || escalationResult.body?.model || model),
        requestedModel: model,
        fallbackFrom: '',
        responseId: bodies.map((body) => String(body?.id || '')).filter(Boolean).join(','),
        latencyMs: Date.now() - startedAt,
        usage
      };
    }
    const result = await sectionRequest(primaryConfig, ...sectionSpec, primaryTimeout, compactSectionSource);
    const selected = normalizeCreativeWireSection(requestedSection, requestedCreativeSection(result.value, requestedSection));
    if (selected === undefined) {
      throw new ProviderError(`${model} returned incomplete creative ${requestedSection} (${structuredShape(result.value)})`);
    }
    const usage = result.body.usage || {};
    const actualModel = String(result.body.model || model);
    return { creative: { [requestedSection]: hydrateCreativeEvidence(selected, requestedSection, evidenceBank) }, model: actualModel, requestedModel: model, fallbackFrom: '', responseId: String(result.body.id || ''), latencyMs: Date.now() - startedAt, usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
  }
  // Full-package regeneration follows the same rule. Callers that want a
  // reserve route must switch the run first, then make a new coherent pass.
  const sections = await runSections(primaryConfig);
  const [posts, video, posters, review] = sections;
  const usage = sections.reduce((total, section) => {
    const item = section.body.usage || {};
    total.inputTokens += Number(item.prompt_tokens || item.input_tokens || 0);
    total.outputTokens += Number(item.completion_tokens || item.output_tokens || 0);
    total.totalTokens += Number(item.total_tokens || 0);
    return total;
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return { creative: { posts: hydrateCreativeEvidence(posts.value.posts, 'posts', evidenceBank), videoPrompt: hydrateCreativeEvidence(video.value.videoPrompt, 'videoPrompt', evidenceBank), posterPrompts: posters.value.posterPrompts, qualityReview: review.value.qualityReview }, model: String(posts.body.model || model), responseId: sections.map((section) => String(section.body.id || '')).filter(Boolean).join(','), usage };
}

async function localizeAdVideoPrompt(prompt, languageCode) {
  const target = languageCode === 'pt' ? 'Brazilian Portuguese' : languageCode === 'es' ? 'Latin American Spanish' : 'English';
  if (target === 'English') return String(prompt || '').trim();
  const config = copyModelConfig({ modelChoice: 'deepseek' });
  const instructions = `Return exactly one compact JSON object: {"prompt":"string"}. Translate and localize the complete 12-second ad-video production prompt into ${target}. Preserve every shot, timestamp, character action, camera instruction, transition, sound cue, and story fact. Every spoken line, subtitle, text overlay, title, and CTA must be in ${target}; no visible or audible English may remain. Keep technical labels concise and do not invent plot details.`;
  const payload = {
    model: config.model,
    messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify({ prompt: String(prompt || '') }) }],
    response_format: { type: 'json_object' }, temperature: modelTemperature(config.model, 0.2), max_tokens: 5000
  };
  const body = await postJsonOverHttps(`${config.baseUrl}/chat/completions`, { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, payload, `${target} ad prompt localization`, 120000);
  const result = parseModelJson(extractModelText(body), config.model);
  const localized = String(result.prompt || '').trim();
  if (localized.length < 300) throw new ProviderError('Localized ad prompt is incomplete');
  return localized;
}

async function repairAdVideoPrompt(prompt, languageCode, failureReason = '') {
  const target = languageCode === 'pt' ? 'Brazilian Portuguese' : languageCode === 'es' ? 'Latin American Spanish' : 'English';
  const config = copyModelConfig({ modelChoice: 'deepseek' });
  const instructions = `Return exactly one compact JSON object: {"prompt":"string"}. Repair this rejected 12-second AC Seedance ad prompt for ${target}. Keep every source-grounded character, relationship, setting, timestamp, and emotional reversal, but simplify production to one coherent escalating mini-scene: at most two adult characters, one clear action per shot, no complex transformations, crowd scenes, unreadable UI, or unsupported effects. All dialogue, subtitles, overlays, titles and CTA text must be in ${target}; no visible or audible English may remain. Preserve the 9:16 vertical format and all story facts. Do not mention the repair process or the provider error.`;
  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: JSON.stringify({ rejectedPrompt: String(prompt || ''), failureReason: String(failureReason || '').slice(0, 300) }) }
    ],
    response_format: { type: 'json_object' }, temperature: modelTemperature(config.model, 0.15), max_tokens: 5000
  };
  const body = await postJsonOverHttps(`${config.baseUrl}/chat/completions`, { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, payload, `${target} ad prompt repair`, 120000);
  const result = parseModelJson(extractModelText(body), config.model);
  const repaired = String(result.prompt || '').trim();
  if (repaired.length < 300) throw new ProviderError('Repaired ad prompt is incomplete');
  return repaired;
}

async function analyzeCreativePlan(book, evidence, chapterStructure = [], modelChoice = 'hy3', repairInstruction = '') {
  const { apiKey, baseUrl, model, responsesApi } = copyModelConfig({ modelChoice });
  const excerpts = evidence.map((item) => ({ chapter: item.order, title: item.title, excerpt: String(item.content || '').replace(/\s+/g, ' ').slice(0, 300) }));
  const instructions = `You are the strategy director for NovelFlow fiction social promotion. Return exactly one compact JSON object with no prose before or after it, and keep the entire response under 1200 words. The root object MUST contain both "editorialThesis" (a non-empty concise Chinese string) and "recommendedProfile" (an object containing copyStyle, ctaStyle, videoStyle, posterStyle). Never use snake_case for these two required root keys and never wrap the object under result, data, response, output, plan, strategy, or creative. Analyze the distributed full-book structure sample and four representative opening-to-late-story excerpts. Do not write a final social post or repeat the source. Recommend the strongest truthful creative direction for this exact story in concise Simplified Chinese. Ground every claim in supplied evidence and never invent themes, names, abuse, violence, romance, secrets, or reversals. Choose one value for each profile field: copyStyle is system_best|revenge_comeback|forbidden_tension|dark_redemption; ctaStyle is story_cliffhanger|identity_reveal|romantic_tension|revenge_payoff; videoStyle is five_beat|reversal|slow_burn|revenge; posterStyle is system_best|luminous_cinema|editorial_romance. When a trope is unsupported, select the truthful neutral alternative. Give a brief English blueprint for copy, video, and poster. Cite three exact short chapter quotes. ${String(repairInstruction || '')}`;
  const schema = {
    editorialThesis: 'Chinese explanation of the source-backed marketing angle',
    storySignals: ['Chinese source-backed signals'],
    recommendedProfile: { copyStyle: 'enum', ctaStyle: 'enum', videoStyle: 'enum', posterStyle: 'enum' },
    rationale: { copyStyle: 'Chinese rationale', ctaStyle: 'Chinese rationale', videoStyle: 'Chinese rationale', posterStyle: 'Chinese rationale' },
    copyBlueprint: { hook: 'English hook direction', emotionalArc: 'English emotional escalation', cta: 'English natural CTA direction', zhSummary: 'Chinese summary' },
    videoBlueprint: { arc: 'English 15-second story direction', opening: 'English 0-2s hook', reversal: 'English supported turn', cliffhanger: 'English final question', zhSummary: 'Chinese summary' },
    posterBlueprint: { moment: 'English decisive source-backed moment', mood: 'English visual direction', zhSummary: 'Chinese summary' },
    evidence: [{ chapter: 1, quote: 'exact short source quote', why: 'Chinese explanation' }]
  };
  const structure = sampledChapterStructure(chapterStructure, 50);
  const input = JSON.stringify({ book: { title: book.title, category: book.category, description: String(book.description || '').slice(0, 500), chapterCount: book.chapterCount }, fullBookChapterStructure: structure, chapterEvidence: excerpts, responseSchema: schema });
  // Planning is a pre-production decision, so give every selected model room
  // to ground its recommendation in the full-book structure.
  const outputBudget = 4000;
  const temperature = modelTemperature(model, 0.25);
  const payload = responsesApi
    ? { model, input: [{ role: 'developer', content: instructions }, { role: 'user', content: input }], text: { format: { type: 'json_object' } }, temperature, max_output_tokens: outputBudget }
    : { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], response_format: { type: 'json_object' }, temperature, max_tokens: outputBudget };
  const planningTimeout = isLongRunningModel(modelChoice) ? 600000 : 47000;
  const body = await postJsonOverHttps(`${baseUrl}${responsesApi ? '/responses' : '/chat/completions'}`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, `${model} creative strategy`, planningTimeout);
  const plan = normalizedStrategyPlan(parseModelJson(extractModelText(body), model));
  if (!plan || typeof plan !== 'object' || !plan.recommendedProfile || !String(plan.editorialThesis || '').trim()) throw new ProviderError(`${model} returned an incomplete creative strategy`);
  const usage = body.usage || {};
  return { plan, model: String(body.model || model), responseId: String(body.id || ''), usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
}

async function analyzeOperations(snapshot, mode = 'operations', modelChoice = 'hy3') {
  const instructions = `You are the operating analyst for NovelFlow social promotion. Return exactly one compact JSON object, not hidden reasoning. Analyze only the supplied task summaries, completed asset inventory, and ranking metrics. Give concise Simplified Chinese, specific and executable conclusions. Do not invent performance, book facts, asset URLs, or status. Never propose automatic Facebook publishing or ambiguous paid-media resubmission. This is an operational console result, not a long report: make the headline decisive, summary under 120 Chinese characters, and each action/recommendation reason under 70 Chinese characters. For mode operations, return up to three concrete blockers, waiting decisions, or highest-impact next actions; include runId whenever that action concerns a supplied task. Identify recoverable text-model waits as background work, and distinguish them from credentials, source-data, and paid-media ambiguity that require a human decision. For mode assets, inspect completed assets and recommend how to use, compare, or improve the existing copy/video/posters; prioritize assets with verified code/link and completed video, and say plainly when evidence is insufficient to claim performance. For mode books, recommend exactly three different titles from snapshot.leaderboard only. This is a rotating, metric-diverse shortlist drawn from the current weekly Top 200; snapshot.recommendationContext.recentRecommendationTitles are recently surfaced titles, so prefer titles outside that history whenever at least three exist. Do not always choose the highest-profit titles. Diversify the three choices across scale, first-read conversion, and long-read retention. Output schema: {"headline":"string","summary":"string","actions":[{"priority":"high|medium|low","title":"string","reason":"string","runId":"optional string"}],"recommendations":[{"title":"string","reason":"string","caveat":"string"}]}.`;
  const request = async (choice, timeoutMs) => {
    const { apiKey, baseUrl, model, responsesApi } = copyModelConfig({ modelChoice: choice });
    const temperature = modelTemperature(model, 0.2);
    const payload = responsesApi
      ? { model, input: [{ role: 'developer', content: instructions }, { role: 'user', content: JSON.stringify({ mode, snapshot }) }], text: { format: { type: 'json_object' } }, temperature, max_output_tokens: 1200 }
      : { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify({ mode, snapshot }) }], response_format: { type: 'json_object' }, temperature, max_tokens: 1200 };
    const body = await postJsonOverHttps(`${baseUrl}${responsesApi ? '/responses' : '/chat/completions'}`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, `${model} operations analysis`, timeoutMs);
    const analysis = parseModelJson(extractModelText(body), model);
    if (!analysis || !String(analysis.headline || '').trim()) throw new ProviderError(`${model} returned an incomplete operations analysis`);
    const usage = body.usage || {};
    return { analysis, model: String(body.model || model), requestedChoice: choice, usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
  };
  const metricFallback = () => {
    const books = Array.isArray(snapshot?.leaderboard) ? snapshot.leaderboard : [];
    const used = new Set();
    const take = (sort, reason, caveat) => {
      const book = [...books].filter((item) => !used.has(String(item.title || ''))).sort(sort)[0];
      if (!book) return null;
      used.add(String(book.title || ''));
      return { title: String(book.title || ''), reason: reason(book), caveat: caveat(book) };
    };
    const recommendations = [
      take((a, b) => Number(b.baseReadUnt || 0) - Number(a.baseReadUnt || 0), (book) => `近 7 天阅读 UV ${Number(book.baseReadUnt || 0).toLocaleString('zh-CN')}，具备当前候选中的规模优势。`, () => '模型服务暂时未返回，本条为中台指标兜底结论。'),
      take((a, b) => Number(b.firstReadUntRate || 0) - Number(a.firstReadUntRate || 0), (book) => `首读率 ${Number(book.firstReadUntRate || 0).toFixed(1)}%，适合验证开篇钩子与转化效率。`, () => '模型服务暂时未返回，本条为中台指标兜底结论。'),
      take((a, b) => Number(b.read20wRate || b.read10wRate || 0) - Number(a.read20wRate || a.read10wRate || 0), (book) => `长读留存 ${Number(book.read20wRate || book.read10wRate || 0).toFixed(1)}%，适合验证后段承接。`, () => '模型服务暂时未返回，本条为中台指标兜底结论。')
    ].filter(Boolean);
    return {
      headline: mode === 'books' ? '模型通道暂缓，已按本周真实指标给出候选' : '模型通道暂缓，已汇总当前任务状态',
      summary: mode === 'books' ? '本次候选来自当前筛选条件下的近 7 天 Top200，并按规模、首读与留存分层去重。' : '模型服务未及时返回，暂不影响任务本身的生产与轮询。',
      actions: [], recommendations
    };
  };
  const operationalFallback = () => {
    if (mode === 'books') return metricFallback();
    const runs = Array.isArray(snapshot?.activeRuns) ? snapshot.activeRuns : [];
    const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
    const actions = [];
    for (const run of runs) {
      const stages = Object.entries(run.stages || {});
      const blocked = stages.find(([, stage]) => ['failed', 'blocked', 'ambiguous'].includes(String(stage?.status || '')));
      const recovering = stages.find(([, stage]) => Boolean(stage?.recoverable));
      if (blocked) actions.push({ priority: 'high', title: `${run.title || '任务'}：需要人工核验`, reason: `${blocked[0]} 为 ${blocked[1].status}，${blocked[1].error || '请打开任务查看已保存的失败原因。'}`.slice(0, 120), runId: run.id });
      else if (recovering) actions.push({ priority: 'medium', title: `${run.title || '任务'}：后台恢复中`, reason: `${recovering[0]} 会从已保存的证据和素材继续，无需重新创建 Code 或付费任务。`, runId: run.id });
      else if (['queued', 'running'].includes(String(run.state))) actions.push({ priority: 'low', title: `${run.title || '任务'}：继续生产`, reason: `已完成 ${Number(run.completedStages || 0)}/9 个节点；可打开查看当前素材和下一节点。`, runId: run.id });
      if (actions.length >= 3) break;
    }
    if (mode === 'assets') {
      for (const item of assets) {
        if (!item.video && !actions.some((action) => action.runId === item.id)) actions.push({ priority: 'medium', title: `${item.title || '素材'}：视频尚未就绪`, reason: '现有文案、追踪链接和海报可先手动复用；视频完成后再补齐发布包。', runId: item.id });
        if (actions.length >= 3) break;
      }
    }
    return {
      headline: mode === 'assets' ? '素材状态已扫描' : '实时生产诊断已就绪',
      summary: actions.length ? '以下结论直接来自已保存的任务节点和素材状态；模型分析暂不可用不会阻断操作。' : '当前没有需要立即推进的任务，可从 Top 200 继续选择新书。',
      actions, recommendations: []
    };
  };
  // Do not race two providers. Racing doubled provider pressure and made a
  // healthy DeepSeek request look like a failure once the shared 22s timer won.
  // This route is non-paid, so a clearly failed text request may safely move to
  // the fast, verified reserve before falling back to metrics.
  // Keep the initial local dashboard summary responsive, but do not let a
  // short network timer overwrite the operator's explicit model choice.
  const primaryTimeout = operationsTimeoutForModel(modelChoice);
  try {
    return await request(modelChoice, primaryTimeout);
  } catch (primaryError) {
    const reserve = modelChoice === 'qwen3.7-max' ? 'deepseek' : 'qwen3.7-max';
    try {
      const reserveResult = await request(reserve, Math.min(120000, operationsTimeoutForModel(reserve)));
      return {
        ...reserveResult,
        fallbackFrom: modelChoice,
        fallbackReason: `${modelChoice} did not return a usable result; ${reserveResult.model} completed the analysis`
      };
    } catch (reserveError) {
      return {
        analysis: operationalFallback(), model: 'metrics-fallback', requestedChoice: modelChoice,
        fallbackFrom: modelChoice,
        fallbackReason: `${modelChoice} and ${reserve} did not return a usable result; realtime task data is shown instead`,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      };
    }
  }
}

async function analyzeBookCandidates(query, candidates) {
  const { apiKey, baseUrl, model, responsesApi } = copyModelConfig({ modelChoice: 'deepseek' });
  const instructions = `You match a user-provided novel excerpt or plot description to a closed NovelFlow candidate list. Return exactly one compact JSON object. Use only supplied metadata. Never invent titles, characters, chapters, or plot evidence. A confidence value is a calibrated matching score, not a probability: 90-100 requires an exact title or distinctive phrase match; 70-89 requires several specific aligned facts; 45-69 is only a plausible recommendation; below 45 means insufficient evidence. Return at most five candidates sorted by confidence. Reasons must be short and quote or name concrete supplied evidence. Schema: {"extracted":{"language":"string","possibleTitle":"string","characters":["string"],"plotTerms":["string"]},"candidates":[{"bookSkuId":"string","confidence":0,"reasons":["string"],"matchedTerms":["string"]}]}.`;
  const input = JSON.stringify({
    query: String(query || '').slice(0, 12000),
    candidates: (candidates || []).slice(0, 40).map((book) => ({
      bookSkuId: String(book.bookSkuId || ''), title: String(book.title || ''), author: String(book.author || ''),
      category: String(book.category || ''), tags: Array.isArray(book.tags) ? book.tags.slice(0, 8) : [],
      description: String(book.description || '').slice(0, 1200), sources: Array.isArray(book.sources) ? book.sources : [],
      chapterEvidence: book.chapterEvidence || { score: 0, hits: [] }
    }))
  });
  const payload = responsesApi
    ? { model, input: [{ role: 'developer', content: instructions }, { role: 'user', content: input }], text: { format: { type: 'json_object' } }, temperature: 0.1, max_output_tokens: 1400 }
    : { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], response_format: { type: 'json_object' }, temperature: 0.1, max_tokens: 1400 };
  const body = await postJsonOverHttps(`${baseUrl}${responsesApi ? '/responses' : '/chat/completions'}`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, `${model} book matching`, 35000);
  const analysis = parseModelJson(extractModelText(body), model);
  if (!analysis || !Array.isArray(analysis.candidates)) throw new ProviderError(`${model} returned an incomplete book match`);
  return { analysis, model: String(body.model || model) };
}

async function extractScreenshotText(imageUrl) {
  const apiKey = secretToken('NOVELFLOW_OCR_API_KEY') || secretToken('NOVELFLOW_COPY_LLM_API_KEY') || secretToken('NOVELFLOW_LLM_API_KEY');
  const baseUrl = env('NOVELFLOW_OCR_BASE_URL', env('NOVELFLOW_COPY_LLM_BASE_URL', 'https://api.deepseek.com')).replace(/\/$/, '');
  const model = env('NOVELFLOW_OCR_MODEL');
  if (!apiKey || !model) throw new ProviderError('Screenshot OCR is not configured', { status: 503 });
  const prompt = 'Extract every readable word from this novel screenshot in reading order. Preserve names, dialogue, punctuation, and paragraph breaks. Do not summarize or translate. Return JSON only: {"text":"string","language":"string","quality":"high|medium|low"}.';
  const payload = {
    model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: String(imageUrl || '') } }
    ] }],
    response_format: { type: 'json_object' }, temperature: 0, max_tokens: 3000
  };
  const body = await postJsonOverHttps(`${baseUrl}/chat/completions`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, `${model} screenshot OCR`, 45000);
  const result = parseModelJson(extractModelText(body), model);
  const text = String(result?.text || '').trim();
  if (!text) throw new ProviderError('Screenshot OCR returned no readable text', { status: 422 });
  return { text: text.slice(0, 20000), language: String(result.language || ''), quality: String(result.quality || 'medium'), model: String(body.model || model) };
}

async function analyzeScreenshotWithSeed(imageUrl) {
  const { apiKey, baseUrl, model } = copyModelConfig({ modelChoice: 'seed-2.0-mini' });
  const prompt = 'Inspect this novel screenshot. Read the page header and cover area before the story body. Return JSON only: {"visibleTitle":"exact book title visibly printed in the screenshot, or empty string","text":"up to 500 words of readable story text","characters":["names"],"phrases":["2-4 rare exact phrases copied verbatim, each 6-14 words"],"searchPhrases":["up to 4 distinctive phrases suitable for bookstore search"],"plotClues":["specific clues"],"quality":"high|medium|low"}. Preserve spelling. visibleTitle must be copied exactly from visible pixels and must be empty when no title is shown. Do not infer or invent any title, character, or plot fact.';
  const payload = {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: String(imageUrl || '') } }] }],
    thinking: { type: 'disabled' }, temperature: 0, max_tokens: 900
  };
  const body = await postJsonOverHttps(`${baseUrl}/chat/completions`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, 'Seed screenshot analysis', 60000);
  const result = parseModelJson(extractModelText(body), model);
  const text = String(result?.text || '').trim();
  if (!text) throw new ProviderError('Seed screenshot analysis returned no readable text', { status: 422 });
  return {
    visibleTitle: String(result.visibleTitle || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    text: text.slice(0, 20000), characters: Array.isArray(result.characters) ? result.characters.map(String).slice(0, 8) : [],
    phrases: Array.isArray(result.phrases) ? result.phrases.map(String).slice(0, 6) : [],
    searchPhrases: Array.isArray(result.searchPhrases) ? result.searchPhrases.map(String).slice(0, 6) : [],
    plotClues: Array.isArray(result.plotClues) ? result.plotClues.map(String).slice(0, 6) : [], quality: String(result.quality || 'medium'), model: String(body.model || model)
  };
}

async function generateDistributionPlan(book, creative, modelChoice = 'hy3') {
  const { apiKey, baseUrl, model, responsesApi } = copyModelConfig({ modelChoice });
  const instructions = `You are the distribution editor for NovelFlow's manually published social assets. Return exactly one compact JSON object, no prose outside it. Review only the supplied finished copy, video story package, poster variants, book category and source-grounded story brief. Recommend 2-4 suitable channels ONLY from this allowed list: NovelFlow推书, MafiaRomance, WerewolfRomance, FantasyRomance, DarkRomance, SpicyRomance, BillionaireRomance. Never recommend a channel whose genre is unsupported. Write one reusable, short English hook under 150 characters for the operator to paste above any finished asset. It must feel like a genuine plot hook, must not mention a Code, link, channel, hashtag, or generic command, and must not invent facts. Give a natural Simplified Chinese review translation. For every selected channel, state whether copy, video, and/or poster is best suited there. This is a recommendation only: never imply that anything was posted or shared automatically.`;
  const schema = {
    universalHook: 'short English reusable hook under 150 characters',
    zhUniversalHook: 'Chinese operator translation',
    channels: [{ name: 'one allowed channel', reason: 'short Chinese source-grounded reason', bestFor: ['copy|video|poster'] }]
  };
  const source = {
    book: { title: book.title, category: book.category, tags: book.tags || [], description: String(book.description || '').slice(0, 700) },
    storyIntelligence: creative.storyBrief || null,
    finishedAssets: {
      posts: (creative.posts || []).map((item) => ({ type: item.type, content: String(item.content || '').slice(0, 700) })),
      videoPrompt: { hook: creative.videoPrompt?.hook, reversal: creative.videoPrompt?.reversal, cliffhanger: creative.videoPrompt?.cliffhanger },
      posters: (creative.posterPrompts || []).map((item) => ({ variant: item.variant, prompt: String(item.prompt || '').slice(0, 360) }))
    },
    responseSchema: schema
  };
  const temperature = modelTemperature(model, 0.35);
  const payload = responsesApi
    ? { model, input: [{ role: 'developer', content: instructions }, { role: 'user', content: JSON.stringify(source) }], text: { format: { type: 'json_object' } }, temperature, max_output_tokens: 1100 }
    : { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(source) }], response_format: { type: 'json_object' }, temperature, max_tokens: 1100 };
  const body = await postJsonOverHttps(`${baseUrl}${responsesApi ? '/responses' : '/chat/completions'}`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, `${model} distribution recommendation`, isLongRunningModel(modelChoice) ? 600000 : 40000);
  const plan = parseModelJson(extractModelText(body), model);
  const allowed = new Set(['NovelFlow推书', 'MafiaRomance', 'WerewolfRomance', 'FantasyRomance', 'DarkRomance', 'SpicyRomance', 'BillionaireRomance']);
  const channels = Array.isArray(plan?.channels) ? plan.channels.filter((item) => allowed.has(String(item?.name || ''))).slice(0, 4).map((item) => ({ name: String(item.name), reason: String(item.reason || '').trim().slice(0, 120), bestFor: (Array.isArray(item.bestFor) ? item.bestFor : []).filter((asset) => ['copy', 'video', 'poster'].includes(String(asset))).map(String) })) : [];
  const universalHook = String(plan?.universalHook || '').trim();
  if (!universalHook || universalHook.length > 150 || !channels.length) throw new ProviderError(`${model} returned an incomplete distribution recommendation`);
  const usage = body.usage || {};
  return { plan: { universalHook, zhUniversalHook: String(plan?.zhUniversalHook || '').trim(), channels }, model: String(body.model || model), responseId: String(body.id || ''), usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
}

const COPILOT_TOOLS = [
  { type: 'function', function: { name: 'open_task', description: 'Open one existing NovelFlow production task in the operator console.', parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] } } },
  { type: 'function', function: { name: 'open_book_planning', description: 'Open the AI creative planning panel for one supplied ranked book. This does not create paid media, a Code, or a link.', parameters: { type: 'object', properties: { title: { type: 'string' }, sku: { type: 'string' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'prefill_new_task', description: 'Open the new production form with a supplied book prefilled. The operator must still explicitly submit it.', parameters: { type: 'object', properties: { title: { type: 'string' }, sku: { type: 'string' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'set_catalog_filters', description: 'Change the visible new-book ranking filters. Use only values from the supplied schema.', parameters: { type: 'object', properties: { days: { type: 'number', enum: [7, 30, 90] }, genre: { type: 'string', enum: ['all', 'werewolf', 'ceo', 'mafia', 'vampire'] }, length: { type: 'string', enum: ['all', 'short', 'long'] } }, required: [] } } },
  { type: 'function', function: { name: 'refresh_dashboard', description: 'Refresh the dashboard task summaries and ranking data.', parameters: { type: 'object', properties: {}, required: [] } } }
];

function copilotMessages(messages) {
  return (Array.isArray(messages) ? messages : []).slice(-14).map((item) => {
    const role = ['user', 'assistant', 'tool'].includes(item?.role) ? item.role : 'user';
    const message = { role, content: String(item?.content || '').slice(0, 4000) };
    if (role === 'assistant' && Array.isArray(item?.toolCalls) && item.toolCalls.length) message.tool_calls = item.toolCalls.slice(0, 3).map((call) => ({ id: String(call.id || crypto.randomUUID()), type: 'function', function: { name: String(call.name || ''), arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}) } }));
    if (role === 'tool') message.tool_call_id = String(item.toolCallId || '');
    return message;
  });
}

async function copilotReply(messages, context, modelChoice = 'hy3') {
  const config = copyModelConfig({ modelChoice });
  const system = `You are Whale, the concise operating copilot inside NovelFlow's private social-production console. Speak natural Simplified Chinese. Use only the supplied dashboard context and tool results; never invent book facts, performance, task completion, provider status, links, Codes, or model output. You may call only the listed tools. Tools only navigate, prefill forms, change filters, or refresh data. Never claim an action created a Code, short link, poster, video, or post. Never publish to Facebook. Never ask a tool to make a paid or irreversible external submission. When a user requests such an action, explain that the console will present a separate confirmation after planning/review. Prefer one concise conclusion and at most two relevant tools. Do not reveal hidden reasoning.`;
  const safeContext = {
    activeRuns: Array.isArray(context?.activeRuns) ? context.activeRuns.slice(0, 10) : [],
    selectedRun: context?.selectedRun || null,
    todayBooks: Array.isArray(context?.todayBooks) ? context.todayBooks.slice(0, 12) : [],
    filters: context?.filters || {}
  };
  const chatMessages = [{ role: 'system', content: system }, { role: 'system', content: `Dashboard context: ${JSON.stringify(safeContext)}` }, ...copilotMessages(messages)];
  const payload = {
    model: config.model,
    messages: chatMessages,
    tools: COPILOT_TOOLS,
    tool_choice: 'auto',
    temperature: modelTemperature(config.model, 0.25),
    max_tokens: 900
  };
  const body = await postJsonOverHttps(`${config.baseUrl}/chat/completions`, { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, payload, `${config.model} copilot`, operationsTimeoutForModel(modelChoice));
  const message = body.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 3).map((call) => ({ id: String(call.id || crypto.randomUUID()), name: String(call.function?.name || ''), arguments: String(call.function?.arguments || '{}') })) : [];
  const usage = body.usage || {};
  return { message: { content: String(message.content || '').trim(), toolCalls }, model: String(body.model || config.model), usage: { inputTokens: Number(usage.prompt_tokens || 0), outputTokens: Number(usage.completion_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
}

async function rewritePosterPrompt(book, evidence, asset, failureReason, modelChoice = 'deepseek') {
  const { apiKey, baseUrl, model, responsesApi } = copyModelConfig({ modelChoice });
  const excerpts = evidence.slice(0, 4).map((item) => ({ chapter: item.order, excerpt: String(item.content || '').replace(/\s+/g, ' ').slice(0, 400) }));
  const instructions = `You repair one rejected romance-fiction image prompt for a commercial image model. Return exactly one JSON object: {"prompt":"English prompt","zhPrompt":"Simplified Chinese explanation"}. Preserve one source-grounded emotional conflict and the requested aspect ratio. Make it audit-safe: adult characters only, fully clothed, no nudity, no sexual activity, no coercion, no violence, no self-harm, no illegal activity, no weapons, no brands, no readable text, no logos, no watermark, no QR, no UI, no collage, no duplicate people or extra limbs. Prefer elegant cinematic or editorial visual language, clear pose and environment, and negative space. Do not mention the rejection in the result.`;
  const input = JSON.stringify({ book: { title: book.title, category: book.category, description: String(book.description || '').slice(0, 700) }, variant: asset.variant, originalPrompt: asset.prompt, providerFailure: String(failureReason || '').slice(0, 400), chapterEvidence: excerpts });
  const payload = responsesApi
    ? { model, input: [{ role: 'developer', content: instructions }, { role: 'user', content: input }], text: { format: { type: 'json_object' } }, temperature: 0.35, max_output_tokens: 900 }
    : { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], response_format: { type: 'json_object' }, temperature: 0.35, max_tokens: 900 };
  const body = await postJsonOverHttps(`${baseUrl}${responsesApi ? '/responses' : '/chat/completions'}`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, `${model} poster prompt repair`, Math.max(60000, operationsTimeoutForModel(modelChoice)));
  const repaired = parseModelJson(extractModelText(body), model);
  const prompt = String(repaired.prompt || '').trim();
  if (prompt.length < 100) throw new ProviderError(`${model} poster repair returned an invalid prompt`);
  const usage = body.usage || {};
  return { prompt, zhPrompt: String(repaired.zhPrompt || '').trim(), model: String(body.model || model), responseId: String(body.id || ''), usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
}

function acRedis() {
  try { return require('./store').getRedis(); } catch { return null; }
}

function acBudgetModule() {
  try { return require('./ac-budget'); } catch { return null; }
}

async function acResponseJson(response, label) {
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch {
    throw new ProviderError(`${label} returned invalid JSON`, { status: getAcProxyStatus(response.status) });
  }
  if (!response.ok) {
    const detail = String(body?.message || body?.error || body?.msg || '').slice(0, 240);
    throw new ProviderError(`${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`, { status: getAcProxyStatus(response.status), code: response.status === 401 ? 'ac_auth' : 'provider_http' });
  }
  return body;
}

function taskIdOf(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  for (const key of ['thread_id', 'threadId', 'task_id', 'taskId', 'id']) {
    const candidate = String(value[key] ?? '').trim();
    if (candidate) return candidate;
  }
  for (const key of ['data', 'creative', 'task', 'result', 'item', 'base_info', 'baseInfo']) {
    const candidate = taskIdOf(value[key], seen);
    if (candidate) return candidate;
  }
  return '';
}

async function acFetchJson(path, options = {}, label = 'AC request', timeoutMs = 30000) {
  const redis = acRedis();
  const token = await readAcToken(redis);
  if (!token) throw new ProviderError('AC video token is not configured', { status: 503, code: 'ac_token_unavailable' });
  // AC list/result calls are reconciliation reads.  They are deliberately
  // excluded from the paid-request budget; only create/retry POSTs reserve
  // estimated points.  This prevents normal polling from exhausting the
  // daily cap while a video is rendering.
  const response = await fetchAcWithTokenFallback(redis, token, `${getAcBaseUrl()}${path}`, {
    ...options,
    headers: getAcHeaders(token, options.headers)
  }, timeoutMs);
  await rotateAcToken(redis, response).catch(() => {});
  const body = await acResponseJson(response, label);
  return { response, body };
}

async function findAcTask(remark) {
  const pageSize = 100;
  for (let page = 1; page <= 5; page += 1) {
    const { body } = await acFetchJson(`/creative/paged-list?${qs({ PageSize: pageSize, PageIndex: page, type: 'video' })}`, {}, 'AC task reconciliation', 30000);
    const result = pageItems(body);
    const match = result.items.find((item) => String(item?.remark || '') === String(remark));
    if (match) {
      const id = taskIdOf(match);
      if (id) await acRedis()?.set?.(`nf_social:ac_task:${id}`, JSON.stringify({ threadId: id, owner: 'social-console', remark: String(remark || ''), reconciledAt: new Date().toISOString() }), { ex: 180 * 24 * 60 * 60 }).catch?.(() => {});
      return match;
    }
    if (!result.items.length
      || (result.hasPages && page >= result.pages)
      || (result.hasTotal && page * pageSize >= result.total)
      // The AC list endpoint can omit both counters. A full page means there
      // may be another page; stop only on a short/empty page in that shape.
      || (!result.hasPages && !result.hasTotal && result.items.length < pageSize)) break;
  }
  return null;
}

async function submitAc(payload, options = {}) {
  const redis = acRedis();
  const budget = acBudgetModule();
  let reservation = options?.budgetReservation || null;
  const ownsReservation = !reservation;
  if (reservation) {
    if (reservation.granted !== true) {
      throw new ProviderError('AC budget reservation is not granted', { status: 429, code: 'ac_points_budget_exceeded' });
    }
    // A caller may pass a persisted reservation from the P4 run state, but it
    // must still have the immutable server-created identity.  Do not let a
    // malformed or hand-built `{ granted: true }` object bypass the counter.
    if (!budget?.isValidReservation || !budget.isValidReservation(reservation)) {
      throw new ProviderError('AC budget reservation is invalid; no paid request was submitted', { status: 503, code: 'ac_budget_storage_unavailable' });
    }
  }
  if (!reservation && redis && budget?.reserve) {
    reservation = await budget.reserve(redis, 'video_create', { metadata: { source: 'providers.submitAc', remark: String(payload?.remark || '') } });
    if (!reservation.granted) throw budget.budgetError(reservation, 'video_create', reservation.cost);
  }
  if (!reservation && ownsReservation) {
    throw new ProviderError('AC budget storage is not configured', { status: 503, code: 'ac_budget_storage_unavailable' });
  }
  let body;
  try {
    ({ body } = await acFetchJson('/creative/by-user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 'AC paid video submission', 45000));
  } catch (error) {
    if (ownsReservation && reservation?.granted && budget) {
      const status = Number(error?.status || 0);
      const definitive = !error?.ambiguous && status >= 400 && status < 500;
      if (error?.code === 'ac_token_unavailable' || error?.code === 'ac_budget_storage_unavailable' || error?.code === 'ac_auth' || definitive) await budget.release(redis, reservation, error?.code || 'definitive_rejection');
      else await budget.outcome(redis, reservation, { status: 'submitted_or_unknown', providerCode: error?.code });
    }
    throw error;
  }
  const id = taskIdOf(body);
  if (id) await acRedis()?.set?.(`nf_social:ac_task:${id}`, JSON.stringify({ threadId: id, owner: 'social-console', remark: String(payload?.remark || ''), submittedAt: new Date().toISOString() }), { ex: 180 * 24 * 60 * 60 }).catch?.(() => {});
  if (ownsReservation && reservation?.granted && budget) await budget.outcome(redis, reservation, { status: id ? 'submitted' : 'accepted_without_task_id', externalId: id });
  return body;
}

function resultJson(item) {
  const value = item?.result_json ?? item?.resultJson;
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

const AC_RESULT_WRAPPERS = ['final_result', 'finalResult', 'final_video_result', 'finalVideoResult', 'result_json', 'resultJson', 'video_result', 'videoResult', 'processed_video_result', 'processedVideoResult', 'media_records', 'mediaRecords', 'videos', 'materials', 'items', 'results', 'result', 'data', 'media', 'assets', 'output'];
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try { return JSON.parse(text); } catch { return value; }
}
function extractAcVideoMedia(result) {
  const candidates = [];
  const seen = new Set();
  const visit = (raw) => {
    const value = parseMaybeJson(raw);
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) return value.forEach(visit);
    candidates.push(value);
    AC_RESULT_WRAPPERS.forEach((key) => visit(value[key]));
  };
  const videoUrl = (item) => {
    const video = item.video;
    return item.final_video_url || item.finalVideoUrl || item.processed_video_url || item.processedVideoUrl || item.video_url || item.videoUrl || item.file_url || item.fileUrl || item.media_url || item.mediaUrl || item.download_url || item.downloadUrl || (typeof video === 'string' && video) || video?.video_url || video?.videoUrl || video?.url || video?.file_url || item.url || '';
  };
  visit(result);
  const item = candidates.find((candidate) => String(videoUrl(candidate) || '').trim());
  if (!item) return { videoUrl: '', coverUrl: '' };
  return { videoUrl: videoUrl(item), coverUrl: item.cover_image_url || item.coverImageUrl || item.cover_url || item.coverUrl || item.thumbnail_url || item.thumbnailUrl || item.poster_url || item.posterUrl || item.preview_image_url || item.previewImageUrl || item.first_frame_url || item.firstFrameUrl || item.video?.cover_image_url || item.video?.thumbnail_url || '' };
}

function optionalBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  return null;
}

function firstDefined(values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function executionControlsFor(resultItems) {
  const entries = resultItems.map((item) => ({ item, result: resultJson(item) }));
  const values = (pick) => entries.map(pick).filter((value) => value !== undefined && value !== null && value !== '');
  const bool = (pick) => firstDefined(values((entry) => optionalBoolean(pick(entry))));
  const string = (pick, limit = 180) => String(firstDefined(values(pick)) || '').trim().slice(0, limit);
  const references = firstDefined(values((entry) => entry.result.reference_picture_list ?? entry.item.reference_picture_list));
  const storyboard = firstDefined(values((entry) => entry.result.base_storyboard ?? entry.item.base_storyboard));
  const storyboardText = storyboard == null ? '' : typeof storyboard === 'string' ? storyboard : JSON.stringify(storyboard);
  const traces = [...new Set(values((entry) => entry.result.copy_parent_thread_id ?? entry.result.copy_thread_id ?? entry.item.copy_parent_thread_id ?? entry.item.copy_thread_id).map((value) => String(value).slice(0, 180)))].slice(0, 4);
  return {
    enableSubtitles: bool((entry) => entry.result.enable_subtitles ?? entry.item.enable_subtitles),
    isRewriting: bool((entry) => entry.result.is_rewriting ?? entry.item.is_rewriting),
    isGenerateImage: bool((entry) => entry.result.is_generate_img ?? entry.item.is_generate_img),
    effectiveVideoModel: string((entry) => entry.result.video_model ?? entry.item.video_model),
    ttsAudioVoice: string((entry) => entry.result.tts_audio_voice ?? entry.item.tts_audio_voice),
    wordCount: string((entry) => entry.result.word_count ?? entry.item.word_count, 40),
    referenceCount: Array.isArray(references) ? references.length : 0,
    storyboard: storyboardText ? { length: storyboardText.length, sha256: sha(storyboardText) } : null,
    materialTraceIds: traces
  };
}

async function acResult(threadId) {
  const redis = acRedis();
  const token = await readAcToken(redis);
  if (!token) throw new ProviderError('AC video token is not configured', { status: 503, code: 'ac_token_unavailable' });
  let response;
  // Result polling is a non-billable reconciliation read.  It must remain
  // available throughout a long render even when the daily paid-request cap
  // is exhausted.
  response = await fetchAcWithTokenFallback(redis, token, `${getAcBaseUrl()}/creative/${encodeURIComponent(threadId)}/result`, { headers: getAcHeaders(token) }, 30000);
  await rotateAcToken(redis, response).catch(() => {});
  if (response.status === 204) return { status: 'running', threadId };
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch {
    throw new ProviderError('AC result returned invalid JSON', { status: 502, code: 'provider_invalid_json' });
  }
  if (!response.ok) {
    throw new ProviderError(`AC result failed with HTTP ${response.status}`, { status: getAcProxyStatus(response.status), code: response.status === 401 ? 'ac_auth' : 'provider_http' });
  }
  const envelope = parseMaybeJson(body?.data);
  const dataObject = envelope && typeof envelope === 'object' ? envelope : {};
  const nestedResult = parseMaybeJson(dataObject.result_json || dataObject.resultJson);
  const resultObject = nestedResult && typeof nestedResult === 'object' ? nestedResult : {};
  const base = body.base_info || body.baseInfo || dataObject.base_info || dataObject.baseInfo || resultObject.base_info || resultObject.baseInfo || {};
  const media = extractAcVideoMedia(body);
  const videoUrls = media.videoUrl ? [absoluteUrl(media.videoUrl)] : [];
  const rawResults = body.final_result || body.finalResult || dataObject.final_result || dataObject.finalResult || resultObject.final_result || resultObject.finalResult || [];
  const resultItems = Array.isArray(rawResults) ? rawResults : [];
  const videoModels = [...new Set(resultItems.map((item) => String(item.video_model || '').trim()).filter(Boolean))];
  const userAdCopyValues = resultItems.map((item) => item.is_user_ad_copy).filter((value) => typeof value === 'boolean');
  const runStatus = String(body.run_status || body.runStatus || body.status || dataObject.run_status || dataObject.runStatus || dataObject.status || resultObject.run_status || resultObject.runStatus || resultObject.status || '').toLowerCase();
  const baseStatus = String(base.status || '').toLowerCase();
  const failed = ['failed', 'fail', 'error', 'cancelled', 'canceled', 'interrupted', '-1'].includes(runStatus) || ['failed', 'fail', 'error', 'cancelled', 'canceled', 'interrupted', '-1'].includes(baseStatus);
  const complete = ['completed', 'done', 'success', '2'].includes(runStatus) || ['completed', 'done', 'success', '2'].includes(baseStatus);
  const executionControls = executionControlsFor(resultItems);
  return { status: failed ? (videoUrls.length ? 'partial' : 'failed') : complete ? (videoUrls.length ? 'completed' : 'completed_missing_media') : 'running', threadId, videoUrls, coverImageUrl: absoluteUrl(media.coverUrl), videoModel: videoModels.length === 1 ? videoModels[0] : videoModels.join(', '), isUserAdCopy: userAdCopyValues.length ? userAdCopyValues.every(Boolean) : null, executionControls, error: String(base.error_msg || body.message || body.error || '').slice(0, 500) };
}

function publicHttpsUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' || !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return null;
  if (host === '::1' || /^fe80:/i.test(host) || /^(?:fc|fd)[0-9a-f]{2}:/i.test(host)) return null;
  return parsed;
}

async function safeMediaFetch(url, options = {}) {
  let current = publicHttpsUrl(url);
  if (!current) throw new ProviderError('Generated media URL is not a public HTTPS URL');
  for (let redirect = 0; redirect < 4; redirect += 1) {
    const response = await fetch(current.toString(), { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    current = location ? publicHttpsUrl(new URL(location, current).toString()) : null;
    if (!current) throw new ProviderError('Generated media redirected to a disallowed URL');
  }
  throw new ProviderError('Generated media exceeded the redirect limit');
}

async function validateVideo(url) {
  let response;
  try { response = await safeMediaFetch(url, { method: 'HEAD' }); } catch { response = null; }
  if (!response?.ok || !String(response.headers.get('content-type') || '').toLowerCase().startsWith('video/')) response = await safeMediaFetch(url, { headers: { Range: 'bytes=0-0' } });
  const type = String(response.headers.get('content-type') || '');
  const length = Number(response.headers.get('content-length') || String(response.headers.get('content-range') || '').split('/').pop() || 0);
  if (!response.ok || !type.toLowerCase().startsWith('video/') || length <= 0) throw new ProviderError('Generated AC media could not be verified as a non-empty video');
  return { contentType: type, contentLength: length };
}

async function validateImage(url) {
  let response;
  try { response = await safeMediaFetch(url, { method: 'HEAD' }); } catch { response = null; }
  if (!response?.ok || !String(response.headers.get('content-type') || '').toLowerCase().startsWith('image/')) {
    response = await safeMediaFetch(url, { headers: { Range: 'bytes=0-0' } });
  }
  const type = String(response.headers.get('content-type') || '');
  const length = Number(response.headers.get('content-length') || String(response.headers.get('content-range') || '').split('/').pop() || 0);
  if (!response.ok || !type.toLowerCase().startsWith('image/') || length <= 0) throw new ProviderError('Generated poster could not be verified as a readable image');
  return { contentType: type, contentLength: length, resolvedUrl: response.url || url };
}

const IIIT_IMAGE_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024']);

function iiitImageConfig() {
  const apiKey = secretToken('IIIT_IMAGE_API_KEY');
  if (!apiKey) throw new ProviderError('IIIT image API key is not configured', { status: 503 });
  const base = env('IIIT_IMAGE_BASE_URL', 'https://ai.iiit.cn/v1').replace(/\/$/, '');
  let parsed;
  try { parsed = new URL(base); } catch { throw new ProviderError('IIIT image base URL is invalid', { status: 503 }); }
  if (parsed.protocol !== 'https:') throw new ProviderError('IIIT image base URL must use HTTPS', { status: 503 });
  return { apiKey, base, model: env('IIIT_IMAGE_MODEL', 'IMG-2') || 'IMG-2' };
}

function httpsResultUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' && parsed.hostname ? parsed.toString() : '';
  } catch {
    return '';
  }
}

async function generateIIITImage(input = {}) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 12000) throw new ProviderError('IIIT image prompt must contain 1 to 12000 characters', { status: 400 });
  const size = IIIT_IMAGE_SIZES.has(String(input.size || '')) ? String(input.size) : '1024x1024';
  const { apiKey, base, model } = iiitImageConfig();
  const payload = { model, prompt, n: 1, size, response_format: 'url' };
  const { body } = await request(`${base}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ambiguousOnInvalidJson: true
  }, 'IIIT image submission', Math.max(30000, Math.min(Number(input.timeoutMs) || 120000, 240000)));
  const item = Array.isArray(body?.data) ? body.data[0] : null;
  const url = httpsResultUrl(item?.url);
  if (!url) throw new ProviderError('IIIT accepted the image request without a usable HTTPS image URL', { ambiguous: true });
  return { provider: 'iiit', status: 'success', url, requestId: String(body?.id || body?.created || '').slice(0, 180), model, size };
}

// Compatibility export for older character-asset callers. New work records
// the provider as IIIT and reads only the IIIT_IMAGE_* environment contract.
const generateMeituImage = generateIIITImage;

async function submitImage(asset) {
  const result = await generateIIITImage({
    prompt: asset?.prompt,
    size: asset?.size || (asset?.variant === 'editorial_romance' ? '1024x1536' : '1024x1024'),
    timeoutMs: asset?.timeoutMs
  });
  return { ...result, id: result.requestId || '', status: 'success', provider: 'iiit' };
}

async function imageResult(taskId) {
  throw new ProviderError(`IIIT image task ${String(taskId || '').slice(0, 80)} is not pollable`, { status: 400 });
}

const PUTREPORT_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport';
const SOCIAL_FUNNEL_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/socialsource-code-funnel/list';
const FUNNEL_METRICS = [
  'pullUv', 'activeUv', 'newUv', 'attActiveUv', 'attNewUv',
  'd0Income', 'd1Income', 'd3Income', 'd7Income', 'd14Income',
  'd30Income', 'd90Income', 'dnIncome'
];

function reportDate(date) {
  return date.toISOString().slice(0, 10);
}

function reportRowsFromBody(body) {
  const data = body?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return pageItems(body).items;
}

function funnelRowsFromBody(body) {
  let value = body?.data ?? body;
  if (Array.isArray(value)) return value;
  if (value?.data && typeof value.data === 'object' && !Array.isArray(value.data)) value = value.data;
  const rows = value?.list || value?.dataSource || (Array.isArray(value?.data) ? value.data : []);
  return Array.isArray(rows) ? rows : [];
}

function normalizedFunnelRow(row) {
  const number = (value) => Number(value || 0);
  return {
    date: String(row.dt || row.date || '').slice(0, 10),
    mediaSource: String(row.mediaSource || '').trim(),
    adId: String(row.adId || row.adid || row.ad_id || '').trim(),
    ...Object.fromEntries(FUNNEL_METRICS.map((key) => [key, number(row[key])])),
    attSuccessRate: number(row.attSuccessRate)
  };
}

function normalizedPutreportRow(row) {
  const number = (value) => Number(value || 0);
  return {
    adId: String(row.adid || row.adId || row.ad_id || ''),
    campaignId: String(row.campaignid || row.campaignId || row.campaign_id || ''),
    adsetId: String(row.adsetid || row.adsetId || row.adset_id || ''),
    copywritingId: String(row.copywritingid || row.copywritingId || row.copywriting_id || ''),
    date: String(row.date || row.dt || ''),
    pullUv: number(row.h5landingpageclickusernum ?? row.pullUv ?? row.pull_uv),
    // Putreport has no activation field. Do not mislabel another metric.
    activeUv: number(row.activeUv ?? row.active_uv),
    newUv: number(row.newusernum ?? row.newUv ?? row.new_uv),
    d0Income: number(row.d0income ?? row.d0Income ?? row.d0_income),
    d1Income: number(row.d1income ?? row.d1Income ?? row.d1_income),
    d3Income: number(row.d3income ?? row.d3Income ?? row.d3_income),
    d7Income: number(row.d7income ?? row.d7Income ?? row.d7_income),
    d14Income: number(row.d14income ?? row.d14Income ?? row.d14_income),
    d30Income: number(row.d30income ?? row.d30Income ?? row.d30_income),
    d90Income: number(row.d90income ?? row.d90Income ?? row.d90_income),
    totalIncome: number(row.totalincome ?? row.totalIncome ?? row.total_income),
    visits: number(row.h5landingpageclicknum ?? row.visits),
  };
}

async function getReportToken(forceRefresh = false) {
  const configured = secretToken('NOVELFLOW_REPORT_TOKEN');
  if (configured && !forceRefresh) return configured;
  return oidcToken(forceRefresh);
}

function reportWindow(days, range = {}) {
  const count = Math.max(1, Math.min(Number(days) || 90, 180));
  // The current day is usually incomplete in the reporting warehouse. Use
  // the latest complete natural day unless an operator explicitly supplies a
  // boundary for a live diagnostic query.
  const to = range.to || reportDate(new Date(Date.now() - 86400000));
  const from = range.from || reportDate(new Date(Date.parse(`${to}T00:00:00Z`) - (count - 1) * 86400000));
  return { from, to };
}

async function reportRequest(url, payload, headers, label) {
  const perform = async (token) => request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers },
    body: JSON.stringify(payload)
  }, label, 55000);
  try {
    return await perform(await getReportToken(false));
  } catch (error) {
    const canRefresh = error.status === 401 && env('NOVELFLOW_OIDC_USERNAME') && env('NOVELFLOW_OIDC_PASSWORD');
    if (!canRefresh) throw error;
    return perform(await getReportToken(true));
  }
}

async function putreportQuery(identifiers, dimension, days = 90, range = {}, groupings = [dimension, 'date'], sourceSuffix = 'realtime') {
  const allowed = new Set(['campaignid', 'adsetid', 'adid', 'copywritingid']);
  if (!allowed.has(dimension)) throw new ProviderError('Unsupported putreport dimension', { status: 400 });
  const ids = identifiers.map((value) => String(value || '').trim()).filter(Boolean);
  if (!ids.length) throw new ProviderError('A reporting identifier is required', { status: 400 });
  const { from, to } = reportWindow(days, range);
  const filters = {
    productline: ['NovelFlow'], mediasource: [], mediasource2: ['SocialMedia'],
    date: { from, to, datesLabel: '' }, campaignid: [], adsetid: [], adid: [], copywritingid: []
  };
  filters[dimension] = ids;
  const payload = {
    filters,
    groupings
  };
  const response = await reportRequest(PUTREPORT_API, payload, {
      'Content-Type': 'application/json;charset=UTF-8',
      'X-OS': 'web', 'X-AppName': 'web-admin', 'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1'
  }, 'Real-time putreport query');
  return { rows: reportRowsFromBody(response.body).map(normalizedPutreportRow), from, to, source: `putreport_${dimension}_${sourceSuffix}`, dimension, groupings };
}

async function putreportRows(code, linkId, days = 90, range = {}) {
  const adIds = [code, linkId].map((value) => String(value || '').trim()).filter(Boolean);
  return putreportQuery(adIds, 'adid', days, range);
}

async function putreportDimensionRows(identifier, dimension, days = 90, range = {}) {
  return putreportQuery([identifier], dimension, days, range);
}

async function putreportBreakdownRows(identifier, dimension, days = 90, range = {}) {
  return putreportQuery([identifier], dimension, days, range, ['adid', 'date'], 'breakdown_realtime');
}

async function funnelReportIds(adIds, days = 90, range = {}) {
  const ids = adIds.map((value) => String(value || '').trim()).filter(Boolean);
  if (!ids.length) throw new ProviderError('A promotion Code or link ID is required for reporting', { status: 400 });
  const { from, to } = reportWindow(days, range);
  const endpoint = env('NOVELFLOW_REPORT_FUNNEL_API', SOCIAL_FUNNEL_API);
  const rows = [];
  for (let pageIndex = 1; pageIndex <= 10; pageIndex += 1) {
    const payload = { pageIndex, pageSize: 1000, from, to, adIds: ids, groupings: ['dt', 'ad_id'] };
    const response = await reportRequest(endpoint, payload, { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, 'Real-time social funnel query');
    const page = funnelRowsFromBody(response.body);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return { rows: rows.map(normalizedFunnelRow), from, to, source: 'social_funnel_realtime' };
}

async function funnelReportRows(code, linkId, days = 90, range = {}) {
  return funnelReportIds([code, linkId], days, range);
}

async function reportRows(code, linkId, days = 90, range = {}) {
  return funnelReportRows(code, linkId, days, range);
}

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

module.exports = { ProviderError, enabled, absoluteUrl, findExactBook, findExactBookBySku, exactBookFromCatalog, topBooks, searchBooks, performanceBooks, contentDashboardBooks, listChapters, chapterContent, keywordRecord, createKeyword, findLink, createLink, linkDetail, generateCreative, localizeAdVideoPrompt, repairAdVideoPrompt, analyzeCreativePlan, analyzeOperations, analyzeBookCandidates, extractScreenshotText, analyzeScreenshotWithSeed, copilotReply, generateDistributionPlan, rewritePosterPrompt, findAcTask, submitAc, acResult, extractAcVideoMedia, taskIdOf, validateVideo, validateImage, generateIIITImage, generateMeituImage, submitImage, imageResult, reportRows, funnelReportRows, funnelReportIds, putreportRows, putreportDimensionRows, putreportBreakdownRows, sha, titleKey, modelTemperature, operationsTimeoutForModel, creativeWireUsesResponses, modelEnvelopeDiagnostic, reserveModelFor, normalizeTokenDanceDeepSeekModel, copyModelConfig, parseModelJson, extractModelText, requestedCreativeSection, normalizeCreativeWireSection, structuredShape, buildEvidenceBank, hydrateCreativeEvidence };
