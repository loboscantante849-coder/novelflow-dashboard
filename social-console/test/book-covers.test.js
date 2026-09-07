const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCoverBooks, coverErrorKind } = require('../api/book-covers');

test('cover lookup separates missing covers from provider failures', async () => {
  const resolved = await resolveCoverBooks([
    { sku: 'ready', title: 'Ready Book' },
    { sku: 'missing', title: 'Missing Book' },
    { sku: 'failed', title: 'Failed Book' }
  ], null, async (title) => {
    if (title === 'Missing Book') return { cover: '' };
    if (title === 'Failed Book') throw Object.assign(new Error('content dashboard unavailable'), { status: 503 });
    return { cover: 'https://oss.novelago.app/prod/cover.jpg' };
  });

  assert.deepEqual(resolved.map((item) => [item.sku, item.state]), [
    ['ready', 'ready'], ['missing', 'missing'], ['failed', 'failed']
  ]);
  assert.equal(resolved[2].kind, 'upstream_5xx');
});

test('cover error kinds remain safe and non-sensitive', () => {
  assert.equal(coverErrorKind(Object.assign(new Error('invalid_grant'), { status: 400 })), 'auth');
  assert.equal(coverErrorKind(Object.assign(new Error('request timed out'), { status: 504 })), 'timeout');
  assert.equal(coverErrorKind(Object.assign(new Error('boom'), { status: 500 })), 'upstream_5xx');
});

test('cover cache and exact lookup are isolated by target application', async () => {
  const values = new Map();
  const redis = {
    async get(key) { return values.get(key) || null; },
    async set(key, value) { values.set(key, value); return 'OK'; }
  };
  const calls = [];
  const lookup = async (_title, _sku, options) => {
    calls.push(options.applicationId);
    return { cover: `https://cdn.example/${options.applicationId}.jpg` };
  };
  await resolveCoverBooks([{ sku: 'shared-sku', title: 'Shared Title' }], redis, lookup, { appKey: 'novelflow', applicationId: 'nf-app' });
  await resolveCoverBooks([{ sku: 'shared-sku', title: 'Shared Title' }], redis, lookup, { appKey: 'maxnovel', applicationId: 'max-app' });
  await resolveCoverBooks([{ sku: 'shared-sku', title: 'Shared Title' }], redis, lookup, { appKey: 'maxnovel', applicationId: 'max-app' });
  assert.deepEqual(calls, ['nf-app', 'max-app']);
  assert.ok(values.has('nf_social:book_cover:novelflow:shared-sku'));
  assert.ok(values.has('nf_social:book_cover:maxnovel:shared-sku'));
});
