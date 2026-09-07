#!/usr/bin/env node
/*
 * SocialEcho schedule harness
 *
 * This file is intentionally a standalone operational guard.  It does not
 * submit anything unless BOTH --execute and SCHEDULE_CONFIRM=I_UNDERSTAND are
 * supplied.  The default mode is local validation; --live performs GET-only
 * reconciliation.  It never retries a request whose outcome is ambiguous.
 *
 * Input may be a plan array, {items: []}, or a state/ledger object with an
 * `items` map.  Existing ledgers can be supplied repeatedly with
 * --known-ledger.  The audit file contains hashes and identifiers only; API
 * credentials, signed upload URLs, and full captions are never persisted.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const API_BASE = String(process.env.SOCIALECHO_API_BASE_URL || 'https://api.socialecho.net').replace(/\/$/, '');
try {
  if (new URL(API_BASE).protocol !== 'https:') throw new Error('SOCIALECHO_API_BASE_URL must use HTTPS');
} catch (error) {
  throw new Error(`Invalid SocialEcho API base URL: ${error.message}`);
}
const TZ_SUFFIX = '+08:00';
const MIN_LEAD_MS = 60 * 1000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_AUDIT = `socialecho_schedule_audit_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.json`;

// Leave headroom below SocialEcho's documented 120 requests/minute limit.
// This gate covers both GET reconciliation and POST scheduling calls.
const requestTimes = [];
const requestGate = {
  async take() {
    while (true) {
      const now = Date.now();
      while (requestTimes.length && requestTimes[0] <= now - 60_000) requestTimes.shift();
      if (requestTimes.length < 100) { requestTimes.push(now); return; }
      await new Promise((resolve) => setTimeout(resolve, Math.max(250, requestTimes[0] + 60_000 - now)));
    }
  }
};

// The route table is duplicated deliberately: this script can run outside the
// Vercel function bundle and must not depend on Redis or a browser session.
export const ROUTES = Object.freeze({
  13751295: { accountId: 13751295, brand: 'novelflow', platform: 'facebook', type: 'reels', title: 'NovelFlow' },
  13943450: { accountId: 13943450, brand: 'novelflow', platform: 'instagram', type: 'reels', title: 'NovelFlow' },
  13943940: { accountId: 13943940, brand: 'novelflow', platform: 'tiktok', type: 'video', title: 'NovelFlow' },
  13943483: { accountId: 13943483, brand: 'astranovel', platform: 'facebook', type: 'reels', title: 'AstraNovel' },
  15401748: { accountId: 15401748, brand: 'astranovel', platform: 'instagram', type: 'reels', title: 'AstraNovel' },
  13944009: { accountId: 13944009, brand: 'astranovel', platform: 'tiktok', type: 'video', title: 'astranovel_freenovels' },
  13943482: { accountId: 13943482, brand: 'maxnovel', platform: 'facebook', type: 'reels', title: 'MaxNovel' },
  15590770: { accountId: 15590770, brand: 'maxnovel', platform: 'instagram', type: 'reels', title: 'MaxNovel' },
  13943764: { accountId: 13943764, brand: 'maxnovel', platform: 'tiktok', type: 'video', title: 'maxnovel.app' },
  13943484: { accountId: 13943484, brand: 'storyca', platform: 'facebook', type: 'reels', title: 'Storyca' },
  13943914: { accountId: 13943914, brand: 'storyca', platform: 'instagram', type: 'reels', title: 'Storyca' },
  13943918: { accountId: 13943918, brand: 'storyca', platform: 'tiktok', type: 'video', title: 'storyca.app' },
  13943485: { accountId: 13943485, brand: 'novelvio', platform: 'facebook', type: 'reels', title: 'Novelvio' },
  18185914: { accountId: 18185914, brand: 'novelvio', platform: 'tiktok', type: 'video', title: 'novelvio' }
});

const PLATFORM_ALIASES = Object.freeze({
  fb: 'facebook', facebook: 'facebook',
  ig: 'instagram', instagram: 'instagram',
  tt: 'tiktok', tiktok: 'tiktok'
});

function asText(value, max = 12000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(item) {
  return sha256(stableJson({
    accountId: Number(item.account_id || item.accountId || 0),
    type: asText(item.type || item.publish_type || item.publishType).toLowerCase(),
    scheduledAt: canonicalSchedule(item.scheduled_at || item.scheduledAt),
    caption: asText(item.content || item.caption || item.copy),
    publicUrl: cleanPublicUrl(item.public_url || item.publicUrl || item.attachment_url)
  }));
}

function normalizePlatform(value) {
  const key = asText(value, 40).toLowerCase().replace(/[ _-]+/g, '');
  return PLATFORM_ALIASES[key] || key;
}

function pick(item, ...keys) {
  for (const key of keys) if (item && item[key] !== undefined && item[key] !== null && String(item[key]).trim() !== '') return item[key];
  return '';
}

function extractRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.items)) return raw.items;
  if (raw?.items && typeof raw.items === 'object') return Object.values(raw.items);
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

// Small RFC-4180 reader for the CSV ledgers kept beside the JSON manifests.
// It intentionally returns strings only; all semantic coercion happens in
// normalizeItem(), keeping one validation path for both formats.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < String(text || '').length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => String(header || '').trim());
  return rows.filter((values) => values.some((value) => String(value || '').trim() !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

export function canonicalSchedule(value) {
  const text = asText(value, 100);
  if (!text) return '';
  const stamp = Date.parse(text);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : '';
}

function hasExplicitBeijingOffset(value) {
  return /\+08:00$/.test(asText(value, 100));
}

function cleanPublicUrl(value) {
  const text = asText(value, 5000);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    // Query strings on public_url are not needed and can contain temporary
    // signatures.  Never carry them into a payload or audit record.
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch { return text; }
}

function redactedUrl(value) {
  const clean = cleanPublicUrl(value);
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    return `${parsed.origin}${parsed.pathname}`;
  } catch { return ''; }
}

function codeValues(caption) {
  const values = [];
  const re = /(?:search\s+)?code\s*[:#]?\s*(\d{4,8})/ig;
  let match;
  while ((match = re.exec(String(caption || '')))) values.push(match[1]);
  return [...new Set(values)];
}

function urls(caption) {
  return [...String(caption || '').matchAll(/https?:\/\/[^\s)]+/ig)].map((match) => match[0].replace(/[.,!?]+$/, ''));
}

function isApprovedAttributionUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'social.novelplatform.vip' && /^\/s\/[A-Za-z0-9_-]+$/.test(parsed.pathname);
  } catch { return false; }
}

function isSocialEchoPublicVideo(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'oss.socialecho.net' && !parsed.search && /\.(?:mp4|mov|webm|avi|mkv|wmv|flv|3gp)(?:$|\/)/i.test(parsed.pathname);
  } catch { return false; }
}

function utf16Length(value) { return Array.from(String(value || '')).reduce((n, ch) => n + (ch.length > 1 ? 2 : 1), 0); }

function expectedAttribution(route) {
  // Current contract: NovelFlow and AstraNovel carry Code; only Facebook
  // carries the approved short URL. MaxNovel/Storyca/Novelvio carry neither.
  return { code: ['novelflow', 'astranovel'].includes(route.brand), link: ['novelflow', 'astranovel'].includes(route.brand) && route.platform === 'facebook' };
}

export function normalizeItem(raw, index = 0) {
  const accountId = Number(pick(raw, 'account_id', 'accountId', 'account')); // account may be numeric in old ledgers
  const route = ROUTES[accountId] || null;
  const platform = normalizePlatform(pick(raw, 'platform', 'app', 'channel'));
  const caption = asText(pick(raw, 'content', 'caption', 'copy'), 12000);
  const scheduledRaw = asText(pick(raw, 'scheduled_at', 'scheduledAt', 'publish_at', 'publishAt'), 100);
  const publicUrlRaw = asText(pick(raw, 'public_url', 'publicUrl', 'attachment_url', 'attachmentUrl'), 5000);
  const publicUrl = cleanPublicUrl(publicUrlRaw);
  const externalId = asText(pick(raw, 'external_id', 'externalId', 'socialecho_id', 'socialEchoId', 'article_id'), 100);
  const sku = asText(pick(raw, 'sku', 'book_sku', 'bookSku', 'book_id'), 200);
  const title = asText(pick(raw, 'title', 'book_title', 'bookTitle'), 500);
  const explicitStatus = pick(raw, 'status', 'provider_status');
  const status = explicitStatus === '' ? null : String(explicitStatus).toLowerCase();
  return {
    index: index + 1,
    raw,
    sku,
    title,
    platform,
    accountId,
    type: asText(pick(raw, 'type', 'publish_type', 'publishType'), 40).toLowerCase(),
    status,
    scheduledRaw,
    scheduledAt: canonicalSchedule(scheduledRaw),
    caption,
    code: asText(pick(raw, 'code', 'tracking_code', 'trackingCode'), 100),
    link: asText(pick(raw, 'link', 'shortUrl', 'short_url'), 500),
    videoUrl: asText(pick(raw, 'video_url', 'videoUrl', 'source_video_url', 'sourceVideoUrl'), 5000),
    publicUrlRaw,
    publicUrl,
    externalId,
    key: asText(pick(raw, 'key'), 300) || `${sku}|${platform}`,
    fingerprint: ''
  };
}

export function validateItem(item, { now = Date.now(), allowExisting = true } = {}) {
  const errors = [];
  const warnings = [];
  const route = ROUTES[item.accountId];
  if (!route) errors.push('account_unknown_or_disabled');
  if (!item.platform || !PLATFORM_ALIASES[item.platform] && !['facebook', 'instagram', 'tiktok'].includes(item.platform)) errors.push('platform_unsupported');
  if (route && item.platform && route.platform !== item.platform) errors.push('account_platform_mismatch');
  if (route && item.type && route.type !== item.type) errors.push('account_type_mismatch');
  if (route && !item.type) errors.push('type_missing');
  if (item.status !== null && ['0', 'draft', 'ready_for_review', 'internal_draft'].includes(item.status)) errors.push('status_not_schedule');
  if (item.status !== null && !['1', 'scheduled', 'scheduled_external', 'external_draft', 'submitting', 'publish_ambiguous', 'uploaded', 'planned', 'ready_to_submit'].includes(item.status)) warnings.push('unknown_input_status');
  if (!item.scheduledRaw) errors.push('scheduled_at_missing');
  else if (!hasExplicitBeijingOffset(item.scheduledRaw)) errors.push('scheduled_at_must_end_+08:00');
  else if (!item.scheduledAt) errors.push('scheduled_at_invalid');
  else if (Date.parse(item.scheduledAt) < now + MIN_LEAD_MS) errors.push('scheduled_at_not_in_future');
  if (!item.caption) errors.push('caption_missing');
  const max = item.platform === 'facebook' || item.platform === 'instagram' ? 2200 : 2200;
  if (item.caption && (item.platform === 'tiktok' ? utf16Length(item.caption) : item.caption.length) > max) errors.push('caption_over_2200');
  if (!item.publicUrl) errors.push('uploaded_public_url_missing');
  else if (!isSocialEchoPublicVideo(item.publicUrl)) errors.push('attachment_not_socialecho_public_video');
  if (item.publicUrlRaw && /[?]/.test(item.publicUrlRaw)) errors.push('attachment_query_or_signed_url_forbidden');
  if (item.videoUrl && !/^https:\/\//i.test(item.videoUrl)) errors.push('source_video_url_not_https');
  if (item.externalId && !allowExisting) errors.push('external_id_present');
  if (item.status === 'publish_ambiguous' || item.status === 'submitting' || item.status === 'uploading') warnings.push('ambiguous_requires_reconciliation');
  if (item.status === 'external_draft' || item.status === 'scheduled_external' || item.externalId) warnings.push('already_has_external_record');

  if (route) {
    const attribution = expectedAttribution(route);
    const foundCodes = codeValues(item.caption);
    const foundUrls = urls(item.caption);
    if (attribution.code && !foundCodes.length) errors.push('attribution_code_missing');
    if (attribution.code && item.code && foundCodes.length && !foundCodes.includes(item.code)) errors.push('attribution_code_mismatch');
    // `code`/`link` columns are allowed as planning metadata.  Only values
    // that would actually be sent in content are enforced here.
    if (!attribution.code && foundCodes.length) errors.push('attribution_forbidden_for_brand');
    if (attribution.link) {
      if (!foundUrls.some(isApprovedAttributionUrl)) errors.push('facebook_attribution_link_missing_or_invalid');
      if (foundUrls.some((url) => !isApprovedAttributionUrl(url))) errors.push('unapproved_attribution_url');
    } else {
      if (foundUrls.length) errors.push('url_forbidden_on_this_route');
    }
    if (!attribution.link && foundUrls.some((url) => !isApprovedAttributionUrl(url))) errors.push('url_forbidden_on_this_route');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], route };
}

export function buildPayload(item) {
  const route = ROUTES[item.accountId];
  if (!route) throw new Error('Cannot build payload for an unknown account');
  const result = validateItem(item);
  if (!result.ok) throw new Error(`Invalid item ${item.index}: ${result.errors.join(', ')}`);
  return {
    account_id: route.accountId,
    type: route.type,
    status: 1,
    scheduled_at: formatBeijing(item.scheduledAt),
    content: item.caption,
    extra: route.platform === 'tiktok' ? { draft: false } : {},
    attachments: [{ url: item.publicUrl }],
    comment: []
  };
}

function formatBeijing(value) {
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(stamp)).reduce((out, part) => { if (part.type !== 'literal') out[part.type] = part.value; return out; }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${TZ_SUFFIX}`;
}

function parseArgs(argv) {
  const args = { manifests: [], known: [], live: false, execute: false, concurrency: DEFAULT_CONCURRENCY, audit: DEFAULT_AUDIT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--live') args.live = true;
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--manifest') args.manifests.push(argv[++i]);
    else if (arg.startsWith('--manifest=')) args.manifests.push(arg.slice(11));
    else if (arg === '--known-ledger') args.known.push(argv[++i]);
    else if (arg.startsWith('--known-ledger=')) args.known.push(arg.slice(15));
    else if (arg === '--audit') args.audit = argv[++i];
    else if (arg.startsWith('--audit=')) args.audit = arg.slice(8);
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (arg.startsWith('--concurrency=')) args.concurrency = Number(arg.slice(15));
    else if (!arg.startsWith('-')) args.manifests.push(arg);
  }
  args.concurrency = Math.max(1, Math.min(4, Number.isFinite(args.concurrency) ? args.concurrency : DEFAULT_CONCURRENCY));
  return args;
}

async function readStructured(file) {
  const text = await fs.readFile(file, 'utf8');
  if (String(file).toLowerCase().endsWith('.csv')) return parseCsv(text);
  try { return JSON.parse(text); } catch (error) { throw new Error(`Invalid JSON manifest ${file}: ${error.message}`); }
}

async function loadItems(files) {
  const rows = [];
  for (const file of files) {
    const raw = await readStructured(file);
    extractRows(raw).forEach((row, index) => rows.push(normalizeItem(row, rows.length + index)));
  }
  return rows;
}

function loadKnownRows(raw) {
  return extractRows(raw).map((row, index) => normalizeItem(row, index));
}

async function loadKnown(files) {
  const rows = [];
  for (const file of files) rows.push(...loadKnownRows(await readStructured(file)));
  return rows;
}

function knownKeys(rows) {
  const exact = new Set();
  const slots = new Map();
  const itemKeys = new Set();
  for (const row of rows) {
    if (row.externalId || ['scheduled_external', 'external_draft', 'published'].includes(row.status)) exact.add(fingerprint(row));
    const slot = `${row.accountId}|${row.type}|${row.scheduledAt}`;
    if (row.scheduledAt && row.accountId && row.type) slots.set(slot, row);
    if (row.sku && row.platform && row.externalId) itemKeys.add(`${row.sku}|${row.platform}`);
  }
  return { exact, slots, itemKeys };
}

function auditEntry(item, validation, state = 'validated', extra = {}) {
  return {
    at: new Date().toISOString(),
    index: item.index,
    sku: item.sku,
    title: item.title,
    brand: validation.route?.brand || '',
    platform: item.platform,
    account_id: item.accountId || null,
    type: item.type || validation.route?.type || '',
    scheduled_at: item.scheduledAt ? formatBeijing(item.scheduledAt) : item.scheduledRaw,
    caption_sha256: sha256(item.caption),
    public_url: redactedUrl(item.publicUrl),
    public_url_sha256: sha256(item.publicUrl),
    external_id: item.externalId || '',
    state,
    errors: validation.errors || [],
    warnings: validation.warnings || [],
    ...extra
  };
}

async function readAudit(file) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, items: {} };
    return { ...raw, items: raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? raw.items : {} };
  } catch { return { version: 1, items: {} }; }
}

let auditWriteChain = Promise.resolve();
async function writeAudit(file, audit) {
  const operation = auditWriteChain.then(async () => {
    const target = path.resolve(file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: audit.items || {} }, null, 2), 'utf8');
    await fs.rename(tmp, target);
  });
  auditWriteChain = operation.catch(() => {});
  return operation;
}

function safeError(error) {
  return asText(error?.message || error, 300)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/ig, 'Bearer [redacted]')
    .replace(/(?:se|sk)-[A-Za-z0-9._-]{12,}/ig, '[redacted]')
    .replace(/https:\/\/[^\s]+[?&](?:Signature|sig|token|Expires)=[^\s]+/ig, '[signed-url-redacted]');
}

async function apiJson(method, endpoint, body, { timeoutMs = 60000, requestId = '', allowPost = false } = {}) {
  if (method !== 'GET' && !allowPost) throw new Error('POST is disabled in read-only mode');
  const key = String(process.env.SOCIALECHO_API_KEY || '').replace(/^Bearer\s+/i, '').trim();
  if (!key) throw new Error('SOCIALECHO_API_KEY is not configured');
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json', 'X-Lang': 'zh_CN' };
  if (requestId) headers['X-Request-Id'] = requestId;
  await requestGate.take();
  const options = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body || {}); }
  const response = await fetch(`${API_BASE}${endpoint}`, options);
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('SocialEcho returned invalid JSON'), { status: response.status, ambiguous: method !== 'GET' }); }
  if (!response.ok || Number(parsed.code || 0) !== 0) {
    const error = Object.assign(new Error(asText(parsed.message || parsed.error?.reason || `SocialEcho HTTP ${response.status}`, 300)), { status: response.status, code: Number(parsed.code || 0), requestId: parsed.request_id || response.headers.get('x-request-id') || requestId });
    if (method !== 'GET' && [422, 500].includes(response.status) || method !== 'GET' && response.status >= 502) error.ambiguous = true;
    throw error;
  }
  return { ...parsed, requestId: parsed.request_id || response.headers.get('x-request-id') || requestId };
}

async function listArticles(accountId, pages = 10) {
  const rows = [];
  let lastPage = pages;
  for (let page = 1; page <= pages; page += 1) {
    const query = new URLSearchParams({ page: String(page) });
    query.append('account_ids[]', String(accountId));
    const result = await apiJson('GET', `/v1/article?${query}`);
    if (Array.isArray(result.data)) rows.push(...result.data);
    lastPage = Number(result.meta?.last_page || result.meta?.lastPage || page);
    if (page >= lastPage || !result.data?.length) break;
  }
  return rows;
}

async function listAccountsLive(pages = 10) {
  const rows = [];
  for (let page = 1; page <= pages; page += 1) {
    const query = new URLSearchParams({ page: String(page), type: '1' });
    const result = await apiJson('GET', `/v1/account?${query}`);
    if (Array.isArray(result.data)) rows.push(...result.data);
    const lastPage = Number(result.meta?.last_page || result.meta?.lastPage || page);
    if (page >= lastPage || !result.data?.length) break;
  }
  return rows;
}

function liveAccountPlatform(account) {
  const title = asText(account?.app?.title || account?.app?.name || '', 100).toLowerCase().replace(/[^a-z]/g, '');
  if (title.includes('instagram')) return 'instagram';
  if (title.includes('facebook')) return 'facebook';
  if (title.includes('tiktok')) return 'tiktok';
  return '';
}

function liveAccountStatus(account) {
  return Number(account?.status?.value ?? account?.status ?? 0);
}

function verifyLiveAccounts(accounts, items, audit) {
  const byId = new Map((Array.isArray(accounts) ? accounts : []).map((account) => [Number(account?.id), account]));
  let unavailable = 0;
  for (const item of items) {
    const route = ROUTES[item.accountId];
    const account = byId.get(item.accountId);
    const livePlatform = liveAccountPlatform(account);
    const valid = Boolean(route && account && liveAccountStatus(account) === 1 && livePlatform === route.platform);
    if (!valid) {
      const current = audit.items[item.fingerprint] || {};
      audit.items[item.fingerprint] = {
        ...current,
        state: 'account_live_unavailable',
        errors: [...new Set([...(current.errors || []), 'account_live_unavailable'])]
      };
      unavailable += 1;
    }
  }
  return unavailable;
}

function articleExternalId(article) { return asText(article?.id ?? article?.uuid ?? '', 100); }
function articleAccount(article) { return Number(article?.account?.id ?? article?.account_id ?? article?.accountId ?? 0); }
function articleType(article) { return asText(article?.type ?? article?.publish_type ?? article?.publishType, 40).toLowerCase(); }
function articleStatus(article) { return Number(article?.status?.value ?? article?.status ?? article?.publish_status ?? article?.publishStatus); }
function articleCaption(article) { return asText(article?.content, 12000); }
function articleAttachmentUrls(article) {
  const out = [];
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') { if (/^https:\/\//i.test(value)) out.push(cleanPublicUrl(value)); return; }
    if (Array.isArray(value)) { value.forEach((x) => visit(x, depth + 1)); return; }
    if (typeof value === 'object') ['url', 'public_url', 'publicUrl', 'media_url', 'mediaUrl', 'src'].forEach((key) => visit(value[key], depth + 1));
  };
  ['attachments', 'attachment', 'media', 'files'].forEach((key) => visit(article?.[key]));
  return [...new Set(out)];
}
function articleSchedule(article) { return canonicalSchedule(article?.scheduled_at ?? article?.scheduledAt ?? article?.publish_at ?? article?.publishAt); }

function findMatchingArticle(articles, item) {
  const expected = { account: item.accountId, type: item.type, status: 1, schedule: item.scheduledAt, content: item.caption, attachment: item.publicUrl };
  return articles.find((article) => articleExternalId(article)
    && articleAccount(article) === expected.account
    && articleType(article) === expected.type
    && articleStatus(article) === expected.status
    && articleCaption(article) === expected.content
    && articleSchedule(article) === expected.schedule
    && articleAttachmentUrls(article).includes(expected.attachment));
}

async function reconcile(items, audit) {
  const byAccount = new Map();
  for (const item of items) if (item.accountId) {
    if (!byAccount.has(item.accountId)) byAccount.set(item.accountId, []);
    byAccount.get(item.accountId).push(item);
  }
  for (const [accountId, accountItems] of byAccount) {
    let articles;
    try { articles = await listArticles(accountId); }
    catch (error) {
      for (const item of accountItems) audit.items[item.fingerprint] = auditEntry(item, { errors: ['live_reconcile_failed'], warnings: [], route: ROUTES[item.accountId] }, 'reconcile_inconclusive', { error: safeError(error) });
      continue;
    }
    for (const item of accountItems) {
      const found = findMatchingArticle(articles, item);
      audit.items[item.fingerprint] = auditEntry(item, { errors: found ? [] : ['external_record_not_confirmed'], warnings: [], route: ROUTES[item.accountId] }, found ? 'scheduled_external_confirmed' : 'reconcile_inconclusive', { reconciled_external_id: found ? articleExternalId(found) : '' });
    }
  }
}

async function execute(items, audit, args) {
  if (!args.execute || process.env.SCHEDULE_CONFIRM !== 'I_UNDERSTAND') throw new Error('Execution requires --execute and SCHEDULE_CONFIRM=I_UNDERSTAND');
  const queue = items.filter((item) => audit.items[item.fingerprint]?.state === 'ready_to_submit');
  let cursor = 0;
  async function worker() {
    while (true) {
      const at = cursor++;
      if (at >= queue.length) return;
      const item = queue[at];
      const entry = audit.items[item.fingerprint];
      const requestId = crypto.randomUUID();
      const payload = buildPayload(item);
      audit.items[item.fingerprint] = auditEntry(item, { errors: [], warnings: [], route: ROUTES[item.accountId] }, 'submitting', { request_id: requestId, payload_sha256: sha256(stableJson(payload)) });
      await writeAudit(args.audit, audit);
      try {
        const out = await apiJson('POST', '/v1/publish/article', payload, { requestId, timeoutMs: 60000, allowPost: true });
        const externalId = asText(out.data?.id, 100);
        if (!externalId) throw Object.assign(new Error('SocialEcho response omitted data.id; reconcile before retry'), { ambiguous: true });
        audit.items[item.fingerprint] = auditEntry(item, { errors: [], warnings: [], route: ROUTES[item.accountId] }, 'scheduled_external', { external_id: externalId, request_id: out.requestId || requestId });
      } catch (error) {
        audit.items[item.fingerprint] = auditEntry(item, { errors: [error?.ambiguous ? 'publish_ambiguous' : 'publish_failed'], warnings: [], route: ROUTES[item.accountId] }, error?.ambiguous ? 'publish_ambiguous' : 'failed', { request_id: error?.requestId || requestId, error: safeError(error) });
      }
      await writeAudit(args.audit, audit);
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, queue.length) }, worker));
}

function help() {
  return `Usage:\n  node scripts/socialecho-schedule-harness.mjs --manifest PLAN.json [options]\n\nOptions:\n  --known-ledger FILE   Existing state/ledger(s) used for idempotency checks\n  --audit FILE          Redacted audit output (default: ${DEFAULT_AUDIT})\n  --live                GET /v1/article reconciliation only (never POST)\n  --execute             Submit validated rows; also requires SCHEDULE_CONFIRM=I_UNDERSTAND\n  --concurrency N       Maximum 4 concurrent submissions (default 4)\n\nThe harness only counts status=1 + future + data.id as scheduled_external.\nHTTP 422/5xx, timeout, or a response without data.id are publish_ambiguous and are never retried.\n`;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.manifests.length) { console.log(help()); return 0; }
  if (args.execute && !args.live) throw new Error('--execute requires --live so existing SocialEcho records are reconciled first');
  const items = await loadItems(args.manifests);
  if (!items.length) throw new Error('No rows found in manifest');
  const known = await loadKnown(args.known);
  const prior = knownKeys(known);
  const audit = await readAudit(args.audit);
  const seen = new Set();
  const seenSlots = new Set();
  let counts = { total: items.length, ready_to_submit: 0, skipped_existing: 0, invalid: 0, slot_conflict: 0, ambiguous: 0 };
  for (const item of items) {
    item.fingerprint = fingerprint(item);
    const validation = validateItem(item);
    const slot = `${item.accountId}|${item.type || ROUTES[item.accountId]?.type || ''}|${item.scheduledAt}`;
    const key = item.fingerprint;
    if (seen.has(key)) validation.errors.push('duplicate_in_manifest');
    seen.add(key);
    let state = validation.ok ? 'ready_to_submit' : 'invalid';
    if (seenSlots.has(slot)) validation.errors.push('duplicate_schedule_slot_in_manifest');
    seenSlots.add(slot);
    if (['external_draft', 'scheduled_external', 'published', 'submitting', 'publish_ambiguous', 'uploading'].includes(item.status) || item.externalId) {
      // A manifest carrying an existing/ambiguous provider state is never a
      // new submission candidate, even when the operator forgot --known-ledger.
      state = item.status === 'publish_ambiguous' || item.status === 'submitting' || item.status === 'uploading'
        ? 'publish_ambiguous' : 'skipped_existing';
      if (state === 'publish_ambiguous') counts.ambiguous += 1;
      else counts.skipped_existing += 1;
    } else if (prior.exact.has(key) || (item.sku && item.platform && prior.itemKeys.has(`${item.sku}|${item.platform}`))) { state = 'skipped_existing'; counts.skipped_existing += 1; }
    else if (prior.slots.has(slot)) { state = 'slot_conflict'; counts.slot_conflict += 1; }
    else if (validation.errors.length) { state = 'invalid'; counts.invalid += 1; }
    else counts.ready_to_submit += 1;
    if (validation.warnings.includes('ambiguous_requires_reconciliation')) counts.ambiguous += 1;
    audit.items[key] = auditEntry(item, validation, state);
  }
  await writeAudit(args.audit, audit);
  if (args.live) {
    let liveAccounts;
    try {
      liveAccounts = await listAccountsLive();
      const unavailable = verifyLiveAccounts(liveAccounts, items, audit);
      if (unavailable && args.execute) throw new Error(`${unavailable} schedule rows target unavailable or mismatched live accounts`);
    } catch (error) {
      if (args.execute) throw error;
      for (const item of items) {
        const current = audit.items[item.fingerprint] || {};
        if (current.state === 'ready_to_submit' || current.state === 'skipped_existing') {
          audit.items[item.fingerprint] = { ...current, state: 'reconcile_inconclusive', errors: [...new Set([...(current.errors || []), 'account_live_check_failed'])], error: safeError(error) };
        }
      }
      await writeAudit(args.audit, audit);
    }
    const eligible = items.filter((item) => ['ready_to_submit', 'skipped_existing'].includes(audit.items[item.fingerprint]?.state));
    await reconcile(eligible, audit);
    await writeAudit(args.audit, audit);
  }
  if (args.execute) {
    // Never execute rows that were merely skipped or whose live reconciliation
    // is inconclusive.  A prior external ID remains a hard idempotency stop.
    await execute(items, audit, args);
  }
  const finalStates = Object.values(audit.items).reduce((out, row) => { out[row.state] = (out[row.state] || 0) + 1; return out; }, {});
  console.log(JSON.stringify({ audit: path.resolve(args.audit), counts, states: finalStates, post_enabled: Boolean(args.execute) }, null, 2));
  return 0;
}

// `process.argv[1]` is a Windows path and may contain non-ASCII characters;
// compare canonical file URLs so the CLI entry point also works from a path
// such as the workspace's Chinese-named parent directory.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().then((code) => { process.exitCode = code; }).catch((error) => { console.error(JSON.stringify({ error: safeError(error) })); process.exitCode = 1; });
}
