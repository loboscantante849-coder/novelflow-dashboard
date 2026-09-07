const { getRedis, getRun, saveRun, addEvent } = require('./_lib/store');
const { requireSession, requireOperatorMutation } = require('./_lib/auth');
const videoControl = require('./_lib/video-control');

const RUN_ID = /^[a-z0-9][a-z0-9_-]{11,79}$/i;

function publicControl(control = {}) {
  return {
    version: Number(control.version || videoControl.POLICY_VERSION),
    template: String(control.template || 'Ad_Plot_Seedance'),
    referenceAssetIds: Array.isArray(control.referenceAssetIds) ? control.referenceAssetIds.map((id) => String(id)).slice(0, 9) : [],
    enableSubtitles: control.enableSubtitles === true,
    subtitleWireValue: control.subtitleWireValue === 'number_zero' ? 'number_zero' : 'string_false',
    lineage: control.lineage && typeof control.lineage === 'object'
      ? { source: String(control.lineage.source || ''), threadId: String(control.lineage.threadId || '') }
      : null
  };
}

function storedControl(compiled) {
  return publicControl(compiled.control);
}

function preparedVideo(compiled) {
  return {
    status: 'prepared',
    remark: compiled.remark,
    payload: compiled.payload,
    payloadFingerprint: compiled.payloadFingerprint,
    control: compiled.control,
    controlWarnings: [...(compiled.warnings || [])],
    submissionAllowed: compiled.submissionAllowed,
    threadId: '',
    videoUrls: []
  };
}

function canReplacePreparedVideo(run) {
  const video = run?.artifacts?.video;
  if (!video) return true;
  return video.status === 'prepared' && !video.threadId && !video.submitAttemptedAt && !run?.stages?.P4?.threadId;
}

function preview(compiled) {
  return {
    version: compiled.version,
    control: publicControl(compiled.control),
    payloadFingerprint: compiled.payloadFingerprint,
    remark: compiled.remark,
    warnings: compiled.warnings || [],
    submissionAllowed: compiled.submissionAllowed,
    payloadSummary: {
      template: compiled.payload.template,
      chapterWindow: compiled.control.chapterWindow,
      referenceCount: compiled.control.references.length,
      enableSubtitles: compiled.payload.enable_subtitles === true,
      aspectRatio: compiled.payload.aspect_ratio,
      num: compiled.payload.num,
      lineageAttached: Boolean(compiled.control.lineage)
    }
  };
}

function requestRunId(req) {
  const id = String(req.body?.runId || '').trim();
  if (!RUN_ID.test(id)) return '';
  return id;
}

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const action = String(req.body?.action || 'get');
  if (!['get', 'set_video_control', 'preview_video_contract'].includes(action)) return res.status(400).json({ error: 'Unsupported video control action' });
  if (action !== 'get' && !requireOperatorMutation(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  const runId = requestRunId(req);
  if (!runId) return res.status(400).json({ error: 'A valid production run ID is required' });
  const run = await getRun(redis, runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  try {
    if (action === 'get') {
      return res.status(200).json({
        control: publicControl(run.input?.videoControl || {}),
        templates: videoControl.publicTemplatePolicies(),
        video: run.artifacts?.video ? { status: String(run.artifacts.video.status || ''), payloadFingerprint: String(run.artifacts.video.payloadFingerprint || ''), controlWarnings: Array.isArray(run.artifacts.video.controlWarnings) ? run.artifacts.video.controlWarnings.slice(-12) : [] } : null
      });
    }
    if (action === 'set_video_control') {
      if (!canReplacePreparedVideo(run)) return res.status(409).json({ error: 'Video control is locked after a paid submission has started' });
      const compiled = videoControl.compileVideoContract(run, { controlOverride: req.body?.control });
      run.input = run.input || {};
      run.input.videoControl = storedControl(compiled);
      if (run.artifacts?.video) {
        run.artifacts.video = preparedVideo(compiled);
        run.stages.P4 = { ...(run.stages.P4 || {}), status: 'prepared', label: '视频导演合同已更新；等待提交', blockedReason: '', error: '', threadId: '', nextAttemptAt: '' };
      }
      addEvent(run, 'video_control_saved', 'AC director control contract saved; no paid video was submitted', { template: compiled.control.template, references: compiled.control.references.length, payloadFingerprint: compiled.payloadFingerprint });
      await saveRun(redis, run);
      return res.status(200).json({ control: publicControl(run.input.videoControl), preview: preview(compiled) });
    }
    const compiled = videoControl.compileVideoContract(run);
    return res.status(200).json({ control: publicControl(run.input?.videoControl || compiled.control), preview: preview(compiled) });
  } catch (error) {
    const status = Number(error?.status || 400);
    return res.status(status >= 400 && status < 600 ? status : 400).json({ error: String(error?.message || 'Unable to compile AC video control').slice(0, 500) });
  }
};

module.exports.publicControl = publicControl;
module.exports.preview = preview;
module.exports.canReplacePreparedVideo = canReplacePreparedVideo;
