const providers = require('./providers');

const CATALOG_VERSION = 'v2';

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(value) {
  return new Set(normalize(value).split(/\s+/).filter((item) => item.length >= 3));
}

function ngrams(value, size = 3) {
  const clean = normalize(value).replace(/\s+/g, ' ');
  const result = new Set();
  for (let index = 0; index <= clean.length - size; index += 1) result.add(clean.slice(index, index + size));
  return result;
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const value of left) if (right.has(value)) common += 1;
  return common / Math.max(1, Math.min(left.size, right.size));
}

function sourceRankScore(book) {
  const ranks = Object.values(book.rankings || {}).map((item) => Number(item.rank || 999)).filter(Number.isFinite);
  if (!ranks.length) return 0;
  return Math.max(...ranks.map((rank) => Math.max(0, 1 - (rank - 1) / 200)));
}

function lexicalScore(query, book) {
  const cleanQuery = normalize(query);
  const cleanTitle = normalize(book.title);
  const metadata = [book.title, book.author, book.category, ...(book.tags || []), book.description].filter(Boolean).join(' ');
  const titleContained = cleanTitle.length >= 3 && cleanQuery.includes(cleanTitle);
  const queryContained = cleanQuery.length >= 4 && cleanTitle.includes(cleanQuery);
  const titleSimilarity = overlap(ngrams(cleanQuery), ngrams(cleanTitle));
  const termSimilarity = overlap(tokens(cleanQuery), tokens(metadata));
  const exactBoost = titleContained ? 0.7 : queryContained ? 0.55 : 0;
  return Math.min(1, exactBoost + titleSimilarity * 0.45 + termSimilarity * 0.35 + sourceRankScore(book) * 0.03);
}

function mergeBooks(sources) {
  const merged = new Map();
  for (const source of sources) {
    for (const item of source.books || []) {
      const sku = String(item.bookSkuId || item.sku || '');
      const titleKey = providers.titleKey(item.title);
      if (!sku && !titleKey) continue;
      const key = sku ? `sku:${sku}` : `title:${titleKey}`;
      const current = merged.get(key) || { bookSkuId: sku, title: String(item.title || ''), sources: [], rankings: {}, tags: [] };
      current.bookSkuId = current.bookSkuId || sku;
      current.title = current.title || String(item.title || '');
      current.cover = current.cover || String(item.cover || '');
      current.author = current.author || String(item.author || '');
      current.category = current.category || String(item.category || '');
      current.description = current.description || String(item.description || '');
      current.tags = [...new Set([...(current.tags || []), ...(Array.isArray(item.tags) ? item.tags : [])].filter(Boolean))].slice(0, 12);
      current.sources = [...new Set([...current.sources, source.name])];
      current.rankings[source.name] = { rank: Number(item.rank || 0), metric: source.metric, value: Number(item[source.metric] || item.uv || 0) };
      for (const metric of ['uv', 'baseReadUnt', 'firstReadUntRate', 'read10wRate', 'read20wRate', 'ttProfit']) {
        current[metric] = Math.max(Number(current[metric] || 0), Number(item[metric] || 0));
      }
      merged.set(key, current);
    }
  }
  return [...merged.values()].filter((book) => book.bookSkuId && book.title);
}

function dateWindow(days) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function catalogKey(language) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return `nf_social:discord:catalog:${CATALOG_VERSION}:${day}:${language}`;
}

async function buildCatalog(redis, language = 'EN', refresh = false) {
  const key = catalogKey(language);
  if (!refresh) {
    const stored = await redis.get(key);
    if (stored) return typeof stored === 'string' ? JSON.parse(stored) : stored;
  }
  const window = dateWindow(30);
  const filters = { productLine: ['novelflow'], language, completeSts: '\u5df2\u5b8c\u7ed3', status: '\u4e0a\u67b6' };
  const requests = [
    { name: 'bookstore_uv', metric: 'uv', promise: providers.topBooks(200) },
    { name: 'funnel_7d', metric: 'profit', promise: providers.performanceBooks(7).then((value) => value.books || []) },
    { name: 'funnel_30d', metric: 'profit', promise: providers.performanceBooks(30).then((value) => value.books || []) },
    ...['baseReadUnt', 'firstReadUntRate', 'read20wRate', 'ttProfit'].map((metric) => ({
      name: `content_30d_${metric}`, metric,
      promise: providers.contentDashboardBooks({ ...window, sortField: metric, minReadUnt: metric === 'baseReadUnt' ? 0 : 150, filters }).then((value) => value.books || [])
    }))
  ];
  const settled = await Promise.allSettled(requests.map((item) => item.promise));
  const sources = settled.flatMap((result, index) => result.status === 'fulfilled' && Array.isArray(result.value)
    ? [{ name: requests[index].name, metric: requests[index].metric, books: result.value }]
    : []);
  if (!sources.length) throw new providers.ProviderError('No NovelFlow catalog or ranking source is available');
  const payload = { books: mergeBooks(sources), sources: sources.map((source) => source.name), generatedAt: new Date().toISOString(), language };
  await redis.set(key, JSON.stringify(payload), { ex: 18 * 60 * 60 });
  return payload;
}

