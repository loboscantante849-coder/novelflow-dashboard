module.exports = (req, res) => {
  res.writeHead(200, {'Content-Type': 'application/json'});
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k] = v;
  }
  res.end(JSON.stringify(out, null, 2));
};
