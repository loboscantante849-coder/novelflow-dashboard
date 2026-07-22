const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyDiscordRequest, newSearchJob, searchPayload, helpResponse } = require('../api/_lib/discord');
const { discordJobSummary } = require('../api/_lib/store');

function publicHex(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

test('verifies Discord Ed25519 signatures and rejects altered payloads', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from('{"type":1}');
  const timestamp = '1700000000';
  const signature = crypto.sign(null, Buffer.concat([Buffer.from(timestamp), raw]), pair.privateKey).toString('hex');
  const key = publicHex(pair.publicKey);
  assert.equal(verifyDiscordRequest(raw, signature, timestamp, key), true);
  assert.equal(verifyDiscordRequest(Buffer.from('{"type":2}'), signature, timestamp, key), false);
});

test('builds a search job from text and a Discord image attachment', () => {
  const job = newSearchJob({
    id: '123456789012345678', application_id: 'app', token: 'token', guild_id: 'guild', channel_id: 'channel',
    user: { id: 'user', username: 'reader' },
    data: { options: [{ name: 'text', value: 'secret marriage and a hidden heir' }, { name: 'image', value: 'att-1', type: 11 }], resolved: { attachments: { 'att-1': { id: 'att-1', url: 'https://cdn.discordapp.com/a.png', filename: 'a.png', content_type: 'image/png' } } } }
  });
  assert.equal(job.input.text, 'secret marriage and a hidden heir');
  assert.equal(job.input.attachments.length, 1);
  assert.equal(job.input.attachments[0].contentType, 'image/png');
});

test('builds a search job from a selected Discord message and its screenshot', () => {
  const job = newSearchJob({
    id: '223456789012345678', application_id: 'app', token: 'token', guild_id: 'guild', channel_id: 'channel',
    member: { user: { id: 'user', username: 'reader' } },
    data: { type: 3, target_id: 'message-1', resolved: { messages: { 'message-1': { content: 'Who said this quote?', attachments: [{ id: 'att-2', url: 'https://media.discordapp.net/b.png', filename: 'b.png', content_type: 'image/png' }] } } } }
  });
  assert.equal(job.input.source, 'message_context');
  assert.equal(job.input.text, 'Who said this quote?');
  assert.equal(job.input.attachments.length, 1);
});

test('help response explains commands without creating a search job', () => {
  const response = helpResponse();
  assert.equal(response.type, 4);
  assert.match(response.data.content, /find-book/);
  assert.equal(response.data.flags, 64);
});

test('search payload exposes candidate confirmation controls', () => {
  const payload = searchPayload({ catalog: { sources: ['bookstore_uv'] }, matches: [{ bookSkuId: 'sku-1', title: 'The Crown', confidence: 91, confidenceLabel: 'high', reasons: ['Exact title phrase'], sources: ['bookstore_uv'] }], recommendations: [] }, { id: 'discord_123456789012345678' });
  assert.match(payload.content, /system matching score/i);
  assert.equal(payload.components[0].components[0].custom_id, 'nf_select:discord_123456789012345678:sku-1');
});

test('operator summaries exclude private Discord tokens and raw reader content', () => {
  const summary = discordJobSummary({
    id: 'discord_123456789012345678', kind: 'search', state: 'completed', phase: 'results_ready', createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:01:00.000Z',
    interaction: { applicationId: 'app', token: 'sensitive-interaction-token' }, guildId: 'guild', channelId: 'channel', user: { id: 'user', username: 'reader' },
    input: { source: 'slash_command', text: 'private novel excerpt', attachments: [{ id: 'image' }], ocr: [{ filename: 'page.png', text: 'private OCR text', quality: 'high' }] },
    result: { matches: [{ bookSkuId: 'sku-1', title: 'The Crown', confidence: 91, confidenceLabel: 'high', sources: ['bookstore_uv'] }], catalog: { sources: ['bookstore_uv'] } }
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /sensitive-interaction-token|private novel excerpt|private OCR text/);
  assert.equal(summary.result.matches[0].title, 'The Crown');
  assert.equal(summary.input.ocr[0].quality, 'high');
});
