const crypto = require('crypto');
const { put, del } = require('@vercel/blob');
const { analyzeScreenshotWithSeed } = require('./_lib/providers');

function authorized(req) {
  const expected = String(process.env.DISCORD_VISION_SECRET || '');
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected) && supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function stageDiscordImage(imageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(imageUrl, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`Unable to download Discord image (HTTP ${response.status})`);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!contentType.startsWith('image/')) throw new Error('Discord attachment is not an image');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Discord image must be between 1 byte and 8 MB');
    const extension = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1].replace(/[^a-z0-9]/g, '') || 'png';
    return put(`discord-vision/${crypto.randomUUID()}.${extension}`, bytes, { access: 'public', contentType, cacheControlMaxAge: 60, addRandomSuffix: false });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const imageUrl = String(req.body?.imageUrl || '');
  try {
    const parsed = new URL(imageUrl);
    if (!/^https:$/.test(parsed.protocol) || !/(?:discordapp\.com|discordapp\.net)$/i.test(parsed.hostname)) throw new Error('Only Discord image attachments are supported');
  } catch (error) { return res.status(400).json({ error: String(error.message || error) }); }
  let staged;
  try {
    staged = await stageDiscordImage(imageUrl);
    const model = String(process.env.DISCORD_VISION_MODEL || 'seed-2.1-turbo').trim();
    const vision = await analyzeScreenshotWithSeed(staged.url, model);
    return res.status(200).json({ vision });
  } catch (error) {
    console.error('[social/discord-vision]', String(error?.message || error));
    return res.status(error?.status || 502).json({ error: String(error?.message || 'Seed screenshot analysis failed').slice(0, 300) });
  } finally {
    if (staged?.url) await del(staged.url).catch((error) => console.warn('[social/discord-vision] blob cleanup failed:', String(error?.message || error)));
  }
};
