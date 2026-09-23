const assert = require('node:assert/strict');
const test = require('node:test');

const { isVideoGenerationEnabled, parseFeatureFlagValue } = require('../api/_lib/feature-flags');

function redisWith(value, { throwOnGet = false } = {}) {
  return {
    async get() {
      if (throwOnGet) throw new Error('redis offline');
      return value;
    },
  };
}

test('video generation is enabled by default', async () => {
  delete process.env.VIDEO_GENERATION_ENABLED;
  assert.equal(await isVideoGenerationEnabled(redisWith(null)), true);
  assert.equal(await isVideoGenerationEnabled(null), true);
});

test('the redis switch pauses and resumes video generation', async () => {
  delete process.env.VIDEO_GENERATION_ENABLED;
  assert.equal(await isVideoGenerationEnabled(redisWith('off')), false);
  assert.equal(await isVideoGenerationEnabled(redisWith('paused')), false);
  assert.equal(await isVideoGenerationEnabled(redisWith('on')), true);
});

test('the environment override wins over redis and survives a redis outage', async () => {
  process.env.VIDEO_GENERATION_ENABLED = 'false';
  try {
    assert.equal(await isVideoGenerationEnabled(redisWith('on')), false);
    assert.equal(await isVideoGenerationEnabled(redisWith(null, { throwOnGet: true })), false);
  } finally {
    delete process.env.VIDEO_GENERATION_ENABLED;
  }
});

test('an unreadable switch keeps the feature on instead of blocking it', async () => {
  delete process.env.VIDEO_GENERATION_ENABLED;
  assert.equal(await isVideoGenerationEnabled(redisWith(null, { throwOnGet: true })), true);
});

test('flag values parse the same way the admin endpoint stores them', () => {
  assert.equal(parseFeatureFlagValue('on'), true);
  assert.equal(parseFeatureFlagValue('off'), false);
  assert.equal(parseFeatureFlagValue(''), null);
});
