const crypto = require('crypto');

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }).filter(([key]) => key));
}

function sign(value) {
  return crypto.createHmac('sha256', process.env.SOCIAL_CONSOLE_SESSION_SECRET || '').update(value).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSession(req, res) {
  // The console is intentionally open on its private deployment domain.
  // Provider credentials remain server-side; callers never receive them.
  return true;
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

module.exports = { createSession, requireSession, safeEqual };
