module.exports = async (req, res) => {
  // 不调用任何cors helper，也不设任何CORS头
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send('pong');
};
