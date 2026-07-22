/* Register the NovelFlow commands using environment variables only.
 * Usage: node scripts/register-discord.js
 */
const applicationId = String(process.env.DISCORD_APPLICATION_ID || '').trim();
const botToken = String(process.env.DISCORD_BOT_TOKEN || '').replace(/^Bearer\s+/i, '').trim();
const guildId = String(process.env.DISCORD_GUILD_ID || '').trim();
if (!applicationId || !botToken) throw new Error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required');
const endpoint = guildId
  ? `https://discord.com/api/v10/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`
  : `https://discord.com/api/v10/applications/${encodeURIComponent(applicationId)}/commands`;
const commands = [
  {
    name: 'find-book', description: 'Find a NovelFlow book from an excerpt or screenshot',
    options: [
      { name: 'text', description: 'Novel excerpt, title, character, or plot clue', type: 3, required: false },
      { name: 'image', description: 'Novel screenshot attachment', type: 11, required: false },
      { name: 'language', description: 'Bookstore language', type: 3, required: false, choices: [{ name: 'English', value: 'EN' }, { name: 'Spanish', value: 'ES' }] }
    ]
  },
  { name: 'book-help', description: 'Learn how NovelFlow book search and attribution work' },
  { name: 'Find NovelFlow book', type: 3 }
];
fetch(endpoint, { method: 'PUT', headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) })
  .then(async (response) => { const body = await response.text(); if (!response.ok) throw new Error(`Discord command registration failed with HTTP ${response.status}`); process.stdout.write(`Registered ${JSON.parse(body).length} NovelFlow command(s).\n`); })
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
