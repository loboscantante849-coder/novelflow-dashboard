'use strict';

const META_ACCOUNT_ID = '915817154893411';
const META_GRAPH_API_VERSION = String(process.env.META_GRAPH_API_VERSION || 'v23.0').trim() || 'v23.0';
const META_GRAPH_BASE_URL = String(process.env.META_GRAPH_API_BASE_URL || `https://graph.facebook.com/${META_GRAPH_API_VERSION}`).replace(/\/$/, '');
const META_REGISTRY_KEY = `nf_social:ad_registry:${META_ACCOUNT_ID}`;

// These are the only Meta ads accepted until an operator explicitly registers
// another account-matching ID through the private endpoint.
const SEED_META_ADS = Object.freeze([
  Object.freeze({ metaAdId: '120248838909080743', accountId: META_ACCOUNT_ID, language: 'pt', market: 'PT', name: '葡语私信0806-H5-2', active: true, source: 'seed' }),
  Object.freeze({ metaAdId: '120248835695450743', accountId: META_ACCOUNT_ID, language: 'pt', market: 'PT', name: '葡语私信0806- H5落地页版本', active: true, source: 'seed' }),
  Object.freeze({ metaAdId: '120248801168210743', accountId: META_ACCOUNT_ID, language: 'pt', market: 'PT', name: '葡语私信0806-直跳版本', active: true, source: 'seed' }),
  Object.freeze({ metaAdId: '120248839344220743', accountId: META_ACCOUNT_ID, language: 'es', market: 'ES', name: '早上七点在血泊中醒来', active: true, source: 'seed' }),
  Object.freeze({ metaAdId: '120248846340630743', accountId: META_ACCOUNT_ID, language: 'es', market: 'ES', name: '史上最年轻的CEO', active: true, source: 'seed' }),
  Object.freeze({ metaAdId: '120248846975590743', accountId: META_ACCOUNT_ID, language: 'es', market: 'ES', name: 'Hannah 失去了一切', active: true, source: 'seed' })
]);

const META_FIELDS = [
  'account_id', 'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id',
  'campaign_name', 'date_start', 'date_stop', 'spend', 'impressions', 'reach',
  'frequency', 'clicks', 'inline_link_clicks', 'actions', 'cost_per_action_type',
  'conversions', 'cost_per_conversion', 'ctr', 'cpc', 'cpm', 'cpp',
  'attribution_setting'
];

const META_ID_PATTERN = /^\d{15,22}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeMetaAdId(value) {
  const id = String(value || '').trim();
  return META_ID_PATTERN.test(id) ? id : '';
}

