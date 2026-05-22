const { setCORSHeaders } = require('../../_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  // Clear all auth cookies
  res.setHeader('Set-Cookie', [
    'nf_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    'nf_user=; Path=/; Max-Age=0'
  ]);

  // Redirect to app
  return res.redirect('/app.html');
};
