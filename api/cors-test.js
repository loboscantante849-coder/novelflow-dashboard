module.exports = (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://testfromcode.example',
  });
  res.end(JSON.stringify({ ok: true, origin: req.headers.origin || '(none)' }));
};
