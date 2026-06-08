module.exports = (req, res) => {
  const { setCORSHeaders } = require('./_lib/cors');
  setCORSHeaders(req, res);
  
  const envKeys = Object.keys(process.env).sort();
  const oidc_username = process.env.OIDC_USERNAME || 'NOT_SET';
  const oidc_password = process.env.OIDC_PASSWORD ? 'SET(' + process.env.OIDC_PASSWORD.length + 'chars)' : 'NOT_SET';
  const github_token = process.env.GITHUB_TOKEN ? 'SET(' + process.env.GITHUB_TOKEN.length + 'chars)' : 'NOT_SET';
  const novelspa_token = process.env.NOVELSPA_TOKEN ? 'SET(' + process.env.NOVELSPA_TOKEN.length + 'chars)' : 'NOT_SET';
  const bookstore_token = process.env.BOOKSTORE_TOKEN ? 'SET(' + process.env.BOOKSTORE_TOKEN.length + 'chars)' : 'NOT_SET';
  
  res.json({
    envKeys,
    oidc_username,
    oidc_password,
    github_token,
    novelspa_token,
    bookstore_token,
    totalEnvVars: envKeys.length
  });
};
