const { getRedis, getRun, saveRun, addEvent, reserveVideoSlot } = require('./_lib/store');
const { requireOperatorMutation } = require('./_lib/auth');
const providers = require('./_lib/providers');
const videoControl = require('./_lib/video-control');
const { videoPayload } = require('./_lib/pipeline');
const { videoAssetFingerprint } = require('./_lib/video-asset');

const now = () => new Date().toISOString();
const threadId = (value) => String(providers.taskIdOf(value) || '');

function completeRevision(run, video, mediaValidation) {
  video.mediaValidation = mediaValidation;
  video.status = 'completed';
  video.executionQa = {
    status: 'pending_manual_review',
    score: null,
    criteria: {},
    defects: [],
    assetFingerprint: videoAssetFingerprint(video),
    createdAt: now()
  };
  run.state = 'running';
  run.stages.P4 = {
    ...(run.stages.P4 || {}),
    status: 'done',
    label: '修订视频已生成并通过媒体校验',
    threadId: video.threadId,
    error: '',
    recoverable: false,
    completedAt: now(),
    updatedAt: now()
  };
  if (run.stages.P6?.status !== 'done') run.stages.P6 = { status: 'waiting' };
  addEvent(run, 'video_revision_ready', 'Rewritten-prompt AC video completed and replaced the failed P4 media for review packaging', { threadId: video.threadId });
}

module.exports = async (req, res) => {
  // A revision can reserve quota and submit a paid AC job.  In private
  // open-access deployments a normal session deliberately does not imply
  // authority to create paid provider work.
  if (!requireOperatorMutation(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const pauseSetting = String(process.env.SOCIAL_VIDEO_GENERATION_PAUSED || '').trim().toLowerCase();
  const submissionsPaused = pauseSetting ? !['0', 'false', 'off'].includes(pauseSetting) : process.env.VERCEL_ENV === 'production';
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const run = await getRun(redis, String(req.body?.runId || ''));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const approved = run.artifacts?.videoPromptDraft?.status === 'approved';
  const manualVideoLimitOverride = req.body?.manualVideoLimitOverride === true;
  let video = run.artifacts?.videoRevision;
  try {
    if (!video) {
      if (submissionsPaused) return res.status(409).json({ error: 'New video submissions are paused by the operator' });
      if (!approved) return res.status(409).json({ error: 'Approve the rewritten video prompt before submitting a new paid video' });
      const prepared = videoPayload(run, { kind: 'revision', prompt: run.artifacts.videoPromptDraft });
      video = { status: 'prepared', remark: prepared.remark, payload: prepared.payload, payloadFingerprint: prepared.payloadFingerprint, control: prepared.control, controlWarnings: [...(prepared.warnings || [])], submissionAllowed: prepared.submissionAllowed, threadId: '', videoUrls: [], promptDraftId: run.artifacts.videoPromptDraft.id };
      run.artifacts.videoRevision = video;
      addEvent(run, 'video_revision_prepared', 'Rewritten-prompt AC video prepared after explicit prompt approval');
      await saveRun(redis, run);
    }
    if (video.status === 'prepared') {
      const reconciled = await providers.findAcTask(video.remark);
      if (reconciled) { video.threadId = threadId(reconciled); video.status = 'running'; await saveRun(redis, run); return res.status(200).json({ video, runId: run.id }); }
      if (submissionsPaused) return res.status(409).json({ error: 'New video submissions are paused by the operator', video });
      if (video.submissionAllowed === false || video.control?.policy?.production === false) return res.status(409).json({ error: 'Experimental templates are dry-run only until a single-variable experiment is explicitly authorized', video });
      let slot = await reserveVideoSlot(redis);
      if (!slot.granted && manualVideoLimitOverride) {
        slot = { ...slot, granted: true, override: true, used: slot.limit + 1, remaining: 0 };
        addEvent(run, 'video_limit_operator_override', 'Operator-authorized temporary video-capacity override used for this revision', { limit: slot.limit });
      }
      if (!slot.granted) return res.status(429).json({ error: `Daily video limit reached (${slot.limit}/${slot.limit}); retry after ${slot.resetLabel}`, video });
      video.slot = { key: slot.key, day: slot.label, resetAt: slot.resetAt, reservedAt: now(), position: slot.used, limit: slot.limit, ...(slot.override ? { override: true } : {}) };
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
      video.controlWarnings = [...new Set([...(video.controlWarnings || []), ...videoControl.executionWarnings(video.control, result.executionControls)])].slice(-12);
      if (result.status === 'completed') completeRevision(run, video, await providers.validateVideo(result.videoUrls[0]));
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

module.exports.completeRevision = completeRevision;
