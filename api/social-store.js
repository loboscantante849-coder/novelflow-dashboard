const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const KEY_PREFIX = 'nf_social:';

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validKey(key) {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) && key.length <= 240;
}

function options(value) {
  const input = value && typeof value === 'object' ? value : {};
  const output = {};
  if (input.nx === true) output.nx = true;
  if (Number.isInteger(input.ex) && input.ex > 0 && input.ex <= 7 * 86400) output.ex = input.ex;
  if (input.rev === true) output.rev = true;
  return output;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SOCIAL_STORE_SECRET || !safeEqual(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), process.env.SOCIAL_STORE_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return res.status(503).json({ error: 'Storage is unavailable' });
  const { op, args = {} } = req.body || {};
  const key = args.key;
  if (!validKey(key)) return res.status(400).json({ error: 'Invalid social storage key' });
  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  try {
    let result;
    if (op === 'get') result = await redis.get(key);
    else if (op === 'set') {
      if (typeof args.value !== 'string' || args.value.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Invalid value' });
      result = await redis.set(key, args.value, options(args.options));
    } else if (op === 'zrange') {
      if (!Number.isInteger(args.start) || !Number.isInteger(args.end)) return res.status(400).json({ error: 'Invalid range' });
      result = await redis.zrange(key, args.start, args.end, options(args.options));
    } else if (op === 'zadd') {
      if (!args.entry || !Number.isFinite(args.entry.score) || typeof args.entry.member !== 'string' || !validKey(`${KEY_PREFIX}run:${args.entry.member}`)) return res.status(400).json({ error: 'Invalid sorted-set entry' });
      result = await redis.zadd(key, { score: args.entry.score, member: args.entry.member });
    } else if (op === 'incr') result = await redis.incr(key);
    else if (op === 'del') result = await redis.del(key);
    else return res.status(400).json({ error: 'Unsupported operation' });
    return res.status(200).json({ result: result ?? null });
  } catch (error) {
    console.error('[social-store]', error);
    return res.status(502).json({ error: 'Social storage request failed' });
  }
};