function validDate(value) {
  const date = String(value || '').trim();
  if (!DATE_PATTERN.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validateWindow(range = {}) {
  const from = String(range.from || '').trim();
  const to = String(range.to || '').trim();
  if (!validDate(from) || !validDate(to) || from > to) {
    const error = new Error('from and to must be valid YYYY-MM-DD dates and from cannot be after to');
    error.status = 400;
    throw error;
  }
  return { from, to };
}

function parseStored(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function cloneSeedRegistry() {
  return SEED_META_ADS.map((entry) => ({ ...entry }));
}

function cleanRegistryEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const metaAdId = normalizeMetaAdId(value.metaAdId || value.adId || value.id);
  const accountId = String(value.accountId || value.account_id || '').trim();
  if (!metaAdId || accountId !== META_ACCOUNT_ID) return null;
  const language = String(value.language || value.locale || '').trim().toLowerCase();
  if (!['pt', 'es'].includes(language)) return null;
  const reportDimension = String(value.reportDimension || '').trim().toLowerCase();
  const reportId = String(value.reportId || '').trim();
  return {
    metaAdId,
    accountId: META_ACCOUNT_ID,
    language,
    market: String(value.market || language.toUpperCase()).trim().slice(0, 20),
    active: !(value.active === false || value.active === 'false' || value.active === 0 || value.active === '0'),
    source: String(value.source || 'operator').trim().slice(0, 30) || 'operator',
    ...(String(value.name || '').trim() ? { name: String(value.name).trim().slice(0, 240) } : {}),
    ...(String(value.beidouCampaignName || '').trim() ? { beidouCampaignName: String(value.beidouCampaignName).trim().slice(0, 240) } : {}),
    ...(reportDimension ? { reportDimension } : {}),
    ...(reportId ? { reportId: reportId.slice(0, 240) } : {}),
    ...(String(value.createdAt || '').trim() ? { createdAt: String(value.createdAt).trim().slice(0, 40) } : {}),
    ...(String(value.updatedAt || '').trim() ? { updatedAt: String(value.updatedAt).trim().slice(0, 40) } : {})
  };
}

function mergeRegistry(stored) {
  const byId = new Map(cloneSeedRegistry().map((entry) => [entry.metaAdId, entry]));
  const values = Array.isArray(stored)
    ? stored
    : Array.isArray(stored?.ads)
      ? stored.ads
        : Array.isArray(stored?.registry)
          ? stored.registry
          : Array.isArray(stored?.items) ? stored.items : [];
  for (const value of values) {
    const seedId = normalizeMetaAdId(value?.metaAdId || value?.adId || value?.id);
    const entry = cleanRegistryEntry(seedId && byId.has(seedId) ? { ...byId.get(seedId), ...value } : value);
    if (entry) byId.set(entry.metaAdId, { ...byId.get(entry.metaAdId), ...entry });
  }
  return [...byId.values()].sort((left, right) => left.metaAdId.localeCompare(right.metaAdId));
}

async function loadMetaRegistry(redis) {
  if (!redis || typeof redis.get !== 'function') return cloneSeedRegistry();
  try { return mergeRegistry(parseStored(await redis.get(META_REGISTRY_KEY))); } catch { return cloneSeedRegistry(); }
}

async function saveMetaRegistry(redis, entries) {
  if (!redis || typeof redis.set !== 'function') {
    const error = new Error('Social console storage is not configured');
    error.status = 503;
    throw error;
  }
  const normalized = mergeRegistry(entries);
  await redis.set(META_REGISTRY_KEY, JSON.stringify(normalized));
  return normalized;
}

function accountMatches(value) {
  return String(value == null ? '' : value).trim() === META_ACCOUNT_ID;
}

function rowAdId(row) {
  return normalizeMetaAdId(row?.ad_id || row?.adId || row?.id);
}

function filterMetaRows(rows, registry, accountId = META_ACCOUNT_ID) {
  const allowed = new Set((Array.isArray(registry) ? registry : [])
    .filter((entry) => entry?.active !== false && accountMatches(entry?.accountId || entry?.account_id))
    .map((entry) => normalizeMetaAdId(entry?.metaAdId || entry?.adId || entry?.id))
    .filter(Boolean));
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const adId = rowAdId(row);
    return Boolean(adId && allowed.has(adId) && String(accountId) === META_ACCOUNT_ID && accountMatches(row?.account_id || row?.accountId));
  });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function actionValue(actions, type) {
  const item = (Array.isArray(actions) ? actions : []).find((action) => String(action?.action_type || action?.type || '') === type);
  return item ? number(item.value) : 0;
}

function normalizeMetaRow(row, registryById = new Map()) {
  const adId = rowAdId(row);
  const registry = registryById.get(adId) || null;
  const delivery = row.delivery_info || row.delivery || '';
  const normalized = {
    adId,
    metaAdId: adId,
    accountId: META_ACCOUNT_ID,
    language: registry?.language || '',
    market: registry?.market || '',
    name: String(row.ad_name || row.name || registry?.name || '').slice(0, 300),
    adsetId: String(row.adset_id || row.adgroup_id || '').slice(0, 160),
    adsetName: String(row.adset_name || '').slice(0, 300),
    campaignId: String(row.campaign_id || '').slice(0, 160),
    campaignName: String(row.campaign_name || '').slice(0, 300),
    delivery: typeof delivery === 'string' ? delivery.slice(0, 100) : delivery,
    dateStart: String(row.date_start || '').slice(0, 10),
    dateStop: String(row.date_stop || '').slice(0, 10),
    spend: number(row.spend),
    impressions: number(row.impressions),
    reach: number(row.reach),
    frequency: number(row.frequency),
    results: number(row.results || row.conversions),
    costPerResult: number(row.cost_per_result || row.cost_per_conversion),
    budget: number(row.budget || row.daily_budget || row.lifetime_budget),
    linkClicks: actionValue(row.actions, 'link_click'),
    clicks: number(row.clicks),
    inlineLinkClicks: number(row.inline_link_clicks),
    actions: Array.isArray(row.actions) ? row.actions.slice(0, 80) : [],
    costPerActionType: Array.isArray(row.cost_per_action_type) ? row.cost_per_action_type.slice(0, 80) : [],
    attributionSetting: String(row.attribution_setting || '').slice(0, 160),
    endTime: String(row.end_time || '').slice(0, 80),
    lastSignificantEdit: String(row.last_significant_edit || '').slice(0, 80),
    qualityScoreOrganic: row.quality_score_organic == null ? null : number(row.quality_score_organic),
    qualityScoreEctr: row.quality_score_ectr == null ? null : number(row.quality_score_ectr),
    qualityScoreEcvr: row.quality_score_ecvr == null ? null : number(row.quality_score_ecvr)
  };
  return normalized;
}

function summarizeMetaRows(rows) {
  const values = ['spend', 'impressions', 'reach', 'results', 'linkClicks'];
  const summary = Object.fromEntries(values.map((key) => [key, (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + number(row?.[key]), 0)]));
  summary.rowCount = Array.isArray(rows) ? rows.length : 0;
  return summary;
}

function graphUrl(from, to) {
  const configuredBase = String(process.env.META_GRAPH_API_BASE_URL || '').trim().replace(/\/$/, '');
  const configuredVersion = String(process.env.META_GRAPH_API_VERSION || META_GRAPH_API_VERSION).trim() || META_GRAPH_API_VERSION;
  const base = configuredBase || `https://graph.facebook.com/${configuredVersion}`;
  const url = new URL(`${base}/act_${META_ACCOUNT_ID}/insights`);
  url.searchParams.set('level', 'ad');
  url.searchParams.set('fields', META_FIELDS.join(','));
  url.searchParams.set('time_range', JSON.stringify({ since: from, until: to }));
  url.searchParams.set('time_increment', 'all_days');
  url.searchParams.set('limit', '500');
  return url;
}

function pageUrl(value) {
  try {
    const url = new URL(String(value));
    const configuredBase = String(process.env.META_GRAPH_API_BASE_URL || '').trim().replace(/\/$/, '');
    const allowedOrigin = new URL(configuredBase || META_GRAPH_BASE_URL).origin;
    if (url.origin !== allowedOrigin) return '';
    url.searchParams.delete('access_token');
    url.searchParams.delete('token');
    return url.toString();
  } catch { return ''; }
}

function responseRows(body) {
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.data)) return body.data.data;
  if (Array.isArray(body?.rows)) return body.rows;
  return [];
}

