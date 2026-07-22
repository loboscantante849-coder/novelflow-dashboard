const crypto = require('crypto');
const https = require('https');

function cleanTitle(value) {
  return String(value || '').replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, '&').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim();
}

function titleKey(value) { return cleanTitle(value).normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase(); }

const APPLICATION_ID = process.env.NOVELFLOW_APPLICATION_ID || '642fc1ace309494378a774a6';
const ADMIN_BASE = 'https://admin.novelspa.app/api/v1/novelmanage';
const BOOK_API = `${ADMIN_BASE}/book/booklist`;
const CHAPTER_LIST_API = `${ADMIN_BASE}/book/bookchapterlist`;
const CHAPTER_CONTENT_API = `${ADMIN_BASE}/book/bookchaptercontentdetail`;
const KEYWORD_API = `${ADMIN_BASE}/book/bookpromotionkeywords`;
const KEYWORD_SAVE_API = `${ADMIN_BASE}/book/savebookpromotionkeywords`;
const LINK_API = `${ADMIN_BASE}/SocialMediaLinkConfig`;
const AC_BASE = process.env.NOVELFLOW_AC_BASE_URL || 'https://ac.beidou.win';
const CONTENT_DASHBOARD_API = 'https://admin.novelsnack.com/api/v1/authorstationmanage/contentmiddleground/report/list';

class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.ambiguous = Boolean(options.ambiguous);
    this.status = options.status || 502;
  }
}

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function secretToken(name) {
  let value = env(name);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
  }
  return String(value || '').replace(/^Bearer\s+/i, '').trim();
}

const TOKENDANCE_MODELS = new Set([
  'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'hy3', 'kimi-k2.7-code',
  // Existing runs may still reference the prior presets.
  'qwen3.5-flash', 'glm-4.5-air', 'kimi-k2.5', 'minimax-m2.5',
  // Preserve routing for runs created with the previous presets.
  'qwen3.7-max', 'glm-5.2', 'kimi-k3', 'minimax-m3'
]);
const LONG_RUNNING_MODELS = new Set(['deepseek', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'kimi-k2.7-code']);
function isLongRunningModel(choice) { return LONG_RUNNING_MODELS.has(String(choice || '').toLowerCase()); }

