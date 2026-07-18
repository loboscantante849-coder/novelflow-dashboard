const { createSession, safeEqual } = require('./_lib/auth');
module.exports = async (req, res) => {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'nf_social_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SOCIAL_CONSOLE_PASSWORD || !process.env.SOCIAL_CONSOLE_SESSION_SECRET) return res.status(503).json({ error: 'Console authentication is not configured' });
  if (!safeEqual(req.body?.password, process.env.SOCIAL_CONSOLE_PASSWORD)) return res.status(401).json({ error: 'Invalid password' });
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const secure = !local && (process.env.VERCEL || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https');
  res.setHeader('Set-Cookie', `nf_social_session=${createSession()}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Max-Age=43200`);
  return res.status(200).json({ ok: true });
};
