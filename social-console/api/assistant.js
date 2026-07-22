const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const mode = ['books', 'assets', 'operations'].includes(req.body?.mode) ? req.body.mode : 'operations';
  const modelChoice = String(req.body?.modelChoice || 'hy3');
  const snapshot = req.body?.snapshot && typeof req.body.snapshot === 'object' ? req.body.snapshot : {};
  try {
    const result = await providers.analyzeOperations(snapshot, mode, modelChoice);
    return res.status(200).json({ analysis: result.analysis, usage: { model: result.model, fallbackFrom: result.fallbackFrom || '', fallbackReason: result.fallbackReason || '', ...result.usage } });
  } catch (error) {
    console.error('[social/assistant]', error);
    return res.status(error?.status || 500).json({ error: String(error?.message || 'Unable to analyze current operations') });
  }
};
