const crypto = require('crypto');
const providers = require('./providers');
const { matchBooks } = require('./book-matcher');
const { getDiscordJob, saveDiscordJob, removeDiscordJobFromQueue } = require('./store');

const DISCORD_API = 'https://discord.com/api/v10';

function publicKeyObject(hex) {
  const raw = Buffer.from(String(hex || ''), 'hex');
  if (raw.length !== 32) return null;
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

function verifyDiscordRequest(rawBody, signature, timestamp, publicKey = process.env.DISCORD_PUBLIC_KEY) {
  try {
    const key = publicKeyObject(publicKey);
    if (!key || !/^[a-f0-9]{128}$/i.test(String(signature || '')) || !timestamp) return false;
    return crypto.verify(null, Buffer.concat([Buffer.from(String(timestamp)), Buffer.from(rawBody)]), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}

function optionMap(data) {
  const result = {};
  const visit = (items) => (items || []).forEach((item) => {
    if (Array.isArray(item.options)) visit(item.options);
    else result[item.name] = item.value;
  });
  visit(data?.options);
  return result;
}

function requester(interaction) {
  return interaction.member?.user || interaction.user || {};
}

function allowedGuild(interaction) {
  const configured = String(process.env.NOVELFLOW_DISCORD_ALLOWED_GUILD_IDS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (configured.length && !configured.includes(String(interaction.guild_id || ''))) return false;
  const roles = String(process.env.NOVELFLOW_DISCORD_ALLOWED_ROLE_IDS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (roles.length && !roles.some((role) => (interaction.member?.roles || []).map(String).includes(role))) return false;
  return true;
}

function imageAttachments(interaction, options) {
  const target = interaction.data?.resolved?.messages?.[interaction.data?.target_id] || {};
  const resolved = Object.values(interaction.data?.resolved?.attachments || {});
  const messageAttachments = Array.isArray(target.attachments) ? target.attachments : Object.values(target.attachments || {});
  const byId = new Map([...resolved, ...messageAttachments].filter((item) => item?.id).map((item) => [String(item.id), item]));
  const attachments = [...byId.values()];
  return attachments.filter((item) => {
    if (options.image && String(item.id) !== String(options.image)) return false;
    try {
      const host = new URL(item.url).hostname.toLowerCase();
      return String(item.content_type || '').startsWith('image/') && (host.endsWith('discordapp.com') || host.endsWith('discordapp.net'));
    } catch { return false; }
  }).slice(0, 2).map((item) => ({ id: String(item.id), url: String(item.url), filename: String(item.filename || ''), contentType: String(item.content_type || '') }));
}

function selectedMessage(interaction) {
  return interaction.data?.resolved?.messages?.[interaction.data?.target_id] || null;
}

function newSearchJob(interaction) {
  const options = optionMap(interaction.data);
  const message = selectedMessage(interaction);
  const user = requester(interaction);
  const now = new Date().toISOString();
  return {
    id: `discord_${interaction.id}`, kind: 'search', state: 'queued', phase: 'input', createdAt: now, updatedAt: now,
    interaction: { applicationId: String(interaction.application_id || ''), token: String(interaction.token || '') },
    guildId: String(interaction.guild_id || ''), channelId: String(interaction.channel_id || ''),
    user: { id: String(user.id || ''), username: String(user.username || '') },
    input: { source: message ? 'message_context' : 'slash_command', text: String(options.text || options.fragment || message?.content || '').trim().slice(0, 12000), language: String(options.language || 'EN').toUpperCase(), attachments: imageAttachments(interaction, options) },
    result: null, error: ''
  };
}

function helpResponse() {
  return {
    type: 4,
    data: {
      flags: 64,
      content: [
        '**NovelFlow Book Concierge**',
        '`/find-book` accepts a title, quote, character, plot clue, or screenshot.',
        'You can also right-click a message and choose **Find NovelFlow book**.',
        'The match score is system evidence, not a guarantee. Confirm a title before requesting its Discord code and short link.',
        'For an unclear result, send a longer excerpt or a clearer screenshot. Only approved server roles can create attribution.'
      ].join('\n')
    }
  };
}

function newTrackingJob(interaction, parent, selectedBook) {
  const user = requester(interaction);
  const now = new Date().toISOString();
  return {
    id: `discord_${interaction.id}`, kind: 'tracking', state: 'queued', phase: 'confirmation_saved', createdAt: now, updatedAt: now,
    interaction: { applicationId: String(interaction.application_id || ''), token: String(interaction.token || '') },
    guildId: String(interaction.guild_id || parent.guildId || ''), channelId: String(interaction.channel_id || parent.channelId || ''),
    user: { id: String(user.id || ''), username: String(user.username || '') }, parentJobId: parent.id,
    selectedBook: { bookSkuId: String(selectedBook.bookSkuId), title: String(selectedBook.title), cover: String(selectedBook.cover || '') },
    promoter: String(process.env.NOVELFLOW_DISCORD_PROMOTER || 'xujt'), tracking: { status: 'confirmed', code: '', linkId: '', shortUrl: '' }, error: ''
  };
}

async function discordRequest(path, options = {}) {
  const response = await fetch(`${DISCORD_API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (!response.ok) throw new providers.ProviderError(`Discord response update failed with HTTP ${response.status}`, { status: response.status });
  return response.status === 204 ? {} : response.json().catch(() => ({}));
}

async function updateOriginal(job, payload) {
  return discordRequest(`/webhooks/${encodeURIComponent(job.interaction.applicationId)}/${encodeURIComponent(job.interaction.token)}/messages/@original`, { method: 'PATCH', body: JSON.stringify(payload) });
}

function sourceLabel(source) {
  if (source === 'bookstore_uv') return 'Bookstore UV';
  if (source.startsWith('content_30d_')) return `Content 30d ${source.slice(12)}`;
  if (source.startsWith('funnel_')) return `Funnel ${source.slice(7)}`;
  return source;
}

function matchEmbed(book, index, recommendation = false) {
  const evidence = book.reasons?.length ? book.reasons.map((item) => `- ${item}`).join('\n') : '- Not enough distinctive evidence';
  const rankings = (book.sources || []).slice(0, 3).map(sourceLabel).join(', ') || 'NovelFlow catalog';
  return {
    title: `${recommendation ? 'Similar recommendation' : `Candidate ${index + 1}`}: ${book.title}`.slice(0, 256),
    description: `${book.author ? `By ${book.author}\n` : ''}**System match score: ${book.confidence}%** (${book.confidenceLabel})\n${evidence}`.slice(0, 4000),
    color: book.confidence >= 85 ? 0x238636 : book.confidence >= 65 ? 0xd29922 : 0x6e7781,
    fields: [{ name: 'Ranking sources', value: rankings.slice(0, 1024), inline: false }],
    ...(book.cover ? { thumbnail: { url: book.cover } } : {})
  };
}

function searchPayload(result, job) {
  const reliable = (result.matches || []).filter((item) => item.confidence >= 40);
  const books = reliable.length ? reliable : result.recommendations;
  const recommendations = !reliable.length;
  const sourceCount = result.catalog?.sources?.length || 0;
  const content = reliable.length
    ? `Found ${reliable.length} candidate${reliable.length === 1 ? '' : 's'} across ${sourceCount} NovelFlow catalog/ranking sources. The percentage is a system matching score, not a guaranteed probability.`
    : `No reliable exact match yet. These are similar ranked books. Send a longer excerpt or a clearer screenshot for another search.`;
  const components = books?.length ? [{ type: 1, components: books.slice(0, 3).map((book, index) => ({
    type: 2, style: 3, label: `Confirm ${index + 1}`.slice(0, 80), custom_id: `nf_select:${job.id}:${book.bookSkuId}`.slice(0, 100)
  })) }] : [];
  return { content, embeds: (books || []).slice(0, 3).map((book, index) => matchEmbed(book, index, recommendations)), components };
}

function trackingPayload(job) {
  const tracking = job.tracking || {};
  if (job.state === 'blocked') return { content: `I saved the attribution attempt for **${job.selectedBook.title}**, but the external write is ambiguous or needs operator review. It will not be retried automatically.`, embeds: [], components: [] };
  return {
    content: `Attribution is ready for **${job.selectedBook.title}**.`,
    embeds: [{ title: job.selectedBook.title, color: 0x238636, fields: [
      { name: 'NovelFlow Code', value: String(tracking.code), inline: true },
      { name: 'Verified short link', value: String(tracking.shortUrl), inline: false }
    ], ...(job.selectedBook.cover ? { thumbnail: { url: job.selectedBook.cover } } : {}) }], components: []
  };
}

async function processSearchJob(redis, job) {
  job.state = 'running'; job.phase = 'ocr';
  await saveDiscordJob(redis, job);
  const parts = [job.input.text].filter(Boolean);
  const ocr = [];
  for (const attachment of job.input.attachments || []) {
    try {
      const extracted = await providers.extractScreenshotText(attachment.url);
      parts.push(extracted.text);
      ocr.push({ filename: attachment.filename, text: extracted.text, language: extracted.language, quality: extracted.quality, model: extracted.model });
    } catch (error) {
      ocr.push({ filename: attachment.filename, text: '', error: String(error?.message || 'OCR failed').slice(0, 180) });
    }
  }
  if (!parts.length) throw new providers.ProviderError('Add a text excerpt or configure screenshot OCR before searching', { status: 400 });
  job.input.ocr = ocr;
  job.phase = 'matching';
  await saveDiscordJob(redis, job);
  job.result = await matchBooks(redis, parts.join('\n\n'), { language: ['EN', 'ES'].includes(job.input.language) ? job.input.language : 'EN' });
  job.state = 'completed'; job.phase = 'results_ready';
  await saveDiscordJob(redis, job);
  await updateOriginal(job, searchPayload(job.result, job));
}

function keywordOwned(record, job) {
  const ids = [record?.bookId, record?.bookSkuId].map(String);
  const channel = String(process.env.NOVELFLOW_DISCORD_CHANNEL_CODE || 'DISCORD').toUpperCase();
  return ids.includes(String(job.selectedBook.bookSkuId)) && String(record?.channel || '').toUpperCase() === channel && providers.enabled(record?.isEnable);
}

async function allocateCode(redis, job) {
  await redis.set('nf_social:next_code', '44443', { nx: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(await redis.incr('nf_social:next_code'));
    job.tracking = { ...job.tracking, status: 'code_allocated', code, codeAttempts: attempt + 1 };
    job.phase = 'code_allocated';
    await saveDiscordJob(redis, job);
    const existing = await providers.keywordRecord(code);
    if (!existing || keywordOwned(existing, job)) return { code, existing };
  }
  throw new providers.ProviderError('Could not allocate a free NovelFlow code');
}

async function processTrackingJob(redis, job) {
  job.state = 'running';
  await saveDiscordJob(redis, job);
  const allocation = job.tracking?.code ? { code: job.tracking.code, existing: await providers.keywordRecord(job.tracking.code) } : await allocateCode(redis, job);
  if (!allocation.existing) {
    job.phase = 'code_submitting'; job.tracking.status = 'code_submitting';
    await saveDiscordJob(redis, job);
    await providers.createKeyword(job.selectedBook.bookSkuId, allocation.code, { channel: String(process.env.NOVELFLOW_DISCORD_CHANNEL_CODE || 'DISCORD') });
  }
  const keyword = await providers.keywordRecord(allocation.code);
  if (!keywordOwned(keyword, job)) throw new providers.ProviderError('Created Discord code could not be verified remotely');
  job.phase = 'code_verified'; job.tracking.status = 'code_verified';
  await saveDiscordJob(redis, job);
  const channelSource = String(process.env.NOVELFLOW_DISCORD_CHANNEL_SOURCE || 'Discord');
  let link = await providers.findLink(job.selectedBook.bookSkuId, job.promoter, allocation.code, { channelSource });
  if (!link) {
    job.phase = 'link_submitting'; job.tracking.status = 'link_submitting';
    await saveDiscordJob(redis, job);
    const created = await providers.createLink(job.selectedBook, job.promoter, allocation.code, { channel: 'DISCORD', guildId: job.guildId, languageCode: 'en' });
    job.tracking.linkId = created.id;
    job.phase = 'link_submitted'; job.tracking.status = 'link_submitted';
    await saveDiscordJob(redis, job);
    link = await providers.findLink(job.selectedBook.bookSkuId, job.promoter, allocation.code, { channelSource });
  }
  if (!link?.shortUrl || !providers.enabled(link.isEnabled)) throw new providers.ProviderError('Created Discord short link could not be verified remotely', { ambiguous: Boolean(job.tracking.linkId) });
  job.tracking = { ...job.tracking, status: 'verified', linkId: String(link.id || job.tracking.linkId || ''), shortUrl: providers.absoluteUrl(link.shortUrl) };
  job.phase = 'tracking_ready'; job.state = 'completed';
  await saveDiscordJob(redis, job);
  await updateOriginal(job, trackingPayload(job));
}

async function processDiscordJob(redis, job) {
  try {
    if (job.kind === 'search') await processSearchJob(redis, job);
    else if (job.kind === 'tracking') await processTrackingJob(redis, job);
    else throw new providers.ProviderError('Unsupported Discord job type', { status: 400 });
  } catch (error) {
    job.error = String(error?.message || 'Discord job failed').slice(0, 500);
    job.state = error?.ambiguous ? 'blocked' : 'failed';
    job.phase = error?.ambiguous ? 'ambiguous_external_write' : 'failed';
    await saveDiscordJob(redis, job);
    const content = error?.ambiguous
      ? `The external attribution request for **${job.selectedBook?.title || 'this book'}** has an ambiguous status. It was saved and will not be retried automatically.`
      : `I could not complete this request: ${job.error}`;
    await updateOriginal(job, { content: content.slice(0, 1900), embeds: [], components: [] }).catch(() => {});
  } finally {
    await removeDiscordJobFromQueue(redis, job.id);
  }
  return job;
}

async function handleComponent(redis, interaction) {
  const match = /^nf_select:(discord_[a-z0-9_-]+):(.+)$/i.exec(String(interaction.data?.custom_id || ''));
  if (!match) return { status: 400, body: { error: 'Unsupported component' } };
  const parent = await getDiscordJob(redis, match[1]);
  if (!parent || parent.state !== 'completed') return { status: 404, body: { error: 'Search result expired' } };
  if (String(parent.user?.id) !== String(requester(interaction).id || '')) return { status: 403, body: { error: 'Only the requester can confirm this book' } };
  const candidates = [...(parent.result?.matches || []), ...(parent.result?.recommendations || [])];
  const selected = candidates.find((book) => String(book.bookSkuId) === String(match[2]));
  if (!selected) return { status: 404, body: { error: 'Candidate not found' } };
  const job = newTrackingJob(interaction, parent, selected);
  await saveDiscordJob(redis, job, true);
  return { status: 200, body: { type: 5, data: { flags: 64 } } };
}

module.exports = { verifyDiscordRequest, optionMap, allowedGuild, newSearchJob, newTrackingJob, processDiscordJob, handleComponent, searchPayload, trackingPayload, helpResponse };
