const { getRedis } = require('./_lib/store');
const { matchBooks } = require('./_lib/book-matcher');

function authorized(req) {
  const expected = [process.env.DISCORD_GATEWAY_SECRET_V2, process.env.DISCORD_GATEWAY_SECRET, process.env.DISCORD_VISION_SECRET, process.env.CRON_SECRET]
    .map((value) => String(value || ''))
    .filter(Boolean);
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return expected.some((value) => supplied.length === value.length && require('crypto').timingSafeEqual(Buffer.from(supplied), Buffer.from(value)));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const allowedGuilds = String(process.env.NOVELFLOW_DISCORD_ALLOWED_GUILD_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const guildId = String(req.body?.guildId || '');
  if (allowedGuilds.length && !allowedGuilds.includes(guildId)) return res.status(403).json({ error: 'This Discord server is not enabled.' });
  const query = String(req.body?.query || '').trim().slice(0, 12000);
  if (query.length < 4) return res.status(400).json({ error: 'Send a longer title, quote, character, or plot clue.' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'NovelFlow storage is not configured.' });
  try {
    const result = await matchBooks(redis, query, { language: String(req.body?.language || 'EN').toUpperCase() });
    return res.status(200).json({ result });
  } catch (error) {
    console.error('[social/discord-gateway-search]', String(error?.message || error));
    return res.status(error?.status || 500).json({ error: String(error?.message || 'Book search failed').slice(0, 400) });
  }
};
