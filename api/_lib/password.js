const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const LEGACY_PATTERN = /^[a-f0-9]{64}$/i;

function safeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function legacyPasswordHash(password) {
  return crypto.createHash('sha256').update(`nf_${password}_salt2026`).digest('hex');
}

async function derive(password, salt, options = {}) {
  const N = options.N || SCRYPT_N;
  const r = options.r || SCRYPT_R;
  const p = options.p || SCRYPT_P;
  return scrypt(password, salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
}

async function createPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') {
    return { valid: false, needsRehash: false };
  }

  if (LEGACY_PATTERN.test(storedHash)) {
    return {
      valid: safeEqual(legacyPasswordHash(password), storedHash.toLowerCase()),
      needsRehash: true,
    };
  }

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return { valid: false, needsRehash: false };
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return { valid: false, needsRehash: false };
  }

  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    if (salt.length < 16 || expected.length !== KEY_LENGTH) {
      return { valid: false, needsRehash: false };
    }
    const actual = await derive(password, salt, { N, r, p });
    return {
      valid: safeEqual(actual, expected),
      needsRehash: N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P,
    };
  } catch {
    return { valid: false, needsRehash: false };
  }
}

module.exports = {
  createPasswordHash,
  verifyPassword,
  legacyPasswordHash,
};
