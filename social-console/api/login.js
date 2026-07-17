const { createSession, safeEqual } = require('./_lib/auth');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SOCIAL_CONSOLE_PASSWORD || !process.env.SOCIAL_CONSOLE_SESSION_SECRET) return res.status(503).json({ error: 'Console authentication is not configured' });
  if (!safeEqual(req.body?.password, process.env.SOCIAL_CONSOLE_PASSWORD)) return res.status(401).json({ error: 'Invalid password' });
  res.setHeader('Set-Cookie', `nf_social_session=${createSession()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
  return res.status(200).json({ ok: true });
};
