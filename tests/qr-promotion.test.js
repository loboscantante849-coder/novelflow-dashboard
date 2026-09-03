const assert = require('node:assert/strict');
const test = require('node:test');
const { installFakeUpstash, invoke } = require('./helpers/endpoint');

const FakeRedis = installFakeUpstash();
process.env.JWT_SECRET = 'qr-promotion-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

const qrPromotion = require('../api/qr-promotion');
const qrRedirect = require('../api/qr/[token]');
const { signAccessToken } = require('../api/_lib/auth');

function request(method, token, body = {}) {
  return {
    method, headers: { authorization: `Bearer ${token}`, host: 'novelflow.top' },
    body, query: body,
  };
}

function seedPromotion() {
  FakeRedis.reset({
    'nf_user_subs:alice': new Set(['1000']),
    nf_subs: {
      1000: JSON.stringify({
        code: '1000', discordUsername: 'alice', bookId: 'book-1',
        matchedBookName: 'Safe Book', link: 'https://social.example/s/safe-book',
      }),
    },
  });
}

test('QR promotion card is only created for a server-owned promotion and returns a self-hosted QR bitmap', async () => {
  seedPromotion();
  const token = signAccessToken({ username: 'alice' });
  const result = await invoke(qrPromotion, request('POST', token, { code: '1000' }));
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.success, true);
  assert.match(result.body.url, /^https:\/\/novelflow\.top\/api\/qr\/[A-Za-z0-9_-]{20,80}$/);
  assert.match(result.body.qrDataUrl, /^data:image\/png;base64,/);
  const stored = JSON.parse(FakeRedis.values.get('nf_qr_token:' + result.body.token));
  assert.equal(stored.destination, 'https://social.example/s/safe-book');
  assert.equal(stored.owner, 'alice');
  assert.equal(FakeRedis.expiries.get('nf_qr_token:' + result.body.token), 180 * 86400);
});

test('QR promotion rejects another account and never trusts a supplied redirect URL', async () => {
  seedPromotion();
  const token = signAccessToken({ username: 'mallory' });
  const result = await invoke(qrPromotion, request('POST', token, { code: '1000', destination: 'https://evil.example' }));
  assert.equal(result.statusCode, 404);
  assert.equal(Array.from(FakeRedis.values.keys()).some(key => String(key).startsWith('nf_qr_token:')), false);
});

test('a QR scan increments a counter then performs a temporary redirect without exposing the record', async () => {
  seedPromotion();
  const token = signAccessToken({ username: 'alice' });
  const asset = await invoke(qrPromotion, request('POST', token, { code: '1000' }));
  const result = await new Promise(resolve => {
    const res = {
      statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; }, end() { resolve(this); return this; },
      send(value) { this.sent = value; resolve(this); return this; },
      redirect(code, destination) { this.statusCode = code; this.destination = destination; resolve(this); return this; },
    };
    qrRedirect({ method: 'GET', query: { token: asset.body.token }, headers: {} }, res);
  });
  assert.equal(result.statusCode, 302);
  assert.equal(result.destination, 'https://social.example/s/safe-book');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(FakeRedis.values.get('nf_qr_token:' + asset.body.token + ':scans'), 1);
  assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
});
