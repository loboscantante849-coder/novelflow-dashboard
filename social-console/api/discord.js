const { getRedis, saveDiscordJob } = require('./_lib/store');
const { verifyDiscordRequest, newSearchJob, handleComponent, allowedGuild, helpResponse } = require('./_lib/discord');

async function rawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (req.readable && !req.readableEnded) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (chunks.length) return Buffer.concat(chunks);
  }
  return Buffer.from(JSON.stringify(req.body || {}));
}

function interactionError(res, status, message) {
  return res.status(status).json({ type: 4, data: { content: String(message).slice(0, 1900), flags: 64 } });
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const raw = await rawBody(req);
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  if (!verifyDiscordRequest(raw, signature, timestamp)) return res.status(401).json({ error: 'Invalid Discord signature' });
  let interaction;
  try { interaction = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  if (interaction.type === 1) return res.status(200).json({ type: 1 });
  const redis = getRedis();
  if (!redis) return interactionError(res, 200, 'NovelFlow assistant storage is not configured.');
  if (!allowedGuild(interaction)) return interactionError(res, 200, 'This Discord server or role is not enabled for the NovelFlow assistant.');
  try {
    if (interaction.type === 3) {
      const result = await handleComponent(redis, interaction);
      if (result.status !== 200) return interactionError(res, 200, result.body?.error || 'Unable to confirm this book.');
      return res.status(200).json(result.body);
    }
    if (interaction.type !== 2) {
      return interactionError(res, 200, 'Unsupported NovelFlow command.');
    }
    const command = String(interaction.data?.name || '');
    if (command === 'book-help') return res.status(200).json(helpResponse());
    const messageContextSearch = interaction.data?.type === 3 && command === 'Find NovelFlow book';
    if (command !== 'find-book' && !messageContextSearch) return interactionError(res, 200, 'Unsupported NovelFlow command.');
    const job = newSearchJob(interaction);
    if (!job.input.text && !job.input.attachments.length) return interactionError(res, 200, 'Add a novel excerpt, plot description, or screenshot.');
    await saveDiscordJob(redis, job, true);
    return res.status(200).json({ type: 5, data: { flags: 64 } });
  } catch (error) {
    console.error('[social/discord]', String(error?.message || error));
    return interactionError(res, 200, 'The NovelFlow assistant could not queue this request.');
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
