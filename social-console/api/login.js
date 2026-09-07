const crypto = require('crypto');
const { createSession, safeEqual, openAccess, localOpenAccess } = require('./_lib/auth');
const { getRedis } = require('./_lib/store');
const { consumeRateLimit, requestIdentity } = require('./_lib/rate-limit');

module.exports = async (req, res) => {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'nf_social_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (localOpenAccess(req) || openAccess()) {
    const session = createSession();
    res.setHeader('Set-Cookie', `nf_social_session=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
    return res.status(200).json({ ok: true, authentication: 'open-bound' });
  }
  const password = String(process.env.SOCIAL_CONSOLE_PASSWORD || '');
  const secret = String(process.env.SOCIAL_CONSOLE_SESSION_SECRET || '');
  if (!password || secret.length < 32) return res.status(503).json({ error: 'Console authentication is not configured' });
  const redis = getRedis();
  const rate = await consumeRateLimit(redis, 'login', requestIdentity(req), 8, 15 * 60);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!safeEqual(crypto.createHash('sha256').update(supplied).digest('hex'), crypto.createHash('sha256').update(password).digest('hex'))) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  const session = createSession();
  res.setHeader('Set-Cookie', `nf_social_session=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
  return res.status(200).json({ ok: true });
};
