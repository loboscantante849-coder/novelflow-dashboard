const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');

process.env.JWT_SECRET = 'unit-test-secret-that-is-not-used-in-production';

const auth = require('../api/_lib/auth');
const legacyEntryPoint = require('../api/_lib/jwt');

function signRaw(payload, secret = process.env.JWT_SECRET) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret)
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

test('accepts previous-secret tokens while signing new tokens with the current secret', () => {
  const previousSecret = 'previous-unit-test-secret-not-used-in-production';
  process.env.JWT_SECRET_PREVIOUS = previousSecret;
  try {
    const now = Math.floor(Date.now() / 1000);
    const previousToken = signRaw({ username: 'migrating-user', iat: now, exp: now + 60 }, previousSecret);
    assert.equal(auth.verifyJWT(previousToken).username, 'migrating-user');
    assert.equal(legacyEntryPoint.verifyJWT(previousToken).username, 'migrating-user');

    const newToken = auth.signAccessToken({ username: 'migrating-user' });
    assert.notEqual(newToken, signRaw(auth.verifyJWT(newToken), previousSecret));
    assert.equal(auth.verifyJWT(newToken).username, 'migrating-user');
  } finally {
    delete process.env.JWT_SECRET_PREVIOUS;
  }
});

test('rejects previous-secret tokens after the migration secret is removed', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRaw(
    { username: 'expired-migration', iat: now, exp: now + 60 },
    'removed-previous-secret',
  );
  assert.equal(auth.verifyJWT(token), null);
});
