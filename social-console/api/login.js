module.exports = async (req, res) => {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'nf_social_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(200).json({ ok: true, authentication: 'open' });
};
