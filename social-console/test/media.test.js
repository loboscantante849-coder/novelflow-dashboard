const test = require('node:test');
const assert = require('node:assert/strict');

test('allowed image media is redirected without buffering through Vercel', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('media proxy must not buffer the remote image'); };
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

  assert.equal(result.statusCode, 307);
  assert.equal(result.location, 'https://assets.laoye.chat/gallery/poster.jpg');
  assert.equal(result.body, null);
});
