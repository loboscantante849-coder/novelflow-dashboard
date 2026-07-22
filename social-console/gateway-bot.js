const { Client, Events, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

function loadLocalEnv() {
  const file = path.resolve(__dirname, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)=(.*)\s*$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadLocalEnv();
const { getRedis } = require('./api/_lib/store');
const { matchBooks, normalize, lexicalScore } = require('./api/_lib/book-matcher');
const providers = require('./api/_lib/providers');

const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
const gatewaySecret = String(process.env.DISCORD_GATEWAY_SECRET_V2 || process.env.DISCORD_GATEWAY_SECRET || process.env.DISCORD_VISION_SECRET || process.env.CRON_SECRET || '').trim();
const searchUrl = String(process.env.DISCORD_GATEWAY_SEARCH_URL || 'https://social.novelflow.top/api/discord-gateway-search').trim();
const allowedGuilds = new Set(String(process.env.NOVELFLOW_DISCORD_ALLOWED_GUILD_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
const recentSessions = new Map();
let nextPromoCode = 55555;
const execFileAsync = promisify(execFile);
const OCR_SCRIPT = 'C:\\Users\\yuanju\\.codex\\skills\\screenshot-book-finder\\scripts\\runtime\\scripts\\ocr_images.ps1';
const visionEndpoint = String(process.env.DISCORD_VISION_ENDPOINT || 'https://social.novelflow.top/api/discord-vision').trim();
const visionSecret = String(process.env.DISCORD_VISION_SECRET || '').trim();

if (!token) throw new Error('DISCORD_BOT_TOKEN is required');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

function conversationKey(message) {
  return [String(message.guildId || ''), String(message.channelId || ''), String(message.author?.id || '')].join(':');
}

function rememberResult(message, result) {
  recentSessions.set(conversationKey(message), { createdAt: Date.now(), candidates: result.matches || result.recommendations || [], exact: result.matches?.[0]?.confidence >= 85 ? result.matches[0] : null });
}

function recentResult(message) {
  const value = recentSessions.get(conversationKey(message));
  if (!value || Date.now() - value.createdAt > 30 * 60 * 1000) return null;
  return value;
}

async function replyInChannel(message, payload) {
  try { return await message.reply(payload); }
  catch (error) {
    console.error(`Discord channel reply failed guild=${message.guildId || ''} channel=${message.channelId || ''}:`, String(error?.message || error));
    return null;
  }
}

function queryFromMessage(message) {
  const mention = new RegExp(`<@!?${client.user.id}>`, 'g');
  const text = String(message.content || '').replace(mention, '').trim();
  if (message.mentions.has(client.user)) return text;
  const matched = /^(?:找书|查书|find\s+book)\s*[:：-]?\s*(.+)$/i.exec(text);
  return matched ? matched[1].trim() : '';
}

async function screenshotText(message) {
  const attachment = [...message.attachments.values()].find((item) => String(item.contentType || '').startsWith('image/'));
  if (!attachment) return '';
  try {
    const response = await fetch(visionEndpoint, { method: 'POST', headers: { Authorization: `Bearer ${visionSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl: attachment.url }) });
    if (!response.ok) throw new Error(`Seed vision returned HTTP ${response.status}`);
    const body = await response.json();
    const vision = body.vision || {};
    if (!vision.text) throw new Error('Seed vision returned no text');
    const visibleTitle = String(vision.visibleTitle || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
    const query = [visibleTitle ? `Visible title: ${visibleTitle}` : '', vision.text, ...vision.characters, ...vision.phrases, ...vision.plotClues].filter(Boolean).join('\n').slice(0, 12000);
    return { query, visibleTitle };
  } catch (error) {
    console.warn('Seed screenshot analysis unavailable, using Windows OCR:', String(error?.message || error));
  }
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error('Unable to download the screenshot');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Screenshot is too large for OCR');
  const extension = String(attachment.name || '').match(/\.(png|jpe?g|webp)$/i)?.[0] || '.png';
  const file = path.join(os.tmpdir(), `novelflow-discord-${crypto.randomUUID()}${extension}`);
  try {
    fs.writeFileSync(file, bytes);
    const { stdout } = await execFileAsync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, '-ImagePaths', file], { timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { query: String(stdout || '').replace(/\s+/g, ' ').trim().slice(0, 12000), visibleTitle: '' };
  } finally { fs.rmSync(file, { force: true }); }
}

function resultEmbed(result) {
  const books = result.matches?.length ? result.matches : result.recommendations || [];
  if (!books.length) return { content: 'I could not find a ranked NovelFlow candidate. Send a longer excerpt or a clearer clue.' };
  const exact = result.matches?.[0];
  if (exact?.confidence >= 85) {
    const promo = exact.promo?.status === 'ready'
      ? `**Code:** \`${exact.promo.code}\`\n**Read now:** ${exact.promo.shortUrl}\n\nOpen the link or search this Code in NovelFlow to start reading.`
      : 'The identification is confirmed. I could not create the attribution link yet.';
    return { embeds: [{
      title: `Found it | ${exact.title}`.slice(0, 256), color: 0x238636,
      description: `**Match:** ${exact.confidence}%\n**Evidence:** ${(exact.reasons || []).join('; ') || 'Exact NovelFlow bookstore evidence'}\n\n**About this novel**\n${String(exact.description || 'NovelFlow bookstore introduction is unavailable.').replace(/\s+/g, ' ').trim().slice(0, 700)}\n\n${promo}`.slice(0, 4000),
      footer: { text: 'Verified through the NovelFlow bookstore.' }
    }] };
  }
  const lines = books.slice(0, 3).map((book, index) => {
    const evidence = (book.reasons || []).slice(0, 2).join('; ') || 'Ranking and metadata evidence';
    const intro = String(book.description || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    const promo = book.promo?.status === 'ready'
      ? `\n**Code:** \`${book.promo.code}\`\n**Read now:** ${book.promo.shortUrl}\nUse the code above when you open the book.`
      : `\nReply **${index + 1}** to confirm this candidate, then I will create its Discord code and link.`;
    return `**${index + 1}. ${book.title}** - ${book.confidence}%\n${evidence}${intro ? `\n${intro}` : ''}${promo}`;
  });
  return {
    embeds: [{
      title: result.matches?.length ? 'NovelFlow candidates - confirmation needed' : 'Similar NovelFlow recommendations',
      description: lines.join('\n\n').slice(0, 4000),
      footer: { text: 'Match percentage is a system score, not a guarantee.' },
      color: 0x238636
    }]
  };
}

function localSearch(query) {
  const file = path.resolve(__dirname, '..', 'featured-books.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const books = Object.values(payload.categories || {}).flat().filter((book) => book?.title);
  const scored = books.map((book) => ({ book, score: lexicalScore(query, { ...book, bookSkuId: book.bookId, category: book.category || book.bookClassName }) }))
    .sort((a, b) => b.score - a.score).slice(0, 3);
  const matches = scored.map(({ book, score }) => ({
      bookSkuId: String(book.bookId), title: String(book.title), author: String(book.author || ''), cover: String(book.cover || ''),
      confidence: Math.round(score * 100), reasons: [normalize(query).includes(normalize(book.title)) ? 'Title matches the request' : 'Excerpt, tags, or synopsis overlap the request'],
      sources: ['NovelFlow featured catalog']
    }));
  // Never turn a weak lexical overlap into a claimed book identification.
  return { matches: matches[0]?.confidence >= 45 ? matches : [], recommendations: [], model: 'local-featured-catalog' };
}

function recommendationIntent(text) {
  return /推荐|热门|榜单|top\s*[1-5]|today|今日|popular|recommend|suggest/i.test(String(text || ''));
}

function linkIntent(text) {
  return /\b(?:link|code|url|short\s*link)\b|链接|短链|归因码|推广码|创建码/i.test(String(text || ''));
}

async function aiRoute(input) {
  const apiKey = String(process.env.NOVELFLOW_COPY_LLM_API_KEY || process.env.NOVELFLOW_LLM_API_KEY || '').trim();
  if (!apiKey || !String(input || '').trim()) return null;
  const baseUrl = String(process.env.NOVELFLOW_COPY_LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = String(process.env.NOVELFLOW_COPY_LLM_MODEL || 'deepseek-chat');
  const system = 'You are the routing brain for a NovelFlow Discord book assistant. Return JSON only: {"intent":"chat|search|recommend|link","query":"string","reply":"string"}. recommend means asking for books, rankings, or suggestions. link means asking for a promotion code or short link. search means title, quote, character, or plot clue. chat means greetings or general conversation. Keep reply under 140 characters. Never invent a title, code, link, or book fact.';
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: String(input).slice(0, 2000) }], response_format: { type: 'json_object' }, temperature: 0.1, max_tokens: 180 }) });
    if (!response.ok) return null;
    const body = await response.json();
    const parsed = JSON.parse(String(body.choices?.[0]?.message?.content || '{}'));
    return ['chat', 'search', 'recommend', 'link'].includes(parsed.intent) ? parsed : null;
  } catch { return null; }
}

function localTopBooks(limit = 5) {
  const file = path.resolve(__dirname, '..', 'featured-books.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const books = Object.values(payload.categories || {}).flat().filter((book) => book?.title && (book.languageCode || 'en').toLowerCase() === 'en');
  const unique = [...new Map(books.map((book) => [String(book.bookId), book])).values()];
  return unique.slice(0, limit).map((book, index) => ({
    bookSkuId: String(book.bookId), title: String(book.title), author: String(book.author || ''), cover: String(book.cover || ''),
    description: String(book.description || '').replace(/\s+/g, ' ').trim().slice(0, 260), category: String(book.category || book.bookClassName || 'Romance'),
    tags: Array.isArray(book.tags) ? book.tags.slice(0, 4).map(String) : [], rank: index + 1
  }));
}

function linkBook(query) {
  const clean = String(query || '').replace(/\b(?:link|code|url|short\s*link)\b|链接|短链|归因码|推广码|创建码/gi, ' ').trim();
  const result = localSearch(clean);
  return { query: clean, book: result.matches?.[0], confidence: result.matches?.[0]?.confidence || 0 };
}

async function promoCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(nextPromoCode++);
    if (code.length !== 5) throw new Error('Discord promotion code range is exhausted');
    const existing = await providers.keywordRecord(code);
    if (!existing) return code;
  }
  throw new Error('No free five-digit Discord promotion code is available');
}

async function createDiscordPromo(book, index, message) {
  const promoter = String(process.env.NOVELFLOW_DISCORD_PROMOTER || process.env.NOVELFLOW_PROMOTER || '').trim();
  if (!promoter) return { status: 'not_created', reason: 'Discord promoter is not configured' };
  const channelNameId = String(process.env.NOVELFLOW_DISCORD_CHANNEL_NAME_ID || process.env.NOVELFLOW_CHANNEL_NAME_ID || '699ef7b8194eb218db3c2270').trim();
  if (!channelNameId) return { status: 'not_created', reason: 'Discord attribution channel is not configured' };
  try {
    const code = await promoCode();
    await providers.createKeyword(book.bookSkuId, code, { channel: String(process.env.NOVELFLOW_DISCORD_CHANNEL_CODE || 'DISCORD') });
    const created = await providers.createLink(book, promoter, code, { channel: 'DISCORD', guildId: message.guildId || 'direct', languageCode: 'en' });
    let link = created.shortUrl ? { shortUrl: created.shortUrl, id: created.id } : null;
    if (!link && created.id) {
      try {
        const detail = await providers.linkDetail(created.id);
        if (detail?.shortUrl) link = { shortUrl: detail.shortUrl, id: created.id };
      } catch {}
    }
    if (!link) {
      try { link = await providers.findLink(book.bookSkuId, promoter, code, { channelSource: String(process.env.NOVELFLOW_DISCORD_CHANNEL_SOURCE || 'Discord') }); } catch {}
    }
    if (!link?.shortUrl) return { status: 'unverified', code, reason: 'Code created, but short link could not be verified', linkId: created.id };
    return { status: 'ready', code, shortUrl: link.shortUrl, linkId: String(link.id || created.id || '') };
  } catch (error) {
    return { status: 'failed', code: '', reason: String(error?.message || 'Attribution creation failed').slice(0, 180) };
  }
}

function recommendationPayload(books) {
  const fields = books.map((book) => ({
    name: `${book.rank}. ${book.title}`.slice(0, 256),
    value: `${book.author ? `By ${book.author}\n` : ''}${book.description || 'NovelFlow featured title'}\n**Tags:** ${(book.tags || []).join(', ') || book.category}\n${book.promo?.status === 'ready' ? `**Code:** \`${book.promo.code}\`\n**Short link:** ${book.promo.shortUrl}` : `**Attribution:** ${book.promo?.reason || 'not created'}`}`.slice(0, 1024),
    inline: false
  }));
  return { embeds: [{ title: 'NovelFlow | Today\'s Top 5', description: 'Five featured novels from the current NovelFlow catalog. Codes and short links are created and verified per title.', color: 0xd29922, fields, footer: { text: 'Links are attributed to Discord.' } }] };
}

async function recommend(message) {
  const pending = await replyInChannel(message, { content: 'Building today\'s Top 5 and creating Discord links...' });
  if (!pending) return;
  const books = localTopBooks(5);
  for (let index = 0; index < books.length; index += 1) books[index].promo = await createDiscordPromo(books[index], index, message);
  await pending.edit(recommendationPayload(books));
}

async function createLinkForBook(message, book, confidence = 99) {
  if (!book?.bookSkuId || !book?.title) {
    await replyInChannel(message, { content: 'I do not have a confirmed NovelFlow book for that request.' });
    return;
  }
  const pending = await replyInChannel(message, { content: `Creating a verified Discord code and short link for **${book.title}**...` });
  if (!pending) return;
  const promo = await createDiscordPromo(book, 0, message);
  if (promo.status === 'ready') {
    const description = String(book.description || '').replace(/\s+/g, ' ').trim().slice(0, 700);
    await pending.edit({ embeds: [{ title: `Attribution ready | ${book.title}`.slice(0, 256), description: `**Match:** ${Math.round(confidence)}%\n\n**About this novel**\n${description || 'NovelFlow bookstore introduction is unavailable.'}\n\n**Code:** \`${promo.code}\`\n**Short link:** ${promo.shortUrl}\n\nOpen the link or search this Code in NovelFlow to start reading.`, color: 0x238636, footer: { text: 'Verified against NovelFlow attribution records.' } }] });
  } else {
    await pending.edit({ content: `I confirmed **${book.title}**, but I could not create a verified link yet.\n**Reason:** ${promo.reason || promo.status}` });
  }
}