async function enrichCandidates(candidates) {
  const enriched = [];
  for (let index = 0; index < candidates.length; index += 4) {
    const group = candidates.slice(index, index + 4);
    const values = await Promise.all(group.map(async (book) => {
      try { return { ...book, ...(await providers.findExactBook(book.title, book.bookSkuId)) }; }
      catch { return book; }
    }));
    enriched.push(...values);
  }
  return enriched;
}

function recommendationScore(book, reference) {
  const sameCategory = normalize(book.category) && normalize(book.category) === normalize(reference?.category) ? 0.35 : 0;
  const tagScore = overlap(tokens((book.tags || []).join(' ')), tokens((reference?.tags || []).join(' '))) * 0.35;
  return sameCategory + tagScore + sourceRankScore(book) * 0.3;
}

function resultView(book, confidence, reasons, matchedTerms) {
  return {
    bookSkuId: book.bookSkuId, title: book.title, author: book.author || '', cover: book.cover || '', category: book.category || '',
    description: String(book.description || '').replace(/\s+/g, ' ').trim().slice(0, 700),
    tags: book.tags || [], confidence: Math.max(0, Math.min(100, Math.round(Number(confidence) || 0))),
    confidenceLabel: confidence >= 85 ? 'high' : confidence >= 65 ? 'medium' : 'low',
    reasons: (reasons || []).map(String).filter(Boolean).slice(0, 3), matchedTerms: (matchedTerms || []).map(String).filter(Boolean).slice(0, 8),
    sources: book.sources || [], rankings: book.rankings || {}
  };
}

async function matchBooks(redis, query, options = {}) {
  const cleanQuery = String(query || '').trim();
  if (cleanQuery.length < 4) throw new providers.ProviderError('Please provide a longer excerpt or description', { status: 400 });
  const catalog = await buildCatalog(redis, options.language || 'EN', options.refresh === true);
  const scored = catalog.books.map((book) => ({ book, score: lexicalScore(cleanQuery, book) }))
    .sort((left, right) => right.score - left.score || sourceRankScore(right.book) - sourceRankScore(left.book));
  const candidates = await enrichCandidates(scored.slice(0, 24).map((item) => item.book));
  let analysis = null;
  let model = 'lexical-fallback';
  try {
    const response = await providers.analyzeBookCandidates(cleanQuery, candidates);
    analysis = response.analysis;
    model = response.model;
  } catch {
    analysis = null;
  }
  const bySku = new Map(candidates.map((book) => [String(book.bookSkuId), book]));
  let matches = analysis?.candidates?.map((item) => {
    const book = bySku.get(String(item.bookSkuId || ''));
    if (!book) return null;
    const lexical = lexicalScore(cleanQuery, book) * 100;
    const exactTitle = normalize(cleanQuery).includes(normalize(book.title));
    const confidence = exactTitle ? Math.max(92, Number(item.confidence || 0)) : Number(item.confidence || 0) * 0.88 + lexical * 0.12;
    return resultView(book, confidence, item.reasons, item.matchedTerms);
  }).filter(Boolean) || [];
  if (!matches.length) {
    matches = scored.slice(0, 5).map(({ book, score }) => resultView(book, score * 100, score > 0.35 ? ['Title or metadata terms overlap the request'] : ['Ranking-based candidate; plot evidence is insufficient'], []));
  }
  matches.sort((left, right) => right.confidence - left.confidence);
  const topMatches = matches.slice(0, 3);
  const excluded = new Set(topMatches.map((book) => String(book.bookSkuId)));
  const reference = bySku.get(String(topMatches[0]?.bookSkuId || ''));
  const recommendations = catalog.books.filter((book) => !excluded.has(String(book.bookSkuId)))
    .map((book) => ({ book, score: recommendationScore(book, reference) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ book, score }) => resultView(book, Math.min(64, 35 + score * 35), ['Similar category, tags, or current ranking strength'], []));
  return {
    query: cleanQuery, matches: topMatches, recommendations: topMatches[0]?.confidence >= 65 ? [] : recommendations,
    extracted: analysis?.extracted || {}, model, catalog: { generatedAt: catalog.generatedAt, sources: catalog.sources, size: catalog.books.length }
  };
}

module.exports = { normalize, lexicalScore, mergeBooks, buildCatalog, matchBooks, recommendationScore };
