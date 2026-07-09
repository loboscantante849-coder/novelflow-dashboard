// Disabled: OIDC init endpoint removed for security (was anonymous-writable)
module.exports = async (req, res) => {
  res.status(404).end();
};
