module.exports = async (req, res) => {
  // Clear auth cookies
  res.setHeader('Set-Cookie', [
    'nf_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    'nf_user=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  ]);

  // Redirect to app
  return res.redirect('/app.html');
};
