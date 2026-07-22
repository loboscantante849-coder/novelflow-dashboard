const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');

const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
const gatewaySecret = String(process.env.DISCORD_GATEWAY_SECRET || process.env.CRON_SECRET || '').trim();
const searchUrl = String(process.env.DISCORD_GATEWAY_SEARCH_URL || 'https://social.novelflow.top/api/discord-gateway-search').trim();
const allowedGuilds = new Set(String(process.env.NOVELFLOW_DISCORD_ALLOWED_GUILD_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));

if (!token) throw new Error('DISCORD_BOT_TOKEN is required');
if (!gatewaySecret) throw new Error('DISCORD_GATEWAY_SECRET is required');

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

async function search(message, query) {
  const pending = await message.reply({ content: 'Searching NovelFlow catalog and rankings...' });
  try {
    const response = await fetch(searchUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gatewaySecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId: message.guildId || '', query, language: 'EN' })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Search failed with HTTP ${response.status}`);
    await pending.edit(resultEmbed(body.result));
  } catch (error) {
    await pending.edit({ content: `I could not search the NovelFlow catalog: ${String(error.message || error).slice(0, 300)}` });
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

client.login(token);
