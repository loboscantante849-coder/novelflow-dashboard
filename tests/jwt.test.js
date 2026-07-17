const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');

process.env.JWT_SECRET = 'unit-test-secret-that-is-not-used-in-production';

const auth = require('../api/_lib/auth');
const legacyEntryPoint = require('../api/_lib/jwt');

function signRaw(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

test('both JWT entry points enforce the access-token expiry', () => {
  const expired = signRaw({ username: 'test-user', iat: 1, exp: 2 });
  assert.equal(auth.verifyJWT(expired), null);
  assert.equal(legacyEntryPoint.verifyJWT(expired), null);
});

test('accepts a valid signed access token', () => {
  const token = auth.signAccessToken({ username: 'test-user' });
  assert.equal(auth.verifyJWT(token).username, 'test-user');
  assert.equal(legacyEntryPoint.verifyJWT(token).username, 'test-user');
});

test('rejects tokens without expiry or a bounded legacy issued-at time', () => {
  assert.equal(auth.verifyJWT(signRaw({ username: 'test-user' })), null);
});
