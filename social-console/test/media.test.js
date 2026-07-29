const test = require('node:test');
const assert = require('node:assert/strict');

test('allowed image media is proxied only when the upstream is a readable image', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
  const handler = require('../api/media');
  const result = { statusCode: 200, location: '', body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    setHeader(name, value) { if (String(name).toLowerCase() === 'location') result.location = value; },
    send(body) { result.body = body; return this; },
    json(body) { result.body = body; return this; },
    end() { return this; }
  };

  try {
    await handler({ method: 'GET', query: { url: 'https://assets.laoye.chat/gallery/poster.jpg' } }, res);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(result.statusCode, 200);
  assert.deepEqual([...result.body], [1, 2, 3]);
});
