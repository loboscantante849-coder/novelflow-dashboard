module.exports = async (req, res) => {
  // Test: explicitly set a bogus origin
  res.setHeader('Access-Control-Allow-Origin', 'https://test.example');
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send('pong');
};
