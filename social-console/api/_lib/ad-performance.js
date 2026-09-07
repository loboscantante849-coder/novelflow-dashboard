'use strict';

const { getRedis } = require('./store');
const { openAccess, requireSession } = require('./auth');
const { consumeRateLimit, requestIdentity } = require('./rate-limit');
const providers = require('./providers');
const meta = require('./meta-ads');
const beidou = require('./beidou-ads');

const REGISTRY_KEY = meta.META_REGISTRY_KEY;
const META_ACCOUNT_ID = meta.META_ACCOUNT_ID;
const REPORT_DIMENSIONS = Object.freeze(new Set(['campaignid', 'adsetid', 'adid', 'copywritingid']));
const REPORT_ROW_ID_FIELDS = Object.freeze({
  campaignid: 'campaignId',
  adsetid: 'adsetId',
  adid: 'adId',
  copywritingid: 'copywritingId'
});
const ID_PATTERN = /^[A-Za-z0-9_-]{1,240}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validationError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseDate(value) {
  const date = String(value || '').trim();
  if (!DATE_PATTERN.test(date)) return '';
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : '';
}

function defaultWindow(now = new Date()) {
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 6);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function parseWindow(input = {}, options = {}) {
  const defaults = options.defaultWindow === false ? {} : defaultWindow(options.now);
  const from = String(input.from == null ? defaults.from || '' : input.from).trim();
  const to = String(input.to == null ? defaults.to || '' : input.to).trim();
  if (!parseDate(from) || !parseDate(to) || from > to) throw validationError('from and to must be valid YYYY-MM-DD dates and from cannot be after to');
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.floor((end - start) / 86400000) + 1;
  if (days > 366) throw validationError('The reporting window cannot exceed 366 days');
  return { from, to, days };
}

function normalizeLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  return ['pt', 'es'].includes(language) ? language : '';
}

function normalizeReportDimension(value) {
  const dimension = String(value || '').trim().toLowerCase();
  return REPORT_DIMENSIONS.has(dimension) ? dimension : '';
}

function normalizeReportId(value) {
  const reportId = String(value || '').trim();
  return ID_PATTERN.test(reportId) ? reportId : '';
}

function validateAdRecord(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw validationError('An ad registry record is required');
  const metaAdId = meta.normalizeMetaAdId(input.metaAdId || input.adId || input.id || existing?.metaAdId);
  if (!metaAdId) throw validationError('metaAdId must contain 15-22 digits');
  const accountId = String(input.accountId == null ? existing?.accountId || META_ACCOUNT_ID : input.accountId).trim();
  if (accountId !== META_ACCOUNT_ID) throw validationError(`Only Meta account ${META_ACCOUNT_ID} is allowed`);
  const language = normalizeLanguage(input.language == null ? existing?.language : input.language);
  if (!language) throw validationError('language must be pt or es');
  const reportDimensionValue = input.reportDimension == null ? existing?.reportDimension || '' : input.reportDimension;
  const reportIdValue = input.reportId == null ? existing?.reportId || '' : input.reportId;
  const reportDimension = normalizeReportDimension(reportDimensionValue);
  const reportId = normalizeReportId(reportIdValue);
  if ((reportDimensionValue && !reportDimension) || (reportIdValue && !reportId)) throw validationError('reportDimension or reportId is invalid');
  if (Boolean(reportDimension) !== Boolean(reportId)) throw validationError('reportDimension and reportId must be supplied together');
  const beidouName = input.beidouCampaignName == null ? existing?.beidouCampaignName || '' : String(input.beidouCampaignName).trim();
  if (beidouName.length > 240) throw validationError('beidouCampaignName must be at most 240 characters');
  if (/[\u0000-\u001f\u007f]/.test(beidouName)) throw validationError('beidouCampaignName contains invalid characters');
  const name = input.name == null ? existing?.name || '' : String(input.name).trim();
  if (name.length > 300) throw validationError('name must be at most 300 characters');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw validationError('name contains invalid characters');
  const now = new Date().toISOString();
  const record = {
    ...(existing || {}),
    metaAdId,
    accountId: META_ACCOUNT_ID,
    language,
    market: String(input.market == null ? existing?.market || language.toUpperCase() : input.market).trim().slice(0, 20),
    active: input.active == null ? (existing?.active !== false) : input.active === true,
    source: existing?.source === 'seed' ? 'seed' : 'operator',
    createdAt: String(existing?.createdAt || now).slice(0, 40),
    updatedAt: now
  };
  if (name) record.name = name; else delete record.name;
  if (beidouName) record.beidouCampaignName = beidouName; else delete record.beidouCampaignName;
  if (reportDimension && reportId) {
    record.reportDimension = reportDimension;
    record.reportId = reportId;
  } else {
    delete record.reportDimension;
    delete record.reportId;
  }
  return record;
}

