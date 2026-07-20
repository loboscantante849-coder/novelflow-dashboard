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

async function topBooks(limit = 50) {
  const pageSize = Math.max(1, Math.min(Number(limit) || 50, 50));
  const load = async (languageCode) => {
    const { body } = await adminRequest(`${BOOK_API}?${qs({
      current: 1, pageIndex: 1, pageSize, applicationId: APPLICATION_ID, bookStatus: 1,
      orderBy: 'uv', orderType: 'desc', languageCode
    })}`, {}, 'Top books lookup');
    return pageItems(body).items;
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

async function createKeyword(sku, code) {
  const payload = { applicationId: APPLICATION_ID, keyword: String(code), bookId: String(sku), channel: env('NOVELFLOW_CHANNEL_CODE', 'FB'), isEnable: true };
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

async function findLink(sku, promoter, code) {
  const { body } = await adminRequest(`${LINK_API}?${qs({ pageIndex: 1, pageSize: 100, linkName: code })}`, {}, 'Short-link lookup');
  for (const item of pageItems(body).items) {
    if (!String(item.linkName || '').startsWith(String(code))) continue;
    const detail = item.id ? await linkDetail(String(item.id)) : item;
    const sourceSku = String(detail.contentNameOrSku || item.contentNameOrSku || '');
    const operator = String(detail.operatorName || item.operatorName || '');
    if ((sourceSku === String(sku) || sourceSku.includes(String(sku))) && operator.toLowerCase() === String(promoter).toLowerCase() && enabled(detail.isEnabled ?? item.isEnabled)) {
      return { ...item, ...detail, shortUrl: absoluteUrl(detail.shortUrl || item.shortUrl) };
    }
  }
  return null;
}

async function createLink(book, promoter, code) {
  const channelName = `NovelFlow_SocialMedia_Facebook-grounp_Facebook_${promoter}`;
  const title = String(book.title || '').slice(0, 180);
  const payload = {
    linkName: `${code}${title}-Book-Detail-FB`, applicationId: APPLICATION_ID, mediaSource: 'SocialMedia',
    channelSource: env('NOVELFLOW_CHANNEL_SOURCE', 'Facebook-grounp'), channelNameId: env('NOVELFLOW_CHANNEL_NAME_ID', '699ef7b8194eb218db3c2270'),
    channelName, contentType: 1, contentNameOrSku: book.bookSkuId, languageCode: 'en',
    redirectConfigId: env('NOVELFLOW_REDIRECT_CONFIG_ID', '68fecf8b3a29f6eff435fd3b'), contentRedirectSequence: 1,
    adGroupName: `${channelName}_${code}${title}-Book-Detail-FB_${promoter}`, operatorName: promoter,
    landingPageTemplates: [{ templateId: env('NOVELFLOW_LANDING_TEMPLATE_ID', '6a01499261118c6285dff7dd'), templateName: env('NOVELFLOW_LANDING_TEMPLATE_NAME', 'Book Detail FB'), templateWeight: 100, isDeleted: false }],
    isEnabled: true, contentName: title,
    customConfig: JSON.stringify({ appName: 'NovelFlow', languageConfig: { h5_read_more: 'Read More for Free', h5_open_app: 'Open APP' } })
  };
  const { body } = await adminRequest(LINK_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 40000 }, 'Short-link creation');
  return { payload, id: typeof body.data === 'string' ? body.data : String(body.data?.id || '') };
}

function extractModelText(body) {
  if (body.output_text) return String(body.output_text);
  const choice = body.choices?.[0]?.message?.content;
  if (choice) return String(choice);
  const parts = [];
  for (const output of body.output || []) for (const item of output.content || []) if (item.text) parts.push(item.text);
  return parts.join('');
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

async function generateCreative(book, evidence, code, shortUrl) {
  const apiKey = secretToken('NOVELFLOW_COPY_LLM_API_KEY') || secretToken('NOVELFLOW_LLM_API_KEY');
  if (!apiKey) throw new ProviderError('DeepSeek copy model is not configured', { status: 503 });
  const baseUrl = env('NOVELFLOW_COPY_LLM_BASE_URL', 'https://api.deepseek.com').replace(/\/$/, '');
  const model = env('NOVELFLOW_COPY_LLM_MODEL', 'deepseek-chat');
  // Keep the generation well below the worker deadline. Ten complete chapters
  // were needlessly pushing a single creative request into the Vercel timeout.
  const excerpts = evidence.map((item) => ({ chapter: item.order, title: item.title, excerpt: String(item.content).replace(/\s+/g, ' ').slice(0, 700) }));
  const instructions = `You are the senior bilingual fiction social editor for NovelFlow. Return one JSON object only. Create exactly two evidence-grounded English promotional posts: hook and escalation. Each post must follow six steps: hook, pain, sensory, contrast, deepDesire, emotionalCta. Keep each final English post under 170 words. Use only supplied chapter facts and names. Cite two exact chapter quotes per post. Use 2-4 fitting emoji per final post. The CTA must contain the exact code and short URL. Also write natural Simplified Chinese translations for operator review. Create one concise AC Seedance vertical-video prompt in English plus Chinese translation, grounded in the same evidence, with a character lock, 3-4 chronological beats, and a 0-12 second shot plan; prohibit subtitles, readable text, CTA cards and identity drift. Create two distinct concise English image prompts plus Chinese translations: luminous_cinema 9:16 using nano, and editorial_romance 2:3 using gpt. Image prompts must show one decisive supported moment, reserve negative space, and prohibit readable text, title, logo, watermark, QR, UI, collage, duplicated people and extra limbs.`;
  const schema = {
    posts: [{ type: 'hook|escalation', sixSteps: { hook: 'string', pain: 'string', sensory: 'string', contrast: 'string', deepDesire: 'string', emotionalCta: 'string' }, content: 'complete English post', zhContent: 'complete Chinese translation', evidence: [{ chapter: 1, quote: 'exact quote' }] }],
    videoPrompt: { adCopy: 'English story bible', buildRequirement: 'English shot plan', zhAdCopy: 'Chinese', zhBuildRequirement: 'Chinese', evidenceChapters: [1, 2] },
    posterPrompts: [{ variant: 'luminous_cinema|editorial_romance', prompt: 'English image prompt', zhPrompt: 'Chinese translation' }]
  };
  const payload = {
    model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify({ book, tracking: { code, shortUrl }, chapterEvidence: excerpts, responseSchema: schema }) }],
    response_format: { type: 'json_object' }, temperature: 0.55, max_tokens: 3000
  };
  let body;
  try {
    body = await postJsonOverHttps(`${baseUrl}/chat/completions`, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload, 'DeepSeek creative generation', 48000);
  } catch (error) {
    // Creative generation is idempotent and does not charge a paid media task.
    // Its request may safely be retried by the pipeline.
    error.ambiguous = false;
    throw error;
  }
  let raw = extractModelText(body).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let creative;
  try { creative = JSON.parse(raw); } catch { throw new ProviderError('DeepSeek returned invalid creative JSON'); }
  const usage = body.usage || {};
  return { creative, model: String(body.model || model), responseId: String(body.id || ''), usage: { inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0), outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0) } };
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

module.exports = { ProviderError, enabled, absoluteUrl, findExactBook, topBooks, performanceBooks, listChapters, chapterContent, keywordRecord, createKeyword, findLink, createLink, generateCreative, findAcTask, submitAc, acResult, validateVideo, submitImage, imageResult, reportRows, sha, titleKey };
