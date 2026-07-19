function number(value) { return Number(value) || 0; }

function cleanTitle(value) {
  return String(value || '').replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function dailyRows(entry) {
  const daily = entry?.daily || {};
  if (Array.isArray(daily)) return daily.map((row) => ({ date: String(row.dt || row.date || ''), row }));
  return Object.entries(daily).map(([date, row]) => ({ date: String(row?.dt || date), row: row || {} }));
}

function rankBooks(data, days) {
  const dates = [];
  for (const entry of Object.values(data?.ad_ids || {})) for (const item of dailyRows(entry)) if (/^\d{4}-\d{2}-\d{2}$/.test(item.date)) dates.push(item.date);
  const throughDate = dates.sort().at(-1) || '';
  if (!throughDate) return { books: [], window: { days, throughDate: '', startDate: '', endDate: '' } };
  const end = new Date(`${throughDate}T00:00:00Z`);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  const startDate = start.toISOString().slice(0, 10);
  const names = new Map();
  for (const promoter of Object.values(data?.by_promoter || {})) for (const book of promoter?.books || []) {
    const title = cleanTitle(book.name || book.book_name);
    if (title) for (const id of book.ad_ids || []) if (!names.has(String(id))) names.set(String(id), title);
  }
  const books = new Map();
  for (const [adId, entry] of Object.entries(data?.ad_ids || {})) {
    const title = cleanTitle(entry?.book_name || names.get(String(adId)));
    if (!title) continue;
    const key = title.toLowerCase();
    const book = books.get(key) || { title, pullUv: 0, newUv: 0, d14Income: 0, dnIncome: 0, assetIds: new Set() };
    let used = false;
    for (const item of dailyRows(entry)) {
      if (item.date < startDate || item.date > throughDate) continue;
      book.pullUv += number(item.row.pull_uv); book.newUv += number(item.row.new_uv);
      book.d14Income += number(item.row.d14_income); book.dnIncome += number(item.row.dn_income || item.row.d14_income); used = true;
    }
    if (used) book.assetIds.add(String(adId));
    books.set(key, book);
  }
  const minimum = Math.max(6, days * 2);
  const candidates = [...books.values()].filter((book) => book.pullUv >= minimum && !/^legacy link|^unknown$/i.test(book.title));
  const totalPull = candidates.reduce((sum, book) => sum + book.pullUv, 0);
  const baselineReadRate = totalPull ? candidates.reduce((sum, book) => sum + book.newUv, 0) / totalPull : 0;
  const baselineIncomePerUv = totalPull ? candidates.reduce((sum, book) => sum + book.dnIncome, 0) / totalPull : 0;
  const volumeMax = Math.max(1, ...candidates.map((book) => Math.log1p(book.pullUv)));
  const incomeMax = Math.max(0.0001, ...candidates.map((book) => Math.log1p((book.dnIncome + baselineIncomePerUv * 120) / (book.pullUv + 120))));
  const confidenceTarget = days === 3 ? 80 : days === 7 ? 160 : 420;
  const ranked = candidates.map((book) => {
    const firstReadRate = (book.newUv + baselineReadRate * 80) / (book.pullUv + 80);
    const incomePerUv = (book.dnIncome + baselineIncomePerUv * 120) / (book.pullUv + 120);
    const confidence = Math.min(1, book.pullUv / confidenceTarget);
    const score = 100 * ((Math.log1p(book.pullUv) / volumeMax) * 0.5 + (baselineReadRate ? Math.min(1.4, firstReadRate / baselineReadRate) / 1.4 : 0) * 0.25 + (Math.log1p(incomePerUv) / incomeMax) * 0.25) * (0.55 + confidence * 0.45);
    return { title: book.title, pullUv: Math.round(book.pullUv), newUv: Math.round(book.newUv), d14Income: Math.round(book.d14Income * 100) / 100, dnIncome: Math.round(book.dnIncome * 100) / 100, firstReadRate: Math.round(firstReadRate * 10000) / 100, incomePerUv: Math.round(incomePerUv * 10000) / 10000, confidence: Math.round(confidence * 100), score: Math.round(score * 10) / 10, assetCount: book.assetIds.size, retentionRate: null };
  }).sort((left, right) => right.score - left.score || right.pullUv - left.pullUv).slice(0, 50);
  return { books: ranked.map((book, index) => ({ ...book, rank: index + 1 })), window: { days, throughDate, startDate, endDate: throughDate }, metrics: { firstRead: 'new_uv / pull_uv (Bayesian-smoothed)', retention: 'not_available', d14Income: 'daily D14 income' } };
}

module.exports = { rankBooks };
