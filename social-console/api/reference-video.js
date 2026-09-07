const { getRedis, getRun, saveRun, addEvent, reserveVideoSlot } = require('./_lib/store');
const { requireOperatorMutation } = require('./_lib/auth');
const providers = require('./_lib/providers');
const videoControl = require('./_lib/video-control');
const { referenceVideoPayload } = require('./_lib/pipeline');

const now = () => new Date().toISOString();
const threadId = (value) => String(providers.taskIdOf(value) || '');

module.exports = async (req, res) => {
  // This route can create a paid AC task, so an open-access preview must not
  // turn it into an unauthenticated provider client.
  if (!requireOperatorMutation(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const pauseSetting = String(process.env.SOCIAL_VIDEO_GENERATION_PAUSED || '').trim().toLowerCase();
  const submissionsPaused = pauseSetting ? !['0', 'false', 'off'].includes(pauseSetting) : process.env.VERCEL_ENV === 'production';
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const run = await getRun(redis, String(req.body?.runId || ''));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const referenceAssetId = String(req.body?.referenceAssetId || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{2,119}$/i.test(referenceAssetId)) return res.status(400).json({ error: 'Select one approved managed character reference image' });
  let video = run.artifacts.referenceVideo;
  try {
    if (video?.referenceAssetId && video.referenceAssetId !== referenceAssetId) return res.status(409).json({ error: 'A character-reference video already exists for this run. Keep or remove it before switching the reference image.', video });
    if (!video) {
      if (submissionsPaused) return res.status(409).json({ error: 'New video submissions are paused by the operator' });
      const prepared = referenceVideoPayload(run, referenceAssetId);
      video = { status: 'prepared', remark: prepared.remark, payload: prepared.payload, payloadFingerprint: prepared.payloadFingerprint, control: prepared.control, controlWarnings: [...(prepared.warnings || [])], submissionAllowed: prepared.submissionAllowed, referenceAssetId, threadId: '', videoUrls: [] };
      run.artifacts.referenceVideo = video;
      addEvent(run, 'reference_video_prepared', 'Character-reference AC video prepared', { referenceAssetId });
      await saveRun(redis, run);
    }
    if (video.status === 'prepared') {
      const reconciled = await providers.findAcTask(video.remark);
      if (reconciled) {
        video.threadId = threadId(reconciled);
        video.status = 'running';
        await saveRun(redis, run);
        return res.status(200).json({ video, runId: run.id });
      }
      if (submissionsPaused) return res.status(409).json({ error: 'New video submissions are paused by the operator', video });
      if (video.submissionAllowed === false || video.control?.policy?.production === false) return res.status(409).json({ error: 'Experimental templates are dry-run only until a single-variable experiment is explicitly authorized', video });
      const slot = await reserveVideoSlot(redis);
      if (!slot.granted) return res.status(429).json({ error: `Daily video limit reached (${slot.limit}/${slot.limit}); retry after ${slot.resetLabel}`, video });
      video.slot = { key: slot.key, day: slot.label, resetAt: slot.resetAt, reservedAt: now(), position: slot.used, limit: slot.limit };
      video.status = 'submitting';
      video.submitAttemptedAt = now();
      await saveRun(redis, run);
      try {
        const response = await providers.submitAc(video.payload);
        video.threadId = threadId(response);
        if (!video.threadId) throw new providers.ProviderError('AC accepted the reference-video request without a thread ID', { ambiguous: true });
        video.status = 'running';
        video.submittedAt = now();
        addEvent(run, 'reference_video_submitted', 'One paid AC character-reference video submitted', { threadId: video.threadId, referenceAssetId });
        await saveRun(redis, run);
        return res.status(202).json({ video, runId: run.id });
      } catch (error) {
        error.ambiguous = true;
        throw error;
      }
    }
    if (video.status === 'submitting' && !video.threadId) return res.status(409).json({ error: 'Reference video submission is ambiguous; automatic retry is disabled', video });
    if (video.status === 'running') {
      const result = await providers.acResult(video.threadId);
      Object.assign(video, result, { lastCheckedAt: now() });
      video.controlWarnings = [...new Set([...(video.controlWarnings || []), ...videoControl.executionWarnings(video.control, result.executionControls)])].slice(-12);
      if (result.status === 'completed') {
        video.mediaValidation = await providers.validateVideo(result.videoUrls[0]);
        addEvent(run, 'reference_video_ready', 'AC poster-reference video completed and media URL verified', { threadId: video.threadId });
      } else if (['failed', 'partial', 'completed_missing_media'].includes(result.status)) {
        video.status = 'failed';
        video.error = result.error || result.status;
      }
      await saveRun(redis, run);
    }
    return res.status(200).json({ video, runId: run.id });
  } catch (error) {
    const message = String(error?.message || error || 'Reference video request failed').slice(0, 500);
    if (video?.status === 'submitting' && !video.threadId) {
      video.error = message;
      await saveRun(redis, run);
      return res.status(409).json({ error: 'Reference video submission is ambiguous; automatic retry is disabled', video });
    }
    return res.status(502).json({ error: message, video });
  }
};
