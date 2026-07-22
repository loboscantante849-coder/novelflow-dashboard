const { requireSession } = require('./_lib/auth');
const { getRedis, getCreativePlan, listCreativePlanSummaries, newCreativePlan, saveCreativePlan } = require('./_lib/store');

const MODEL_CHOICES = new Set(['deepseek', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'hy3', 'kimi-k2.7-code', 'qwen3.5-flash', 'glm-4.5-air', 'kimi-k2.5', 'minimax-m2.5', 'glm-5.2', 'kimi-k3', 'minimax-m3']);
const text = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
const requestKey = (id) => `nf_social:plan_request:${id}`;

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  try {
    if (req.method === 'GET') {
      const id = text(req.query?.id, 100);
      const requestId = text(req.query?.requestId, 100);
      if (requestId) {
        const jobId = await redis.get(requestKey(requestId));
        const job = jobId ? await getCreativePlan(redis, String(jobId)) : null;
        return res.status(job ? 200 : 202).json({ job, pending: Boolean(jobId && !job) });
      }
      if (id) {
        const job = await getCreativePlan(redis, id);
        return job ? res.status(200).json({ job }) : res.status(404).json({ error: 'Planning task not found' });
      }
      return res.status(200).json({ jobs: await listCreativePlanSummaries(redis, 5) });
    }
    if (req.method === 'PATCH') {
      const id = text(req.body?.id, 100);
      const job = await getCreativePlan(redis, id);
      if (!job) return res.status(404).json({ error: 'Planning task not found' });
      if (req.body?.action !== 'retry') return res.status(400).json({ error: 'Unsupported planning action' });
      job.input.preferredModelChoice = job.input.preferredModelChoice || job.input.modelChoice || 'hy3';
      job.input.modelChoice = job.input.preferredModelChoice;
      job.input.fallbackUsed = false;
      job.state = 'running';
      job.stages.analysis = { ...job.stages.analysis, status: 'waiting', attempt: 0, nextAttemptAt: '', error: '', label: '已恢复后台策划，将先尝试首选模型' };
      job.events.push({ at: new Date().toISOString(), type: 'manual_retry_requested', message: 'Operator resumed the background planning task from saved evidence' });
      await saveCreativePlan(redis, job);
      return res.status(200).json({ job });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const title = text(req.body?.title, 200);
    const sku = text(req.body?.sku, 100);
    const requestId = text(req.body?.requestId, 100);
    const requestedModel = String(req.body?.modelChoice || 'hy3');
    const modelChoice = MODEL_CHOICES.has(requestedModel) ? requestedModel : 'hy3';
    if (!title) return res.status(400).json({ error: 'Exact book title is required' });
    if (requestId) {
      const existingId = await redis.get(requestKey(requestId));
      const existing = existingId ? await getCreativePlan(redis, String(existingId)) : null;
      if (existing) return res.status(200).json({ job: existing, queued: ['queued', 'running'].includes(existing.state), duplicate: true });
    }
    const job = newCreativePlan({ title, sku, modelChoice, preferredModelChoice: modelChoice, fallbackUsed: false, clientRequestId: requestId });
    if (requestId) await redis.set(requestKey(requestId), job.id, { ex: 86400 });
    await saveCreativePlan(redis, job);
    return res.status(202).json({ job, queued: true });
  } catch (error) {
    console.error('[social/creative-plan]', error);
    return res.status(error?.status || 500).json({ error: String(error?.message || 'Unable to queue an AI strategy') });
  }
};