function registryById(entries) {
  return new Map((Array.isArray(entries) ? entries : []).map((entry) => [String(entry.metaAdId), entry]));
}

async function readRegistry(redis) {
  return meta.loadMetaRegistry(redis);
}

async function writeRegistry(redis, entries) {
  return meta.saveMetaRegistry(redis, entries);
}

async function mutateRegistry(redis, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw validationError('A JSON object is required');
  const action = String(payload.action || '').trim().toLowerCase();
  if (!['upsert', 'disable'].includes(action)) throw validationError('action must be upsert or disable');
  const allowedFields = new Set(['action', 'metaAdId', 'adId', 'id', 'accountId', 'language', 'market', 'name', 'active', 'beidouCampaignName', 'reportDimension', 'reportId']);
  const unknown = Object.keys(payload).filter((key) => !allowedFields.has(key));
  if (unknown.length) throw validationError(`Unsupported registry field: ${unknown[0]}`);
  if (!redis) throw validationError('Social console storage is not configured', 503);
  const existingEntries = await readRegistry(redis);
  const byId = registryById(existingEntries);
  const id = meta.normalizeMetaAdId(payload.metaAdId || payload.adId || payload.id);
  if (!id) throw validationError('metaAdId must contain 15-22 digits');
  if (payload.accountId != null && String(payload.accountId).trim() !== META_ACCOUNT_ID) {
    throw validationError(`Only Meta account ${META_ACCOUNT_ID} is allowed`);
  }
  const existing = byId.get(id) || null;
  if (action === 'disable') {
    if (!existing) throw validationError('The ad is not registered', 404);
    byId.set(id, { ...existing, active: false, updatedAt: new Date().toISOString() });
  } else {
    const record = validateAdRecord(payload, existing);
    byId.set(id, record);
  }
  const entries = await writeRegistry(redis, [...byId.values()]);
  return { registry: entries, record: entries.find((entry) => entry.metaAdId === id) || null };
}

function adapterCall(adapter, args) {
  if (typeof adapter === 'function') return adapter(args);
  if (adapter && typeof adapter.fetch === 'function') return adapter.fetch(args);
  if (adapter && typeof adapter.query === 'function') return adapter.query(args);
  throw validationError('A source adapter is not configured', 503);
}

function safeAdapterCall(adapter, args) {
  try { return Promise.resolve(adapterCall(adapter, args)); }
  catch (error) { return Promise.reject(error); }
}

function sourceRows(result) {
  if (!result || typeof result !== 'object') return [];
  if (Array.isArray(result.ads)) return result.ads;
  if (Array.isArray(result.rows)) return result.rows;
  return [];
}

function sourceAdId(row) {
  return String(row?.metaAdId || row?.adId || row?.ad_id || row?.id || '').trim();
}

function safeErrorMessage(value) {
  return String(value || 'source unavailable')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:access_token|token|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 240);
}

function sourceMap(result) {
  const map = new Map();
  for (const row of sourceRows(result)) {
    const id = sourceAdId(row);
    if (id) map.set(id, row);
  }
  return map;
}

