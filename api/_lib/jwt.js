/**
 * Shared JWT utilities
 * Uses JWT_SECRET env var. In production, MUST be set.
 * In development, falls back to a default (not secure for production).
 */
const crypto = require('crypto');

// For production: JWT_SECRET MUST be set via env var
// For dev: fallback is provided but NOT secure
const JWT_SECRET = process.env.JWT_SECRET;

function getSecret() {
  if (!JWT_SECRET) {
    if (process.env.VERCEL === '1') {
      // Running on Vercel production without JWT_SECRET - log warning but continue
      // This prevents complete lockout; set JWT_SECRET ASAP
      console.error('⚠️ JWT_SECRET not set in production! JWT tokens are insecure.');
    }
    return 'nf-dev-secret-not-for-production-use';
  }
  return JWT_SECRET;
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
