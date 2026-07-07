module.exports = async (req, res) => {
  const origin = req.headers.origin || '(none)';
  const { getAllowedOrigin } = require('./_lib/cors');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    receivedOrigin: origin,
    allowedOrigin: getAllowedOrigin(req),
    allHeaders: JSON.stringify(req.headers, null, 2).slice(0, 2000)
  });
};
