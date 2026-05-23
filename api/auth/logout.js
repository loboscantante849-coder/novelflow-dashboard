const { setCORSHeaders } = require('../_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Clear all auth cookies
  res.setHeader('Set-Cookie', [
    'nf_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    'nf_user=; Path=/; Max-Age=0'
  ]);

  // Redirect to app
  return res.redirect('/app-v2');
};
