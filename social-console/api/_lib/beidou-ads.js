'use strict';

const { validateWindow, META_ACCOUNT_ID } = require('./meta-ads');

const BEIDOU_PROJECT_ID = String(process.env.BEIDOU_PROJECT_ID || '1006').trim() || '1006';
const BEIDOU_REPORT_URL = String(process.env.BEIDOU_REPORT_URL || 'https://beidou.win/api/v1/event-analysis-report/query-report').trim();
const DATE_KEYS = ['date', 'dt', 'day', 'reportDate'];
const METRIC_ALIASES = {
  visits: ['visits', 'visitCount', 'value', 'BodyCount'],
  spend: ['spend', 'cost', 'fee', 'amount'],
  impressions: ['impressions', 'impression', 'showCount', '展示量'],
  reach: ['reach', 'reachCount', '触达'],
  clicks: ['clicks', 'linkClicks', 'clickCount', '点击量'],
  pullUv: ['pullUv', 'pull_uv', 'h5landingpageclickusernum'],
  activeUv: ['activeUv', 'active_uv'],
  newUv: ['newUv', 'new_uv', 'newusernum'],
  d0Income: ['d0Income', 'd0income', 'd0_income'],
  d7Income: ['d7Income', 'd7income', 'd7_income'],
  d14Income: ['d14Income', 'd14income', 'd14_income'],
  d30Income: ['d30Income', 'd30income', 'd30_income'],
  totalIncome: ['totalIncome', 'totalincome', 'total_income']
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeErrorMessage(value) {
  return String(value || 'request failed')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:access_token|token|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 180);
}

function firstValue(row, keys) {
  for (const key of keys) if (row && row[key] != null && row[key] !== '') return row[key];
  return 0;
}

function parseStoredRows(body, window = null, campaignName = '') {
  const envelope = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
  const candidates = [envelope?.data, envelope?.rows, envelope?.list, envelope];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate?.data)) return candidate.data;
    if (Array.isArray(candidate?.list)) return candidate.list;
    if (Array.isArray(candidate?.rows)) return candidate.rows;
  }
  const detail = envelope?.items?.[0]?.detailResult;
  if (detail && Array.isArray(detail.rows)) {
    const series = Array.isArray(detail.series) ? detail.series : [];
    const dates = series.map((value) => {
      const date = String(value || '').trim();
      return /^\d{2}-\d{2}-\d{2}$/.test(date) ? `20${date}` : date.slice(0, 10);
    });
    const result = [];
    for (const row of detail.rows) {
      const returnedName = exactCampaignName(row?.byValues?.[0]) || campaignName;
      if (campaignName && returnedName !== campaignName) continue;
      const values = Array.isArray(row?.values) ? row.values : [];
      dates.forEach((date, index) => {
        if (!date || (window && (date < window.from || date > window.to))) return;
        const cell = values[index];
        const value = Array.isArray(cell) ? cell[0] : cell;
        result.push({ campaignName: returnedName, date, visits: number(value), value: number(value) });
      });
    }
    return result;
  }
  return [];
}

function exactCampaignName(value) {
  const name = String(value || '').trim();
  return name.length > 0 && name.length <= 240 && !/[\u0000-\u001f\u007f]/.test(name) ? name : '';
}

function sanitizeEndpoint(value) {
  const endpoint = String(value || '').trim();
  try {
    const url = new URL(endpoint);
    url.searchParams.delete('access_token');
    url.searchParams.delete('token');
    return url.toString();
  } catch { return endpoint; }
}

function normalizeBeidouRow(row, campaignName, window) {
  const date = DATE_KEYS.map((key) => String(row?.[key] || '').slice(0, 10)).find(Boolean) || '';
  const normalized = {
    date,
    campaignName,
    granularity: 'campaign',
    campaignLevel: true,
    adLevel: false,
    source: 'beidou',
    ...Object.fromEntries(Object.entries(METRIC_ALIASES).map(([key, aliases]) => [key, number(firstValue(row, aliases))]))
  };
  if (date && (date < window.from || date > window.to)) normalized.outOfWindow = true;
  return normalized;
}

function summarizeBeidouRows(rows) {
  const metrics = Object.keys(METRIC_ALIASES);
  const summary = Object.fromEntries(metrics.map((key) => [key, (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + number(row?.[key]), 0)]));
  summary.rowCount = Array.isArray(rows) ? rows.length : 0;
  summary.granularity = 'campaign';
  summary.campaignLevel = true;
  summary.adLevel = false;
  return summary;
}

