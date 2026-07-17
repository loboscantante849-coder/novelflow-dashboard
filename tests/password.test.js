const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPasswordHash,
  legacyPasswordHash,
  verifyPassword,
} = require('../api/_lib/password');

test('creates and verifies a versioned scrypt hash', async () => {
  const stored = await createPasswordHash('correct-horse-7');
  assert.match(stored, /^scrypt\$/);
  assert.deepEqual(await verifyPassword('correct-horse-7', stored), {
    valid: true,
    needsRehash: false,
  });
  assert.equal((await verifyPassword('wrong-password-7', stored)).valid, false);
});

test('accepts legacy hashes and marks them for transparent migration', async () => {
  const stored = legacyPasswordHash('legacy-pass-8');
  assert.deepEqual(await verifyPassword('legacy-pass-8', stored), {
    valid: true,
    needsRehash: true,
  });
  assert.equal((await verifyPassword('wrong-pass-8', stored)).valid, false);
});

test('rejects malformed hashes', async () => {
  assert.deepEqual(await verifyPassword('anything-1', 'not-a-hash'), {
    valid: false,
    needsRehash: false,
  });
});
