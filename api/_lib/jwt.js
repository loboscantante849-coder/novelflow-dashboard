/**
 * Shared JWT utilities
 * Uses JWT_SECRET env var. MUST be set in production; throws if missing.
 * No dev fallback — no secret = no tokens accepted/issued.
 */
const { signAccessToken, verifyJWT } = require('./auth');

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not configured');
  }
  return secret;
}

function createJWT(payload) {
  return signAccessToken(payload);
}

module.exports = { createJWT, verifyJWT, getSecret };
