const { getRedis, getRun, getRunDetail, getRunSummary, getRunAssets, saveRunAssets, runAssets, listRuns, listRunSummaries, newRun, saveRun, setStage, getCreativePlan, registerActiveRun, findActiveRun, acquireRunCreation, releaseRunCreation } = require('./_lib/store');
const { requireSession, requireOperatorMutation } = require('./_lib/auth');
const { normalizeCreative, refreshAnalytics, sourceGroundedCreativeFallback, applySourceGroundedCreativeFallback } = require('./_lib/pipeline');
const providers = require('./_lib/providers');
const videoControl = require('./_lib/video-control');
const { effectiveVideoForRun, videoAssetFingerprint } = require('./_lib/video-asset');
const { normalizeDelivery, sanitizeP0Selection } = require('./_lib/distribution');
const { p0SelectionFromReceipt, rebindP0ReceiptBook, requiresP0Receipt } = require('./_lib/p0-receipts');

const text = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
const publicError = (error, fallback) => {
  const message = String(error?.message || fallback || 'The requested operation could not be completed')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gi, '[redacted]')
    .slice(0, 500);
  const status = Number(error?.status || 0);
  return { status: status >= 400 && status < 600 ? status : 502, message };
};

function exactLookupFailure(error, title, appName) {
  const upstreamStatus = Number(error?.status || 0);
  if (String(error?.code || '') === 'exact_not_found') {
    return {
      status: 422,
      message: `“${title}” is not an active exact ${appName || 'target'} bookstore record and cannot start automation.`
    };
  }
  const failure = publicError(error, 'Book identity validation failed');
  if (String(error?.code || '') === 'provider_timeout') failure.status = 504;
  else if (['provider_transport', 'provider_invalid_json', 'provider_protocol'].includes(String(error?.code || ''))) failure.status = 502;
  else if (String(error?.code || '') === 'provider_http') {
    if ([401, 403].includes(upstreamStatus)) failure.status = 503;
    else if (upstreamStatus === 429) failure.status = 429;
    else failure.status = 502;
  }
  else if ([401, 403].includes(upstreamStatus)) failure.status = 503;
  else if (upstreamStatus === 408 || !upstreamStatus) failure.status = 504;
  else if (upstreamStatus === 429) failure.status = 429;
  else if (upstreamStatus >= 500) failure.status = 502;
  else if ([404, 409].includes(upstreamStatus) && String(error?.code || '') !== 'exact_mismatch') failure.status = 502;
  return failure;
}
const CREATIVE_PROFILE_OPTIONS = Object.freeze({
  copyStyle: new Set(['system_best', 'revenge_comeback', 'forbidden_tension', 'dark_redemption']),
  ctaStyle: new Set(['story_cliffhanger', 'identity_reveal', 'romantic_tension', 'revenge_payoff']),
  videoStyle: new Set(['five_beat', 'reversal', 'slow_burn', 'revenge']),
  posterStyle: new Set(['system_best', 'luminous_cinema', 'editorial_romance']),
  modelChoice: new Set(['glm-5.3-flash', 'deepseek-v4-flash-preview', 'hy3', 'deepseek', 'seed-2.1-turbo', 'qwen3.7-max', 'minimax-m2.7', 'kimi-k2.7-code', 'qwen3.5-flash', 'glm-4.5-air', 'kimi-k2.5', 'minimax-m2.5', 'glm-5.2', 'kimi-k3', 'minimax-m3'])
});

const VOICE_STYLES = new Set(['confessional', 'cinematic', 'confrontation', 'mystery', 'reflective', 'punchy', 'yearning']);
const CREATIVE_FORMS = new Set([
  'witnessed_confrontation', 'evidence_discovery', 'pursuit_in_motion', 'public_power_reversal',
  'protective_interruption', 'ceremony_rupture', 'deadline_choice', 'authority_arrival',
  'secret_overheard', 'contract_or_letter_break', 'identity_recognition', 'departure_challenge'
]);
const SECONDARY_FORMS = new Set([
  'private_consequence', 'accusation_aftershock', 'blocked_escape', 'status_aftershock',
  'boundary_choice', 'symbolic_departure', 'cost_reveal', 'room_reaction', 'silent_decision',
  'doorway_consequence', 'choice_after_reveal', 'pursuer_reaction'
]);
const HOOK_DEVICES = new Set([
  'dialogue_cut', 'object_closeup', 'motion_open', 'reaction_cut', 'blocked_action', 'public_symbol',
  'countdown_object', 'entrance_reaction', 'reaction_then_source', 'document_action', 'visual_recognition', 'doorway_motion'
]);
const OPENING_GRAMMARS = new Set([
  'dialogue_verdict', 'conflict_object_action', 'movement_interruption',
  'public_reaction', 'arrival_disruption', 'choice_countdown'
]);
const VIDEO_GRAMMARS = new Set([
  'object_action_reaction_reversal', 'wide_action_crowd_reaction',
  'movement_block_countermove', 'discovery_consequence_reaction',
  'arrival_intercept_power_shift', 'two_shot_choice_distance_shift'
]);
const CTA_MODES = new Set([
  'unresolved_question', 'cost_of_choice', 'identity_reveal',
  'power_reversal', 'relationship_boundary', 'next_move'
]);

function sanitizeCreativeProfile(value) {
  const profile = value && typeof value === 'object' ? value : {};
  const sanitized = Object.fromEntries(Object.entries(CREATIVE_PROFILE_OPTIONS).map(([key, allowed]) => {
    const selected = String(profile[key] || '').trim();
    return [key, allowed.has(selected) ? selected : [...allowed][0]];
  }));
  sanitized.adCreativeNoTracking = profile.adCreativeNoTracking === true;
  sanitized.outputLanguage = ['en', 'pt', 'es'].includes(String(profile.outputLanguage || '').toLowerCase())
    ? String(profile.outputLanguage).toLowerCase()
    : '';
  sanitized.forceEnglish = sanitized.outputLanguage === 'en' || profile.forceEnglish === true;
  // Preserve the visible-copy contract on newly created runs as well as on
  // later creative variants.  Without this, a caller's explicit 3–5 choice
  // was silently downgraded before P3 had a chance to honour it.
  sanitized.emojiRange = profile.emojiRange === '3-5' ? '3-5' : '2-4';
  sanitized.ctaLinkPlacement = profile.ctaLinkPlacement === 'front' ? 'front' : 'end';
  sanitized.sceneBrief = text(profile.sceneBrief, 2400);
  sanitized.sceneChapters = [...new Set((Array.isArray(profile.sceneChapters) ? profile.sceneChapters : [])
    .map(Number)
    .filter((chapter) => Number.isInteger(chapter) && chapter > 0 && chapter <= 100000))]
    .sort((left, right) => left - right)
    .slice(0, 8);
  sanitized.visualContinuity = text(profile.visualContinuity, 1800);
  sanitized.sceneVariant = text(profile.sceneVariant, 120);
  sanitized.campaignId = text(profile.campaignId, 100);
  sanitized.campaignSlot = Math.max(0, Math.min(Number(profile.campaignSlot) || 0, 1000));
  sanitized.accountSlot = Math.max(0, Math.min(Number(profile.accountSlot) || 0, 10));
  const sceneLane = Number(profile.sceneLane);
  sanitized.sceneLane = profile.sceneLane !== null && profile.sceneLane !== undefined && profile.sceneLane !== ''
    && Number.isInteger(sceneLane) && sceneLane >= 0 && sceneLane <= 2 ? sceneLane : null;
  sanitized.sceneRepeatIndex = Math.max(0, Math.min(Number(profile.sceneRepeatIndex) || 0, 3));
  sanitized.sceneRepeatCount = Math.max(0, Math.min(Number(profile.sceneRepeatCount) || 0, 3));
  sanitized.voiceStyle = VOICE_STYLES.has(String(profile.voiceStyle || '')) ? String(profile.voiceStyle) : 'cinematic';
  sanitized.creativeForm = CREATIVE_FORMS.has(String(profile.creativeForm || '')) ? String(profile.creativeForm) : '';
  sanitized.secondaryForm = SECONDARY_FORMS.has(String(profile.secondaryForm || '')) ? String(profile.secondaryForm) : '';
  sanitized.hookDevice = HOOK_DEVICES.has(String(profile.hookDevice || '')) ? String(profile.hookDevice) : '';
  sanitized.openingGrammar = OPENING_GRAMMARS.has(String(profile.openingGrammar || '')) ? String(profile.openingGrammar) : '';
  sanitized.videoGrammar = VIDEO_GRAMMARS.has(String(profile.videoGrammar || '')) ? String(profile.videoGrammar) : '';
  sanitized.ctaMode = CTA_MODES.has(String(profile.ctaMode || '')) ? String(profile.ctaMode) : '';
  sanitized.uniquenessRequired = profile.uniquenessRequired === true;
  sanitized.draftPostIndex = Number(profile.draftPostIndex) === 1 ? 1 : 0;
  sanitized.qualityMode = profile.qualityMode === 'premium' ? 'premium' : 'standard';
  return sanitized;
}

function rewriteModelChoice(body, run) {
  const requested = text(body?.modelChoice, 80);
  if (requested && !CREATIVE_PROFILE_OPTIONS.modelChoice.has(requested)) throw new providers.ProviderError('Unsupported creative model', { status: 400 });
  return requested || run?.input?.creativeProfile?.modelChoice || run?.artifacts?.modelRoute?.activeModel || 'hy3';
}

