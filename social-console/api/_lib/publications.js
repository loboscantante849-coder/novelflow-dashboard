const crypto = require('crypto');
const { effectiveVideoForRun } = require('./video-asset');

const DRAFT_INDEX = 'nf_social:publication_drafts';
const draftKey = (id) => `nf_social:publication_draft:${id}`;
const lockKey = (id) => `nf_social:publication_lock:${id}`;

function parse(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function clean(value, limit = 12000) { return String(value || '').trim().slice(0, limit); }
function hash(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function draftIdForRun(runId) { return `pub_${hash(String(runId || '')).slice(0, 32)}`; }
function variantDraftIdForRun(runId, variantKey) { return `pub_${hash(`${String(runId || '')}:variant:${String(variantKey || '')}`).slice(0, 32)}`; }

function videoUrlFor(run) {
  return clean(effectiveVideoForRun(run).url, 4000);
}

function previewImageFor(run) {
  const effective = effectiveVideoForRun(run);
  return clean(effective.asset?.coverImageUrl || run?.artifacts?.book?.cover, 4000);
}

function automaticDraftAccountId() {
  const accountId = Number(process.env.SOCIALECHO_DEFAULT_ACCOUNT_ID || '');
  return Number.isSafeInteger(accountId) && accountId > 0 ? accountId : null;
}

function deliveryModeFor(value, scheduledAt = '') {
  const requested = clean(value, 20).toLowerCase();
  if (requested === 'scheduled') return 'scheduled';
  if (requested === 'draft') return 'draft';
  return clean(scheduledAt, 80) ? 'scheduled' : 'draft';
}

function publicDraft(draft) {
  if (!draft) return null;
  return {
    id: draft.id,
    runId: draft.runId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    status: draft.status,
    book: draft.book,
    tracking: draft.tracking,
    posts: draft.posts,
    postIndex: draft.postIndex,
    caption: draft.caption,
    videoUrl: draft.videoUrl,
    previewImageUrl: draft.previewImageUrl || draft.book?.cover || '',
    accountId: draft.accountId,
    accountTitle: draft.accountTitle,
    routeLocked: draft.routeLocked === true,
    campaignLocked: draft.campaignLocked === true,
    platform: draft.platform,
    publishType: draft.publishType,
    deliveryMode: deliveryModeFor(draft.deliveryMode, draft.scheduledAt),
    scheduledAt: draft.scheduledAt,
    provider: {
      uploadFileId: draft.provider?.uploadFileId || '',
      uploadRequestId: draft.provider?.uploadRequestId || '',
      uploadStatus: draft.provider?.uploadStatus || '',
      publicUrl: draft.provider?.publicUrl || '',
      executionQaStatus: draft.provider?.executionQaStatus || '',
      executionQaWarning: draft.provider?.executionQaWarning || '',
      publishId: draft.provider?.publishId || '',
      publishRequestId: draft.provider?.publishRequestId || '',
      payloadHash: draft.provider?.payloadHash || '',
      platformUrl: draft.provider?.platformUrl || '',
      externalDraftId: draft.provider?.externalDraftId || '',
      socialEchoUrl: draft.provider?.socialEchoUrl || 'https://app.socialecho.net/'
    },
    error: clean(draft.error, 500)
  };
}

function draftFromRun(run) {
  const posts = (Array.isArray(run?.artifacts?.posts) ? run.artifacts.posts : [])
    .map((post, index) => ({ index, type: clean(post?.type, 120), content: clean(post?.content), zhContent: clean(post?.zhContent) }))
    .filter((post) => post.content);
  const videoUrl = videoUrlFor(run);
  if (!run?.id || !posts.length || !videoUrl) return null;
  const delivery = run.input?.delivery && typeof run.input.delivery === 'object' ? run.input.delivery : {};
  const campaign = run.input?.campaign && typeof run.input.campaign === 'object' ? run.input.campaign : {};
  const scheduledAt = clean(campaign.scheduledAt, 80);
  const requestedPostIndex = Number(run.input?.creativeProfile?.draftPostIndex) === 1 && posts[1] ? 1 : 0;
  const now = new Date().toISOString();
  return {
    id: draftIdForRun(run.id),
    runId: run.id,
    createdAt: now,
    updatedAt: now,
    status: 'ready_for_review',
    book: {
      title: clean(run.artifacts?.book?.title || run.input?.title, 500),
      sku: clean(run.artifacts?.book?.bookSkuId || run.input?.sku, 200),
      cover: clean(run.artifacts?.book?.cover, 4000)
    },
    tracking: {
      code: clean(run.artifacts?.code, 200),
      shortUrl: clean(run.artifacts?.shortUrl, 4000),
      linkId: clean(run.artifacts?.linkId, 200)
    },
    posts,
    postIndex: requestedPostIndex,
    caption: posts[requestedPostIndex].content,
    videoUrl,
    previewImageUrl: previewImageFor(run),
    sourceVideoHash: hash(videoUrl),
    sourceCaptionHash: hash(posts[requestedPostIndex].content),
    accountId: Number(delivery.accountId || 0) || null,
    accountTitle: clean(delivery.accountTitle, 300),
    routeLocked: Number(delivery.accountId || 0) > 0,
    campaignLocked: Boolean(campaign.id && run.input?.creativeProfile?.uniquenessRequired === true),
    platform: clean(delivery.platform, 80).toLowerCase(),
    publishType: clean(delivery.publishType, 40).toLowerCase(),
    // Keep the delivery intent, rather than merely a timestamp, durable from
    // campaign reservation through P7. A scheduled item must never silently
    // degrade to a status:0 draft when its timestamp is absent or malformed.
    deliveryMode: deliveryModeFor(campaign.deliveryMode, scheduledAt),
    scheduledAt,
    autoSubmit: campaign.autoSocialEchoDraft === true,
    provider: {},
    error: ''
  };
}

function draftFromRunVariant(run, variantKey) {
  const draft = draftFromRun(run);
  if (!draft) return null;
  const id = variantDraftIdForRun(run.id, variantKey);
  const now = new Date().toISOString();
  return { ...draft, id, createdAt: now, updatedAt: now, status: 'ready_for_review', provider: {}, error: '' };
}

async function getDraft(redis, id) {
  if (!redis || !/^pub_[a-f0-9]{32}$/i.test(String(id || ''))) return null;
  const value = await redis.get(draftKey(id));
  return value ? parse(value) : null;
}

async function listDrafts(redis, limit = 30) {
  if (!redis) return [];
  const ids = await redis.zrange(DRAFT_INDEX, 0, Math.max(0, Math.min(Number(limit) || 30, 100) - 1), { rev: true });
  const values = await Promise.all(ids.map((id) => redis.get(draftKey(id))));
  return values.map(parse).filter(Boolean).map(publicDraft);
}

async function saveDraft(redis, draft, { preserveOrder = false } = {}) {
  draft.updatedAt = new Date().toISOString();
  await redis.set(draftKey(draft.id), JSON.stringify(draft));
  if (!preserveOrder) await redis.zadd(DRAFT_INDEX, { score: Date.now(), member: draft.id });
  return draft;
}

async function ensureDraftForRun(redis, run) {
  const id = draftIdForRun(run?.id);
  const existing = await getDraft(redis, id);
  if (existing) {
    const previewImageUrl = previewImageFor(run);
    if (!existing.previewImageUrl && previewImageUrl) {
      existing.previewImageUrl = previewImageUrl;
      await saveDraft(redis, existing, { preserveOrder: true });
    }
    return existing;
  }
  const draft = draftFromRun(run);
  if (!draft) return null;
  const acquired = await redis.set(draftKey(id), JSON.stringify(draft), { nx: true });
  const saved = acquired === true || String(acquired || '').toUpperCase() === 'OK' ? draft : await getDraft(redis, id);
  if (saved) await redis.zadd(DRAFT_INDEX, { score: Date.parse(saved.createdAt) || Date.now(), member: id });
  return saved;
}

async function ensureVariantDraftForRun(redis, run, variantKey) {
  const key = clean(variantKey, 80).replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!key) return null;
  const id = variantDraftIdForRun(run?.id, key);
  const existing = await getDraft(redis, id);
  if (existing) return existing;
  const draft = draftFromRunVariant(run, key);
  if (!draft) return null;
  const acquired = await redis.set(draftKey(id), JSON.stringify(draft), { nx: true });
  const saved = acquired === true || String(acquired || '').toUpperCase() === 'OK' ? draft : await getDraft(redis, id);
  if (saved) await redis.zadd(DRAFT_INDEX, { score: Date.parse(saved.createdAt) || Date.now(), member: id });
  return saved;
}

function updateDraftFields(draft, input = {}) {
  if (!['ready_for_review', 'failed'].includes(String(draft.status || ''))) throw Object.assign(new Error('This draft can no longer be edited'), { status: 409 });
  if (input.postIndex !== undefined) {
    const index = Number(input.postIndex);
    if (!Number.isInteger(index) || !draft.posts[index]) throw Object.assign(new Error('Invalid copy version'), { status: 400 });
    draft.postIndex = index;
    if (input.caption === undefined) {
      draft.caption = draft.posts[index].content;
      draft.sourceCaptionHash = hash(draft.caption);
    }
  }
  if (input.caption !== undefined) {
    const caption = clean(input.caption, 12000);
    if (!caption) throw Object.assign(new Error('Caption is required'), { status: 400 });
    if (draft.campaignLocked && !draft.posts.some((post) => post.content === caption)) {
      throw Object.assign(new Error('Campaign copy is locked to a validated P3 version'), { status: 409 });
    }
    draft.caption = caption;
    if (draft.campaignLocked) draft.sourceCaptionHash = hash(caption);
  }
  if (input.accountId !== undefined) {
    const accountId = Number(input.accountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw Object.assign(new Error('Invalid account'), { status: 400 });
    if (draft.routeLocked && accountId !== Number(draft.accountId)) throw Object.assign(new Error('The P0 target account is locked for this production run'), { status: 409 });
    draft.accountId = accountId;
  }
  if (draft.routeLocked && input.platform !== undefined && clean(input.platform, 80).toLowerCase() !== draft.platform) throw Object.assign(new Error('The P0 target platform is locked for this production run'), { status: 409 });
  if (draft.routeLocked && input.publishType !== undefined && clean(input.publishType, 40).toLowerCase() !== draft.publishType) throw Object.assign(new Error('The P0 publish type is locked for this production run'), { status: 409 });
  if (input.accountTitle !== undefined && !draft.routeLocked) draft.accountTitle = clean(input.accountTitle, 300);
  if (input.platform !== undefined && !draft.routeLocked) draft.platform = clean(input.platform, 80).toLowerCase();
  if (input.publishType !== undefined && !draft.routeLocked) draft.publishType = clean(input.publishType, 40).toLowerCase();
  if (input.deliveryMode !== undefined) {
    const mode = clean(input.deliveryMode, 20).toLowerCase();
    if (!['draft', 'scheduled'].includes(mode)) throw Object.assign(new Error('deliveryMode must be draft or scheduled'), { status: 400 });
    if (mode === 'scheduled' && !clean(input.scheduledAt ?? draft.scheduledAt, 80)) {
      throw Object.assign(new Error('Scheduled delivery requires scheduledAt'), { status: 400 });
    }
    if (mode === 'draft' && clean(input.scheduledAt ?? draft.scheduledAt, 80)) {
      throw Object.assign(new Error('Clear scheduledAt before changing deliveryMode to draft'), { status: 400 });
    }
    draft.deliveryMode = mode;
  }
  if (input.scheduledAt !== undefined) {
    const value = clean(input.scheduledAt, 80);
    if (value && (!Number.isFinite(Date.parse(value)) || Date.parse(value) < Date.now() + 60 * 1000)) {
      throw Object.assign(new Error('Scheduled time must be at least one minute in the future'), { status: 400 });
    }
    if (!value && deliveryModeFor(draft.deliveryMode, draft.scheduledAt) === 'scheduled' && input.deliveryMode !== 'draft') {
      throw Object.assign(new Error('Scheduled delivery cannot clear scheduledAt without an explicit draft deliveryMode'), { status: 400 });
    }
    draft.scheduledAt = value ? new Date(value).toISOString() : '';
    if (value) draft.deliveryMode = 'scheduled';
  }
  draft.error = '';
  if (draft.status === 'failed') draft.status = 'ready_for_review';
  return draft;
}

async function acquireDraftLock(redis, id, ttl = 10 * 60) {
  const token = crypto.randomUUID();
  const key = lockKey(id);
  const result = await redis.set(key, token, { nx: true, ex: ttl });
  return { acquired: result === true || String(result || '').toUpperCase() === 'OK', key, token };
}

async function releaseDraftLock(redis, lock) {
  if (!lock?.key) return;
  const value = await redis.get(lock.key).catch(() => '');
  if (String(value || '') === String(lock.token || '')) await redis.del(lock.key).catch(() => {});
}

module.exports = {
  DRAFT_INDEX, draftKey, lockKey, hash, draftIdForRun, variantDraftIdForRun, draftFromRun, draftFromRunVariant, publicDraft,
  getDraft, listDrafts, saveDraft, ensureDraftForRun, ensureVariantDraftForRun, updateDraftFields, automaticDraftAccountId, deliveryModeFor, acquireDraftLock, releaseDraftLock
};
