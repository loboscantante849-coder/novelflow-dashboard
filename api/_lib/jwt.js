/**
 * Shared JWT utilities
 * Uses JWT_SECRET env var. MUST be set in production; throws if missing.
 * No dev fallback — no secret = no tokens accepted/issued.
 */
const crypto = require('crypto');

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not configured');
  }
  return secret;
}

function createJWT(payload) {
  const secret = getSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyJWT(token) {
  try {
    const secret = getSecret();
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [encodedHeader, encodedPayload, signature] = parts;
    
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    
    if (signature !== expectedSignature) return null;
    
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
    
    // Check expiration (30 days max)
    const maxAge = 2592000;
    if (payload.iat && (Date.now() / 1000 - payload.iat) > maxAge) {
      return null;
    }
    
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = { createJWT, verifyJWT, getSecret };