function reusableSiblingVideo(targetRun, sourceRun) {
  if (!targetRun || !sourceRun || targetRun.id === sourceRun.id) throw new providers.ProviderError('A different source run is required', { status: 400 });
  if (targetRun.stages?.P4?.status !== 'failed') throw new providers.ProviderError('Only a definitively failed video stage can reuse verified sibling media', { status: 409 });
  if (String(targetRun.input?.sku || '') !== String(sourceRun.input?.sku || '')) throw new providers.ProviderError('Sibling media must belong to the exact same SKU', { status: 409 });
  if (targetRun.input?.creativeProfile?.uniquenessRequired === true && String(targetRun.input?.campaign?.id || '').trim()) {
    throw new providers.ProviderError('Uniqueness-required campaigns cannot reuse sibling video media', { status: 409 });
  }
  if (sourceRun.stages?.P4?.status !== 'done') throw new providers.ProviderError('The sibling video has not passed P4 verification', { status: 409 });
  const revision = sourceRun.artifacts?.videoRevision;
  const sourceVideo = revision?.status === 'completed' && revision?.videoUrls?.[0] ? revision : sourceRun.artifacts?.video;
  const videoUrl = String(sourceVideo?.videoUrls?.[0] || '');
  if (!videoUrl) throw new providers.ProviderError('The sibling run has no verified video URL', { status: 409 });
  const targetContract = String(targetRun.artifacts?.video?.payloadFingerprint || '');
  const sourceContract = String(sourceVideo?.payloadFingerprint || '');
  if (!targetContract || !sourceContract || targetContract !== sourceContract) throw new providers.ProviderError('Sibling media must match the exact saved video contract fingerprint', { status: 409 });
  return { sourceVideo, videoUrl };
}

function authorizePaidMediaSubmission(run) {
  const videoStatus = String(run?.stages?.P4?.status || 'waiting');
  const posterStatus = String(run?.stages?.P3_5?.status || 'waiting');
  const videoTaskExists = Boolean(run?.artifacts?.video?.threadId || run?.artifacts?.video?.submitAttemptedAt);
  const imageTaskExists = (run?.artifacts?.images || []).some((item) => item?.taskId || item?.submitAttemptedAt);
  if (run?.stages?.P3?.status !== 'done') throw new providers.ProviderError('Finish the validated creative package before authorizing paid media', { status: 409 });
  if (run?.stages?.P7?.status === 'done') throw new providers.ProviderError('This run already has a finished draft', { status: 409 });
  if (videoTaskExists || imageTaskExists || ['submitting', 'running', 'ambiguous', 'failed'].includes(videoStatus) || ['submitting', 'running', 'ambiguous', 'failed'].includes(posterStatus)) {
    throw new providers.ProviderError('A media task already exists or requires separate recovery; this authorization cannot reopen it', { status: 409 });
  }
  run.input = run.input || {};
  run.input.paidAuthorized = true;
  run.input.paidMediaSubmissionAuthorized = true;
  run.artifacts = run.artifacts || {};
  run.artifacts.mediaAuthorization = { scope: 'video_and_posters', authorizedAt: new Date().toISOString(), mode: 'per_run', status: 'approved' };
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push({ at: new Date().toISOString(), type: 'paid_media_authorized', message: 'Operator authorized one new AC video and the prepared poster tasks for this exact run' });
}

const VIDEO_FIDELITY_DEFECTS = new Set([
  'missing_event', 'merged_characters', 'identity_drift', 'wrong_object',
  'wrong_order', 'missing_reversal', 'unwanted_text', 'unusable_media',
  'low_information_opening', 'bedroom_wake_opening'
]);

function reviewVideoFidelity(run, body = {}) {
  const effective = effectiveVideoForRun(run);
  const video = effective.asset;
  if (run?.stages?.P4?.status !== 'done' || !effective.url) {
    throw new providers.ProviderError('A completed verified video is required before fidelity review', { status: 409 });
  }
  const decision = text(body.decision, 20);
  if (!['approve', 'reject'].includes(decision)) throw new providers.ProviderError('Video fidelity decision must be approve or reject', { status: 400 });
  const score = Number(body.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new providers.ProviderError('Video fidelity score must be between 0 and 100', { status: 400 });
  const submittedDefects = [...new Set((Array.isArray(body.defects) ? body.defects : [])
    .map((item) => text(item, 80))
    .filter(Boolean))];
  const unknownDefects = submittedDefects.filter((item) => !VIDEO_FIDELITY_DEFECTS.has(item));
  const defects = submittedDefects;
  const criteria = {};
  const requiredCriteria = ['eventImmediacy', 'socialStakes', 'conflictObject', 'powerDelta', 'visualSpecificity', 'brandPremium'];
  for (const key of requiredCriteria) {
    const value = Number(body.criteria?.[key]);
    if (Number.isFinite(value)) criteria[key] = Math.max(0, Math.min(5, value));
  }
  const computedScore = requiredCriteria.every((key) => Object.prototype.hasOwnProperty.call(criteria, key))
    ? Math.round(requiredCriteria.reduce((total, key) => total + Number(criteria[key]), 0) / (requiredCriteria.length * 5) * 100)
    : null;
  if (decision === 'approve' && (score < 80 || defects.length)) {
    throw new providers.ProviderError('Premium video approval requires score 80+ and no recorded fidelity defects', { status: 409 });
  }
  const openingClass = text(body.openingClass, 120);
  if (decision === 'approve' && requiredCriteria.some((key) => !Object.prototype.hasOwnProperty.call(criteria, key))) {
    throw new providers.ProviderError('Premium video approval requires all six fidelity criteria', { status: 409 });
  }
  if (decision === 'approve' && (computedScore < 80 || Math.abs(score - computedScore) > 5)) {
    throw new providers.ProviderError('Premium video approval requires the six fidelity criteria to compute to 80+ and agree with the submitted score', { status: 409 });
  }
  const criticalCriteria = ['eventImmediacy', 'conflictObject', 'visualSpecificity', 'brandPremium'];
  if (decision === 'approve' && criticalCriteria.some((key) => Number(criteria[key]) < 4)) {
    throw new providers.ProviderError('Premium video approval requires every critical first-frame criterion to score at least 4/5', { status: 409 });
  }
  if (decision === 'approve' && !openingClass) throw new providers.ProviderError('Premium video approval requires the observed opening class', { status: 409 });
  const plannedOpening = text(run.input?.creativeProfile?.openingGrammar, 120);
  if (decision === 'approve' && plannedOpening && openingClass !== plannedOpening) {
    throw new providers.ProviderError('Finished video opening does not match the campaign opening grammar', { status: 409 });
  }
  video.executionQa = {
    status: decision === 'approve' ? 'approved' : 'rejected',
    score: Math.round(score),
    computedScore,
    defects,
    unknownDefects,
    taxonomyVersion: 1,
    criteria,
    openingClass,
    notes: text(body.notes, 1000),
    reviewedAt: new Date().toISOString(),
    reviewer: 'operator',
    assetKind: effective.kind,
    assetFingerprint: videoAssetFingerprint(video)
  };
  if (decision === 'approve') {
    if (run.stages?.P6?.blockedReason === 'video_fidelity_review') run.stages.P6 = { status: 'waiting' };
    if (run.state === 'blocked') run.state = 'running';
    run.events.push({ at: new Date().toISOString(), type: 'video_fidelity_approved', message: `Premium visual QA approved the finished video with score ${Math.round(score)}` });
  } else {
    setStage(run, 'P6', 'blocked', { label: '成片保真或首屏质感未通过，已阻止进入 SocialEcho 草稿', blockedReason: 'video_fidelity_review', recoverable: false, error: defects.join(', ') || 'video fidelity rejected' });
    run.state = 'blocked';
    run.events.push({ at: new Date().toISOString(), type: 'video_fidelity_rejected', message: `Premium visual QA rejected the finished video with score ${Math.round(score)}`, data: { defects } });
  }
  return video.executionQa;
}

function resetManualCreativeRetry(run, failedStage = {}) {
  run.artifacts = run.artifacts || {};
  const preferredModel = String(run.artifacts.modelRoute?.preferredModel || run.input?.creativeProfile?.modelChoice || 'hy3');
  run.input = run.input || {};
  run.input.creativeProfile = { ...(run.input.creativeProfile || {}), modelChoice: preferredModel };
  run.artifacts.modelRoute = {
    preferredModel,
    activeModel: preferredModel,
    fallbackModel: '',
    fallbackUsed: false,
    fallbackFrom: '',
    switchedAt: '',
    switchReason: ''
  };
  delete run.artifacts.creativeDraft;
  delete run.artifacts.posts;
  delete run.artifacts.translations;
  delete run.artifacts.videoPrompt;
  delete run.artifacts.posterPrompts;
  delete run.artifacts.qualityReview;
  delete run.artifacts.optimization;
  run.stages.P3 = {
    status: 'waiting',
    retryCount: Number(failedStage.retryCount || 0) + 1,
    attempt: 0,
    phase: 'manual_retry',
    nextAttemptAt: '',
    error: ''
  };
}

function skipUnsubmittedPosters(run) {
  const images = Array.isArray(run?.artifacts?.images) ? run.artifacts.images : [];
  if (images.some((asset) => asset?.taskId || ['submitting', 'running'].includes(String(asset?.status || '')))) {
    throw new providers.ProviderError('A paid poster task already exists and cannot be skipped', { status: 409 });
  }
  run.artifacts = run.artifacts || {};
  run.artifacts.images = images.map((asset) => ({
    ...asset,
    status: String(asset?.status || '') === 'prepared' ? 'skipped' : asset.status,
    skippedAt: new Date().toISOString()
  }));
  run.stages = run.stages || {};
  run.stages.P3_5 = {
    ...(run.stages.P3_5 || {}),
    status: 'partial',
    label: '海报未纳入本次视频草稿交付；未提交图片任务',
    error: '',
    nonBlocking: true,
    recoverable: false,
    skippedAt: new Date().toISOString()
  };
  run.events = [...(run.events || []), {
    at: new Date().toISOString(),
    type: 'poster_generation_skipped',
    message: 'Poster generation was explicitly skipped because this delivery authorizes video drafts only; no image task was submitted'
  }].slice(-80);
  return run;
}

function sanitizePlanning(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    planId: text(value.planId, 100),
    preferredModel: CREATIVE_PROFILE_OPTIONS.modelChoice.has(String(value.preferredModel || '')) ? String(value.preferredModel) : '',
    actualModel: CREATIVE_PROFILE_OPTIONS.modelChoice.has(String(value.actualModel || '')) ? String(value.actualModel) : '',
    fallbackUsed: value.fallbackUsed === true
  };
}

