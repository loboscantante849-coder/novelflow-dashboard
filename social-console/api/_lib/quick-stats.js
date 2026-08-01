const providers = require('./providers');

const AGGREGATE_URL = 'https://raw.githubusercontent.com/loboscantante849-coder/novelflow-dashboard/main/ad_id_details.json';
const METRICS = [
  'visits', 'pullUv', 'activeUv', 'newUv', 'attActiveUv', 'attNewUv',
  'd0Income', 'd1Income', 'd3Income', 'd7Income', 'd14Income',
  'd30Income', 'd90Income', 'dnIncome', 'totalIncome'
];

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value) {
  return Math.round(number(value) * 10000) / 10000;
}

function summarize(rows) {
  const totals = Object.fromEntries(METRICS.map((key) => [key, round(rows.reduce((sum, row) => sum + number(row[key]), 0))]));
  const rate = (numerator, denominator) => denominator > 0 ? Math.round(numerator / denominator * 10000) / 100 : null;
  const dailyMap = new Map();
  for (const row of rows) {
    const date = String(row.date || row.dt || '').slice(0, 10);
    if (!date) continue;
    if (!dailyMap.has(date)) dailyMap.set(date, Object.fromEntries(METRICS.map((key) => [key, 0])));
    const day = dailyMap.get(date);
    for (const key of METRICS) day[key] += number(row[key]);
  }
  const daily = [...dailyMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => ({
    date, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round(value)]))
  }));
  return {
    ...totals,
    activationRate: rate(totals.activeUv, totals.pullUv),
    newUserRate: rate(totals.newUv, totals.activeUv),
    attributionRate: rate(totals.attActiveUv, totals.activeUv),
    rowCount: rows.length,
    daily
  };
}

function sourceResult(result) {
  if (result.status === 'fulfilled') {
    const value = result.value;
    const summary = summarize(value.rows);
    if (String(value.source).startsWith('putreport_')) {
      for (const key of ['visits', 'activeUv', 'attActiveUv', 'attNewUv', 'dnIncome']) summary[key] = null;
      summary.activationRate = null;
      summary.newUserRate = null;
      summary.attributionRate = null;
    } else if (value.source === 'social_funnel_realtime') {
      summary.visits = null;
      summary.totalIncome = null;
    }
    return { status: value.rows.length ? 'ok' : 'no_data', source: value.source, window: { from: value.from, to: value.to }, summary, rows: value.rows };
  }
  const error = result.reason;
  const status = Number(error?.status || 502);
  return {
    status: status === 401 || /invalid_grant/i.test(String(error?.message || '')) ? 'auth_error' : 'unavailable',
    code: status === 401 ? 'REPORT_AUTH_INVALID' : 'SOURCE_UNAVAILABLE'
  };
}

