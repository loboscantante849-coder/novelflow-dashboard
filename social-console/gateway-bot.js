const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const gatewaySecret = String(process.env.DISCORD_GATEWAY_SECRET_V2 || process.env.DISCORD_GATEWAY_SECRET || process.env.CRON_SECRET || '').trim();
const searchUrl = String(process.env.DISCORD_GATEWAY_SEARCH_URL || 'https://social.novelflow.top/api/discord-gateway-search').trim();
const allowedGuilds = new Set(String(process.env.NOVELFLOW_DISCORD_ALLOWED_GUILD_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));

if (!token) throw new Error('DISCORD_BOT_TOKEN is required');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

function queryFromMessage(message) {
  const mention = new RegExp(`<@!?${client.user.id}>`, 'g');
  const text = String(message.content || '').replace(mention, '').trim();
  if (message.mentions.has(client.user)) return text;
  const matched = /^(?:找书|查书|find\s+book)\s*[:：-]?\s*(.+)$/i.exec(text);
  return matched ? matched[1].trim() : '';
}

function resultEmbed(result) {
  const books = result.matches?.length ? result.matches : result.recommendations || [];
  if (!books.length) return { content: 'I could not find a ranked NovelFlow candidate. Send a longer excerpt or a clearer clue.' };
  const lines = books.slice(0, 3).map((book, index) => {
    const evidence = (book.reasons || []).slice(0, 2).join('; ') || 'Ranking and metadata evidence';
    return `**${index + 1}. ${book.title}** - ${book.confidence}%\n${evidence}`;
  });
  return {
    embeds: [{
      title: result.matches?.length ? 'NovelFlow candidates' : 'Similar NovelFlow recommendations',
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
  return {
    matches: scored.map(({ book, score }) => ({
      bookSkuId: String(book.bookId), title: String(book.title), author: String(book.author || ''), cover: String(book.cover || ''),
      confidence: Math.round(score * 100), reasons: [normalize(query).includes(normalize(book.title)) ? 'Title matches the request' : 'Excerpt, tags, or synopsis overlap the request'],
      sources: ['NovelFlow featured catalog']
    })), recommendations: [], model: 'local-featured-catalog'
  };
}

function recommendationIntent(text) {
  return /推荐|热门|榜单|top\s*[1-5]|today|今日|popular|recommend|suggest/i.test(String(text || ''));
}

function linkIntent(text) {
  return /\b(?:link|code|url|short\s*link)\b|链接|短链|归因码|推广码|创建码/i.test(String(text || ''));
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

function promoCode(index) {
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `D${String(Date.now()).slice(-7)}${index + 1}${suffix}`.slice(0, 16);
}

async function createDiscordPromo(book, index, message) {
  const promoter = String(process.env.NOVELFLOW_DISCORD_PROMOTER || process.env.NOVELFLOW_PROMOTER || '').trim();
  if (!promoter) return { status: 'not_created', reason: 'Discord promoter is not configured' };
  const channelNameId = String(process.env.NOVELFLOW_DISCORD_CHANNEL_NAME_ID || process.env.NOVELFLOW_CHANNEL_NAME_ID || '699ef7b8194eb218db3c2270').trim();
  if (!channelNameId) return { status: 'not_created', reason: 'Discord attribution channel is not configured' };
  const code = promoCode(index);
  try {
    await providers.createKeyword(book.bookSkuId, code, { channel: String(process.env.NOVELFLOW_DISCORD_CHANNEL_CODE || 'DISCORD') });
    const created = await providers.createLink(book, promoter, code, { channel: 'DISCORD', guildId: message.guildId || 'direct', languageCode: 'en' });
    let link = created.shortUrl ? { shortUrl: created.shortUrl, id: created.id } : null;
    if (!link && created.id) {
      try { link = await providers.findLink(book.bookSkuId, promoter, code, { channelSource: String(process.env.NOVELFLOW_DISCORD_CHANNEL_SOURCE || 'Discord') }); } catch {}
    }
    if (!link?.shortUrl) return { status: 'unverified', code, reason: 'Code created, but short link could not be verified', linkId: created.id };
    return { status: 'ready', code, shortUrl: link.shortUrl, linkId: String(link.id || created.id || '') };
  } catch (error) {
    return { status: 'failed', code, reason: String(error?.message || 'Attribution creation failed').slice(0, 180) };
  }
}

function recommendationPayload(books) {
  const fields = books.map((book) => ({
    name: `${book.rank}. ${book.title}`.slice(0, 256),
    value: `${book.author ? `By ${book.author}\n` : ''}${book.description || 'NovelFlow featured title'}\n**Tags:** ${(book.tags || []).join(', ') || book.category}\n${book.promo?.status === 'ready' ? `**Code:** \`${book.promo.code}\`\n[Open book](${book.promo.shortUrl})` : `**Attribution:** ${book.promo?.reason || 'not created'}`}`.slice(0, 1024),
    inline: false
  }));
  return { embeds: [{ title: 'NovelFlow | Today\'s Top 5', description: 'Five featured novels from the current NovelFlow catalog. Codes and short links are created and verified per title.', color: 0xd29922, fields, footer: { text: 'Links are attributed to Discord.' } }] };
}

async function recommend(message) {
  let pending;
  try { pending = await message.reply({ content: 'Building today\'s Top 5 and creating Discord links...' }); }
  catch { try { pending = await message.author.send({ content: 'Building today\'s Top 5 and creating Discord links...' }); } catch { return; } }
  const books = localTopBooks(5);
  for (let index = 0; index < books.length; index += 1) books[index].promo = await createDiscordPromo(books[index], index, message);
  await pending.edit(recommendationPayload(books));
}

async function createLinkForRequest(message, query) {
  const found = linkBook(query);
  if (!found.book || found.confidence < 45) {
    const text = 'I need the exact book title before creating a Discord code and link. Example: `Forbidden Bond link`.';
    try { await message.reply({ content: text }); } catch { await message.author.send({ content: text }).catch(() => {}); }
    return;
  }
  let pending;
  try { pending = await message.reply({ content: `Creating a verified Discord code and short link for **${found.book.title}**...` }); }
  catch { try { pending = await message.author.send({ content: `Creating a verified Discord code and short link for **${found.book.title}**...` }); } catch { return; } }
  const promo = await createDiscordPromo(found.book, 0, message);
  if (promo.status === 'ready') {
    await pending.edit({ embeds: [{ title: `Attribution ready | ${found.book.title}`, description: `**Code:** \`${promo.code}\`\n[Open book](${promo.shortUrl})\n\nThis link is attributed to Discord.`, color: 0x238636, footer: { text: 'Verified against NovelFlow attribution records.' } }] });
  } else {
    await pending.edit({ content: `I found **${found.book.title}** (${found.confidence}% match), but I could not create a verified link yet.\n**Reason:** ${promo.reason || promo.status}` });
  }
}

async function search(message, query) {
  let pending;
  try { pending = await message.reply({ content: 'Searching NovelFlow catalog and rankings...' }); }
  catch (error) {
    console.error('Discord reply permission error:', String(error?.message || error));
    try {
      pending = await message.author.send({ content: `I received your book request in **#${message.channel?.name || 'the channel'}**, but I cannot post there. I will send the result here instead.\n\nSearching NovelFlow catalog and rankings...` });
    } catch (dmError) {
      console.error('Discord DM permission error:', String(dmError?.message || dmError));
      return;
    }
  }
  try {
    // The desktop Gateway has the approved NovelFlow credentials locally. Use
    // that path first so a Vercel secret rotation cannot break Discord replies.
    const redis = getRedis();
    if (redis) {
      const result = await matchBooks(redis, query, { language: 'EN' });
      await pending.edit(resultEmbed(result));
      return;
    }
    const result = localSearch(query);
    await pending.edit(resultEmbed(result));
    return;
    const response = await fetch(searchUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gatewaySecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId: message.guildId || '', query, language: 'EN' })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Search failed with HTTP ${response.status}`);
    await pending.edit(resultEmbed(body.result));
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
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.guildId && allowedGuilds.size && !allowedGuilds.has(String(message.guildId))) return;
  const query = queryFromMessage(message);
  if (!query) return;
  if (recommendationIntent(query)) {
    await recommend(message);
    return;
  }
  if (linkIntent(query)) {
    await createLinkForRequest(message, query);
    return;
  }
  if (query.length < 4) {
    await message.reply({ content: 'Tell me a book title, an excerpt, or say `recommend today top 5`.' }).catch(() => {});
    return;
  }
  await search(message, query);
});

client.on(Events.Error, (error) => console.error('Discord Gateway error:', String(error?.message || error)));
process.on('unhandledRejection', (error) => console.error('Unhandled Gateway rejection:', String(error?.message || error)));

client.login(token);