async function fetchMetaAds({ from, to, registry, fetchImpl = global.fetch, token = process.env.META_MARKETING_ACCESS_TOKEN } = {}) {
  const window = validateWindow({ from, to });
  const activeRegistry = (Array.isArray(registry) ? registry : cloneSeedRegistry()).filter((entry) => entry?.active !== false && accountMatches(entry?.accountId));
  if (!String(token || '').trim()) {
    return { source: 'meta', status: 'unconfigured', configured: false, accountId: META_ACCOUNT_ID, window, rows: [], ads: [], summary: summarizeMetaRows([]), warnings: ['META_MARKETING_ACCESS_TOKEN is not configured'] };
  }
  if (typeof fetchImpl !== 'function') {
    const error = new Error('Meta fetch implementation is unavailable');
    error.status = 502;
    throw error;
  }
  const rows = [];
  const seenPages = new Set();
  let next = graphUrl(window.from, window.to).toString();
  let pages = 0;
  let warning = '';
  while (next && pages < 50 && !seenPages.has(next)) {
    seenPages.add(next);
    pages += 1;
    let response;
    try {
      response = await fetchImpl(next, { redirect: 'error', headers: { Authorization: `Bearer ${String(token).trim()}`, Accept: 'application/json' } });
    } catch (error) {
      const wrapped = new Error(`Meta insights request failed: ${String(error?.message || 'network error').slice(0, 180)}`);
      wrapped.status = 502;
      throw wrapped;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Meta insights request failed with HTTP ${response.status}`);
      error.status = response.status === 401 || response.status === 403 ? 502 : response.status;
      error.upstream = body?.error?.message || '';
      throw error;
    }
    // Filter every page before retaining it, then run the same filter again
    // over the complete response set below. This protects against an
    // unexpected row being introduced by a later pagination response.
    rows.push(...filterMetaRows(responseRows(body), activeRegistry, META_ACCOUNT_ID));
    next = pageUrl(body?.paging?.next);
  }
  if (pages >= 50 && next) warning = 'Meta pagination was capped at 50 pages';
  const filtered = filterMetaRows(rows, activeRegistry, META_ACCOUNT_ID);
  const byId = new Map(activeRegistry.map((entry) => [entry.metaAdId, entry]));
  const normalizedRows = filtered.map((row) => normalizeMetaRow(row, byId));
  const ads = activeRegistry.map((entry) => {
    const adRows = normalizedRows.filter((row) => row.adId === entry.metaAdId);
    return { ...entry, status: adRows.length ? 'ok' : 'no_data', ...(adRows.length ? { metrics: summarizeMetaRows(adRows), rows: adRows } : { metrics: summarizeMetaRows([]), rows: [] }) };
  }).filter((entry) => entry.rows.length);
  return {
    source: 'meta', status: normalizedRows.length ? (warning ? 'partial' : 'ok') : 'no_data', configured: true,
    accountId: META_ACCOUNT_ID, window, rows: normalizedRows, ads, summary: summarizeMetaRows(normalizedRows), pages,
    ...(warning ? { warnings: [warning] } : {})
  };
}

module.exports = {
  META_ACCOUNT_ID, META_GRAPH_API_VERSION, META_GRAPH_BASE_URL, META_REGISTRY_KEY,
  META_FIELDS, SEED_META_ADS, SEED_META_AD_IDS: Object.freeze(SEED_META_ADS.map((entry) => entry.metaAdId)),
  DEFAULT_META_AD_IDS: Object.freeze(SEED_META_ADS.map((entry) => entry.metaAdId)),
  normalizeMetaAdId, validateWindow, cloneSeedRegistry, cleanRegistryEntry, mergeRegistry,
  loadMetaRegistry, saveMetaRegistry, loadRegistry: loadMetaRegistry, saveRegistry: saveMetaRegistry,
  seedRegistry: cloneSeedRegistry, accountMatches, filterMetaRows, filterAllowlistedMetaRows: filterMetaRows, normalizeMetaRow,
  summarizeMetaRows, graphUrl, pageUrl, responseRows, fetchMetaAds
};
