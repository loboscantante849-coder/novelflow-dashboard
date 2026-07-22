const { getRedis, getRun, saveRun, addEvent, reserveVideoSlot } = require('./_lib/store');
const { requireSession } = require('./_lib/auth');
const providers = require('./_lib/providers');
const { videoPayload } = require('./_lib/pipeline');

const now = () => new Date().toISOString();
const threadId = (value) => String(value?.thread_id || value?.threadId || value?.base_info?.thread_id || value?.id || '');

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const run = await getRun(redis, String(req.body?.runId || ''));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const approved = run.artifacts?.videoPromptDraft?.status === 'approved';
  let video = run.artifacts?.videoRevision;
  try {
    if (!video) {
      if (!approved) return res.status(409).json({ error: 'Approve the rewritten video prompt before submitting a new paid video' });
      const prepared = videoPayload(run);
      prepared.remark = `nf_re_${providers.sha(`${run.id}:${run.artifacts.videoPromptDraft.id}:${prepared.payload.ad_copy}`).slice(0, 20)}`;
      prepared.payload.remark = prepared.remark;
      video = { status: 'prepared', remark: prepared.remark, payload: prepared.payload, threadId: '', videoUrls: [], promptDraftId: run.artifacts.videoPromptDraft.id };
      run.artifacts.videoRevision = video;
      addEvent(run, 'video_revision_prepared', 'Rewritten-prompt AC video prepared after explicit prompt approval');
      await saveRun(redis, run);
    }
    if (video.status === 'prepared') {
      const reconciled = await providers.findAcTask(video.remark);
      if (reconciled) { video.threadId = threadId(reconciled); video.status = 'running'; await saveRun(redis, run); return res.status(200).json({ video, runId: run.id }); }
      const slot = await reserveVideoSlot(redis);
      if (!slot.granted) return res.status(429).json({ error: `Video limit reached (${slot.limit}/${slot.limit}); retry after ${slot.label}`, video });
      video.slot = { key: slot.key, hour: slot.label, reservedAt: now(), position: slot.used, limit: slot.limit };
      video.status = 'submitting'; video.submitAttemptedAt = now(); await saveRun(redis, run);
      try {
        const response = await providers.submitAc(video.payload);
        video.threadId = threadId(response);
        if (!video.threadId) throw new providers.ProviderError('AC accepted the revised-video request without a thread ID', { ambiguous: true });
        video.status = 'running'; video.submittedAt = now(); addEvent(run, 'video_revision_submitted', 'One paid AC video submitted from an operator-approved rewritten prompt', { threadId: video.threadId }); await saveRun(redis, run);
        return res.status(202).json({ video, runId: run.id });
      } catch (error) { error.ambiguous = true; throw error; }
    }
    if (video.status === 'submitting' && !video.threadId) return res.status(409).json({ error: 'Revised video submission is ambiguous; automatic retry is disabled', video });
    if (video.status === 'running') {
      const result = await providers.acResult(video.threadId);
      Object.assign(video, result, { lastCheckedAt: now() });
      if (result.status === 'completed') { video.mediaValidation = await providers.validateVideo(result.videoUrls[0]); addEvent(run, 'video_revision_ready', 'Rewritten-prompt AC video completed and media URL verified', { threadId: video.threadId }); }
      else if (['failed', 'partial', 'completed_missing_media'].includes(result.status)) { video.status = 'failed'; video.error = result.error || result.status; }
      await saveRun(redis, run);
    }
    return res.status(200).json({ video, runId: run.id });
  } catch (error) {
    const message = String(error?.message || error || 'Revised video request failed').slice(0, 500);
    if (video?.status === 'submitting' && !video.threadId) { video.error = message; await saveRun(redis, run); return res.status(409).json({ error: 'Revised video submission is ambiguous; automatic retry is disabled', video }); }
    return res.status(502).json({ error: message, video });
  }
};