function sanitizeCatalogueEvidence(value, sku) {
  if (!value || typeof value !== 'object' || String(value.bookSkuId || '') !== String(sku || '')) return null;
  const chapters = (Array.isArray(value.chapters) ? value.chapters : []).map((chapter) => ({
    id: text(chapter?.id, 120),
    order: Math.max(1, Math.min(Number(chapter?.order) || 0, 100000)),
    title: text(chapter?.title, 300),
    content: text(chapter?.content, 16000)
  })).filter((chapter) => chapter.id && chapter.order && chapter.title && chapter.content.length >= 20).slice(0, 12);
  const unique = new Set(chapters.map((chapter) => `${chapter.id}:${chapter.order}`));
  if (chapters.length < 3 || unique.size !== chapters.length) return null;
  const chapterStructure = (Array.isArray(value.chapterStructure) ? value.chapterStructure : []).map((chapter) => ({
    order: Math.max(1, Math.min(Number(chapter?.order) || 0, 100000)),
    title: text(chapter?.title, 300)
  })).filter((chapter) => chapter.order && chapter.title).slice(0, 500);
  return {
    source: 'bookstore_operator_session',
    importedAt: new Date().toISOString(),
    chapters,
    chapterStructure: chapterStructure.length ? chapterStructure : chapters.map(({ order, title }) => ({ order, title }))
  };
}

const OPERATOR_EVIDENCE_RECOVERY = Object.freeze({
  sku: '6a30ed3696382e5ba84ba770',
  source: 'weekly_20260901_novelflow_42'
});

// This recovery path exists for one verified catalog partition gap. It is
// deliberately SKU- and campaign-scoped so it cannot turn into a general
// source injection route or reopen a run after media work has begun.
function attachOperatorCatalogueEvidence(run, value) {
  if (String(run?.input?.sku || '') !== OPERATOR_EVIDENCE_RECOVERY.sku
    || String(run?.input?.source || '') !== OPERATOR_EVIDENCE_RECOVERY.source) {
    throw new providers.ProviderError('This evidence recovery is not available for this run', { status: 409 });
  }
  if (run?.stages?.P1?.status !== 'done') {
    throw new providers.ProviderError('Exact book identity must be verified before attaching catalog evidence', { status: 409 });
  }
  const evidence = sanitizeCatalogueEvidence(value, run.input.sku);
  if (!evidence) {
    throw new providers.ProviderError('Three distinct, non-empty chapters from the exact SKU are required', { status: 400 });
  }
  const videoStarted = Boolean(run.artifacts?.video?.threadId || run.artifacts?.video?.submitAttemptedAt);
  const posterStarted = (run.artifacts?.images || []).some((asset) => asset?.taskId || asset?.submitAttemptedAt);
  if (videoStarted || posterStarted) {
    throw new providers.ProviderError('Catalog evidence cannot replace a run after media work has started', { status: 409 });
  }

  run.input.verifiedBook = { ...(run.input.verifiedBook || {}), catalogueEvidence: evidence };
  run.artifacts = run.artifacts || {};
  for (const key of ['evidence', 'storyBrief', 'modelActivity', 'evidenceContinuationCandidate', 'creativeDraft', 'posts', 'translations', 'videoPrompt', 'posterPrompts', 'qualityReview', 'optimization', 'video', 'images', 'review']) {
    delete run.artifacts[key];
  }
  setStage(run, 'P2', 'waiting', { label: '书库已读章节证据待导入', phase: 'bookstore_operator_evidence', cursor: 0, total: evidence.chapters.length, recoverable: true, nextAttemptAt: '', error: '' });
  setStage(run, 'P3', 'waiting', { label: '等待基于书库证据生成创意', phase: '', recoverable: true, nextAttemptAt: '', error: '' });
  setStage(run, 'P3_5', 'waiting', { label: '等待创意包完成', error: '' });
  setStage(run, 'P4', 'waiting', { label: '等待视频创意包完成', error: '', threadId: '' });
  setStage(run, 'P6', 'waiting', { label: '等待素材审核包完成', error: '' });
  setStage(run, 'P7', 'waiting', { label: '等待 SocialEcho 草稿', error: '' });
  run.state = 'running';
  run.events = [...(run.events || []), {
    at: new Date().toISOString(),
    type: 'bookstore_catalogue_evidence_attached',
    message: `Attached ${evidence.chapters.length} verified bookstore chapters for the exact catalog-partition recovery`
  }].slice(-80);
  return evidence;
}

function buildRunInput(book, body = {}, planning = null) {
  const delivery = normalizeDelivery(body.delivery || { accountId: body.accountId });
  const rawTemplate = text(body.videoControl?.template, 80) || text(body.videoTemplate, 80) || 'Ad_Plot_Seedance';
  const requestedTemplate = rawTemplate === 'adaptive_seedance' ? 'Ad_Plot_Seedance' : rawTemplate;
  videoControl.templatePolicy(requestedTemplate);
  const campaign = body.campaign && typeof body.campaign === 'object' ? (() => {
    const scheduledAt = text(body.campaign.scheduledAt, 80);
    const requestedMode = text(body.campaign.deliveryMode, 20).toLowerCase();
    if (requestedMode && !['draft', 'scheduled'].includes(requestedMode)) {
      throw new providers.ProviderError('Campaign deliveryMode must be draft or scheduled', { status: 400 });
    }
    if (scheduledAt && !Number.isFinite(Date.parse(scheduledAt))) {
      throw new providers.ProviderError('Campaign scheduledAt must be a valid ISO timestamp', { status: 400 });
    }
    const deliveryMode = requestedMode || (scheduledAt ? 'scheduled' : 'draft');
    if (deliveryMode === 'scheduled' && !scheduledAt) {
      throw new providers.ProviderError('Scheduled campaign delivery requires scheduledAt', { status: 400 });
    }
    if (deliveryMode === 'draft' && scheduledAt) {
      throw new providers.ProviderError('Draft campaign delivery cannot carry scheduledAt', { status: 400 });
    }
    return {
      id: text(body.campaign.id, 100),
      itemIndex: Math.max(0, Math.min(Number(body.campaign.itemIndex) || 0, 1000)),
      slot: Math.max(1, Math.min(Number(body.campaign.slot) || 1, 10)),
      selectionTier: text(body.campaign.selectionTier, 80),
      autoSocialEchoDraft: body.campaign.autoSocialEchoDraft === true,
      paidMediaAuthorized: body.campaign.paidMediaAuthorized === true,
      deliveryMode,
      scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : ''
    };
  })() : null;
  return {
    title: book.title,
    sku: book.bookSkuId,
    // `book` has already passed the exact target-application lookup in this
    // request. Persist that verified identity so P1 does not fail later when
    // a lagging Writer Admin partition stops returning the same active SKU.
    verifiedBook: {
      bookSkuId: book.bookSkuId,
      cityBookId: book.cityBookId,
      title: book.title,
      cover: book.cover || '',
      category: book.category || '',
      tags: Array.isArray(book.tags) ? book.tags : [],
      description: book.description || '',
      chapterCount: Number(book.chapterCount || 0),
      words: Number(book.words || 0),
      payPoint: Number(book.payPoint || 0),
      editorFbCopy: String(book.editorFbCopy || body.editorFbCopy || '').slice(0, 12000),
      ...(book.catalogueVerification ? { catalogueVerification: book.catalogueVerification } : {}),
      ...(sanitizeCatalogueEvidence(body.catalogueEvidence, book.bookSkuId) ? { catalogueEvidence: sanitizeCatalogueEvidence(body.catalogueEvidence, book.bookSkuId) } : {})
    },
    source: text(body.source, 100) || 'manual',
    automationMode: 'one_click',
    promoter: text(body.promoter, 80) || 'xujt',
    videoTemplate: requestedTemplate,
    videoControl: { version: videoControl.POLICY_VERSION, template: requestedTemplate, referenceAssetIds: [], enableSubtitles: false, lineage: null },
    fullBookEvidence: body.fullBookEvidence !== false,
    paidAuthorized: body.paidAuthorized === true,
    // Production normally fails closed. This narrow, durable authorization is
    // intentionally separate from `paidAuthorized` so an old prepared run
    // cannot begin submitting paid media merely because a later campaign was
    // approved.
    paidMediaSubmissionAuthorized: body.paidAuthorized === true && body.paidMediaSubmissionAuthorized === true,
    posterGenerationRequired: body.posterGenerationRequired !== false,
    creativeProfile: sanitizeCreativeProfile(body.creativeProfile),
    ...(campaign?.id ? { campaign } : {}),
    ...(delivery ? { delivery } : {}),
    p0Selection: sanitizeP0Selection(body.p0Selection, delivery),
    planning,
    requestedAt: new Date().toISOString()
  };
}

