const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { modelTemperature, operationsTimeoutForModel, parseModelJson, extractModelText } = providers;

test('Kimi K2.7 Code receives its provider-required temperature without changing other models', () => {
  assert.equal(modelTemperature('kimi-k2.7-code', 0.25), 1);
  assert.equal(modelTemperature('KIMI_K2.7_CODE', 0.55), 1);
  assert.equal(modelTemperature('hy3', 0.25), 0.25);
  assert.equal(modelTemperature('qwen3.7-max', 0.55), 0.55);
});

test('creative JSON parser repairs common provider formatting without another model call', () => {
  const parsed = parseModelJson('```json\n{"content":"line one\nline two", "tags":["a","b",],}\n```', 'test-model');
  assert.equal(parsed.content, 'line one\nline two');
  assert.deepEqual(parsed.tags, ['a', 'b']);
});

test('structured provider objects remain valid model output instead of becoming empty text', () => {
  const content = { videoPrompt: { hook: 'A source-grounded disruption' } };
  assert.equal(extractModelText({ choices: [{ message: { content } }] }), JSON.stringify(content));
  assert.deepEqual(parseModelJson(JSON.stringify(JSON.stringify(content))), content);
});

test('selected non-HY models receive a real completion window before fallback', () => {
  assert.ok(operationsTimeoutForModel('seed-2.1-turbo') >= 120000);
  assert.ok(operationsTimeoutForModel('deepseek') >= 120000);
  assert.ok(operationsTimeoutForModel('qwen3.7-max') >= 120000);
  assert.ok(operationsTimeoutForModel('minimax-m2.7') >= 120000);
  assert.ok(operationsTimeoutForModel('kimi-k2.7-code') >= 120000);
  assert.ok(operationsTimeoutForModel('hy3') < operationsTimeoutForModel('seed-2.1-turbo'));
});

test('a paid image success response with invalid JSON is ambiguous', async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NOVELFLOW_IMAGE_API_KEY;
  const originalBase = process.env.NOVELFLOW_IMAGE_BASE_URL;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NOVELFLOW_IMAGE_API_KEY;
    else process.env.NOVELFLOW_IMAGE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.NOVELFLOW_IMAGE_BASE_URL;
    else process.env.NOVELFLOW_IMAGE_BASE_URL = originalBase;
  });
  process.env.NOVELFLOW_IMAGE_API_KEY = 'test-only-key';
  process.env.NOVELFLOW_IMAGE_BASE_URL = 'https://images.invalid.test';
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{invalid-json' });

  await assert.rejects(
    providers.submitImage({ variant: 'luminous_cinema', prompt: 'A safe source-grounded poster prompt', idempotencyKey: 'test-idempotency-key' }),
    (error) => error instanceof providers.ProviderError && error.ambiguous === true
  );
});
