const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const envCheck = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ? `SET (${process.env.GITHUB_TOKEN.length} chars, starts: ${process.env.GITHUB_TOKEN.substring(0,6)})` : 'NOT_SET',
    OIDC_USERNAME: process.env.OIDC_USERNAME || 'NOT_SET',
    OIDC_PASSWORD: process.env.OIDC_PASSWORD ? `SET (${process.env.OIDC_PASSWORD.length} chars)` : 'NOT_SET',
    JWT_SECRET: process.env.JWT_SECRET ? `SET (${process.env.JWT_SECRET.length} chars)` : 'NOT_SET',
    KV_REST_API_URL: process.env.KV_REST_API_URL || 'NOT_SET',
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN ? `SET (${process.env.KV_REST_API_TOKEN.length} chars)` : 'NOT_SET',
    REDIS_URL: process.env.REDIS_URL || 'NOT_SET',
    KV_URL: process.env.KV_URL || 'NOT_SET',
    NOVELSPA_TOKEN: process.env.NOVELSPA_TOKEN ? `SET (${process.env.NOVELSPA_TOKEN.length} chars)` : 'NOT_SET',
    BOOKSTORE_TOKEN: process.env.BOOKSTORE_TOKEN ? `SET (${process.env.BOOKSTORE_TOKEN.length} chars)` : 'NOT_SET',
  };
  
  return res.status(200).json(envCheck);
};