async function createLinkForRequest(message, query) {
  const clean = String(query || '').replace(/\b(?:link|code|url|short\s*link)\b|é“¾æŽ¥|çŸ­é“¾|å½’å› ç |æŽ¨å¹¿ç |åˆ›å»ºç /gi, ' ').replace(/\b(?:please|pls)\b/gi, ' ').trim();
  const recent = recentResult(message);
  if (!clean || clean.length < 4) {
    if (recent?.exact) return createLinkForBook(message, recent.exact, recent.exact.confidence);
    if (recent?.candidates?.length) {
      await replyInChannel(message, { content: 'The last search was not certain enough to create a link automatically. Reply **1**, **2**, or **3** to choose one of the candidates shown above.' });
      return;
    }
    await replyInChannel(message, { content: 'Send a screenshot, an excerpt, or a title first. I will identify the book before creating its code and link.' });
    return;
  }
  try {
    const exact = await providers.findExactBook(clean);
    return createLinkForBook(message, exact, 99);
  } catch (error) {
    if (![404, 409].includes(Number(error?.status || 0))) throw error;
  }
  const found = linkBook(clean);
  if (!found.book || found.confidence < 85) {
    await replyInChannel(message, { content: 'I will not create attribution for an unconfirmed match. Send the screenshot or an excerpt, and I will identify it first.' });
    return;
  }
  return createLinkForBook(message, found.book, found.confidence);
}