async function aggregateResult(identifier, from, to) {
  try {
    const response = await fetch(`${AGGREGATE_URL}?t=${Date.now()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const entry = data?.ad_ids?.[identifier];
    if (!entry) return { status: 'no_match', source: 'unified_aggregate', lastUpdated: data?.last_updated || null, dateRange: data?.date_range || null };
    const rows = (Array.isArray(entry.daily) ? entry.daily : []).filter((row) => {
      const date = String(row.dt || row.date || '').slice(0, 10);
      return date && date >= from && date <= to;
    }).map((row) => ({
      date: String(row.dt || row.date || '').slice(0, 10),
      pullUv: number(row.pull_uv ?? row.pullUv), activeUv: number(row.active_uv ?? row.activeUv), newUv: number(row.new_uv ?? row.newUv),
      d0Income: number(row.d0_income ?? row.d0Income), d7Income: number(row.d7_income ?? row.d7Income),
      d14Income: number(row.d14_income ?? row.d14Income), d30Income: number(row.d30_income ?? row.d30Income),
      d90Income: number(row.d90_income ?? row.d90Income), dnIncome: number(row.dn_income ?? row.dnIncome)
    }));
    const historical = entry.stats || {};
    return {
      status: rows.length ? 'ok' : 'matched_no_window_data', source: 'unified_aggregate', lastUpdated: data?.last_updated || null,
      dateRange: data?.date_range || null, channel: entry.channel || null, username: entry.username || null, bookName: entry.book_name || null,
      firstSeen: entry.first_seen || null, lastSeen: entry.last_seen || null, sourceMix: entry.source_mix || {}, summary: summarize(rows),
      historical: {
        pullUv: number(historical.pull_uv), activeUv: number(historical.active_uv), newUv: number(historical.new_uv),
        d0Income: number(historical.d0_income), d7Income: number(historical.d7_income), d14Income: number(historical.d14_income),
        d30Income: number(historical.d30_income), d90Income: number(historical.d90_income), dnIncome: number(historical.dn_income)
      }, rows
    };
  } catch {
    return { status: 'unavailable', source: 'unified_aggregate', code: 'AGGREGATE_UNAVAILABLE' };
  }
}

async function resolveIdentifier(value) {
  const input = String(value || '').trim();
  if (!input) throw new providers.ProviderError('A URL, Code, linkId, or adId is required', { status: 400 });
  if (!/^https?:\/\//i.test(input)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input)) throw new providers.ProviderError('The tracking identifier format is invalid', { status: 400 });
    return { input, identifier: input, kind: /^\d+$/.test(input) ? 'code_or_adid' : /^[a-f0-9]{24}$/i.test(input) ? 'link_id_or_adid' : 'tracking_id' };
  }
  let url;
  try { url = new URL(input); } catch { throw new providers.ProviderError('The URL is invalid', { status: 400 }); }
  const allowed = ['social.novelplatform.vip', 'social.novelflow.top', 'novelflow.top'];
  if (!allowed.includes(url.hostname.toLowerCase())) throw new providers.ProviderError('Only NovelFlow tracking URLs are supported', { status: 400 });
  const response = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
  const location = response.headers.get('location') || '';
  let identifier = url.searchParams.get('linkId') || '';
  if (!identifier && location) {
    try { identifier = new URL(location, url).searchParams.get('linkId') || ''; } catch {}
  }
  if (!identifier) throw new providers.ProviderError('The short URL did not expose a linkId', { status: 422 });
  return { input, identifier, kind: 'short_url', redirect: location || null };
}

function cleanLinkMetadata(value) {
  if (!value || typeof value !== 'object' || !Object.keys(value).length) return null;
  return {
    id: value.id || null, shortUrl: value.shortUrl || null, contentName: value.contentName || null,
    contentNameOrSku: value.contentNameOrSku || null, channelName: value.channelName || null,
    channelNameId: value.channelNameId || null, operatorName: value.operatorName || null,
    isEnabled: value.isEnabled ?? null, createTime: value.createTime || null
  };
}

function cleanCodeMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  return { keyword: value.keyword || null, bookId: value.bookId || value.bookSkuId || null, channel: value.channel || null, isEnable: value.isEnable ?? value.isEnabled ?? null };
}

async function expandChildren(rows, days, range) {
  const childIds = [...new Set(rows.map((row) => String(row.adId || '').trim()).filter(Boolean))].slice(0, 50);
  if (!childIds.length) return { rows: [], truncated: false };
  const report = await providers.funnelReportIds(childIds, days, range);
  const metadata = await Promise.all(childIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)).map(async (id) => {
    try { return [id, cleanLinkMetadata(await providers.linkDetail(id))]; } catch { return [id, null]; }
  }));
  const metadataById = Object.fromEntries(metadata);
  const children = childIds.map((id) => {
    const childRows = report.rows.filter((row) => row.adId === id);
    return { identifier: id, metadata: metadataById[id] || null, source: report.source, summary: summarize(childRows), rows: childRows };
  });
  return { rows: children, truncated: new Set(rows.map((row) => String(row.adId || '').trim()).filter(Boolean)).size > childIds.length };
}

async function quickStats(query, days = 2, range = {}) {
  const resolved = await resolveIdentifier(query);
  const count = Math.max(1, Math.min(Number(days) || 2, 180));
  const to = range.to || new Date().toISOString().slice(0, 10);
  const from = range.from || new Date(Date.parse(`${to}T00:00:00Z`) - (count - 1) * 86400000).toISOString().slice(0, 10);
  const id = resolved.identifier;
  const linkLookup = /^[a-f0-9]{24}$/i.test(id)
    ? providers.linkDetail(id).then((value) => ({ status: 'fulfilled', value }), () => ({ status: 'rejected' }))
    : Promise.resolve({ status: 'rejected' });
  const candidateDimensions = resolved.kind === 'tracking_id' ? ['campaignid', 'adsetid', 'copywritingid'] : [];
  const dimensionQueries = Promise.all(candidateDimensions.map(async (dimension) => [
    dimension,
    await providers.putreportDimensionRows(id, dimension, count, { from, to })
      .then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))
  ]));
  const [funnelSettled, putreportSettled, aggregate, linkSettled, codeSettled, dimensionSettled] = await Promise.all([
    providers.funnelReportRows('', id, count, { from, to }).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason })),
    providers.putreportRows('', id, count, { from, to }).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason })),
    aggregateResult(id, from, to),
    linkLookup,
    providers.keywordRecord(id).then((value) => ({ status: 'fulfilled', value }), () => ({ status: 'rejected' })),
    dimensionQueries
  ]);
  const funnel = sourceResult(funnelSettled);
  const putreport = sourceResult(putreportSettled);
  const putreportDimensions = Object.fromEntries(dimensionSettled.map(([dimension, result]) => [dimension, sourceResult(result)]));
  const matchedDimension = ['copywritingid', 'campaignid', 'adsetid'].find((dimension) => putreportDimensions[dimension]?.status === 'ok');
  const breakdownSettled = matchedDimension
    ? await providers.putreportBreakdownRows(id, matchedDimension, count, { from, to }).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))
    : { status: 'rejected' };
  const breakdown = sourceResult(breakdownSettled);
  const children = breakdown.status === 'ok'
    ? await expandChildren(breakdown.rows, count, { from, to }).catch(() => ({ rows: [], truncated: false }))
    : { rows: [], truncated: false };
  const primary = funnel.status === 'ok' ? 'social_funnel_realtime' : putreport.status === 'ok' ? 'putreport_adid_realtime' : matchedDimension ? `putreport_${matchedDimension}_realtime` : aggregate.status === 'ok' ? 'unified_aggregate' : null;
  const allAnswered = [funnel.status, putreport.status, ...Object.values(putreportDimensions).map((value) => value.status)].every((status) => ['ok', 'no_data'].includes(status));
  const status = primary ? 'ok' : allAnswered && ['no_match', 'matched_no_window_data'].includes(aggregate.status) ? 'no_data' : 'partial';
  return {
    status, input: resolved.input, identifier: id, identifierKind: resolved.kind, redirect: resolved.redirect || null,
    resolvedDimension: matchedDimension || (funnel.status === 'ok' ? 'tracking_id' : putreport.status === 'ok' ? 'adid' : null),
    window: { from, to, days: count }, primarySource: primary,
    metadata: {
      link: linkSettled.status === 'fulfilled' ? cleanLinkMetadata(linkSettled.value) : null,
      code: codeSettled.status === 'fulfilled' ? cleanCodeMetadata(codeSettled.value) : null
    },
    sources: { socialFunnel: funnel, putreport, putreportDimensions, breakdown, children, aggregate },
    guidance: primary ? 'Use primarySource for headline metrics; sources are independent views and must not be added together.' : 'No source returned a matching event in this window. Verify the identifier type and publication tracking value.'
  };
}

module.exports = { quickStats, resolveIdentifier, summarize };
