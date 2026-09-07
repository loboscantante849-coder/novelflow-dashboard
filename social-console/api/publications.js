const crypto = require('crypto');
const { requireSession, requireOperatorMutation } = require('./_lib/auth');
const { getRedis, getRun, getRunAssets, listRunSummaries, saveRun, setStage, addEvent } = require('./_lib/store');
const { consumeRateLimit, requestIdentity } = require('./_lib/rate-limit');
const {
  getDraft, listDrafts, saveDraft, ensureDraftForRun, ensureVariantDraftForRun, updateDraftFields, publicDraft,
  automaticDraftAccountId, deliveryModeFor, acquireDraftLock, releaseDraftLock, hash
} = require('./_lib/publications');
const { configuredSocialEchoAccount, configuredSocialEchoAccounts } = require('./_lib/distribution');
const socialecho = require('./_lib/socialecho');
const { effectiveVideoForRun, approvedExecutionQaForRun } = require('./_lib/video-asset');

function safeMessage(error) {
  return String(error?.message || 'Publication request failed')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\bse_[A-Za-z0-9_-]+/gi, '[redacted]')
    .slice(0, 500);
}

function statusFor(error) {
  const value = Number(error?.status || 0);
  return value >= 400 && value < 600 ? value : 502;
}

function uploadTitle(draft, contentType) {
  const extension = contentType === 'video/quicktime' ? 'mov' : contentType.split('/')[1] || 'mp4';
  const base = String(draft.book?.title || 'novelflow-video').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 180) || 'novelflow-video';
  return `${base}.${extension}`;
}

