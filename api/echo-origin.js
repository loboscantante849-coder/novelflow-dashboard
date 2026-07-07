module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  // Don't use cors helper - just dump what we see
  res.end(JSON.stringify({
    origin: req.headers.origin || '(none)',
    host: req.headers.host,
    referer: req.headers.referer || '(none)',
    method: req.method,
    'x-forwarded-host': req.headers['x-forwarded-host'],
    'cf-worker': req.headers['cf-worker'],
  }));
};
