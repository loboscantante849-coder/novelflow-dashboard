const { setCORSHeaders } = require('../_lib/cors');
const { Redis } = require('@upstash/redis');

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

module.exports = async (req, res) => {
  setCORSHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username is required' });

    const redis = getRedis();
    if (!redis) return res.status(200).json({ hasPassword: false });

    const storedHash = await redis.get('nf_user_pass:' + username.trim());
    return res.status(200).json({ hasPassword: !!storedHash });
  } catch (error) {
    console.error('Check password error:', error);
    return res.status(200).json({ hasPassword: false });
  }
};
