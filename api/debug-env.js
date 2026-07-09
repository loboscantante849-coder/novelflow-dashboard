// Disabled: environment debug endpoint removed for security
module.exports = async (req, res) => {
  res.status(404).end();
};
