const crypto = require('crypto');

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }).filter(([key]) => key));
}

function sign(value) {
  const secret = String(process.env.SOCIAL_CONSOLE_SESSION_SECRET || '');
  if (secret.length < 32) throw new Error('SOCIAL_CONSOLE_SESSION_SECRET must contain at least 32 characters');
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

// Signed internal receipts use the same server-only secret as the session,
// but are purpose-separated. A receipt signature therefore cannot be replayed
// as an `nf_social_session` cookie.
function scopedToken(scope, claims) {
  const safeScope = String(scope || '').trim();
  if (!/^[a-z0-9_-]{3,64}$/i.test(safeScope)) throw new Error('Invalid token scope');
  const payload = Buffer.from(JSON.stringify(claims || {})).toString('base64url');
  return `${payload}.${sign(`scope:${safeScope}:${payload}`)}`;
}

function readScopedToken(scope, token) {
  const safeScope = String(scope || '').trim();
  const [payload, signature, ...extra] = String(token || '').split('.');
  if (!payload || !signature || extra.length || !/^[a-z0-9_-]{3,64}$/i.test(safeScope)) return null;
  try {
    if (!safeEqual(signature, sign(`scope:${safeScope}:${payload}`))) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function openAccess() {
  return String(process.env.SOCIAL_CONSOLE_OPEN_ACCESS || '').toLowerCase() === 'true';
}

function requestAuthority(req) {
  return String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim().toLowerCase();
}

function requestHost(req) {
  const authority = requestAuthority(req);
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    return closingBracket > 0 ? authority.slice(1, closingBracket) : '';
  }
  return authority.split(':')[0];
}

function localOpenAccess(req) {
  const host = requestHost(req);
  const remoteAddress = String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '').toLowerCase();
  const loopbackHost = ['localhost', '127.0.0.1', '::1'].includes(host);
  const loopbackAddress = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress);
  return loopbackHost && loopbackAddress;
}

function requireSameOrigin(req, res) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return true;
  const origin = String(req.headers?.origin || '');
  if (!origin) return true;
  let valid = false;
  try { valid = Boolean(requestAuthority(req)) && new URL(origin).host.toLowerCase() === requestAuthority(req); } catch { valid = false; }
  if (valid) return true;
  res.status(403).json({ error: 'Cross-origin request rejected' });
  return false;
}

function requireSession(req, res) {
  if (localOpenAccess(req) || openAccess()) return requireSameOrigin(req, res);
  let token;
  try { token = cookies(req).nf_social_session; } catch { token = ''; }
  const [payload, signature, ...extra] = String(token || '').split('.');
  let valid = Boolean(payload && signature && !extra.length);
  try {
    valid = valid && safeEqual(signature, sign(payload));
    const session = valid ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) : null;
    valid = Boolean(session && Number(session.exp) > Date.now());
  } catch { valid = false; }
  if (!valid) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  return requireSameOrigin(req, res);
}

// Open-access is useful for a private local preview, but it must never turn a
// browser page into an unauthenticated paid-provider client. Mutation routes
// therefore require a separate operator token whenever session login is off.
function requireOperatorMutation(req, res) {
  if (!requireSession(req, res)) return false;
  if (!openAccess()) return true;
  const expected = [process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN, process.env.NOVELFLOW_OPERATOR_TOKEN]
    .map((value) => String(value || ''))
    .filter((value) => value.length >= 32);
  const supplied = String(req.headers?.['x-social-operator-token'] || req.headers?.['x-nf-operator-token'] || '');
  if (expected.some((value) => safeEqual(supplied, value))) return true;
  res.status(401).json({ error: 'Operator mutation authorization required' });
  return false;
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

module.exports = { createSession, requireSession, requireOperatorMutation, scopedToken, readScopedToken, safeEqual, openAccess, localOpenAccess };