async function waitForActiveRun(redis, sku, accountId, attempts = 6) {
  for (let index = 0; index < attempts; index += 1) {
    const existing = await findActiveRun(redis, sku, accountId);
    if (existing) return existing;
    if (index < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

// Full runs contain every downloaded chapter and provider payload. Returning
// that raw object makes a detail click compete with the worker for bandwidth
// and can leave a serverless response open for minutes. Keep the UI contract,
// but bound the evidence and diagnostic fields that are only needed for the
// detail view.
function detailPayload(run) {
  const copy = JSON.parse(JSON.stringify(run));
  const artifacts = copy.artifacts || {};
  if (artifacts.book) {
    artifacts.book.description = String(artifacts.book.description || '').slice(0, 4000);
  }
  if (artifacts.evidence && Array.isArray(artifacts.evidence.chapters)) {
    const chapters = artifacts.evidence.chapters;
    artifacts.evidence.chapterCount = chapters.length;
    artifacts.evidence.chapters = chapters.slice(0, 80).map((chapter) => ({
      ...chapter,
      content: String(chapter.content || '').slice(0, 8000),
      title: String(chapter.title || '').slice(0, 300)
    }));
  }
  // The chapter index is useful to the worker, not to the browser detail view.
  delete artifacts.chapterList;
  if (artifacts.creativeDraft) {
    const draft = artifacts.creativeDraft;
    artifacts.creativeDraft = {
      parts: Object.fromEntries(Object.entries(draft.parts || {}).map(([key, value]) => [key, { status: value?.status || 'ready' }])),
      inFlight: draft.inFlight || {},
      failures: Object.fromEntries(Object.entries(draft.failures || {}).map(([key, value]) => [key, {
        attempt: value?.attempt || 1,
        error: String(value?.error || '').slice(0, 300),
        nextAttemptAt: value?.nextAttemptAt || ''
      }])),
      usage: Array.isArray(draft.usage) ? draft.usage.slice(-24) : []
    };
  }
  if (Array.isArray(artifacts.events)) artifacts.events = artifacts.events.slice(-120);
  if (Array.isArray(copy.events)) copy.events = copy.events.slice(-80).map((event) => ({ at: event.at, type: event.type, message: String(event.message || '').slice(0, 500) }));
  if (Array.isArray(artifacts.posts)) artifacts.posts = artifacts.posts.map((post) => ({ ...post, content: String(post.content || '').slice(0, 12000), zhContent: String(post.zhContent || '').slice(0, 12000) }));
  if (Array.isArray(artifacts.images)) artifacts.images = artifacts.images.map((image) => ({ ...image, prompt: String(image.prompt || '').slice(0, 5000), zhPrompt: String(image.zhPrompt || '').slice(0, 5000) }));
  if (artifacts.videoPrompt) artifacts.videoPrompt = { ...artifacts.videoPrompt, adCopy: String(artifacts.videoPrompt.adCopy || '').slice(0, 10000), buildRequirement: String(artifacts.videoPrompt.buildRequirement || '').slice(0, 10000) };
  if (artifacts.videoPromptDraft) artifacts.videoPromptDraft = { ...artifacts.videoPromptDraft, adCopy: String(artifacts.videoPromptDraft.adCopy || '').slice(0, 10000), buildRequirement: String(artifacts.videoPromptDraft.buildRequirement || '').slice(0, 10000) };
  copy.artifacts = artifacts;
  return copy;
}

function copyAssetPayload(run) {
  return {
    id: run.id,
    posts: (Array.isArray(run?.artifacts?.posts) ? run.artifacts.posts : []).map((post) => ({
      type: String(post?.type || ''),
      content: String(post?.content || '').slice(0, 12000),
      zhContent: String(post?.zhContent || '').slice(0, 12000)
    }))
  };
}

async function listRunsPayload(redis, loader = listRunSummaries) {
  return { runs: await loader(redis, 50) };
}

async function archiveFailedRuns(redis, loader = listRuns) {
  // Read the durable index, rather than just the currently visible list, so a
  // failed task cannot reappear after older entries are paged into view.
  const runs = await loader(redis, 500);
  const archived = [];
  for (const run of runs) {
    const hasFailedStage = Object.values(run?.stages || {}).some((stage) => stage?.status === 'failed');
    if (run?.state !== 'failed' && !hasFailedStage) continue;
    run.state = 'archived';
    run.archivedAt = new Date().toISOString();
    run.events = [...(run.events || []), { at: run.archivedAt, type: 'failed_run_archived', message: 'Operator cleared this failed task from the production console; external Code, links, and paid task records remain unchanged' }].slice(-80);
    // Archiving is intentionally invisible to ordering: the task should
    // disappear from the console without rewriting its place in the durable
    // history index or touching its external tracking/media records.
    await saveRun(redis, run, { preserveUpdatedAt: true });
    archived.push(run.id);
  }
  return archived;
}

function hasExternalMediaTask(run) {
  return [run?.artifacts?.video, run?.artifacts?.referenceVideo, ...(run?.artifacts?.images || [])]
    .some((asset) => String(asset?.threadId || asset?.taskId || '').trim());
}

function archiveUnstartedRun(run) {
  if (run?.state !== 'queued') {
    throw Object.assign(new Error('Only an unstarted queued task can be cancelled'), { status: 409 });
  }
  if (hasExternalMediaTask(run)) {
    throw Object.assign(new Error('A task with an external media submission cannot be cancelled through the unstarted-task path'), { status: 409 });
  }
  const archivedAt = new Date().toISOString();
  run.state = 'archived';
  run.archivedAt = archivedAt;
  run.events = [...(run.events || []), {
    at: archivedAt,
    type: 'unstarted_run_cancelled',
    message: 'Operator cancelled this P0 selection before any production stage or paid media submission began'
  }].slice(-80);
  return run;
}

function holdRunForP0Review(run) {
  if (!['queued', 'running'].includes(String(run?.state || ''))) {
    throw Object.assign(new Error('Only queued or active tasks without a terminal outcome can be held for P0 review'), { status: 409 });
  }
  if (hasExternalMediaTask(run)) {
    throw Object.assign(new Error('A task with an external media submission cannot be held through the P0 review path'), { status: 409 });
  }
  if (String(run?.stages?.P7?.status || '') === 'done') {
    throw Object.assign(new Error('A finished external draft cannot be held through the P0 review path'), { status: 409 });
  }
  const heldAt = new Date().toISOString();
  run.state = 'blocked';
  run.operatorHold = {
    reason: 'p0_verification_required',
    heldAt,
    resumable: true
  };
  run.stages = run.stages || {};
  run.stages.P0 = {
    ...(run.stages.P0 || {}),
    status: 'blocked',
    blockedReason: 'p0_verification_required',
    label: 'P0 榜单指标或目标应用归属待复核；后续节点已暂停',
    heldAt,
    updatedAt: heldAt
  };
  run.events = [...(run.events || []), {
    at: heldAt,
    type: 'p0_verification_hold',
    message: 'Operator held this run before external media submission because its P0 ranking evidence requires review'
  }].slice(-120);
  return run;
}

function releaseP0ReviewHold(run) {
  if (String(run?.state || '') !== 'blocked' || String(run?.operatorHold?.reason || '') !== 'p0_verification_required') {
    throw Object.assign(new Error('This task is not held for P0 review'), { status: 409 });
  }
  if (hasExternalMediaTask(run)) {
    throw Object.assign(new Error('A task with an external media submission cannot be resumed through the P0 review path'), { status: 409 });
  }
  const resumedAt = new Date().toISOString();
  run.state = 'running';
  run.operatorHold = { ...run.operatorHold, resumedAt, resumable: false };
  run.stages = run.stages || {};
  run.stages.P0 = {
    ...(run.stages.P0 || {}),
    status: 'done',
    blockedReason: '',
    label: 'P0 审核保留已解除；按已保存的选择证据继续',
    resumedAt,
    updatedAt: resumedAt
  };
  run.events = [...(run.events || []), {
    at: resumedAt,
    type: 'p0_verification_hold_released',
    message: 'Operator released the P0 review hold; the existing durable stages may resume'
  }].slice(-120);
  return run;
}

async function loadRunView(redis, id, detailLoader = getRunDetail, summaryLoader = getRunSummary, detailDeadlineMs = 2500) {
  // A drawer must never wait on a large/legacy detail snapshot before it can
  // show the durable progress summary. The summary is written with every run
  // transition, while an older detail snapshot can be rebuilt in the background.
  const summary = await summaryLoader(redis, id);
  if (!summary) {
    const detail = await detailLoader(redis, id);
    return detail ? { run: detail, partial: false } : { run: null, partial: false };
  }
  let timeout;
  const detail = await Promise.race([
    Promise.resolve().then(() => detailLoader(redis, id)).catch(() => null),
    new Promise((resolve) => { timeout = setTimeout(() => resolve(null), detailDeadlineMs); })
  ]);
  clearTimeout(timeout);
  if (detail) return { run: detail, partial: false };
  return { run: { ...summary, _summary: false, _detailPartial: true }, partial: true };
}

async function resolvePlanning(redis, value) {
  const planning = sanitizePlanning(value);
  if (!planning?.planId) return planning;
  const job = await getCreativePlan(redis, planning.planId);
  if (!job || job.state !== 'completed' || !job.artifacts?.plan) return planning;
  const plan = job.artifacts.plan;
  return {
    ...planning,
    preferredModel: job.input?.preferredModelChoice || planning.preferredModel,
    actualModel: job.artifacts?.usage?.model || job.input?.modelChoice || planning.actualModel,
    fallbackUsed: Boolean(job.input?.fallbackUsed),
    completedAt: job.stages?.analysis?.completedAt || job.updatedAt,
    strategy: {
      editorialThesis: String(plan.editorialThesis || '').slice(0, 1200),
      rationale: plan.rationale && typeof plan.rationale === 'object' ? plan.rationale : {},
      recommendedProfile: plan.recommendedProfile && typeof plan.recommendedProfile === 'object' ? plan.recommendedProfile : {},
      copyBlueprint: plan.copyBlueprint && typeof plan.copyBlueprint === 'object' ? plan.copyBlueprint : {},
      videoBlueprint: plan.videoBlueprint && typeof plan.videoBlueprint === 'object' ? plan.videoBlueprint : {},
      posterBlueprint: plan.posterBlueprint && typeof plan.posterBlueprint === 'object' ? plan.posterBlueprint : {},
      evidence: Array.isArray(plan.evidence) ? plan.evidence.slice(0, 5).map((item) => ({ chapter: Number(item.chapter || 0), quote: String(item.quote || '').slice(0, 240), why: String(item.why || '').slice(0, 300) })) : []
    }
  };
}

module.exports = async (req, res) => {
  if (String(req.method || '').toUpperCase() === 'GET') {
    if (!requireSession(req, res)) return;
  } else if (!requireOperatorMutation(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  try {
    if (req.method === 'GET') {
      const id = text(req.query?.id, 100);
      if (id && req.query?.asset === 'ready') {
        let assets = await getRunAssets(redis, id);
        if (!assets) {
          // Old records have the bounded detail projection even though they
          // predate the dedicated asset snapshot. Prefer it over the raw run
          // so migration does not pull a full book's chapter payload.
          const legacy = await getRunDetail(redis, id) || await getRun(redis, id);
          if (legacy) {
            assets = runAssets(legacy);
            await saveRunAssets(redis, legacy);
          }
        }
        if (!assets) return res.status(404).json({ error: 'Run not found' });
        return res.status(200).json({ run: assets });
      }
      const view = id ? await loadRunView(redis, id) : { run: null, partial: false };
      if (id && !view.run) return res.status(404).json({ error: 'Run not found' });
      if (id && req.query?.asset === 'copy') return !view.partial ? res.status(200).json(copyAssetPayload(view.run)) : res.status(202).json({ pending: true, posts: [] });
      if (req.query?.id && req.query?.asset) return res.status(400).json({ error: 'Unsupported asset view' });
      if (id && !view.partial) return res.status(200).json({ run: view.run });
      if (id && view.partial) return res.status(202).json(view);
      return res.status(200).json(await listRunsPayload(redis));
    }
    if (req.method === 'PATCH') {
      if (req.body?.action === 'archive_failed_all') {
        return res.status(200).json({ archived: await archiveFailedRuns(redis) });
      }
      const run = await getRun(redis, text(req.body?.id, 100));
      if (!run) return res.status(404).json({ error: 'Run not found' });
      if (req.body?.action === 'cancel_unstarted') {
        archiveUnstartedRun(run);
        await saveRun(redis, run, { preserveUpdatedAt: true });
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'authorize_paid_media') {
        authorizePaidMediaSubmission(run);
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'review_video_fidelity') {
        const executionQa = reviewVideoFidelity(run, req.body || {});
        await saveRun(redis, run);
        return res.status(200).json({ run, executionQa });
      }
      if (req.body?.action === 'hold_for_p0_review') {
        holdRunForP0Review(run);
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'release_p0_review_hold') {
        releaseP0ReviewHold(run);
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'refresh_analytics') {
        if (!run.artifacts?.linkId && !run.artifacts?.code) return res.status(409).json({ error: 'A verified Code or link is required before querying analytics' });
        const days = Math.max(1, Math.min(Number(req.body?.days) || 30, 180));
        await refreshAnalytics(run, days);
        run.events.push({ at: new Date().toISOString(), type: 'analytics_refreshed', message: `Real-time attribution refreshed for the most recent ${days} days` });
        await saveRun(redis, run, { preserveUpdatedAt: true });
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'reconcile_attribution') {
        const stage = run.stages?.P5 || {};
        const blockedReason = String(stage.blockedReason || '');
        if (!['ambiguous', 'blocked'].includes(String(stage.status || ''))
          || !['attribution_write_ambiguous', 'attribution_provider_unavailable'].includes(blockedReason)) {
          return res.status(409).json({ error: 'P5 当前没有可恢复的归因歧义或服务阻塞' });
        }
        const phase = ['code_reconcile', 'link_reconcile', 'code', 'link'].includes(String(stage.phase || ''))
          ? String(stage.phase)
          : (stage.linkCreateIntent ? 'link_reconcile' : stage.codeCreateIntent ? 'code_reconcile' : 'code');
        run.state = 'running';
        run.stages.P5 = {
          ...stage,
          status: 'waiting',
          phase,
          blockedReason: '',
          nextAttemptAt: '',
          attributionRetryCount: 0,
          attributionReconcileAttempts: 0,
          recoverable: true,
          error: '',
          label: '已人工确认，P5 将先进行只读归因核验'
        };
        run.events.push({ at: new Date().toISOString(), type: 'attribution_reconcile_requested', message: 'Operator reopened P5 for read-only Code/link reconciliation; no duplicate write will be submitted' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'skip_posters') {
        if (run.stages?.P3?.status !== 'done') return res.status(409).json({ error: 'Finished creative copy is required before skipping poster generation' });
        if (run.stages?.P3_5?.status === 'done') return res.status(409).json({ error: 'Completed poster generation cannot be skipped' });
        skipUnsubmittedPosters(run);
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'attach_catalogue_evidence') {
        attachOperatorCatalogueEvidence(run, req.body?.catalogueEvidence);
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'delete_asset') {
        const asset = text(req.body?.asset, 40);
        const paidInFlight = (value) => ['submitting', 'running'].includes(String(value?.status || ''));
        if (asset === 'copy') {
          run.artifacts.posts = [];
          run.artifacts.translations = null;
          if (run.artifacts.review) run.artifacts.review.posts = [];
        } else if (asset === 'video') {
          if (paidInFlight(run.artifacts.video)) return res.status(409).json({ error: 'The paid video is still generating and cannot be removed yet' });
          run.artifacts.video = null;
          if (run.artifacts.review) run.artifacts.review.video = null;
        } else if (asset === 'reference_video') {
          if (paidInFlight(run.artifacts.referenceVideo)) return res.status(409).json({ error: 'The reference video is still generating and cannot be removed yet' });
          run.artifacts.referenceVideo = null;
        } else if (asset === 'posters') {
          if ((run.artifacts.images || []).some(paidInFlight)) return res.status(409).json({ error: 'A paid poster is still generating and cannot be removed yet' });
          run.artifacts.images = [];
          if (run.artifacts.review) run.artifacts.review.images = [];
        } else {
          return res.status(400).json({ error: 'Unsupported asset removal' });
        }
        run.events.push({ at: new Date().toISOString(), type: 'asset_removed', message: `${asset} removed from the console view` });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'reuse_verified_video') {
        const sourceRun = await getRun(redis, text(req.body?.sourceRunId, 100));
        if (!sourceRun) return res.status(404).json({ error: 'Source run not found' });
        const { sourceVideo, videoUrl } = reusableSiblingVideo(run, sourceRun);
        await providers.validateVideo(videoUrl);
        const failedVideo = run.artifacts?.video || {};
        run.artifacts.videoFailures = [...(run.artifacts.videoFailures || []), {
          threadId: String(failedVideo.threadId || run.stages?.P4?.threadId || ''),
          status: String(failedVideo.status || 'failed'),
          error: String(run.stages?.P4?.error || ''),
          failedAt: String(run.stages?.P4?.updatedAt || new Date().toISOString())
        }].slice(-5);
        run.artifacts.video = {
          ...sourceVideo,
          status: 'completed',
          videoUrls: [videoUrl],
          reusedFromRunId: sourceRun.id,
          reusedFromThreadId: String(sourceVideo.threadId || sourceRun.stages?.P4?.threadId || ''),
          originalFailedThreadId: String(failedVideo.threadId || run.stages?.P4?.threadId || ''),
          reusedAt: new Date().toISOString()
        };
        run.artifacts.video.executionQa = {
          status: 'pending_manual_review',
          score: null,
          criteria: {},
          defects: [],
          createdAt: new Date().toISOString(),
          invalidatedReason: 'video_asset_reused'
        };
        run.stages.P4 = {
          ...run.stages.P4,
          status: 'done',
          label: '同 SKU 已验证视频已复用；原失败任务保留审计',
          sourceRunId: sourceRun.id,
          sourceThreadId: String(sourceVideo.threadId || sourceRun.stages?.P4?.threadId || ''),
          originalFailedThreadId: String(failedVideo.threadId || run.stages?.P4?.threadId || ''),
          error: '',
          completedAt: new Date().toISOString(),
          recoverable: false
        };
        run.stages.P6 = { status: 'waiting' };
        run.stages.P7 = { status: 'waiting' };
        run.state = 'running';
        run.events.push({ at: new Date().toISOString(), type: 'verified_sibling_video_reused', message: `Verified same-SKU media reused from ${sourceRun.id}; no paid video was submitted` });
        await saveRun(redis, run);
        return res.status(200).json({ run, reusedFromRunId: sourceRun.id });
      }
      if (req.body?.action === 'creative_variant') {
        if (run.input?.creativeProfile?.uniquenessRequired === true && String(run.input?.campaign?.id || '').trim()) {
          return res.status(409).json({ error: 'Campaign copy variants require a new uniqueness reservation and are disabled for this run' });
        }
        if (!run.artifacts?.book || !run.artifacts?.evidence?.chapters?.length || !run.artifacts?.code) return res.status(409).json({ error: 'Creative inputs are not ready' });
        const current = { posts: run.artifacts.posts, videoPrompt: run.artifacts.videoPrompt, posterPrompts: run.artifacts.posterPrompts };
        const allowed = (value, values, fallback) => values.includes(String(value || '')) ? String(value) : fallback;
        const existingProfile = run.input.creativeProfile || {};
        const profile = {
          ...existingProfile,
          modelChoice: text(req.body?.modelChoice, 80) || existingProfile.modelChoice || 'glm-5.3-flash',
          forceEnglish: req.body?.forceEnglish === undefined ? existingProfile.forceEnglish === true : req.body.forceEnglish === true,
          emojiRange: req.body?.emojiRange === '3-5' || req.body?.emojiRange === '2-4' ? req.body.emojiRange : existingProfile.emojiRange || '2-4',
          copyStyle: allowed(req.body?.copyStyle, ['system_best', 'revenge_comeback', 'forbidden_tension', 'dark_redemption'], existingProfile.copyStyle || 'system_best'),
          ctaStyle: allowed(req.body?.ctaStyle, ['story_cliffhanger', 'identity_reveal', 'romantic_tension', 'revenge_payoff'], existingProfile.ctaStyle || 'story_cliffhanger'),
          voiceStyle: allowed(req.body?.voiceStyle, ['confessional', 'cinematic', 'confrontation', 'mystery', 'reflective', 'punchy', 'yearning'], existingProfile.voiceStyle || 'cinematic'),
          delivery: run.input.delivery || null
        };
        run.input.creativeProfile = { ...existingProfile, forceEnglish: profile.forceEnglish, emojiRange: profile.emojiRange, copyStyle: profile.copyStyle, ctaStyle: profile.ctaStyle, voiceStyle: profile.voiceStyle };
        // A copy variant must not spend model calls regenerating video and poster
        // prompts that will not be used. Generate only the two posts, then run
        // them through the same full deterministic gate with the locked media
        // artifacts preserved.
        const result = await providers.generateCreative(run.artifacts.book, run.artifacts.evidence.chapters, run.artifacts.code, run.artifacts.shortUrl, current, profile, 'posts');
        result.creative = {
          ...result.creative,
          videoPrompt: current.videoPrompt,
          posterPrompts: current.posterPrompts,
          qualityReview: run.artifacts.qualityReview || { recommendation: 'keep', status: 'verified', conclusion: '文案变体已完成确定性校验。', why: '语言、表情、证据、Code、链接和平台路由均由后端逐项检查。', target: 'copy' }
        };
        const creative = normalizeCreative(result, run, { skipMedia: true });
        run.artifacts.creativeVersions = [...(run.artifacts.creativeVersions || []), { at: new Date().toISOString(), posts: run.artifacts.posts, videoPrompt: run.artifacts.videoPrompt, posterPrompts: run.artifacts.posterPrompts }].slice(-3);
        run.artifacts.posts = creative.posts;
        run.artifacts.translations = { language: 'zh-CN', posts: creative.posts.map((item) => item.zhContent) };
        run.artifacts.videoPrompt = creative.videoPrompt;
        run.artifacts.posterPrompts = creative.posterPrompts;
        run.artifacts.qualityReview = creative.qualityReview;
        run.artifacts.qualityReview.phase = 'post_generation';
        run.artifacts.qualityReview.reviewedAt = new Date().toISOString();
        run.artifacts.optimization = { status: 'manual_variant_applied', review: creative.qualityReview, resolvedAt: new Date().toISOString() };
        run.artifacts.usage = run.artifacts.usage || {};
        run.artifacts.usage.creativeVariant = { model: result.model, responseId: result.responseId, ...result.usage };
        run.events.push({ at: new Date().toISOString(), type: 'creative_variant_ready', message: 'The selected AI model created a new evidence-grounded creative version' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'rewrite_video_prompt') {
        if (!run.artifacts?.book || !run.artifacts?.evidence?.chapters?.length || !run.artifacts?.code) return res.status(409).json({ error: 'Locked book, chapter evidence, and Code are required before rewriting a video prompt' });
        const current = { videoPrompt: run.artifacts.videoPrompt };
        const modelChoice = rewriteModelChoice(req.body, run);
        const result = await providers.generateCreative(run.artifacts.book, run.artifacts.evidence.chapters, run.artifacts.code, run.artifacts.shortUrl, current, { ...(run.input.creativeProfile || {}), modelChoice, delivery: run.input.delivery || null }, 'videoPrompt');
        const draft = result.creative?.videoPrompt || {};
        for (const key of ['hook', 'valuePromise', 'escalation', 'reversal', 'cliffhanger', 'adCopy', 'buildRequirement']) if (String(draft[key] || '').trim().length < 12) throw new providers.ProviderError(`Video rewrite omitted ${key}`);
        if (!Array.isArray(draft.sourceEvidence) || draft.sourceEvidence.length < 3) throw new providers.ProviderError('Video rewrite requires three source evidence beats');
        run.artifacts.videoPromptDraft = { ...draft, status: 'ready_for_review', id: `video_${Date.now().toString(36)}`, generatedAt: new Date().toISOString(), model: result.model, responseId: result.responseId, usage: result.usage };
        run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), { section: 'videoPromptRewrite', requestedModel: run.input?.creativeProfile?.modelChoice, model: result.model, responseId: result.responseId, completedAt: new Date().toISOString(), ...result.usage }].slice(-24);
        run.events.push({ at: new Date().toISOString(), type: 'video_prompt_rewritten', message: 'AI produced a source-grounded video prompt draft for operator review; no paid video was submitted' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'prepare_evidence_video_revision') {
        if (run.stages?.P4?.status !== 'failed') return res.status(409).json({ error: 'Only a definitively failed video can be prepared for revision' });
        if (run.artifacts?.videoRevision?.threadId || run.artifacts?.videoRevision?.submitAttemptedAt) {
          return res.status(409).json({ error: 'A revised video task already exists for this run' });
        }
        // Attribution is route-dependent. Storyca and Novelvio intentionally
        // defer Code creation, so a revision must only require the locked
        // book/evidence; Facebook NovelFlow/Astra routes still carry their
        // verified Code when available.
        if (!run.artifacts?.book || !run.artifacts?.evidence?.chapters?.length) {
          return res.status(409).json({ error: 'Locked book and chapter evidence are required before preparing a revision' });
        }
        const fallback = sourceGroundedCreativeFallback(run, { diagnostics: true, allowLowInfoVideo: true });
        const prompt = fallback?.creative?.videoPrompt;
        if (!prompt || !Array.isArray(prompt.sourceEvidence) || prompt.sourceEvidence.length < 3) {
          return res.status(409).json({ error: text(fallback?.error, 240) || 'Locked evidence cannot form a validated video revision' });
        }
        run.artifacts.videoPromptDraft = {
          ...prompt,
          status: 'ready_for_review',
          id: `video_evidence_${Date.now().toString(36)}`,
          generatedAt: new Date().toISOString(),
          model: 'evidence-continuation',
          fallbackReason: 'glm-5.3-flash returned invalid structured output twice; revision is bounded to saved source evidence'
        };
        run.events.push({ at: new Date().toISOString(), type: 'evidence_video_revision_prepared', message: 'A deterministic video revision contract was prepared from the exact saved chapter evidence after GLM structured-output failure; no paid video was submitted' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'approve_video_prompt') {
        const draft = run.artifacts?.videoPromptDraft;
        if (!draft || draft.status !== 'ready_for_review') return res.status(409).json({ error: 'No video-prompt draft is waiting for review' });
        run.artifacts.videoPrompt = { ...draft };
        run.artifacts.videoPromptDraft = { ...draft, status: 'approved', approvedAt: new Date().toISOString() };
        run.artifacts.videoRevision = null;
        run.events.push({ at: new Date().toISOString(), type: 'video_prompt_approved', message: 'Operator approved the rewritten video prompt; a separate confirmation is still required before paid video submission' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'discard_video_prompt') {
        if (!run.artifacts?.videoPromptDraft) return res.status(409).json({ error: 'No video-prompt draft is available to discard' });
        run.artifacts.videoPromptDraft = null;
        run.events.push({ at: new Date().toISOString(), type: 'video_prompt_discarded', message: 'Operator kept the previous video prompt' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'distribution_plan') {
        if (!run.artifacts?.book || !run.artifacts?.posts?.length) return res.status(409).json({ error: 'Finished copy is required before creating a distribution recommendation' });
        const result = await providers.generateDistributionPlan(run.artifacts.book, {
          posts: run.artifacts.posts, videoPrompt: run.artifacts.videoPrompt, posterPrompts: run.artifacts.posterPrompts,
          storyBrief: run.artifacts.storyBrief?.plan || null
        }, run.artifacts?.modelRoute?.activeModel || run.input?.creativeProfile?.modelChoice || 'hy3');
        run.artifacts.distribution = { ...result.plan, status: 'ready', generatedAt: new Date().toISOString(), model: result.model };
        if (run.artifacts.review) run.artifacts.review.distribution = run.artifacts.distribution;
        run.artifacts.modelActivity = [...(run.artifacts.modelActivity || []), { section: 'distribution', requestedModel: run.artifacts?.modelRoute?.activeModel || run.input?.creativeProfile?.modelChoice || 'hy3', model: result.model, responseId: result.responseId, completedAt: new Date().toISOString(), ...result.usage }].slice(-24);
        run.events.push({ at: new Date().toISOString(), type: 'distribution_ready', message: 'Manual channel recommendations and reusable hook are ready' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'set_creative_model') {
        const modelChoice = text(req.body?.modelChoice, 80);
        if (!CREATIVE_PROFILE_OPTIONS.modelChoice.has(modelChoice)) return res.status(400).json({ error: 'Unsupported creative model' });
        if (run.stages?.P3?.status === 'done' || run.artifacts?.video || (run.artifacts?.images || []).length) return res.status(409).json({ error: 'The creative model cannot change after creative media has started' });
        const existingProfile = run.input.creativeProfile || {};
        // A uniqueness-required campaign must pin both post formats before P3.
        // Older batch clients supplied uniquenessRequired without these fields,
        // making otherwise valid source-grounded output fail deterministically
        // as “assigned format 0”.  Fill only the missing reviewed defaults;
        // never overwrite an operator-selected format.
        run.input.creativeProfile = {
          ...existingProfile,
          modelChoice,
          ...(existingProfile.uniquenessRequired === true ? {
            creativeForm: existingProfile.creativeForm || 'evidence_discovery',
            secondaryForm: existingProfile.secondaryForm || 'accusation_aftershock',
            openingGrammar: existingProfile.openingGrammar || 'conflict_object_action',
            hookDevice: existingProfile.hookDevice || 'object_closeup'
          } : {})
        };
        const planning = await resolvePlanning(redis, req.body?.planning);
        if (planning && !run.input?.planning?.strategy) run.input.planning = planning;
        delete run.artifacts.creativeDraft;
        delete run.artifacts.modelRoute;
        run.state = 'running';
        if (run.stages?.P2?.status !== 'done') {
          if (run.artifacts?.evidence) run.artifacts.evidence.storyBrief = {};
          run.artifacts.storyBrief = null;
          run.stages.P2 = { ...(run.stages.P2 || {}), status: 'waiting', phase: 'model_switched', recoverable: true, nextAttemptAt: '', error: '', label: `${modelChoice} queued from saved chapter evidence` };
        }
        run.stages.P3 = { status: 'waiting', attempt: 0, phase: 'model_switched', nextAttemptAt: '', error: '', label: `${modelChoice} queued for creative generation` };
        run.events.push({ at: new Date().toISOString(), type: 'creative_model_switched', message: `Creative model switched to ${modelChoice} before paid media submission` });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'attach_planning_snapshot') {
        if (run.input?.planning?.strategy) {
          if (run.artifacts?.qualityReview && !run.artifacts.qualityReview.phase) {
            const reviewActivity = [...(run.artifacts.modelActivity || [])].reverse().find((item) => item.section === 'qualityReview' && item.validationStatus !== 'rejected');
            run.artifacts.qualityReview.phase = 'post_generation';
            run.artifacts.qualityReview.reviewedAt = reviewActivity?.completedAt || run.stages?.P3?.completedAt || run.updatedAt;
            await saveRun(redis, run);
            return res.status(200).json({ run, migrated: true });
          }
          return res.status(200).json({ run, unchanged: true });
        }
        const planning = await resolvePlanning(redis, req.body?.planning);
        if (!planning?.strategy) return res.status(409).json({ error: 'Completed pre-production strategy not found' });
        run.input.planning = planning;
        run.events.push({ at: new Date().toISOString(), type: 'planning_snapshot_attached', message: 'Immutable pre-production strategy snapshot attached to the run' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'optimization_decision') {
        const decision = text(req.body?.decision, 20);
        const optimization = run.artifacts?.optimization;
        if (optimization?.status !== 'awaiting_confirmation') return res.status(409).json({ error: 'No pending AI optimization exists for this run' });
        if (decision === 'apply') {
          optimization.dueAt = new Date(Date.now() - 1000).toISOString();
          optimization.status = 'awaiting_confirmation';
          run.events.push({ at: new Date().toISOString(), type: 'creative_optimization_confirmed', message: 'Operator confirmed the DeepSeek refinement' });
        } else if (decision === 'keep') {
          optimization.status = 'kept_by_operator';
          optimization.resolvedAt = new Date().toISOString();
          run.events.push({ at: new Date().toISOString(), type: 'creative_optimization_kept', message: 'Operator kept the current creative package' });
        } else return res.status(400).json({ error: 'Unsupported optimization decision' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'approve_evidence_candidate') {
        const candidate = run.artifacts?.evidenceContinuationCandidate;
        if (candidate?.status !== 'awaiting_operator_review') return res.status(409).json({ error: 'No validated evidence continuation candidate is awaiting approval' });
        if (run.artifacts?.video?.threadId || (run.artifacts?.images || []).some((asset) => asset?.taskId)) {
          return res.status(409).json({ error: 'Evidence continuation cannot replace a run after paid media has started' });
        }
        // The candidate was normalized against the same evidence, language,
        // attribution and platform checks before it was saved. This explicit
        // operator action promotes it; the worker still owns every later paid
        // submission and persists the external task IDs before polling.
        run.artifacts.posts = candidate.posts;
        run.artifacts.translations = candidate.translations;
        run.artifacts.videoPrompt = candidate.videoPrompt;
        run.artifacts.posterPrompts = candidate.posterPrompts;
        run.artifacts.qualityReview = candidate.qualityReview;
        run.artifacts.evidenceContinuationCandidate = {
          ...candidate,
          status: 'operator_approved',
          approvedAt: new Date().toISOString()
        };
        run.artifacts.optimization = { ...(run.artifacts.optimization || {}), status: 'evidence_continuation_approved', approvedAt: new Date().toISOString() };
        run.state = 'running';
        setStage(run, 'P3', 'done', { label: '运营已批准锁定章节证据创意包，继续生成海报和视频', phase: 'evidence_continuation_approved', recoverable: false, error: '', nextAttemptAt: '' });
        run.events.push({ at: new Date().toISOString(), type: 'evidence_continuation_approved', message: 'Operator explicitly approved the validated locked-evidence creative package; paid media remains governed by the existing run authorization' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'continue_from_evidence') {
        if (run.stages?.P3?.status === 'done') return res.status(409).json({ error: 'Creative package is already complete' });
        if (run.artifacts?.video?.threadId || run.artifacts?.video?.status === 'running') return res.status(409).json({ error: 'Evidence continuation is only available before a video task exists' });
        const fallback = sourceGroundedCreativeFallback(run, { diagnostics: true, allowLowInfoVideo: true });
        if (!fallback.creative) {
          // normalizeCreative only emits fixed validation categories.  Keeping
          // this actionable diagnosis behind requireSession avoids exposing
          // the locked source while preventing a recurring opaque 409.
          const reason = text(fallback.error, 240) || 'Locked chapter evidence cannot form a validated creative package';
          run.events.push({ at: new Date().toISOString(), type: 'operator_evidence_continuation_blocked', message: `Evidence continuation validation blocked: ${reason}` });
          await saveRun(redis, run);
          return res.status(409).json({ error: reason });
        }
        applySourceGroundedCreativeFallback(run, fallback.creative, run.stages?.P3?.error || 'Operator requested evidence continuation after repeated structured-output failures');
        run.events.push({ at: new Date().toISOString(), type: 'operator_evidence_continuation', message: 'Operator selected the validated locked-evidence creative package; no model or paid media was submitted' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action === 'refresh_evidence_candidate') {
        if (run.artifacts?.video?.threadId || run.artifacts?.video?.status === 'running' || (run.artifacts?.images || []).some((asset) => asset?.taskId)) {
          return res.status(409).json({ error: 'Evidence candidate cannot be rebuilt after a media task exists' });
        }
        const fallback = sourceGroundedCreativeFallback(run, { diagnostics: true, allowLowInfoVideo: true });
        if (!fallback.creative) return res.status(409).json({ error: text(fallback.error, 240) || 'Locked chapter evidence cannot form a validated creative package' });
        applySourceGroundedCreativeFallback(run, fallback.creative, 'Operator refreshed the locked-evidence candidate to use one continuous video chapter window');
        run.events.push({ at: new Date().toISOString(), type: 'operator_evidence_candidate_refreshed', message: 'Operator refreshed the local evidence candidate; no model or paid media was submitted' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (req.body?.action !== 'retry') return res.status(400).json({ error: 'Unsupported action' });
      const blocked = Object.entries(run.stages).find(([, value]) => value.status === 'ambiguous');
      if (blocked) return res.status(409).json({ error: `${blocked[0]} has an ambiguous paid submission and cannot be retried automatically` });
      const videoCapacityLimit = Object.entries(run.stages).find(([, value]) => value.status === 'blocked' && ['daily_video_limit', 'hourly_video_limit'].includes(String(value.blockedReason || '')));
      if (videoCapacityLimit) {
        run.state = 'running';
        run.stages[videoCapacityLimit[0]] = { ...videoCapacityLimit[1], status: 'prepared', retryCount: Number(videoCapacityLimit[1].retryCount || 0) + 1, error: '' };
        run.events.push({ at: new Date().toISOString(), type: 'video_limit_retry_requested', message: 'Video submission queued after daily capacity block' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      // P4 can be safely re-queued after a *pre-submit* AC rejection (budget,
      // configuration, or definitive provider capacity). These states have no
      // external threadId and the pipeline already released the daily video
      // slot. Clearing only the saved backoff lets the worker retry once; it
      // never bypasses an ambiguous/paid task (guarded above).
      const videoPreSubmitWait = run.stages.P4?.status === 'prepared'
        && ['ac_points_budget', 'ac_configuration_wait', 'ac_capacity_wait', 'ac_provider_unavailable'].includes(String(run.stages.P4?.blockedReason || ''));
      if (videoPreSubmitWait) {
        run.state = 'running';
        run.stages.P4 = {
          ...run.stages.P4,
          status: 'prepared',
          retryCount: Number(run.stages.P4.retryCount || 0) + 1,
          nextAttemptAt: '',
          error: '',
          recoverable: true,
          operatorRetryAt: new Date().toISOString()
        };
        run.events.push({ at: new Date().toISOString(), type: 'video_pre_submit_retry_requested', message: 'Operator requested a safe retry after a pre-submit AC wait; no existing paid task was resubmitted' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      const partialPoster = run.stages.P3_5?.status === 'partial' ? ['P3_5', run.stages.P3_5] : null;
      if (partialPoster) {
        const retryNumber = Number(partialPoster[1].retryCount || 0) + 1;
        for (const asset of run.artifacts.images || []) {
          if (!['failed', 'expired'].includes(String(asset.status || ''))) continue;
          asset.manualRetryCount = Number(asset.manualRetryCount || 0) + 1;
          asset.taskId = '';
          asset.url = '';
          asset.error = '';
          asset.status = 'prepared';
          asset.idempotencyKey = providers.sha(`${run.id}:${asset.variant}:${asset.prompt}:manual:${asset.manualRetryCount}`);
        }
        run.state = 'running';
        run.stages.P3_5 = { ...partialPoster[1], status: 'running', retryCount: retryNumber, error: '', label: '海报已单独排队重试，视频结果保持不变' };
        run.stages.P6 = { status: 'waiting' };
        run.events.push({ at: new Date().toISOString(), type: 'poster_manual_retry_requested', message: 'Operator explicitly queued the failed poster branch for one retry' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (run.state === 'failed' && run.stages.P3?.status === 'waiting') {
        run.state = 'running';
        run.stages.P3 = { ...run.stages.P3, recoverable: true, error: '', label: run.stages.P3.label || '已恢复已保存的创意分段，继续补齐剩余部分' };
        run.events.push({ at: new Date().toISOString(), type: 'inconsistent_creative_state_recovered', message: 'A saved creative section overrode an obsolete failed run state; remaining sections will continue' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      const failed = Object.entries(run.stages).find(([, value]) => value.status === 'failed');
      if (!failed) return res.status(409).json({ error: 'No failed stage to retry' });
      run.state = 'running';
      if (failed[0] === 'P3_5') {
        run.stages.P3_5 = { ...failed[1], status: 'running', retryCount: Number(failed[1].retryCount || 0) + 1, error: '' };
        run.events.push({ at: new Date().toISOString(), type: 'poster_repair_retry_requested', message: 'Failed poster queued for DeepSeek prompt repair or safe continuation' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      if (failed[0] === 'P3') {
        resetManualCreativeRetry(run, failed[1]);
        run.events.push({ at: new Date().toISOString(), type: 'creative_retry_requested', message: 'Creative retry cleared only the prior invalid creative draft; saved book evidence and tracking remain locked' });
        await saveRun(redis, run);
        return res.status(200).json({ run });
      }
      run.stages[failed[0]] = {
        status: 'waiting', retryCount: Number(failed[1].retryCount || 0) + 1,
      };
      run.events.push({ at: new Date().toISOString(), type: 'retry_requested', message: `${failed[0]} queued for retry` });
      await saveRun(redis, run);
      return res.status(200).json({ run });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const title = text(req.body?.title, 200);
    const sku = text(req.body?.sku, 100);
    if (!title) return res.status(400).json({ error: 'Exact book title is required' });
    const requestedAccountId = Number(req.body?.delivery?.accountId || req.body?.accountId || 0);
    const delivery = requestedAccountId ? normalizeDelivery({ accountId: requestedAccountId }) : null;
    if (!requestedAccountId) return res.status(400).json({ error: 'A verified target account is required before starting P0-P7 production' });
    if (requestedAccountId && !delivery) return res.status(400).json({ error: 'The requested SocialEcho account is not part of the verified 14-account route table' });
    let book;
    try {
      // Do this before creating any state: historical funnel titles can point
      // to removed or renamed books, which must never become failed jobs.
      book = await providers.findExactBook(title, sku, delivery ? { applicationId: delivery.applicationId } : {});
    } catch (error) {
      // The authoritative BookStore catalogue can verify a SKU's explicit
      // product-line authorization when the target Writer Admin partition is
      // lagging. Never use this to mask an upstream failure or a mismatch.
      if (String(error?.code || '') === 'exact_not_found' && req.body?.catalogRecord) {
        try {
          book = providers.exactBookFromCatalog(req.body.catalogRecord, {
            title, sku, applicationName: delivery?.appName
          });
        } catch (catalogError) {
          const failure = exactLookupFailure(catalogError, title, delivery?.appName);
          return res.status(failure.status).json({ error: failure.message });
        }
      } else {
      const failure = exactLookupFailure(error, title, delivery?.appName);
      return res.status(failure.status).json({ error: failure.message });
      }
    }
    if (req.body?.dryRun === true) {
      return res.status(200).json({
        verified: true,
        delivery,
        book: {
          title: book.title,
          bookSkuId: book.bookSkuId,
          cityBookId: book.cityBookId,
          chapterCount: book.chapterCount,
          words: book.words,
          payPoint: book.payPoint
        }
      });
    }
    const rawReceipt = text(req.body?.p0Receipt, 12000) || text(req.body?.p0Selection?.receipt, 12000);
    const verifiedP0Selection = requiresP0Receipt(req.body || {})
      ? p0SelectionFromReceipt(rebindP0ReceiptBook(rawReceipt, {
        delivery,
        title,
        sku: sku || book.bookSkuId
      }, book), { delivery, title: book.title, sku: book.bookSkuId })
      : sanitizeP0Selection(req.body?.p0Selection, delivery);
    const planning = await resolvePlanning(redis, req.body?.planning);
    if (planning?.planId) {
      const existing = (await listRunSummaries(redis, 50)).find((item) => String(item.input?.planning?.planId || '') === planning.planId);
      if (existing) return res.status(200).json({ run: existing, duplicate: true });
    }
    const input = buildRunInput(book, { ...(req.body || {}), ...(delivery ? { delivery } : {}), p0Selection: verifiedP0Selection }, planning);
    if (!input.paidAuthorized) return res.status(400).json({ error: 'One-click paid generation authorization is required' });
    // A double-click or an ambiguous network response must never create a
    // second paid-media path for the same book. The short lock covers the
    // creation race; the durable SKU pointer covers the lifetime of a run.
    const accountId = input.delivery?.accountId;
    const lock = await acquireRunCreation(redis, input.sku, accountId);
    if (!lock.acquired) {
      const existing = await waitForActiveRun(redis, input.sku, accountId);
      if (existing) return res.status(200).json({ run: existing, duplicate: true });
      return res.status(409).json({ error: 'A one-click task for this book is being created; please wait for its status to appear.' });
    }
    try {
      const existing = await findActiveRun(redis, input.sku, accountId);
      if (existing) return res.status(200).json({ run: existing, duplicate: true });
      const run = await saveRun(redis, newRun(input));
      await registerActiveRun(redis, run);
      return res.status(202).json({ run });
    } finally {
      await releaseRunCreation(redis, lock);
    }
  } catch (error) {
    console.error('[social/runs]', error);
    // Do not turn a model, validation, or storage diagnosis into the same
    // unhelpful message. The client needs a safe, actionable reason to keep
    // the failed-video rewrite path moving.
    const failure = publicError(error, 'Unable to update production run');
    return res.status(failure.status).json({ error: failure.message });
  }
};

module.exports.copyAssetPayload = copyAssetPayload;
module.exports.listRunsPayload = listRunsPayload;
module.exports.loadRunView = loadRunView;
module.exports.buildRunInput = buildRunInput;
module.exports.exactLookupFailure = exactLookupFailure;
module.exports.waitForActiveRun = waitForActiveRun;
module.exports.archiveFailedRuns = archiveFailedRuns;
module.exports.archiveUnstartedRun = archiveUnstartedRun;
module.exports.holdRunForP0Review = holdRunForP0Review;
module.exports.releaseP0ReviewHold = releaseP0ReviewHold;
module.exports.rewriteModelChoice = rewriteModelChoice;
module.exports.resetManualCreativeRetry = resetManualCreativeRetry;
module.exports.reusableSiblingVideo = reusableSiblingVideo;
module.exports.authorizePaidMediaSubmission = authorizePaidMediaSubmission;
module.exports.reviewVideoFidelity = reviewVideoFidelity;
module.exports.skipUnsubmittedPosters = skipUnsubmittedPosters;
module.exports.attachOperatorCatalogueEvidence = attachOperatorCatalogueEvidence;