function itemStatus(map, adId, sourceState) {
  const item = map.get(adId);
  if (item) return String(item.status || (Array.isArray(item.rows) && item.rows.length ? 'ok' : 'no_data'));
  const status = String(sourceState?.status || 'no_data');
  return status === 'ok' ? 'no_data' : status;
}

function buildSourceStatus(result, error, configured) {
  if (error) return { status: 'failed', configured: Boolean(configured), rows: 0, error: safeErrorMessage(error?.message) };
  const effectiveConfigured = result && Object.prototype.hasOwnProperty.call(result, 'configured')
    ? result.configured === true
    : Boolean(configured);
  return {
    status: String(result?.status || (sourceRows(result).length ? 'ok' : 'no_data')),
    configured: effectiveConfigured,
    rows: sourceRows(result).length,
    ...((Array.isArray(result?.warnings) ? result.warnings : []).concat(Array.isArray(result?.errors) ? result.errors : []).length
      ? { warnings: (Array.isArray(result?.warnings) ? result.warnings : []).concat(Array.isArray(result?.errors) ? result.errors : []).slice(0, 5).map(safeErrorMessage) }
      : {})
  };
}

function sumMetrics(rows, keys) {
  const values = {};
  for (const key of keys) values[key] = (Array.isArray(rows) ? rows : []).reduce((sum, row) => {
    const value = Number(row?.metrics?.[key] ?? row?.[key]);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  values.rowCount = Array.isArray(rows) ? rows.length : 0;
  return values;
}

function filterSocialReportRows(rows, dimension, reportId, window) {
  const field = REPORT_ROW_ID_FIELDS[normalizeReportDimension(dimension)];
  const expectedId = normalizeReportId(reportId);
  if (!field || !expectedId) return [];
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const returnedId = String(row?.[field] || '').trim();
    const date = parseDate(row?.date || row?.dt);
    return returnedId === expectedId && date && date >= window.from && date <= window.to;
  });
}

async function defaultSocialReportAdapter({ from, to, registry }) {
  const active = (Array.isArray(registry) ? registry : []).filter((entry) => entry?.active !== false);
  const results = [];
  const errors = [];
  const days = Math.max(1, Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);
  for (const entry of active) {
    const dimension = normalizeReportDimension(entry.reportDimension);
    const reportId = normalizeReportId(entry.reportId);
    if (!dimension || !reportId) continue;
    try {
      const result = await providers.putreportDimensionRows(reportId, dimension, days, { from, to });
      const rows = filterSocialReportRows(result?.rows, dimension, reportId, { from, to });
      results.push({ ...entry, status: rows.length ? 'ok' : 'no_data', reportId, reportDimension: dimension, granularity: dimension, reportLevel: dimension, adLevel: dimension === 'adid', rows, metrics: sumMetrics(rows, ['visits', 'pullUv', 'activeUv', 'newUv', 'd7Income', 'd14Income', 'd30Income', 'totalIncome']) });
    } catch (error) { errors.push({ metaAdId: entry.metaAdId, error }); }
  }
  return {
    source: 'social', status: errors.length && results.length ? 'partial' : errors.length ? 'failed' : results.length ? (results.some((row) => row.rows.length) ? 'ok' : 'no_data') : 'not_configured',
    configured: Boolean(process.env.NOVELFLOW_REPORT_TOKEN || process.env.NOVELFLOW_OIDC_TOKEN || (process.env.NOVELFLOW_OIDC_USERNAME && process.env.NOVELFLOW_OIDC_PASSWORD)),
    window: { from, to }, ads: results, rows: results.flatMap((row) => row.rows), errors: errors.map(({ metaAdId, error }) => `${metaAdId}: ${safeErrorMessage(error?.message)}`)
  };
}