function buildRequestBody(campaignName, window, projectId = String(process.env.BEIDOU_PROJECT_ID || BEIDOU_PROJECT_ID)) {
  // Keep the name explicit and exact. Do not derive it from a Meta campaign
  // name or send a broad campaign query that could mix campaigns.
  return {
    approx: true,
    sampling_factor: 1,
    projectId: Number(projectId) || 1006,
    timeZones: ['Etc/Greenwich', 'Etc/Greenwich'],
    analysisTypeName: 'ccid',
    byFieldParams: [{
      fieldName: 'e.self_campaign_name', propNmCh: '广告系列名称（自建）',
      propNm: 'self_campaign_name', field: 'e.self_campaign_name',
      fieldLabel: '广告系列名称（自建）', groupByDataType: 'STRING',
      dataTypeValue: 'STRING', reportPropType: 'EventProp', canAccessData: true,
      id: 694111718764677, proType: '2', sqlExpression: '', isVisible: '1'
    }],
    arith_rollup: true,
    maxRowNumber: 2000,
    maxGroupNumber: 500,
    measures: [{
      event_name: 'app_launch', event_id: 225,
      metadata: { color: 'success', origiName: '总link日拉活' },
      field: 'BodyCount', aggregator: 'BodyCount', name: '总link日拉活',
      measureAliasName: 'measure_6', bucketId: 1, fieldLabel: '实体数'
    }],
    filter: {
      relation: 'and',
      conditions: [
        { field: 'e.product_line', function: 'EQUAL', paramDatas: ['NovelFlow'] },
        { field: 'e.self_campaign_name', function: 'EQUAL', paramDatas: [campaignName] }
      ],
      filters: []
    },
    dateRange: [`${window.from} 00:00`, `${window.to} 23:59`],
    unit: 'DAY'
  };
}

