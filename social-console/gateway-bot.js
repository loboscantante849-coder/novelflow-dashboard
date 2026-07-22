const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getRedis } = require('./api/_lib/store');
const { matchBooks } = require('./api/_lib/book-matcher');
const { normalize, lexicalScore } = require('./api/_lib/book-matcher');

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
  await search(message, query);
});

client.on(Events.Error, (error) => console.error('Discord Gateway error:', String(error?.message || error)));
process.on('unhandledRejection', (error) => console.error('Unhandled Gateway rejection:', String(error?.message || error)));

client.login(token);
