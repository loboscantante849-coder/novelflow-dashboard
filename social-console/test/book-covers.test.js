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
