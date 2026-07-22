const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');

const cleanMessages = (value) => Array.isArray(value) ? value.slice(-14).map((item) => ({
  role: ['user', 'assistant', 'tool'].includes(item?.role) ? item.role : 'user',
  content: String(item?.content || '').slice(0, 4000),
  toolCalls: Array.isArray(item?.toolCalls) ? item.toolCalls.slice(0, 3) : undefined,
  toolCallId: String(item?.toolCallId || '').slice(0, 160)
})) : [];

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const messages = cleanMessages(req.body?.messages);
    if (!messages.length) return res.status(400).json({ error: 'A message is required' });
    const result = await providers.copilotReply(messages, req.body?.context || {}, String(req.body?.modelChoice || 'hy3'));
    return res.status(200).json(result);
  } catch (error) {
    console.error('[social/copilot]', error);
    return res.status(error?.status || 500).json({ error: String(error?.message || 'Whale is temporarily unavailable') });
  }
};
