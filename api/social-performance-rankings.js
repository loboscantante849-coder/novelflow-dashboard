const data = require('../ad_id_details.json');
const { rankBooks } = require('./_lib/social-performance');

function publicBook(book) {
  // Keep the public leaderboard useful without exposing exact commercial
  // revenue figures that are intended for authenticated Admin reporting.
  const { d14Income, dnIncome, incomePerUv, ...safe } = book || {};
  return safe;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const days = [3, 7, 30].includes(Number(req.query?.days)) ? Number(req.query.days) : 7;
  const result = rankBooks(data, days);
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({
    ...result,
    books: result.books.map(publicBook),
    generatedAt: new Date().toISOString(),
    source: 'unified_funnel_performance',
  });
};

module.exports.publicBook = publicBook;
