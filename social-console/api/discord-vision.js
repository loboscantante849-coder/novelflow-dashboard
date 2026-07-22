const crypto = require('crypto');
const { analyzeScreenshotWithSeed } = require('./_lib/providers');

function authorized(req) {
  const expected = String(process.env.DISCORD_VISION_SECRET || '');
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected) && supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function seedReachableDiscordUrl(imageUrl) {
  const parsed = new URL(imageUrl);
  if (/^cdn\.discordapp\.com$/i.test(parsed.hostname)) parsed.hostname = 'media.discordapp.net';
  return parsed.toString();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const imageUrl = String(req.body?.imageUrl || '');
  try {
    const parsed = new URL(imageUrl);
    if (!/^https:$/.test(parsed.protocol) || !/(?:discordapp\.com|discordapp\.net)$/i.test(parsed.hostname)) throw new Error('Only Discord image attachments are supported');
  } catch (error) { return res.status(400).json({ error: String(error.message || error) }); }
  try {
    // Discord's media host is optimized for image delivery; Seed's URL fetch
    // can time out against the raw CDN hostname.
    const vision = await analyzeScreenshotWithSeed(seedReachableDiscordUrl(imageUrl));
    return res.status(200).json({ vision });
  } catch (error) {
    console.error('[social/discord-vision]', String(error?.message || error));
    return res.status(error?.status || 502).json({ error: String(error?.message || 'Seed screenshot analysis failed').slice(0, 300) });
  }
};
