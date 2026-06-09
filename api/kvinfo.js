module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const key = req.query.key;
  if (key !== 'nf2026tmp') return res.status(403).json({error:'forbidden'});
  return res.status(200).json({
    KV_REST_API_URL: process.env.KV_REST_API_URL || '',
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN || '',
  });
};