async function queryAdPerformance({ from, to, range, redis = getRedis(), registry, metaAdapter = meta.fetchMetaAds, metaReportAdapter, beidouAdapter = beidou.fetchBeidouAds, socialAdapter, socialReportAdapter, beidouReportAdapter, fetchImpl, now } = {}) {
  const window = parseWindow({ from: from ?? range?.from, to: to ?? range?.to }, { now });
  const allRegistry = Array.isArray(registry) ? meta.mergeRegistry(registry) : await readRegistry(redis);
  const activeRegistry = allRegistry.filter((entry) => entry.active !== false && entry.accountId === META_ACCOUNT_ID);
  const effectiveMetaAdapter = metaReportAdapter || metaAdapter || meta.fetchMetaAds;
  const effectiveBeidouAdapter = beidouReportAdapter || beidouAdapter || beidou.fetchBeidouAds;
  const effectiveSocialAdapter = socialReportAdapter || socialAdapter || defaultSocialReportAdapter;
  const calls = [
    safeAdapterCall(effectiveMetaAdapter, { from: window.from, to: window.to, registry: activeRegistry, redis, fetchImpl }),
    safeAdapterCall(effectiveBeidouAdapter, { from: window.from, to: window.to, registry: activeRegistry, redis, fetchImpl }),
    safeAdapterCall(effectiveSocialAdapter, { from: window.from, to: window.to, registry: activeRegistry, redis, fetchImpl })
  ];
  const settled = await Promise.all(calls.map((promise) => Promise.resolve(promise).then((value) => ({ status: 'fulfilled', value }), (error) => ({ status: 'rejected', reason: error }))));
  const [metaSettled, beidouSettled, socialSettled] = settled;
  const metaResult = metaSettled.status === 'fulfilled' ? metaSettled.value : null;
  const beidouResult = beidouSettled.status === 'fulfilled' ? beidouSettled.value : null;
  const socialResult = socialSettled.status === 'fulfilled' ? socialSettled.value : null;
  const configured = {
    storage: Boolean(redis),
    meta: Boolean(String(process.env.META_MARKETING_ACCESS_TOKEN || '').trim()),
    beidou: Boolean(String(process.env.BEIDOU_REPORT_TOKEN || '').trim()),
    social: Boolean(process.env.NOVELFLOW_REPORT_TOKEN || process.env.NOVELFLOW_OIDC_TOKEN || (process.env.NOVELFLOW_OIDC_USERNAME && process.env.NOVELFLOW_OIDC_PASSWORD))
  };
  const sourceStatus = {
    meta: buildSourceStatus(metaResult, metaSettled.reason, configured.meta),
    beidou: buildSourceStatus(beidouResult, beidouSettled.reason, configured.beidou),
    social: buildSourceStatus(socialResult, socialSettled.reason, configured.social)
  };
  const metaById = sourceMap(metaResult);
  const beidouById = sourceMap(beidouResult);
  const socialById = sourceMap(socialResult);
  const ads = allRegistry.map((entry) => {
    const disabled = entry.active === false;
    return {
      registry: entry,
      meta: disabled ? null : (metaById.get(entry.metaAdId) || null),
      beidou: disabled ? null : (beidouById.get(entry.metaAdId) || null),
      social: disabled ? null : (socialById.get(entry.metaAdId) || null),
      metaStatus: disabled ? 'disabled' : itemStatus(metaById, entry.metaAdId, sourceStatus.meta),
      beidouStatus: disabled ? 'disabled' : entry.beidouCampaignName ? itemStatus(beidouById, entry.metaAdId, sourceStatus.beidou) : 'unmapped',
      socialStatus: disabled ? 'disabled' : entry.reportDimension && entry.reportId ? itemStatus(socialById, entry.metaAdId, sourceStatus.social) : 'unmapped'
    };
  });
  const metaRows = sourceRows(metaResult);
  const beidouRows = sourceRows(beidouResult);
  const socialRows = sourceRows(socialResult);
  const summary = {
    registryAds: allRegistry.length,
    activeAds: activeRegistry.length,
    inactiveAds: allRegistry.filter((entry) => entry.active === false).length,
    byLanguage: { pt: activeRegistry.filter((entry) => entry.language === 'pt').length, es: activeRegistry.filter((entry) => entry.language === 'es').length },
    meta: metaResult?.summary || sumMetrics(metaRows, ['spend', 'impressions', 'reach', 'results', 'linkClicks']),
    beidou: beidouResult?.summary || sumMetrics(beidouRows, ['spend', 'pullUv', 'activeUv', 'newUv', 'd7Income', 'd14Income', 'd30Income', 'totalIncome']),
    social: socialResult?.summary || sumMetrics(socialRows, ['visits', 'pullUv', 'activeUv', 'newUv', 'd7Income', 'd14Income', 'd30Income', 'totalIncome'])
  };
  const statuses = Object.values(sourceStatus).map((value) => value.status);
  const overallStatus = statuses.some((status) => ['failed', 'partial', 'unavailable', 'unconfigured', 'auth_error'].includes(status)) ? 'partial' : 'ok';
  return {
    window: { from: window.from, to: window.to, days: window.days },
    accountId: META_ACCOUNT_ID,
    configured,
    status: overallStatus,
    registry: allRegistry,
    summary,
    ads,
    sourceStatus,
    sources: { meta: metaResult, beidou: beidouResult, social: socialResult }
  };
}

function parseRequestBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string' && body.length <= 20000) {
    try { const value = JSON.parse(body); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
  }
  return null;
}

function privateReject(res) {
  return res.status(403).json({ error: 'Ad performance data requires private console access' });
}

async function handleAdPerformance(req, res, dependencies = {}) {
  if (openAccess()) return privateReject(res);
  const method = String(req.method || '').toUpperCase();
  if (!['GET', 'POST'].includes(method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireSession(req, res)) return;
  const redis = dependencies.redis === undefined ? getRedis() : dependencies.redis;
  let rate;
  try { rate = await consumeRateLimit(redis, 'ad-performance', requestIdentity(req), method === 'POST' ? 20 : 60, 60); }
  catch { rate = await consumeRateLimit(null, 'ad-performance', requestIdentity(req), method === 'POST' ? 20 : 60, 60); }
  if (!rate.allowed) { res.setHeader('Retry-After', String(rate.retryAfter)); return res.status(429).json({ error: 'Too many ad performance requests' }); }
  if (method === 'POST') {
    const body = parseRequestBody(req.body);
    try {
      const changed = await mutateRegistry(redis, body);
      return res.status(200).json({ ok: true, action: String(body.action).toLowerCase(), registry: changed.registry, record: changed.record });
    } catch (error) {
      const status = Number(error?.status || (/storage|redis/i.test(String(error?.message || '')) ? 503 : 400));
      return res.status(status >= 400 && status < 600 ? status : 400).json({ error: String(error?.message || 'Invalid registry request').slice(0, 240) });
    }
  }
  try {
    const query = req.query || {};
    const window = parseWindow({ from: query.from, to: query.to });
    const result = await queryAdPerformance({ ...dependencies, redis, from: window.from, to: window.to });
    return res.status(200).json(result);
  } catch (error) {
    const status = Number(error?.status || 502);
    return res.status(status >= 400 && status < 600 ? status : 502).json({ error: String(error?.message || 'Unable to query ad performance').slice(0, 240) });
  }
}

module.exports = {
  REGISTRY_KEY, META_ACCOUNT_ID, REPORT_DIMENSIONS, REPORT_ROW_ID_FIELDS, defaultWindow, parseDate, parseWindow,
  normalizeLanguage, normalizeReportDimension, normalizeReportId, validateAdRecord,
  registryById, safeErrorMessage, filterSocialReportRows, readRegistry, loadRegistry: readRegistry, writeRegistry, saveRegistry: writeRegistry, mutateRegistry, defaultSocialReportAdapter, socialReportAdapter: defaultSocialReportAdapter,
  queryAdPerformance, parseRequestBody, handleAdPerformance,
  SEED_META_ADS: meta.SEED_META_ADS, SEED_META_AD_IDS: meta.SEED_META_AD_IDS,
  DEFAULT_META_AD_IDS: meta.DEFAULT_META_AD_IDS
};