function copyModelConfig(profile = {}) {
  const choice = String(profile.modelChoice || 'hy3');
  if (TOKENDANCE_MODELS.has(choice)) {
    const apiKey = secretToken('NOVELFLOW_TOKENDANCE_API_KEY');
    if (!apiKey) throw new ProviderError('The selected TokenDance premium model is not configured', { status: 503 });
    return { apiKey, baseUrl: 'https://tokendance.space/gateway/v1', model: choice, responsesApi: false };
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

function pageItems(body) {
  let value = body?.data ?? body;
  if (value?.data && typeof value.data === 'object' && !Array.isArray(value.data)) value = value.data;
  const items = value?.items || value?.list || value?.records || value?.dataSource || (Array.isArray(value?.data) ? value.data : []);
  const total = Number(value?.total || value?.totalCount || items?.length || 0);
  const pages = Number(value?.pages || value?.pageCount || value?.totalPages || 1);
  return { items: Array.isArray(items) ? items : [], total, pages };
}

async function request(url, options = {}, label = 'Provider request', timeoutMs = 30000) {
  const controller = new AbortController();
  let timer;
  let response;
  try {
    const pending = fetch(url, { ...options, signal: controller.signal });
    // Some serverless fetch implementations do not reject promptly after an
    // AbortController signal. Race it so a provider stall can never consume
    // the whole worker and leave a persisted stage stranded as "running".
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`, { ambiguous: options.method && options.method !== 'GET' && options.method !== 'HEAD' }));
      }, timeoutMs);
    });
    response = await Promise.race([pending, timeout]);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const ambiguous = options.method && options.method !== 'GET' && options.method !== 'HEAD';
    throw new ProviderError(`${label} did not return a definitive response`, { ambiguous });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { throw new ProviderError(`${label} returned invalid JSON`, { status: response.status }); }
  }
  if (!response.ok || ![undefined, null, 0, 200].includes(body?.code)) {
    const detail = String(body?.msg || body?.message || body?.error || '').slice(0, 240);
    throw new ProviderError(`${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`, { status: response.status });
  }
  return { response, body };
}

let refreshedToken = '';
async function oidcToken(forceRefresh = false) {
  if (!forceRefresh && refreshedToken) return refreshedToken;
  const configured = secretToken('NOVELFLOW_OIDC_TOKEN');
  if (!forceRefresh && configured) return configured;
  const username = env('NOVELFLOW_OIDC_USERNAME');
  const password = env('NOVELFLOW_OIDC_PASSWORD');
  if (!username || !password) {
    if (configured) return configured;
    throw new ProviderError('NovelFlow OIDC authentication is not configured', { status: 503 });
  }
  const form = new URLSearchParams({
    grant_type: 'password', client_id: 'AuthClient', username, password,
    scope: 'openid profile roles email offline_access'
  });
  const { body } = await request('https://sts.anystories.app/connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, body: form
  }, 'OIDC authentication', 25000);
  refreshedToken = String(body.access_token || '').trim();
  if (!refreshedToken) throw new ProviderError('OIDC response contained no access token');
  return refreshedToken;
}

async function adminRequest(url, options = {}, label = 'NovelFlow admin request') {
  const perform = async (token) => request(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', ...(options.headers || {}) }
  }, label, options.timeoutMs || 35000);
  try {
    return await perform(await oidcToken(false));
  } catch (error) {
    if (error.status !== 401 || (!env('NOVELFLOW_OIDC_USERNAME') || !env('NOVELFLOW_OIDC_PASSWORD'))) throw error;
    return perform(await oidcToken(true));
  }
}

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== '')).toString();
}

async function findExactBook(title, sku) {
  const { body } = await adminRequest(`${BOOK_API}?${qs({ current: 1, pageIndex: 1, pageSize: 50, applicationId: APPLICATION_ID, bookName: title })}`, {}, 'Exact book lookup');
  const items = pageItems(body).items;
  const candidates = items.filter((item) => titleKey(item.title) === titleKey(title));
  const match = sku ? candidates.find((item) => String(item.bookSkuId || '') === String(sku)) : candidates.length === 1 ? candidates[0] : items.length === 1 ? items[0] : null;
  if (!match) throw new ProviderError(`Could not resolve one exact bookstore record for “${cleanTitle(title)}”`, { status: 404 });
  if (titleKey(match.title) !== titleKey(title)) throw new ProviderError('Book title search returned a different record', { status: 409 });
  const category = match.aiCategory || {};
  return {
    bookSkuId: String(match.bookSkuId || ''), cityBookId: String(match.id || ''), title: String(match.title || ''),
    cover: absoluteUrl(match.cover), category: typeof category === 'object' ? String(category.categoryName || '') : String(category),
    tags: (match.aiTags || match.tags || []).map((item) => typeof item === 'object' ? String(item.tagName || '') : String(item)).filter(Boolean),
    description: String(match.description || match.bookDescription || match.introduction || match.blurb || ''),
    chapterCount: Number(match.chapterCount || 0), words: Number(match.words || 0), payPoint: Number(match.payPoint || 0)
  };
}

async function performanceBooks(days) {
  const endpoint = env('NOVELFLOW_PERFORMANCE_RANKING_API', 'https://novelflow.top/api/social-performance-rankings');
  const { body } = await request(`${endpoint}?${qs({ days })}`, { method: 'GET', headers: { Accept: 'application/json' } }, 'Unified funnel performance ranking', 25000);
  return body;
}

async function contentDashboardBooks({ startDate, endDate, sortField = 'baseReadUnt', sortIsAsc = false, minReadUnt = 0, filters = {} }) {
  const payload = {
    pageIndex: 1,
    // Rate-based rankings need a broader candidate set before low-volume
    // books are filtered out; keep the complete Top 200 candidate universe.
    pageSize: 50,
    current: 1,
    groupings: [],
    // For rate/profit comparisons, first pull a high-volume candidate pool.
    // The dashboard does not expose a server-side minimum-UV predicate.
    sortField: minReadUnt > 0 ? 'baseReadUnt' : sortField,
    sortIsAsc,
    readStartTime: startDate,
    readEndTime: endDate,
    billStartTime: startDate,
    billEndTime: endDate
  };
  if (filters.language) payload.language = filters.language;
  if (filters.completeSts) payload.completeSts = filters.completeSts;
  if (filters.status) payload.status = filters.status;
  if ([0, 1].includes(Number(filters.isShort))) payload.isShort = Number(filters.isShort);
  if (Array.isArray(filters.productLine) && filters.productLine.length) payload.productLine = filters.productLine;
  if (Array.isArray(filters.productTp) && filters.productTp.length) payload.productTp = filters.productTp;
  const pages = [];
  let total = 0;
  for (let pageIndex = 1; pageIndex <= 4; pageIndex += 1) {
    const pagePayload = { ...payload, pageIndex, current: pageIndex };
    const { body } = await adminRequest(CONTENT_DASHBOARD_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pagePayload), timeoutMs: 35000
    }, `Content dashboard ranking page ${pageIndex}`);
    const page = body?.data || {};
    const items = Array.isArray(page.data) ? page.data : [];
    if (pageIndex === 1) total = Number(page.total || items.length);
    pages.push(...items);
    if (!items.length || items.length < payload.pageSize || pages.length >= 200 || (total > 0 && pages.length >= total)) break;
  }
  const shortValue = (value) => value === true || value === 1 || ['1', 'true', 'yes', '是'].includes(String(value || '').toLowerCase());
  const records = pages.map((item) => ({
    bookSkuId: String(item.skuId || item.bookId || ''),
    title: cleanTitle(item.title),
    cover: absoluteUrl(item.cover || item.coverImage || item.coverUrl || item.bookCover || ''),
    author: String(item.authorName || ''),
    category: String(item.channelNm || ''),
    productLine: String(item.productLine || item.productTp || ''),
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
  })).filter((book) => book.title && book.bookSkuId);
  const books = records
    .filter((book) => book.baseReadUnt >= minReadUnt)
    .sort((left, right) => Number(right[sortField] || 0) - Number(left[sortField] || 0) || right.baseReadUnt - left.baseReadUnt)
    .slice(0, 200)
    .map((book, index) => ({ ...book, rank: index + 1 }));
  return { books, total: Number(total || records.length), minReadUnt, payload };
}

async function topBooks(limit = 200) {
  const requested = Math.max(1, Math.min(Number(limit) || 200, 200));
  const load = async (languageCode) => {
    const all = [];
    for (let pageIndex = 1; pageIndex <= Math.ceil(requested / 50); pageIndex += 1) {
      const { body } = await adminRequest(`${BOOK_API}?${qs({
        current: pageIndex, pageIndex, pageSize: 50, applicationId: APPLICATION_ID, bookStatus: 1,
        orderBy: 'uv', orderType: 'desc', languageCode
      })}`, {}, 'Top books lookup');
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
      title: String(item.title || ''),
      cover: absoluteUrl(item.cover || item.coverImage || item.coverUrl || ''),
      author: Array.isArray(item.authors) ? item.authors.map((author) => String(author.authorName || author)).filter(Boolean).join(', ') : String(item.author || ''),
      category: typeof category === 'object' ? String(category.categoryName || item.bookClassName || '') : String(category || item.bookClassName || ''),
      tags: (item.aiTags || item.tags || []).map((tag) => typeof tag === 'object' ? String(tag.tagName || tag.name || '') : String(tag)).filter(Boolean).slice(0, 3),
      uv: Number(item.uv || item.bookUv || item.readCount || 0),
      words: Number(item.words || 0),
      chapterCount: Number(item.chapterCount || 0)
    };
  }).filter((book) => book.title && book.bookSkuId);
}

async function listChapters(cityBookId) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const { body } = await adminRequest(`${CHAPTER_LIST_API}?${qs({ pageIndex: page, pageSize: 200, cityBookId })}`, {}, 'Chapter list');
    const result = pageItems(body);
    all.push(...result.items);
    if (!result.items.length || page >= result.pages || all.length >= result.total) break;
  }
  const unique = new Map(all.filter((item) => item.id).map((item) => [String(item.id), item]));
  return [...unique.values()].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

async function chapterContent(id) {
  const { body } = await adminRequest(`${CHAPTER_CONTENT_API}?${qs({ id, applicationId: APPLICATION_ID })}`, {}, 'Chapter content');
  const content = String(body?.data?.content || '');
  if (!content.trim()) throw new ProviderError(`Chapter ${id} returned empty content`);
  return content;
}

async function keywordRecord(code) {
  const { body } = await adminRequest(`${KEYWORD_API}?${qs({ applicationId: APPLICATION_ID, keyword: code, pageIndex: 1, pageSize: 100 })}`, {}, 'Promotion code lookup');
  return pageItems(body).items.find((item) => String(item.keyword || '') === String(code)) || null;
}

async function createKeyword(sku, code, options = {}) {
  const payload = { applicationId: APPLICATION_ID, keyword: String(code), bookId: String(sku), channel: String(options.channel || env('NOVELFLOW_CHANNEL_CODE', 'FB')), isEnable: true };
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
    const channelSource = String(detail.channelSource || item.channelSource || '');
    const channelMatches = !options.channelSource || channelSource.toLowerCase() === String(options.channelSource).toLowerCase();
    if ((sourceSku === String(sku) || sourceSku.includes(String(sku))) && operator.toLowerCase() === String(promoter).toLowerCase() && channelMatches && enabled(detail.isEnabled ?? item.isEnabled)) {
      return { ...item, ...detail, shortUrl: absoluteUrl(detail.shortUrl || item.shortUrl) };
    }
  }
  return null;
}

async function createLink(book, promoter, code, options = {}) {
  const discord = String(options.channel || '').toUpperCase() === 'DISCORD';
  const channelSource = discord ? env('NOVELFLOW_DISCORD_CHANNEL_SOURCE', 'Discord') : env('NOVELFLOW_CHANNEL_SOURCE', 'Facebook-grounp');
  const channelNameId = discord
    ? env('NOVELFLOW_DISCORD_CHANNEL_NAME_ID', env('NOVELFLOW_CHANNEL_NAME_ID', '699ef7b8194eb218db3c2270'))
    : env('NOVELFLOW_CHANNEL_NAME_ID', '699ef7b8194eb218db3c2270');
  if (!channelNameId) throw new ProviderError('Discord attribution channel is not configured', { status: 503 });
  const suffix = discord ? 'Discord' : 'FB';
  const channelName = discord ? `NovelFlow_SocialMedia_Discord_${String(options.guildId || 'direct')}_${promoter}` : `NovelFlow_SocialMedia_Facebook-grounp_Facebook_${promoter}`;
  const title = String(book.title || '').slice(0, 180);
  const payload = {
    linkName: `${code}${title}-Book-Detail-${suffix}`, applicationId: APPLICATION_ID, mediaSource: 'SocialMedia',
    channelSource, channelNameId,
    channelName, contentType: 1, contentNameOrSku: book.bookSkuId, languageCode: String(options.languageCode || 'en'),
    redirectConfigId: env('NOVELFLOW_REDIRECT_CONFIG_ID', '68fecf8b3a29f6eff435fd3b'), contentRedirectSequence: 1,
    adGroupName: `${channelName}_${code}${title}-Book-Detail-${suffix}_${promoter}`, operatorName: promoter,
    landingPageTemplates: [{ templateId: env('NOVELFLOW_LANDING_TEMPLATE_ID', '6a01499261118c6285dff7dd'), templateName: env('NOVELFLOW_LANDING_TEMPLATE_NAME', 'Book Detail FB'), templateWeight: 100, isDeleted: false }],
    isEnabled: true, contentName: title,
    customConfig: JSON.stringify({ appName: 'NovelFlow', languageConfig: { h5_read_more: 'Read More for Free', h5_open_app: 'Open APP' } })
  };
  const { body } = await adminRequest(LINK_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 40000 }, 'Short-link creation');
  const data = body?.data || {};
  return {
    payload,
    id: typeof data === 'string' ? data : String(data.id || data.linkId || ''),
    shortUrl: absoluteUrl(typeof data === 'object' ? (data.shortUrl || data.url || data.linkUrl || '') : '')
  };
}

function extractModelText(body) {
  if (body.output_text) return String(body.output_text);
  if (body.response?.output_text) return String(body.response.output_text);
  const message = body.choices?.[0]?.message || body.data?.choices?.[0]?.message || {};
  const choice = message.content;
  if (typeof choice === 'string') return choice;
  if (Array.isArray(choice)) return choice.map((item) => typeof item === 'string' ? item : String(item?.text || item?.content || '')).join('');
  if (choice && typeof choice === 'object') return String(choice.text || choice.content || '');
  if (message.reasoning_content) return String(message.reasoning_content);
  const parts = [];
  for (const output of body.output || []) for (const item of output.content || []) {
    const value = typeof item.text === 'string' ? item.text : item.text?.value || item.content;
    if (value) parts.push(String(value));
  }
  return parts.join('');
}

function parseModelJson(raw, model = 'selected AI model') {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const candidates = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  throw new ProviderError(`${model} returned invalid structured output`);
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
    story_cliffhanger: 'End with a story-specific "See what happens when..." or "Read what happens when..." invitation built from the most specific unresolved choice.',
    identity_reveal: 'End with a "See what happens when..." or "Read what happens when..." invitation around an evidence-supported identity, secret, or recognition turn. Fall back to a plot cliffhanger when none exists.',
    romantic_tension: 'End with a "See what happens when..." or "Read what happens when..." invitation around an evidence-supported charged look, choice, or boundary. Fall back to a plot cliffhanger when romance is not supported.',
    revenge_payoff: 'End with a "See what happens when..." or "Read what happens when..." invitation around an evidence-supported reckoning or reversal. Fall back to a plot cliffhanger when no revenge arc is supported.'
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
  return [
    `Copy style: ${copy[profile.copyStyle] || copy.system_best}`,
    `CTA style: ${cta[profile.ctaStyle] || cta.story_cliffhanger}`,
    `Video plot style: ${video[profile.videoStyle] || video.five_beat}`,
    `Poster direction: ${poster[profile.posterStyle] || poster.system_best}`,
    'If a selected direction conflicts with the chapter evidence, prioritize the evidence and use the nearest truthful emotional angle.'
  ].join('\n');
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
  // Use a separate reviewer so the drafting model does not grade its own work.
  // HY3 remains the default drafter; Qwen handles the smaller post-generation QA request.
  const primaryChoice = requestedSection === 'qualityReview' ? 'qwen3.7-max' : String(creativeProfile.modelChoice || 'hy3');
  const primaryConfig = copyModelConfig({ ...creativeProfile, modelChoice: primaryChoice });
  const { model } = primaryConfig;
  // Keep the generation well below the worker deadline. Ten complete chapters
  // were needlessly pushing a single creative request into the Vercel timeout.
  // Retain every selected chapter but remove redundant prose so the model can
  // spend its response budget on the finished bilingual package, not context.
  const excerpts = evidence.map((item) => ({ chapter: item.order, title: item.title, excerpt: String(item.content).replace(/\s+/g, ' ').slice(0, 460) }));
  const revisionInstruction = revision && requestedSection !== 'qualityReview' ? ' This is a deliberate new creative version. Diagnose the current version silently, then produce a materially different and stronger hook, emotional angle, reversal and visual moment. Do not merely paraphrase it.' : '';
  const styleGuidance = creativeProfileGuidance(creativeProfile);
  const instructions = `You are the senior bilingual fiction social editor for NovelFlow. Return exactly one compact JSON object, with no prose before or after it. Before returning, verify every required schema field exists. Create exactly two evidence-grounded English promotional posts: hook and escalation. Each post must include the six steps hook, pain, sensory detail, contrast, deep desire, and emotional CTA. EACH post.evidence array must contain 2-3 items, and every item must contain a supplied chapter number plus one exact source quote under 18 words. The videoPrompt.sourceEvidence array MUST contain 3 items, each with a supplied chapter number and exact short source quote; evidenceChapters must contain those chapter numbers. Never omit evidence even when writing concisely. Keep each final post under 190 words. Use only supplied chapter facts and names. Use 2-4 fitting emoji per final post.

Use this proven social-copy structure: at least one of the two versions MUST open with one short quoted first-person character line, such as "...". The quote must be grounded in the supplied chapter evidence, not invented. The other version may instead use a sharp one-sentence narrative hook. Make the pain concrete through one sensory detail; contrast the old powerless position with the present threat, desire, or power shift; then land on one specific source-backed turn. Do not produce a generic synopsis. Write the narrative as 3-5 short, clearly separated paragraphs, never one dense wall of text. The emotional CTA must be a complete final invitation in the pattern "See what happens when..." or "Read what happens when...", naming the unresolved source-backed choice, reversal, attraction, secret, or reckoning. It must never be a generic command such as "Read it now", "Click here", "Start reading", or "Read the explosive beginning".

The content field must end in exactly these four separate lines: first the emotional CTA sentence, then a natural app-navigation line that says readers can search this exact Code in NovelFlow (for example "Search Code ${code} in NovelFlow to continue the story."), then the exact short URL alone, then one hashtag-only line with 5-8 concise, relevant genre/trope tags. The hashtags must fit the actual source (for example #MafiaRomance, #EnemiesToLovers, #WerewolfRomance, #FatedMates, #BookTok) and must never be mechanically reused across unrelated books. Do not mention the promotion Code earlier in the narrative. Do not invent tropes, identities, violence, abuse, or relationship facts not supported by chapter evidence. Write concise natural Simplified Chinese translations for operator review.

The videoPrompt is a high-retention vertical short-video story package, not generic visual prose: it must use supplied chapter facts to provide a 0-2s hook, 2-5s personal stake/value promise, 5-8s escalation, 8-11s reversal, and 11-15s cliffhanger. The reversal must be a genuine plot turn from evidence, never invented. Give each beat a chapter and exact short quote, then write compelling English narration and an explicit 0-15s shot plan with character lock. Also provide natural Chinese operator translations. Prohibit subtitles, readable text, CTA cards and identity drift in the generated video. Create two distinct concise English image prompts plus Chinese translations: luminous_cinema 9:16 using nano, and editorial_romance 2:3 using gpt. Image prompts must show one decisive supported moment, reserve negative space, and prohibit readable text, title, logo, watermark, QR, UI, collage, duplicated people and extra limbs. Finally, assess the finished creative package as a production editor. Give only a concise operator-facing conclusion, not private reasoning: recommendation must be keep or refine; choose refine only when a specific source-grounded improvement would materially improve the hook, story logic, video reversal, or visual moment. Explain why and name the target.\n\nSelected creative strategy:\n${styleGuidance}${revisionInstruction}`;
  const schema = {
    posts: [{ type: 'hook|escalation', sixSteps: { hook: 'string', pain: 'string', sensory: 'string', contrast: 'string', deepDesire: 'string', emotionalCta: 'string' }, content: 'complete English post', zhContent: 'complete Chinese translation', evidence: [{ chapter: 1, quote: 'exact quote' }] }],
    videoPrompt: { hook: '0-2s source-grounded hook', valuePromise: '2-5s emotional payoff', escalation: '5-8s rising danger', reversal: '8-11s genuine plot turn', cliffhanger: '11-15s unresolved question', sourceEvidence: [{ chapter: 1, quote: 'exact short source quote' }], adCopy: 'English voiceover/narration matching the five beats', buildRequirement: 'English 0-15 second shot plan with character lock', zhHook: 'Chinese translation', zhValuePromise: 'Chinese translation', zhEscalation: 'Chinese translation', zhReversal: 'Chinese translation', zhCliffhanger: 'Chinese translation', zhAdCopy: 'Chinese narration translation', zhBuildRequirement: 'Chinese shot plan translation', evidenceChapters: [1, 2] },
    posterPrompts: [{ variant: 'luminous_cinema|editorial_romance', prompt: 'English image prompt', zhPrompt: 'Chinese translation' }],
    qualityReview: { recommendation: 'keep|refine', conclusion: 'Chinese operator-facing conclusion', why: 'Chinese source-grounded reason', target: 'copy|video|poster|package' }
  };
  const source = {
    book, tracking: { code, shortUrl }, creativeProfile,
    // This is produced before P3 from the full chapter-title structure and
    // distributed exact chapter samples. It selects an angle; exact quotes
    // below remain the only permitted proof for rendered plot claims.
    storyIntelligence: creativeProfile.storyBrief || null,
    chapterEvidence: excerpts, currentCreative: revision
  };
  const sectionRequest = async (config, label, sectionInstruction, responseSchema, outputBudget, timeoutMs = 30000) => {
    const { apiKey, baseUrl, model: activeModel, responsesApi } = config;
    const payload = responsesApi
      ? { model: activeModel, input: [{ role: 'developer', content: sectionInstruction }, { role: 'user', content: JSON.stringify({ ...source, responseSchema }) }], text: { format: { type: 'json_object' } }, temperature: 0.55, max_output_tokens: outputBudget }
      : { model: activeModel, messages: [{ role: 'system', content: sectionInstruction }, { role: 'user', content: JSON.stringify({ ...source, responseSchema }) }], response_format: { type: 'json_object' }, temperature: 0.55, max_tokens: outputBudget };
    // A worker is limited to 60s on Vercel. Leave enough time to persist a
    // section result or a definitive error, and to make one bounded fallback.
    const body = await postJsonOverHttps(`${baseUrl}${responsesApi ? '/responses' : '/chat/completions'}`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, `${activeModel} ${label}`, timeoutMs);
    return { body, value: parseModelJson(extractModelText(body), activeModel) };
  };
  const shared = `You are the senior bilingual fiction social editor for NovelFlow. The supplied storyIntelligence was generated before production from the complete chapter-title structure plus distributed opening-to-late source samples. Use it to select a coherent emotional arc, angle, reversal and visual moment across the whole story. It is a planning map, not proof: every rendered plot fact and every evidence citation must still be supported by an exact quote in chapterEvidence. Use only supplied chapter facts, names and quotes. Never invent plot, relationship, violence, or identity facts. Return exactly one JSON object with every required field, no prose outside it. ${styleGuidance}${revisionInstruction}`;
  const postsInstruction = `${shared}\nCreate exactly two English posts: hook and escalation, each under 190 words plus a natural Simplified Chinese translation. Each has all six steps and 2-3 exact chapter evidence quotes under 18 words. One post must open with a short grounded first-person quoted line; the other may use a sharp narrative hook. Write 3-5 short readable paragraphs and 2-4 fitting emoji in the visible narrative. This is social copy, not an evidence report: evidence belongs ONLY in the evidence array. Do not paste evidence quotes into the finished post except for the optional opening dialogue. Every visible paragraph must advance the story, so never repeat a sentence, a quote, a detail, or a beat. Build a first-person-feeling scene: immediate disruption, concrete sensory discomfort or desire, a power/expectation reversal, then a sharply specific unresolved choice. Avoid generic summaries, vague chemistry, and explicit sexual detail. The hook version should sell the opening incident; escalation must use a different, source-backed later turning point. End each content field with four separate lines: a source-specific "See what happens when..." or "Read what happens when..." CTA; "Search Code ${code} in NovelFlow to continue the story."; the exact short URL alone; and one hashtag-only line with 5-8 source-relevant tags.`;
  const videoInstruction = `${shared}\nCreate one premium 15-second vertical-video story package, not a synopsis. It must contain 0-2s visual disruption, 2-5s personal stake, 5-8s pressure mounting, 8-11s a genuine source-backed reversal, and 11-15s a question that cuts at the most emotionally expensive choice. The five beats must form one escalating mini-scene, not five generic captions. Give English narration with visceral, filmable detail and an explicit shot plan with locked character appearance, framing, movement, lighting and transitions. Use exactly 3 sourceEvidence objects with supplied chapter numbers and exact short quotes that occur in those chapter excerpts; do not use chapter titles as quotes. Provide natural Chinese translations. No subtitles, readable text, CTA cards, identity drift, explicit sexual content, or unsupported threats.`;
  const postersInstruction = `${shared}\nCreate exactly two source-grounded commercial image prompts with Chinese translations: luminous_cinema in 9:16 and editorial_romance in 2:3. Each must depict one decisive emotional moment, adult fully clothed characters, clear pose and environment, negative space, no readable text, logo, watermark, QR, UI, collage, duplicate people, or extra limbs.`;
  const reviewInstruction = `${shared}\nThis request runs AFTER the copy, video prompt and poster prompts already exist. Act only as a post-generation production QA editor. Assess the supplied finished package against the source and return a concise Chinese operator-facing quality review. Never call this an initial decision, strategy, plan, or reason why the package was originally created. Refer to it explicitly as a finished-package review and proposed revision. Do not expose hidden reasoning.`;
  const runSections = async (config) => Promise.all([
    sectionRequest(config, 'copy generation', postsInstruction, { posts: schema.posts }, 3800),
    sectionRequest(config, 'video generation', videoInstruction, { videoPrompt: schema.videoPrompt }, 2600),
    sectionRequest(config, 'poster generation', postersInstruction, { posterPrompts: schema.posterPrompts }, 1800),
    sectionRequest(config, 'quality review', reviewInstruction, { qualityReview: schema.qualityReview }, 1200)
  ]);
  const sectionSpec = {
    posts: ['copy generation', postsInstruction, { posts: schema.posts }, 3800],
    videoPrompt: ['video generation', videoInstruction, { videoPrompt: schema.videoPrompt }, 2600],
    posterPrompts: ['poster generation', postersInstruction, { posterPrompts: schema.posterPrompts }, 1800],
    qualityReview: ['quality review', reviewInstruction, { qualityReview: schema.qualityReview }, 1200]
  }[requestedSection];
  if (sectionSpec) {
    const startedAt = Date.now();
    const requestSectionWithFallback = async (config, timeoutMs) => sectionRequest(config, ...sectionSpec, timeoutMs);
    const longTask = isLongRunningModel(primaryChoice) && requestedSection !== 'qualityReview';
    const primaryTimeout = longTask ? 600000 : 31000;
    const fallbackTimeout = longTask ? 75000 : 17000;
    let result;
    let modelUsed = model;
    try {
      result = await requestSectionWithFallback(primaryConfig, primaryTimeout);
    } catch (primaryError) {
      // HY3 is the verified low-latency recovery route. Qwen and DeepSeek can
      // both exceed the same serverless window, so chaining them caused a
      // predictable double-timeout rather than a real fallback.
      const fallback = primaryChoice === 'hy3' ? 'qwen3.7-max' : 'hy3';
      try {
        const fallbackConfig = copyModelConfig({ modelChoice: fallback });
        result = await requestSectionWithFallback(fallbackConfig, fallbackTimeout);
        modelUsed = fallbackConfig.model;
      } catch (fallbackError) {
        fallbackError.ambiguous = false;
        fallbackError.message = `Primary ${model}: ${String(primaryError.message || primaryError)}; fallback ${fallback}: ${String(fallbackError.message || fallbackError)}`.slice(0, 500);
        throw fallbackError;
      }
    }
    const usage = result.body.usage || {};
    const actualModel = String(result.body.model || modelUsed);
    return { creative: { [requestedSection]: result.value[requestedSection] }, model: actualModel, requestedModel: model, fallbackFrom: actualModel !== model ? model : '', responseId: String(result.body.id || ''), latencyMs: Date.now() - startedAt, usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
  }
  let sections;
  let modelUsed = model;
  try {
    sections = await runSections(primaryConfig);
  } catch (primaryError) {
    const fallback = primaryChoice === 'hy3' ? 'qwen3.7-max' : 'hy3';
    try {
      const fallbackConfig = copyModelConfig({ modelChoice: fallback });
      sections = await runSections(fallbackConfig);
      modelUsed = fallbackConfig.model;
    } catch (fallbackError) {
      fallbackError.ambiguous = false;
      fallbackError.message = `Primary ${model}: ${String(primaryError.message || primaryError)}; fallback ${fallback}: ${String(fallbackError.message || fallbackError)}`.slice(0, 500);
      throw fallbackError;
    }
  }
  const [posts, video, posters, review] = sections;
  const usage = sections.reduce((total, section) => {
    const item = section.body.usage || {};
    total.inputTokens += Number(item.prompt_tokens || item.input_tokens || 0);
    total.outputTokens += Number(item.completion_tokens || item.output_tokens || 0);
    total.totalTokens += Number(item.total_tokens || 0);
    return total;
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return { creative: { posts: posts.value.posts, videoPrompt: video.value.videoPrompt, posterPrompts: posters.value.posterPrompts, qualityReview: review.value.qualityReview }, model: String(posts.body.model || modelUsed), responseId: sections.map((section) => String(section.body.id || '')).filter(Boolean).join(','), usage };
}

async function analyzeCreativePlan(book, evidence, chapterStructure = [], modelChoice = 'hy3') {
  const { apiKey, baseUrl, model, responsesApi } = copyModelConfig({ modelChoice });
  const excerpts = evidence.map((item) => ({ chapter: item.order, title: item.title, excerpt: String(item.content || '').replace(/\s+/g, ' ').slice(0, 300) }));
  const instructions = `You are the strategy director for NovelFlow fiction social promotion. Return exactly one compact JSON object with no prose before or after it, and keep the entire response under 1200 words. Analyze the distributed full-book structure sample and four representative opening-to-late-story excerpts. Do not write a final social post or repeat the source. Recommend the strongest truthful creative direction for this exact story in concise Simplified Chinese. Ground every claim in supplied evidence and never invent themes, names, abuse, violence, romance, secrets, or reversals. Choose one value for each profile field: copyStyle is system_best|revenge_comeback|forbidden_tension|dark_redemption; ctaStyle is story_cliffhanger|identity_reveal|romantic_tension|revenge_payoff; videoStyle is five_beat|reversal|slow_burn|revenge; posterStyle is system_best|luminous_cinema|editorial_romance. When a trope is unsupported, select the truthful neutral alternative. Give a brief English blueprint for copy, video, and poster. Cite three exact short chapter quotes.`;
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
  const payload = responsesApi
    ? { model, input: [{ role: 'developer', content: instructions }, { role: 'user', content: input }], text: { format: { type: 'json_object' } }, temperature: 0.25, max_output_tokens: outputBudget }
    : { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], response_format: { type: 'json_object' }, temperature: 0.25, max_tokens: outputBudget };
  const planningTimeout = isLongRunningModel(modelChoice) ? 600000 : 47000;
  const body = await postJsonOverHttps(`${baseUrl}${responsesApi ? '/responses' : '/chat/completions'}`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, `${model} creative strategy`, planningTimeout);
  const plan = parseModelJson(extractModelText(body), model);
  if (!plan || typeof plan !== 'object' || !plan.recommendedProfile || !String(plan.editorialThesis || '').trim()) throw new ProviderError(`${model} returned an incomplete creative strategy`);
  const usage = body.usage || {};
  return { plan, model: String(body.model || model), responseId: String(body.id || ''), usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
}

async function analyzeOperations(snapshot, mode = 'operations', modelChoice = 'hy3') {
  const instructions = `You are the operating analyst for NovelFlow social promotion. Return exactly one compact JSON object, not hidden reasoning. Analyze only the supplied task summaries, completed asset inventory, and ranking metrics. Give concise Simplified Chinese, specific and executable conclusions. Do not invent performance, book facts, asset URLs, or status. Never propose automatic Facebook publishing or ambiguous paid-media resubmission. This is an operational console result, not a long report: make the headline decisive, summary under 120 Chinese characters, and each action/recommendation reason under 70 Chinese characters. For mode operations, return up to three concrete blockers, waiting decisions, or highest-impact next actions; include runId whenever that action concerns a supplied task. Identify recoverable text-model waits as background work, and distinguish them from credentials, source-data, and paid-media ambiguity that require a human decision. For mode assets, inspect completed assets and recommend how to use, compare, or improve the existing copy/video/posters; prioritize assets with verified code/link and completed video, and say plainly when evidence is insufficient to claim performance. For mode books, recommend exactly three different titles from snapshot.leaderboard only. This is a rotating, metric-diverse shortlist drawn from the current weekly Top 200; snapshot.recommendationContext.recentRecommendationTitles are recently surfaced titles, so prefer titles outside that history whenever at least three exist. Do not always choose the highest-profit titles. Diversify the three choices across scale, first-read conversion, and long-read retention. Output schema: {"headline":"string","summary":"string","actions":[{"priority":"high|medium|low","title":"string","reason":"string","runId":"optional string"}],"recommendations":[{"title":"string","reason":"string","caveat":"string"}]}.`;
  const request = async (choice, timeoutMs) => {
    const { apiKey, baseUrl, model, responsesApi } = copyModelConfig({ modelChoice: choice });
    const payload = responsesApi
      ? { model, input: [{ role: 'developer', content: instructions }, { role: 'user', content: JSON.stringify({ mode, snapshot }) }], text: { format: { type: 'json_object' } }, temperature: 0.2, max_output_tokens: 1200 }
      : { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify({ mode, snapshot }) }], response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 1200 };
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
      else if (['queued', 'running'].includes(String(run.state))) actions.push({ priority: 'low', title: `${run.title || '任务'}：继续生产`, reason: `已完成 ${Number(run.completedStages || 0)}/7 个节点；可打开查看当前素材和下一节点。`, runId: run.id });
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
  // Console assistance should feel immediate. Full creative and planning flows
  // keep their larger quality budgets; this compact analysis switches quickly
  // when a selected TokenDance route is not currently producing usable JSON.
  const primaryTimeout = {
    hy3: 10000,
    'qwen3.7-max': 18000,
    deepseek: 28000,
    'seed-2.1-turbo': 7000,
    'minimax-m2.7': 7000,
    'kimi-k2.7-code': 7000
  }[modelChoice] || 12000;
  try {
    return await request(modelChoice, primaryTimeout);
  } catch (primaryError) {
    const reserve = modelChoice === 'qwen3.7-max' ? 'deepseek' : 'qwen3.7-max';
    try {
      const reserveResult = await request(reserve, 16000);
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
      description: String(book.description || '').slice(0, 1200), sources: Array.isArray(book.sources) ? book.sources : []
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
  const { apiKey, baseUrl, model } = copyModelConfig({ modelChoice: 'seed-2.1-turbo' });
  const prompt = 'Inspect this novel screenshot. Return JSON only: {"text":"up to 500 words of readable story text","characters":["names"],"phrases":["2-4 rare exact phrases"],"plotClues":["specific clues"],"quality":"high|medium|low"}. Preserve spelling and do not invent any title, character, or plot fact not visible in the image.';
  const payload = {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: String(imageUrl || '') } }] }],
    response_format: { type: 'json_object' }, temperature: 0, max_tokens: 900
  };
  const body = await postJsonOverHttps(`${baseUrl}/chat/completions`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, 'Seed screenshot analysis', 60000);
  const result = parseModelJson(extractModelText(body), model);
  const text = String(result?.text || '').trim();
  if (!text) throw new ProviderError('Seed screenshot analysis returned no readable text', { status: 422 });
  return {
    text: text.slice(0, 20000), characters: Array.isArray(result.characters) ? result.characters.map(String).slice(0, 8) : [],
    phrases: Array.isArray(result.phrases) ? result.phrases.map(String).slice(0, 6) : [],
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
  const payload = responsesApi
    ? { model, input: [{ role: 'developer', content: instructions }, { role: 'user', content: JSON.stringify(source) }], text: { format: { type: 'json_object' } }, temperature: 0.35, max_output_tokens: 1100 }
    : { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(source) }], response_format: { type: 'json_object' }, temperature: 0.35, max_tokens: 1100 };
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
    temperature: 0.25,
    max_tokens: 900
  };
  const body = await postJsonOverHttps(`${config.baseUrl}/chat/completions`, { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, payload, `${config.model} copilot`, 35000);
  const message = body.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 3).map((call) => ({ id: String(call.id || crypto.randomUUID()), name: String(call.function?.name || ''), arguments: String(call.function?.arguments || '{}') })) : [];
  const usage = body.usage || {};
  return { message: { content: String(message.content || '').trim(), toolCalls }, model: String(body.model || config.model), usage: { inputTokens: Number(usage.prompt_tokens || 0), outputTokens: Number(usage.completion_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
}

async function rewritePosterPrompt(book, evidence, asset, failureReason) {
  const apiKey = secretToken('NOVELFLOW_COPY_LLM_API_KEY') || secretToken('NOVELFLOW_LLM_API_KEY');
  if (!apiKey) throw new ProviderError('DeepSeek copy model is not configured', { status: 503 });
  const baseUrl = env('NOVELFLOW_COPY_LLM_BASE_URL', 'https://api.deepseek.com').replace(/\/$/, '');
  const model = env('NOVELFLOW_COPY_LLM_MODEL', 'deepseek-chat');
  const configuredWire = env('NOVELFLOW_COPY_LLM_WIRE_API').toLowerCase();
  const responsesApi = configuredWire === 'responses' || (!configuredWire && /\/\/(?:[^/]*\.)?max\.jojocode\.com(?:[:/]|$)/i.test(baseUrl));
  const excerpts = evidence.slice(0, 4).map((item) => ({ chapter: item.order, excerpt: String(item.content || '').replace(/\s+/g, ' ').slice(0, 400) }));
  const instructions = `You repair one rejected romance-fiction image prompt for a commercial image model. Return exactly one JSON object: {"prompt":"English prompt","zhPrompt":"Simplified Chinese explanation"}. Preserve one source-grounded emotional conflict and the requested aspect ratio. Make it audit-safe: adult characters only, fully clothed, no nudity, no sexual activity, no coercion, no violence, no self-harm, no illegal activity, no weapons, no brands, no readable text, no logos, no watermark, no QR, no UI, no collage, no duplicate people or extra limbs. Prefer elegant cinematic or editorial visual language, clear pose and environment, and negative space. Do not mention the rejection in the result.`;
  const input = JSON.stringify({ book: { title: book.title, category: book.category, description: String(book.description || '').slice(0, 700) }, variant: asset.variant, originalPrompt: asset.prompt, providerFailure: String(failureReason || '').slice(0, 400), chapterEvidence: excerpts });
  const payload = responsesApi
    ? { model, input: [{ role: 'developer', content: instructions }, { role: 'user', content: input }], text: { format: { type: 'json_object' } }, temperature: 0.35, max_output_tokens: 900 }
    : { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], response_format: { type: 'json_object' }, temperature: 0.35, max_tokens: 900 };
  const body = await postJsonOverHttps(`${baseUrl}${responsesApi ? '/responses' : '/chat/completions'}`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, 'DeepSeek poster prompt repair', 25000);
  const repaired = parseModelJson(extractModelText(body), model);
  const prompt = String(repaired.prompt || '').trim();
  if (prompt.length < 100) throw new ProviderError('DeepSeek poster repair returned an invalid prompt');
  const usage = body.usage || {};
  return { prompt, zhPrompt: String(repaired.zhPrompt || '').trim(), model: String(body.model || model), responseId: String(body.id || ''), usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
}

function acHeaders(json = false) {
  const token = secretToken('NOVELFLOW_AC_TOKEN');
  if (!token) throw new ProviderError('AC video token is not configured', { status: 503 });
  return { Authorization: `Bearer ${token}`, 'X-Project-Id': env('NOVELFLOW_AC_PROJECT_ID', '1006'), 'x-client': env('NOVELFLOW_AC_CLIENT', 'beidou-web'), Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

async function findAcTask(remark) {
  for (let page = 1; page <= 5; page += 1) {
    const { body } = await request(`${AC_BASE}/api/v1/creative/paged-list?${qs({ PageSize: 100, PageIndex: page, type: 'video' })}`, { headers: acHeaders() }, 'AC task reconciliation');
    const result = pageItems(body);
    const match = result.items.find((item) => String(item.remark || '') === String(remark));
    if (match) return match;
    if (!result.items.length || page >= result.pages) break;
  }
  return null;
}

async function submitAc(payload) {
  const { body } = await request(`${AC_BASE}/api/v1/creative/by-user`, { method: 'POST', headers: acHeaders(true), body: JSON.stringify(payload) }, 'AC paid video submission', 45000);
  return body;
}

async function acResult(threadId) {
  const response = await fetch(`${AC_BASE}/api/v1/creative/${encodeURIComponent(threadId)}/result`, { headers: acHeaders() });
  if (response.status === 204) return { status: 'running', threadId };
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { throw new ProviderError('AC result returned invalid JSON'); }
  if (!response.ok) throw new ProviderError(`AC result failed with HTTP ${response.status}`, { status: response.status });
  const base = body.base_info || body.baseInfo || {};
  const results = body.final_result || body.finalResult || [];
  const videoUrls = (Array.isArray(results) ? results : []).map((item) => absoluteUrl(item.video_url || item.source_video_url)).filter(Boolean);
  const runStatus = String(body.run_status || body.status || '').toLowerCase();
  const baseStatus = String(base.status || '').toLowerCase();
  const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(runStatus) || ['failed', 'error', 'cancelled', 'canceled'].includes(baseStatus);
  const complete = runStatus === 'completed' && baseStatus === 'completed';
  return { status: failed ? (videoUrls.length ? 'partial' : 'failed') : complete ? (videoUrls.length ? 'completed' : 'completed_missing_media') : 'running', threadId, videoUrls, coverImageUrl: absoluteUrl(results?.[0]?.cover_image_url || results?.[0]?.cover_url), error: String(base.error_msg || body.message || body.error || '').slice(0, 500) };
}

async function validateVideo(url) {
  let response;
  try { response = await fetch(url, { method: 'HEAD', redirect: 'follow' }); } catch { response = null; }
  if (!response?.ok || !String(response.headers.get('content-type') || '').toLowerCase().startsWith('video/')) response = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
  const type = String(response.headers.get('content-type') || '');
  const length = Number(response.headers.get('content-length') || String(response.headers.get('content-range') || '').split('/').pop() || 0);
  if (!response.ok || !type.toLowerCase().startsWith('video/') || length <= 0) throw new ProviderError('Generated AC media could not be verified as a non-empty video');
  return { contentType: type, contentLength: length };
}

const IMAGE_SPECS = {
  luminous_cinema: { endpoint: '/img/nano', agent_id: 4, aspectRatio: '9:16', imageSize: '2K' },
  editorial_romance: { endpoint: '/img/gpt', agent_id: 12, aspectRatio: '2:3', imageSize: '2K' }
};

async function submitImage(asset) {
  const key = secretToken('NOVELFLOW_IMAGE_API_KEY');
  if (!key) throw new ProviderError('Image API key is not configured', { status: 503 });
  const spec = IMAGE_SPECS[asset.variant];
  const base = env('NOVELFLOW_IMAGE_BASE_URL', 'https://laoye.chat').replace(/\/$/, '');
  const payload = { agent_id: spec.agent_id, prompt: asset.prompt, aspectRatio: spec.aspectRatio, imageSize: spec.imageSize, billingMode: env('NOVELFLOW_IMAGE_BILLING_MODE', 'points'), idempotency_key: asset.idempotencyKey };
  const { body } = await request(`${base}${spec.endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, `Paid ${asset.variant} image submission`, 55000);
  return body.data || {};
}

async function imageResult(taskId) {
  const key = secretToken('NOVELFLOW_IMAGE_API_KEY');
  const base = env('NOVELFLOW_IMAGE_BASE_URL', 'https://laoye.chat').replace(/\/$/, '');
  const { body } = await request(`${base}/api/v1/jobs/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${key}` } }, 'Image result');
  return body.data || {};
}

async function reportRows(code, linkId, days = 90) {
  const reportToken = secretToken('NOVELFLOW_REPORT_TOKEN') || await oidcToken(false);
  const endpoint = env('NOVELFLOW_REPORT_FUNNEL_API', 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/socialsource-code-funnel/list');
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const format = (date) => date.toISOString().slice(0, 10);
  const payload = { pageIndex: 1, pageSize: 1000, from: format(start), to: format(end), adIds: [String(code), String(linkId)].filter(Boolean), groupings: ['dt', 'ad_id'] };
  const { body } = await request(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${reportToken}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) }, 'Social funnel report', 55000);
  return { rows: pageItems(body).items, from: format(start), to: format(end) };
}

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

module.exports = { ProviderError, enabled, absoluteUrl, findExactBook, topBooks, performanceBooks, contentDashboardBooks, listChapters, chapterContent, keywordRecord, createKeyword, findLink, createLink, linkDetail, generateCreative, analyzeCreativePlan, analyzeOperations, analyzeBookCandidates, extractScreenshotText, analyzeScreenshotWithSeed, copilotReply, generateDistributionPlan, rewritePosterPrompt, findAcTask, submitAc, acResult, validateVideo, submitImage, imageResult, reportRows, sha, titleKey };
