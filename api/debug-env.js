// Disabled: environment debug endpoint removed for security - v2.5.2-FIX-TEST-MARKER-20260709
module.exports = async (req, res) => {
  res.setHeader('X-Security-Fix', 'v2.5.2-applied');
  res.status(404).end();
};