function scheduledAtForPayload(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp) || timestamp < Date.now() + 60 * 1000) {
    throw Object.assign(new Error('Scheduled time must be at least one minute in the future'), { status: 400 });
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp)).reduce((result, item) => {
    if (item.type !== 'literal') result[item.type] = item.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function publishPayload(draft) {
  const deliveryMode = deliveryModeFor(draft.deliveryMode, draft.scheduledAt);
  if (deliveryMode === 'scheduled' && !draft.scheduledAt) {
    throw Object.assign(new Error('Scheduled delivery requires scheduledAt; refusing to fall back to a status 0 draft'), { status: 409 });
  }
  if (deliveryMode === 'draft' && draft.scheduledAt) {
    throw Object.assign(new Error('Draft delivery cannot carry scheduledAt; choose scheduled delivery explicitly'), { status: 409 });
  }
  const scheduled = deliveryMode === 'scheduled' ? scheduledAtForPayload(draft.scheduledAt) : '';
  const payload = {
    account_id: Number(draft.accountId),
    type: draft.publishType,
    // SocialEcho status 1 + scheduled_at is the provider's real scheduled
    // publishing mode. Ordinary unscheduled drafts remain status 0.
    status: scheduled ? 1 : 0,
    content: draft.caption,
    extra: draft.platform === 'tiktok' ? { draft: false } : {},
    attachments: [{ url: draft.provider.publicUrl }],
    comment: []
  };
  if (scheduled) payload.scheduled_at = scheduled;
  return payload;
}

function deterministicDraftValidationError(draft) {
  return /是否保存平台草稿/.test(String(draft?.error || ''));
}

function campaignVariantLocked(run) {
  return run?.input?.creativeProfile?.uniquenessRequired === true
    && Boolean(String(run?.input?.campaign?.id || '').trim());
}

function articleAccountId(article) {
  return Number(article?.account?.id ?? article?.account_id ?? article?.accountId ?? 0);
}

function articleType(article) {
  return String(article?.type || article?.publish_type || article?.publishType || '').trim().toLowerCase();
}

function articleStatus(article) {
  const value = article?.status?.value ?? article?.status ?? article?.publish_status ?? article?.publishStatus;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalSchedule(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function articleSchedule(article) {
  return canonicalSchedule(article?.scheduled_at ?? article?.scheduledAt ?? article?.publish_at ?? article?.publishAt);
}

function articleAttachmentUrls(article) {
  const values = [];
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      if (/^https:\/\//i.test(value)) values.push(value.trim());
      return;
    }
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    if (typeof value !== 'object') return;
    for (const key of ['url', 'public_url', 'publicUrl', 'media_url', 'mediaUrl', 'src']) visit(value[key], depth + 1);
  };
  visit(article?.attachments);
  visit(article?.attachment);
  visit(article?.media);
  visit(article?.files);
  return [...new Set(values)];
}

function reconciliationFingerprint(draft) {
  const deliveryMode = deliveryModeFor(draft?.deliveryMode, draft?.scheduledAt);
  return hash({
    accountId: Number(draft?.accountId || 0),
    type: String(draft?.publishType || '').toLowerCase(),
    status: deliveryMode === 'scheduled' ? 1 : 0,
    scheduledAt: deliveryMode === 'scheduled' ? canonicalSchedule(draft?.scheduledAt) : '',
    caption: String(draft?.caption || '').trim(),
    attachment: String(draft?.provider?.publicUrl || '').trim()
  });
}

function matchingArticle(articles, draft) {
  const deliveryMode = deliveryModeFor(draft?.deliveryMode, draft?.scheduledAt);
  const expectedSchedule = deliveryMode === 'scheduled' ? canonicalSchedule(draft?.scheduledAt) : '';
  const expectedStatus = deliveryMode === 'scheduled' ? 1 : 0;
  const expectedAttachment = String(draft?.provider?.publicUrl || '').trim();
  if (!Number(draft?.accountId) || !draft?.publishType || !String(draft?.caption || '').trim() || !expectedAttachment || (deliveryMode === 'scheduled' && !expectedSchedule)) return undefined;
  const matches = (Array.isArray(articles) ? articles : []).filter((article) => {
    if (!String(article?.id ?? article?.uuid ?? '').trim()) return false;
    if (articleAccountId(article) !== Number(draft.accountId)) return false;
    if (articleType(article) !== String(draft.publishType).toLowerCase()) return false;
    if (articleStatus(article) !== expectedStatus) return false;
    if (String(article?.content || '').trim() !== String(draft.caption || '').trim()) return false;
    if (deliveryMode === 'scheduled' && articleSchedule(article) !== expectedSchedule) return false;
    return articleAttachmentUrls(article).includes(expectedAttachment);
  });
  // A reconciliation fingerprint must identify exactly one provider record.
  // Picking the first match would hide a duplicate external submission and
  // falsely turn an ambiguous paid outcome into a completed P7.
  return matches.length === 1 ? matches[0] : undefined;
}

async function syncRunP7(redis, draft) {
  if (!draft?.runId) return null;
  const run = await getRun(redis, draft.runId);
  if (!run) return null;
  run.artifacts = run.artifacts || {};
  run.artifacts.review = run.artifacts.review || { status: 'ready_for_manual_review' };
  run.artifacts.review.publicationDraftId = draft.id;
  run.artifacts.review.publicationStatus = draft.status;
  run.artifacts.review.publicationError = draft.error || '';
  run.artifacts.review.socialEchoDraftId = draft.provider?.externalDraftId || '';
  run.artifacts.review.executionQaStatus = draft.provider?.executionQaStatus || '';
  run.artifacts.review.executionQaWarning = draft.provider?.executionQaWarning || '';
  const externalDraftId = String(draft.provider?.externalDraftId || '').trim();
  if (draft.status === 'external_draft' && externalDraftId) {
    const scheduled = deliveryModeFor(draft.deliveryMode, draft.scheduledAt) === 'scheduled';
    setStage(run, 'P7', 'done', { label: scheduled ? 'SocialEcho status 1 定时任务已对账确认' : 'SocialEcho status 0 草稿已对账确认', error: '' });
    run.state = 'completed';
    addEvent(run, 'p7_external_draft_reconciled', scheduled ? 'P7 was synchronized from a confirmed SocialEcho status 1 scheduled task' : 'P7 was synchronized from a confirmed SocialEcho status 0 draft');
  } else if (draft.status === 'external_draft' || ['publish_ambiguous', 'submitting', 'uploading'].includes(draft.status)) {
    setStage(run, 'P7', 'ambiguous', { label: 'SocialEcho 草稿结果不明确，等待人工对账', error: draft.error || '' });
    run.state = 'blocked';
    addEvent(run, 'p7_external_draft_ambiguous', 'P7 stopped automatic retries until the SocialEcho draft is reconciled');
  } else if (draft.status === 'failed') {
    setStage(run, 'P7', 'failed', { label: 'SocialEcho 草稿创建失败，可人工修复后重试', error: draft.error || '' });
    run.state = 'failed';
    addEvent(run, 'p7_external_draft_failed', 'P7 recorded a definitive SocialEcho draft failure');
  } else if (draft.status === 'ready_for_review') {
    setStage(run, 'P7', 'waiting', { label: '内部草稿已持久化，尚未取得 SocialEcho 外部 ID', blockedReason: 'external_submission_required', recoverable: true, error: '' });
    // The worker has nothing left that it may safely do without an explicit
    // external submission. This is a terminal production outcome, not a
    // broken/blocked loop; P7 itself stays waiting and visibly distinguishes
    // the internal pub_* record from a real SocialEcho ID.
    run.state = 'completed';
    addEvent(run, 'p7_external_submission_required', 'P0-P6 production completed; P7 keeps the internal draft distinct from a real SocialEcho draft until an external ID is saved');
  }
  await saveRun(redis, run);
  return run;
}

async function reconcileDraft(draft) {
  const uploadStatus = String(draft?.provider?.uploadStatus || '');
  if (['allocating', 'allocated', 'uploading', 'upload_ambiguous', 'upload_allocation_ambiguous'].includes(uploadStatus)
    && draft?.provider?.publicUrl) {
    const uploaded = await socialecho.verifyUploadedVideo(draft.provider.publicUrl);
    if (uploaded) {
      draft.status = 'ready_for_review';
      draft.provider = { ...(draft.provider || {}), uploadStatus: 'uploaded', uploadConfirmedAt: new Date().toISOString() };
      draft.error = '';
      return true;
    }
    return false;
  }
  const result = await socialecho.listArticles(draft.accountId, { page: 1, pages: 10 });
  const article = matchingArticle(result.articles, draft);
  if (!article) {
    if (draft.status === 'publish_ambiguous' && deterministicDraftValidationError(draft)) draft.status = 'failed';
    return false;
  }
  const externalDraftId = String(article.id ?? article.uuid ?? '').trim();
  if (!externalDraftId) return false;
  draft.status = 'external_draft';
  draft.provider = {
    ...(draft.provider || {}),
    externalDraftId,
    publishRequestId: draft.provider?.publishRequestId || result.requestId,
    reconciliationFingerprint: reconciliationFingerprint(draft),
    platformPostId: String(article.uuid || ''),
    platformUrl: String(article.url || ''),
    socialEchoUrl: 'https://app.socialecho.net/'
  };
  draft.error = '';
  return true;
}

function uploadConfirmed(draft) {
  return String(draft?.provider?.uploadStatus || '') === 'uploaded'
    && Boolean(String(draft?.provider?.publicUrl || '').trim())
    && String(draft?.provider?.sourceVideoHash || '') === String(draft?.sourceVideoHash || '');
}

function publicationError(error, draft, { ambiguous = false } = {}) {
  const wrapped = error instanceof Error ? error : new Error(String(error || 'Publication request failed'));
  if (ambiguous) wrapped.ambiguous = true;
  wrapped.draft = draft;
  return wrapped;
}

function campaignQaForSubmission(run, draft) {
  const p4 = String(run?.stages?.P4?.status || '');
  const p6 = String(run?.stages?.P6?.status || '');
  if (['failed', 'blocked', 'ambiguous'].includes(p4) || ['failed', 'blocked', 'ambiguous'].includes(p6)) {
    throw Object.assign(new Error('Campaign draft is blocked by a hard P4 or P6 outcome'), { status: 409 });
  }
  const effective = effectiveVideoForRun(run);
  if (!effective.url || effective.url !== draft.videoUrl || hash(effective.url) !== String(draft.sourceVideoHash || '')) {
    throw Object.assign(new Error('Campaign draft video no longer matches its effective finished asset'), { status: 409 });
  }
  const qa = effective.asset?.executionQa || {};
  const qaStatus = String(qa.status || 'pending_manual_review');
  if (qaStatus === 'rejected') throw Object.assign(new Error('Campaign execution QA rejected this finished video'), { status: 409 });
  const approved = approvedExecutionQaForRun(run);
  if (qaStatus === 'approved' && !approved) {
    throw Object.assign(new Error('Campaign execution QA approval is no longer bound to its effective finished video'), { status: 409 });
  }
  return {
    status: qaStatus,
    warning: qaStatus === 'pending_manual_review'
      ? 'Execution QA remains pending_manual_review; the finished video is being delivered with this visible review state.'
      : ''
  };
}

async function submitDraft(redis, draft) {
  const lock = await acquireDraftLock(redis, draft.id);
  if (!lock.acquired) throw Object.assign(new Error('This draft is already being submitted'), { status: 409 });
  try {
    const latest = await getDraft(redis, draft.id);
    if (!latest) throw Object.assign(new Error('Draft not found'), { status: 404 });
    if (['external_draft', 'submitted', 'published', 'submitting', 'publish_ambiguous'].includes(latest.status)) {
      throw Object.assign(new Error('This draft already exists in SocialEcho or requires reconciliation'), { status: 409 });
    }
    if (latest.status === 'uploading' || (latest.provider?.uploadStatus && !uploadConfirmed(latest))) {
      latest.status = 'publish_ambiguous';
      latest.error = 'Video upload outcome is not confirmed; reconcile it before another submission.';
      await saveDraft(redis, latest, { preserveOrder: true });
      throw publicationError(new Error(latest.error), latest, { ambiguous: true });
    }
    const account = configuredSocialEchoAccount(latest.accountId);
    if (!account || account.status !== 1) throw Object.assign(new Error('The selected SocialEcho account is unavailable'), { status: 409 });
    if (!account.supported) throw Object.assign(new Error('This release supports verified Facebook, Instagram and TikTok drafts only'), { status: 409 });
    latest.accountTitle = account.title || account.account;
    latest.platform = account.platform;
    latest.publishType = account.publishType;
    if (!latest.caption || !latest.videoUrl) throw Object.assign(new Error('Finished copy and video are required'), { status: 409 });
    if (latest.campaignLocked) {
      const run = await getRun(redis, latest.runId);
      if (!run) throw Object.assign(new Error('Campaign run is not available for P7 verification'), { status: 409 });
      const allowedPosts = (run.artifacts?.posts || []).map((post) => String(post?.content || '').trim()).filter(Boolean);
      if (!allowedPosts.includes(String(latest.caption || '').trim()) || hash(latest.caption) !== String(latest.sourceCaptionHash || '')) {
        throw Object.assign(new Error('Campaign draft caption no longer matches its validated P3 copy'), { status: 409 });
      }
      const qa = campaignQaForSubmission(run, latest);
      latest.provider = { ...(latest.provider || {}), executionQaStatus: qa.status, executionQaWarning: qa.warning };
      await saveDraft(redis, latest, { preserveOrder: true });
      if (Number(run.input?.delivery?.accountId || 0) !== Number(latest.accountId || 0)) {
        throw Object.assign(new Error('Campaign draft account no longer matches its locked P0 route'), { status: 409 });
      }
    }
    if (latest.platform === 'instagram' && latest.caption.length > 2200) throw Object.assign(new Error('Instagram caption exceeds 2200 characters'), { status: 400 });
    if (latest.platform === 'tiktok' && latest.caption.length > 2200) throw Object.assign(new Error('TikTok caption exceeds 2200 characters'), { status: 400 });

    if (!uploadConfirmed(latest)) {
      const source = await socialecho.inspectVideo(latest.videoUrl);
      const uploadRequestId = crypto.randomUUID();
      latest.status = 'uploading';
      latest.error = '';
      latest.provider = {
        ...(latest.provider || {}),
        uploadRequestId,
        uploadStatus: 'allocating',
        sourceVideoHash: latest.sourceVideoHash
      };
      // Persist the request intent before asking SocialEcho for the upload
      // destination. A function timeout can now be reconciled rather than
      // silently allocating a second upload path.
      await saveDraft(redis, latest, { preserveOrder: true });
      let upload;
      try {
        upload = await socialecho.createUpload(source.contentType, uploadTitle(latest, source.contentType), uploadRequestId);
        if (!String(upload.fileId || '').trim()) throw new socialecho.SocialEchoError('SocialEcho upload response omitted a file ID', { status: 502, ambiguous: true, requestId: upload.requestId });
      } catch (error) {
        latest.status = 'publish_ambiguous';
        latest.provider = { ...(latest.provider || {}), uploadStatus: 'upload_allocation_ambiguous', uploadRequestId: error?.requestId || uploadRequestId };
        latest.error = safeMessage(error);
        await saveDraft(redis, latest, { preserveOrder: true });
        throw publicationError(error, latest, { ambiguous: true });
      }
      latest.provider = {
        ...(latest.provider || {}),
        uploadFileId: String(upload.fileId),
        uploadRequestId,
        uploadResponseRequestId: upload.requestId,
        publicUrl: upload.publicUrl,
        sourceVideoHash: latest.sourceVideoHash,
        uploadStatus: 'uploading'
      };
      await saveDraft(redis, latest, { preserveOrder: true });
      try {
        await socialecho.putVideo(upload.uploadUrl, source);
      } catch (error) {
        latest.status = 'publish_ambiguous';
        latest.provider = { ...(latest.provider || {}), uploadStatus: 'upload_ambiguous' };
        latest.error = safeMessage(error);
        await saveDraft(redis, latest, { preserveOrder: true });
        throw publicationError(error, latest, { ambiguous: true });
      }
      latest.status = 'ready_for_review';
      latest.provider = { ...(latest.provider || {}), uploadStatus: 'uploaded', uploadConfirmedAt: new Date().toISOString() };
      await saveDraft(redis, latest, { preserveOrder: true });
    }

    const payload = publishPayload(latest);
    latest.status = 'submitting';
    latest.provider = {
      ...(latest.provider || {}),
      payloadHash: hash(payload),
      reconciliationFingerprint: reconciliationFingerprint(latest),
      publishRequestId: crypto.randomUUID()
    };
    await saveDraft(redis, latest, { preserveOrder: true });
    try {
      const result = await socialecho.publishArticle(payload, latest.provider.publishRequestId);
      const externalDraftId = String(result.data?.id || '').trim();
      if (!externalDraftId) throw new socialecho.SocialEchoError('SocialEcho publish response omitted data.id; outcome requires reconciliation', { status: 502, requestId: result.requestId, ambiguous: true });
      latest.status = 'external_draft';
      latest.provider.externalDraftId = externalDraftId;
      latest.provider.publishId = '';
      latest.provider.publishRequestId = result.requestId;
      latest.provider.socialEchoUrl = 'https://app.socialecho.net/';
      latest.error = '';
      await saveDraft(redis, latest);
      return latest;
    } catch (error) {
      latest.provider.publishRequestId = error.requestId || latest.provider.publishRequestId;
      latest.status = error.ambiguous ? 'publish_ambiguous' : 'failed';
      latest.error = safeMessage(error);
      if (error.ambiguous) {
        try {
          if (await reconcileDraft(latest)) {
            await saveDraft(redis, latest, { preserveOrder: true });
            if (latest.status === 'external_draft' && latest.provider?.externalDraftId) return latest;
          }
        } catch {}
      }
      await saveDraft(redis, latest, { preserveOrder: true });
      throw publicationError(error, latest, { ambiguous: error.ambiguous === true });
    }
  } finally {
    await releaseDraftLock(redis, lock);
  }
}

async function saveAutomaticDraft(redis, draft) {
  if (String(process.env.SOCIALECHO_AUTO_DRAFT || '').toLowerCase() !== 'true' && draft?.autoSubmit !== true) return draft;
  const accountId = Number(draft?.accountId || 0) || automaticDraftAccountId();
  if (!accountId || !draft || (draft.status === 'external_draft' && String(draft.provider?.externalDraftId || '').trim())) return draft;
  if (['submitting', 'publish_ambiguous', 'uploading'].includes(String(draft.status || ''))) {
    const reconciled = await reconcileDraft(draft);
    if (reconciled && draft.status === 'external_draft' && String(draft.provider?.externalDraftId || '').trim()) return draft;
    throw publicationError(new Error('Existing SocialEcho submission or upload requires reconciliation before any retry'), draft, { ambiguous: true });
  }
  draft.accountId = accountId;
  await saveDraft(redis, draft, { preserveOrder: true });
  return submitDraft(redis, draft);
}

async function syncRecentDrafts(redis) {
  // Campaign completion is often older than the dashboard's default recent
  // window. Use the supported bounded history size so all current P7 work is
  // visible without loading full chapter evidence.
  const runs = await listRunSummaries(redis, 100);
  for (const run of runs) {
    if (run.state !== 'completed' || !run.artifacts?.posts?.length || !effectiveVideoForRun(run).url) continue;
    const assets = await getRunAssets(redis, run.id);
    if (assets) await ensureDraftForRun(redis, assets);
  }
  return listDrafts(redis, 100);
}

function pendingExternalDraft(draft) {
  // A deterministic provider failure is an operator decision, not a cron
  // retry candidate. An operator may explicitly edit it back to
  // ready_for_review after fixing the cause.
  return String(draft?.status || '') === 'ready_for_review';
}

async function backfillOneExternalDraft(redis) {
  if (String(process.env.SOCIALECHO_AUTO_DRAFT || '').toLowerCase() !== 'true' || !automaticDraftAccountId()) {
    throw Object.assign(new Error('Automatic SocialEcho draft routing is not configured'), { status: 503 });
  }
  const drafts = await listDrafts(redis, 100);
  const next = drafts.find(pendingExternalDraft);
  if (!next) return { draft: null, remaining: 0 };
  const durable = await getDraft(redis, next.id);
  let saved;
  try {
    saved = await saveAutomaticDraft(redis, durable);
  } catch (error) {
    if (error?.draft) await syncRunP7(redis, error.draft).catch(() => {});
    throw error;
  }
  await syncRunP7(redis, saved);
  const remaining = (await listDrafts(redis, 100)).filter(pendingExternalDraft).length;
  return { draft: publicDraft(saved), remaining };
}

module.exports = async (req, res) => {
  if (String(req.method || '').toUpperCase() === 'GET') {
    if (!requireSession(req, res)) return;
  } else if (!requireOperatorMutation(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
  try {
    if (req.method === 'GET') {
      if (req.query?.action === 'accounts') {
        if (req.query?.refresh === '1') return res.status(200).json({ accounts: await socialecho.listAccounts(), source: 'socialecho_live' });
        return res.status(200).json({ accounts: configuredSocialEchoAccounts(), source: 'configured_route' });
      }
      return res.status(200).json({ drafts: await listDrafts(redis, req.query?.limit) });
    }
    if (req.method === 'PATCH') {
      const draft = await getDraft(redis, req.body?.id);
      if (!draft) return res.status(404).json({ error: 'Draft not found' });
      updateDraftFields(draft, req.body || {});
      await saveDraft(redis, draft, { preserveOrder: true });
      return res.status(200).json({ draft: publicDraft(draft) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const action = String(req.body?.action || '');
    if (action === 'sync') return res.status(200).json({ drafts: await syncRecentDrafts(redis) });
    if (action === 'backfill_external_draft') {
      const rate = await consumeRateLimit(redis, 'socialecho_backfill', requestIdentity(req), 10, 60);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfter));
        return res.status(429).json({ error: 'SocialEcho draft rate limit reached. Try again later.' });
      }
      return res.status(200).json(await backfillOneExternalDraft(redis));
    }
    if (action === 'create') {
      const run = await getRun(redis, req.body?.runId);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      const draft = await ensureDraftForRun(redis, run);
      if (!draft) return res.status(409).json({ error: 'Finished copy and video are required before creating a publication draft' });
      await syncRunP7(redis, draft);
      return res.status(200).json({ draft: publicDraft(draft) });
    }
    if (action === 'create_variant') {
      const run = await getRun(redis, req.body?.runId);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      if (campaignVariantLocked(run)) {
        return res.status(409).json({ error: 'Campaign runs use their validated P3 copy and cannot create an unregistered copy-variant draft' });
      }
      if (run.stages?.P4?.status !== 'done' || !(run.artifacts?.videoRevision?.videoUrls?.[0] || run.artifacts?.video?.videoUrls?.[0])) {
        return res.status(409).json({ error: 'A verified finished video is required before creating a copy variant draft' });
      }
      const variantKey = String(req.body?.variantKey || 'social_quality_20260811');
      const draft = await ensureVariantDraftForRun(redis, run, variantKey);
      if (!draft) return res.status(409).json({ error: 'Finished copy and video are required before creating a variant draft' });
      if (draft.status === 'external_draft') return res.status(200).json({ draft: publicDraft(draft), reused: true });
      const rate = await consumeRateLimit(redis, 'socialecho_variant_draft', requestIdentity(req), 20, 60);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfter));
        return res.status(429).json({ error: 'Variant SocialEcho draft rate limit reached. Try again later.' });
      }
      const submitted = await submitDraft(redis, draft);
      return res.status(200).json({ draft: publicDraft(submitted), variant: true });
    }
    const draft = await getDraft(redis, req.body?.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (action === 'reconcile') {
      const missingExternalId = draft.status === 'external_draft' && !String(draft.provider?.externalDraftId || '').trim();
      if (!draft.accountId || !['submitting', 'uploading', 'submitted', 'publish_ambiguous'].includes(draft.status) && !missingExternalId) {
        return res.status(409).json({ error: 'This draft does not require reconciliation' });
      }
      const found = await reconcileDraft(draft);
      await saveDraft(redis, draft, { preserveOrder: !found });
      await syncRunP7(redis, draft);
      return res.status(200).json({ draft: publicDraft(draft), found });
    }
    if (action !== 'save_external_draft') return res.status(400).json({ error: 'Unsupported action' });
    const rate = await consumeRateLimit(redis, 'socialecho_draft', requestIdentity(req), 10, 60);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      return res.status(429).json({ error: 'SocialEcho draft rate limit reached. Try again later.' });
    }
    updateDraftFields(draft, req.body || {});
    await saveDraft(redis, draft, { preserveOrder: true });
    const submitted = await submitDraft(redis, draft);
    await syncRunP7(redis, submitted);
    return res.status(200).json({ draft: publicDraft(submitted) });
  } catch (error) {
    if (error?.draft) {
      await syncRunP7(redis, error.draft).catch(() => {});
      return res.status(statusFor(error)).json({ error: safeMessage(error), draft: publicDraft(error.draft), ambiguous: error.draft.status === 'publish_ambiguous' });
    }
    console.error('[social/publications]', safeMessage(error));
    return res.status(statusFor(error)).json({ error: safeMessage(error) });
  }
};

module.exports.publishPayload = publishPayload;
module.exports.submitDraft = submitDraft;
module.exports.matchingArticle = matchingArticle;
module.exports.reconcileDraft = reconcileDraft;
module.exports.syncRecentDrafts = syncRecentDrafts;
module.exports.saveAutomaticDraft = saveAutomaticDraft;
module.exports.backfillOneExternalDraft = backfillOneExternalDraft;
module.exports.pendingExternalDraft = pendingExternalDraft;
module.exports.campaignVariantLocked = campaignVariantLocked;
module.exports.deterministicDraftValidationError = deterministicDraftValidationError;
module.exports.syncRunP7 = syncRunP7;