async function requestCampaign(campaignName, window, options = {}) {
  const endpoint = sanitizeEndpoint(options.endpoint == null ? process.env.BEIDOU_REPORT_URL || BEIDOU_REPORT_URL : options.endpoint);
  const fetchImpl = options.fetchImpl || global.fetch;
  const token = String(options.token == null ? process.env.BEIDOU_REPORT_TOKEN || '' : options.token).trim();
  const projectId = String(options.projectId == null ? process.env.BEIDOU_PROJECT_ID || BEIDOU_PROJECT_ID : options.projectId).trim() || '1006';
  if (!endpoint || typeof fetchImpl !== 'function') {
    const error = new Error('Beidou report endpoint is unavailable');
    error.status = 503;
    throw error;
  }
  const maxAttempts = Math.max(1, Math.min(8, Number(options.maxAttempts || process.env.BEIDOU_MAX_POLL_ATTEMPTS || 5)));
  const delayMs = Math.max(0, Math.min(5000, Number(options.pollDelayMs == null ? process.env.BEIDOU_POLL_DELAY_MS || 250 : options.pollDelayMs)));
  let body = {};
  let resultBody = {};
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-project-id': projectId, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequestBody(campaignName, window, projectId))
    });
    body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Beidou report request failed with HTTP ${response.status}`);
      error.status = response.status;
      error.upstream = body?.message || body?.error || '';
      throw error;
    }
    resultBody = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
    if (resultBody?.is_done !== false && String(resultBody?.is_done || '').toLowerCase() !== 'false') break;
    if (attempt < maxAttempts && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (resultBody?.is_done === false || String(resultBody?.is_done || '').toLowerCase() === 'false') {
    const error = new Error('Beidou report did not finish before the polling limit');
    error.status = 504;
    throw error;
  }
  const rows = parseStoredRows(body, window, campaignName).filter((row) => {
    const returned = exactCampaignName(row?.campaignName || row?.campaign_name || row?.campaign || row?.name);
    // If a provider echoes a campaign field, require an exact match. Rows that
    // omit the field are retained because this endpoint was queried by exact
    // campaign name and some legacy responses contain only metrics.
    return !returned || returned === campaignName;
  }).map((row) => normalizeBeidouRow(row, campaignName, window)).filter((row) => !row.outOfWindow);
  return { campaignName, granularity: 'campaign', campaignLevel: true, adLevel: false, rows, summary: summarizeBeidouRows(rows) };
}

async function fetchBeidouAds({ from, to, registry, fetchImpl = global.fetch, token = process.env.BEIDOU_REPORT_TOKEN, endpoint } = {}) {
  const window = validateWindow({ from, to });
  const active = (Array.isArray(registry) ? registry : []).filter((entry) => entry?.active !== false && String(entry?.accountId || '') === META_ACCOUNT_ID);
  if (!String(token || '').trim()) {
    return {
      source: 'beidou', status: 'unconfigured', configured: false, window, ads: [], rows: [],
      summary: summarizeBeidouRows([]), warnings: ['BEIDOU_REPORT_TOKEN is not configured'],
      granularity: 'campaign', campaignLevel: true, adLevel: false
    };
  }
  const named = active.filter((entry) => exactCampaignName(entry.beidouCampaignName));
  if (!named.length) {
    return {
      source: 'beidou', status: 'not_configured', configured: true, window, ads: [], rows: [],
      summary: summarizeBeidouRows([]), warnings: ['No active registry record has an explicit beidouCampaignName'],
      granularity: 'campaign', campaignLevel: true, adLevel: false
    };
  }
  const byCampaign = new Map();
  const errors = [];
  for (const entry of named) {
    const campaignName = exactCampaignName(entry.beidouCampaignName);
    if (!byCampaign.has(campaignName)) {
      try { byCampaign.set(campaignName, await requestCampaign(campaignName, window, { fetchImpl, token, endpoint })); }
      catch (error) { byCampaign.set(campaignName, { error }); errors.push({ campaignName, error }); }
    }
  }
  const ads = [];
  const rows = [];
  const sharedWarnings = [];
  const mappedByCampaign = new Map();
  for (const entry of named) {
    const campaignName = exactCampaignName(entry.beidouCampaignName);
    const list = mappedByCampaign.get(campaignName) || [];
    list.push(entry.metaAdId);
    mappedByCampaign.set(campaignName, list);
  }
  for (const [campaignName, result] of byCampaign.entries()) {
    if (!result || result.error) continue;
    const mappedMetaAdIds = mappedByCampaign.get(campaignName) || [];
    // The endpoint is campaign-level. Keep one canonical set of source rows
    // for summaries even when an operator maps the same campaign to multiple
    // allowlisted Meta ads. Per-ad projections below remain explicit and are
    // marked shared so the UI never implies ad-level attribution.
    rows.push(...result.rows.map((row) => ({
      ...row,
      accountId: META_ACCOUNT_ID,
      campaignLevel: true,
      adLevel: false,
      ...(mappedMetaAdIds.length > 1 ? { sharedAcrossAds: true, mappedMetaAdIds: mappedMetaAdIds.slice() } : {})
    })));
    if (mappedMetaAdIds.length > 1) {
      sharedWarnings.push(`${campaignName}: campaign-level metrics are mapped to ${mappedMetaAdIds.length} Meta ads and counted once in the Beidou summary`);
    }
  }
  for (const entry of named) {
    const result = byCampaign.get(entry.beidouCampaignName);
    if (!result || result.error) continue;
    const adRows = result.rows.map((row) => ({ ...row, metaAdId: entry.metaAdId, accountId: META_ACCOUNT_ID }));
    const mappedMetaAdIds = mappedByCampaign.get(entry.beidouCampaignName) || [];
    ads.push({
      ...entry,
      status: adRows.length ? 'ok' : 'no_data',
      campaignName: entry.beidouCampaignName,
      granularity: 'campaign', campaignLevel: true, adLevel: false,
      ...(mappedMetaAdIds.length > 1 ? { sharedAcrossAds: true, mappedMetaAdIds: mappedMetaAdIds.slice() } : {}),
      rows: adRows,
      metrics: summarizeBeidouRows(adRows)
    });
  }
  const status = errors.length && rows.length ? 'partial' : errors.length ? 'failed' : rows.length ? 'ok' : 'no_data';
  return {
    source: 'beidou', status, configured: true, window, ads, rows, summary: summarizeBeidouRows(rows),
    granularity: 'campaign', campaignLevel: true, adLevel: false,
    ...((errors.length || sharedWarnings.length) ? {
      warnings: [
        ...errors.map(({ campaignName, error }) => `${campaignName}: ${safeErrorMessage(error?.message)}`),
        ...sharedWarnings
      ].slice(0, 20)
    } : {})
  };
}

module.exports = {
  BEIDOU_PROJECT_ID, BEIDOU_REPORT_URL, METRIC_ALIASES, number, safeErrorMessage, parseStoredRows, exactCampaignName, sanitizeEndpoint,
  normalizeBeidouRow, summarizeBeidouRows, buildRequestBody, requestCampaign, fetchBeidouAds
};
