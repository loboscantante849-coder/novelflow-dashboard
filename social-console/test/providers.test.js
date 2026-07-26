const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { modelTemperature, operationsTimeoutForModel } = providers;

test('Kimi K2.7 Code receives its provider-required temperature without changing other models', () => {
  assert.equal(modelTemperature('kimi-k2.7-code', 0.25), 1);
  assert.equal(modelTemperature('KIMI_K2.7_CODE', 0.55), 1);
  assert.equal(modelTemperature('hy3', 0.25), 0.25);
  assert.equal(modelTemperature('qwen3.7-max', 0.55), 0.55);
});

test('selected creative models receive enough time before transparent fallback', () => {
  assert.ok(operationsTimeoutForModel('kimi-k2.7-code') >= 18000);
  assert.ok(operationsTimeoutForModel('seed-2.1-turbo') >= 15000);
  assert.ok(operationsTimeoutForModel('minimax-m2.7') >= 15000);
  assert.ok(operationsTimeoutForModel('hy3') < operationsTimeoutForModel('deepseek'));
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
