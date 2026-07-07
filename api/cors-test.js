export const config = {
  api: {
    bodyParser: false,
  },
};

module.exports = (req, res) => {
  // Write all headers in ONE call to writeHead to override everything
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://test.example',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify({ ok: true, origin: req.headers.origin || '(none)' }));
};