async function search(message, query) {
  const pending = await replyInChannel(message, { content: 'Searching NovelFlow catalog and rankings...' });
  if (!pending) return;
  try {
    // The desktop Gateway has the approved NovelFlow credentials locally. Use
    // that path first so a Vercel secret rotation cannot break Discord replies.
    const redis = getRedis();
    if (redis) {
      const result = await matchBooks(redis, query, { language: 'EN' });
      rememberResult(message, result);
      if (result.matches?.[0]?.confidence >= 85) result.matches[0].promo = await createDiscordPromo(result.matches[0], 0, message);
      await pending.edit(resultEmbed(result));
      return;
    }
    if (gatewaySecret) {
      const response = await fetch(searchUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gatewaySecret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: message.guildId || '', query, visibleTitle: /^Visible title:\s*(.+)$/im.exec(query)?.[1] || '', language: 'EN' })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Search failed with HTTP ${response.status}`);
      const result = body.result || {};
      rememberResult(message, result);
      if (result.matches?.[0]?.confidence >= 85) result.matches[0].promo = await createDiscordPromo(result.matches[0], 0, message);
      await pending.edit(resultEmbed(result));
      return;
    }
    const result = localSearch(query);
    rememberResult(message, result);
    if (result.matches?.[0]?.confidence >= 85) result.matches[0].promo = await createDiscordPromo(result.matches[0], 0, message);
    await pending.edit(resultEmbed(result));
  } catch (error) {
    // The local worker remains useful while a production deployment is rolling.
    try {
      const redis = getRedis();
      if (!redis) throw error;
      const result = await matchBooks(redis, query, { language: 'EN' });
      await pending.edit(resultEmbed(result));
    } catch {
      await pending.edit({ content: `I could not search the NovelFlow catalog: ${String(error.message || error).slice(0, 300)}` });
    }
  }
}

client.once(Events.ClientReady, (ready) => {
  console.log(`NovelFlow Discord Gateway ready as ${ready.user.tag}`);
  ready.user.setPresence({ activities: [{ name: 'NovelFlow book search', type: 3 }], status: 'online' });
  for (const guild of client.guilds.cache.values()) {
    const rules = guild.channels.cache.find((channel) => channel?.isTextBased?.() && String(channel.name || '').toLowerCase() === 'rules');
    if (!rules) continue;
    const permissions = rules.permissionsFor(ready.user);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
    const missing = required.filter((permission) => !permissions?.has(permission)).map((permission) => Object.entries(PermissionFlagsBits).find(([, value]) => value === permission)?.[0] || String(permission));
    if (missing.length) console.error(`Discord channel permissions missing guild=${guild.id} channel=${rules.id} #${rules.name}: ${missing.join(', ')}`);
    else console.log(`Discord channel permissions ready guild=${guild.id} channel=${rules.id} #${rules.name}`);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guildId) return;
  if (message.guildId && allowedGuilds.size && !allowedGuilds.has(String(message.guildId))) return;
  let query = queryFromMessage(message);
  if (message.mentions.has(client.user) && message.attachments.size) {
    try {
      const screenshot = await screenshotText(message);
      query = screenshot.query;
      if (!query) throw new Error('No readable text found');
    } catch (error) {
      await replyInChannel(message, { content: `I could not read that screenshot: ${String(error.message || error).slice(0, 180)}` });
      return;
    }
  }
  if (!query) return;
  // A screenshot title is evidence, not a conversational instruction. Keep it
  // on the deterministic bookstore path before the routing model can discard it.
  if (/^Visible title:\s*.+/im.test(query)) {
    await search(message, query);
    return;
  }
  const ai = await aiRoute(query);
  const routedQuery = String(ai?.query || query).trim() || query;
  if (ai?.intent === 'chat') {
    await replyInChannel(message, { content: ai.reply || 'Tell me what you enjoy reading, or ask for today\'s Top 5.' });
    return;
  }
  if (ai?.intent === 'recommend') {
    await recommend(message);
    return;
  }
  if (ai?.intent === 'link') {
    await createLinkForRequest(message, query);
    return;
  }
  if (/^(?:hi|hello|hey|你好|嗨)$/i.test(query)) {
    await replyInChannel(message, { content: 'Hi. Send a title or excerpt to find a book, say `recommend today top 5`, or reply `1` after a result to create that book\'s code and link.' });
    return;
  }
  if (/^[1-3]$/.test(query)) {
    const selected = recentResult(message)?.candidates?.[Number(query) - 1];
    if (!selected) {
      await replyInChannel(message, { content: 'I do not have a recent candidate list in this channel. Send a screenshot, excerpt, or title first.' });
      return;
    }
    await createLinkForBook(message, selected, selected.confidence || 0);
    return;
  }
  if (recommendationIntent(query)) {
    await recommend(message);
    return;
  }
  if (linkIntent(query)) {
    await createLinkForRequest(message, query);
    return;
  }
  if (query.length < 4) {
    await replyInChannel(message, { content: 'Tell me a book title, an excerpt, or say `recommend today top 5`.' });
    return;
  }
  await search(message, routedQuery);
});

client.on(Events.Error, (error) => console.error('Discord Gateway error:', String(error?.message || error)));
process.on('unhandledRejection', (error) => console.error('Unhandled Gateway rejection:', String(error?.message || error)));

client.login(token);
