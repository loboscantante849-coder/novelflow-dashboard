const test = require('node:test');
const assert = require('node:assert/strict');
const { draftFromRun, ensureDraftForRun, getDraft, listDrafts, updateDraftFields, saveDraft, hash } = require('../api/_lib/publications');
const { publishPayload, matchingArticle, deterministicDraftValidationError, syncRunP7, submitDraft, reconcileDraft, campaignVariantLocked } = require('../api/publications');
const { newRun, saveRun, getRun, runIsActive } = require('../api/_lib/store');
const { publicAccount, ambiguousFailure } = require('../api/_lib/socialecho');
const { pendingExternalDraft } = require('../api/publications');
const { videoAssetFingerprint } = require('../api/_lib/video-asset');

class MemoryRedis {
  constructor() { this.values = new Map(); this.sorted = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value, options = {}) { if (options.nx && this.values.has(key)) return null; this.values.set(key, value); return 'OK'; }
  async zadd(key, entry) { this.sorted.set(entry.member, entry.score); return 1; }
  async zrange(_key, start, end, options = {}) {
    const ids = [...this.sorted.entries()].sort((a, b) => options.rev ? b[1] - a[1] : a[1] - b[1]).map(([id]) => id);
    return ids.slice(start, end + 1);
  }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
}

function finishedRun() {
  return {
    id: 'run_1234567890abcdef1234567890abcdef',
    input: { title: 'Verified Romance', sku: 'sku-1' },
    artifacts: {
      book: { title: 'Verified Romance', bookSkuId: 'sku-1', cover: 'https://cdn.example/cover.jpg' },
      code: '334589', shortUrl: 'https://social.example/s/abc', linkId: 'link-1',
      posts: [
        { type: 'dialogue_hook', content: 'Finished English copy one', zhContent: '中文审核稿一' },
        { type: 'conflict_hook', content: 'Finished English copy two', zhContent: '中文审核稿二' }
      ],
      video: { status: 'completed', videoUrls: ['https://cdn.example/video.mp4'], coverImageUrl: 'https://cdn.example/video-first-frame.jpg' }
    }
  };
}

function campaignFinishedRun() {
  const run = finishedRun();
  run.input.delivery = { accountId: 13751295, accountTitle: 'NovelFlow', platform: 'facebook', publishType: 'reels' };
  run.input.campaign = { id: 'campaign_20260824_abcdef1234' };
  run.input.creativeProfile = { uniquenessRequired: true, qualityMode: 'premium' };
  run.stages = { P4: { status: 'done' }, P6: { status: 'done' }, P7: { status: 'waiting' } };
  Object.assign(run.artifacts.video, { threadId: 'campaign-thread', payloadFingerprint: 'campaign-contract' });
  run.artifacts.video.executionQa = { status: 'approved', assetFingerprint: videoAssetFingerprint(run.artifacts.video) };
  return run;
}

test('P6 output becomes one idempotent internal publication draft', async () => {
  const redis = new MemoryRedis();
  const run = finishedRun();
  const first = await ensureDraftForRun(redis, run);
  const second = await ensureDraftForRun(redis, run);
  assert.equal(first.id, second.id);
  assert.equal(first.caption, run.artifacts.posts[0].content);
  assert.equal(first.videoUrl, run.artifacts.video.videoUrls[0]);
  assert.equal(first.previewImageUrl, run.artifacts.video.coverImageUrl);
  assert.equal(first.tracking.code, '334589');
  assert.equal((await listDrafts(redis)).length, 1);
  assert.equal((await getDraft(redis, first.id)).runId, run.id);
});

test('draft edits only accept explicit publication fields', () => {
  const draft = draftFromRun(finishedRun());
  updateDraftFields(draft, { postIndex: 1, caption: 'Operator edited copy', accountId: 13943508, scheduledAt: '' });
  assert.equal(draft.postIndex, 1);
  assert.equal(draft.caption, 'Operator edited copy');
  assert.equal(draft.accountId, 13943508);
  assert.throws(() => updateDraftFields(draft, { accountId: 'not-an-id' }), /Invalid account/);
});

test('a routed run preselects its exact SocialEcho account', () => {
  const run = finishedRun();
  run.input.delivery = { accountId: 13943940, accountTitle: 'NovelFlow', platform: 'tiktok', publishType: 'video' };
  const draft = draftFromRun(run);
  assert.equal(draft.accountId, 13943940);
  assert.equal(draft.accountTitle, 'NovelFlow');
  assert.equal(draft.platform, 'tiktok');
  assert.equal(draft.publishType, 'video');
  assert.equal(draft.routeLocked, true);
  assert.throws(() => updateDraftFields(draft, { accountId: 13943450 }), /P0 target account is locked/);
});

test('campaign drafts reject unregistered caption rewrites and video substitutions', async () => {
  const redis = new MemoryRedis();
  const run = campaignFinishedRun();
  await saveRun(redis, run);

  const captionDraft = await ensureDraftForRun(redis, run);
  captionDraft.caption = 'Unregistered campaign rewrite';
  captionDraft.sourceCaptionHash = hash(captionDraft.caption);
  await saveDraft(redis, captionDraft, { preserveOrder: true });
  await assert.rejects(submitDraft(redis, captionDraft), /caption no longer matches its validated P3 copy/);

  const cleanDraft = draftFromRun(run);
  cleanDraft.id = `pub_${'b'.repeat(32)}`;
  cleanDraft.videoUrl = 'https://cdn.example/substituted.mp4';
  cleanDraft.sourceVideoHash = hash(cleanDraft.videoUrl);
  await saveDraft(redis, cleanDraft);
  await assert.rejects(submitDraft(redis, cleanDraft), /video no longer matches its effective finished asset/);
});

test('campaign copy is locked and cannot create an unregistered creative variant', () => {
  const run = campaignFinishedRun();
  const draft = draftFromRun(run);
  assert.equal(campaignVariantLocked(run), true);
  assert.throws(() => updateDraftFields(draft, { caption: 'A different campaign caption' }), /locked to a validated P3 version/);
  assert.equal(campaignVariantLocked(finishedRun()), false);
});

test('SocialEcho payload creates a draft and never directly publishes', () => {
  const draft = draftFromRun(finishedRun());
  Object.assign(draft, { accountId: 13943508, platform: 'instagram', publishType: 'reels', deliveryMode: 'draft' });
  draft.provider.publicUrl = 'https://oss.example/video.mp4';
  const payload = publishPayload(draft);
  assert.deepEqual(payload.attachments, [{ url: 'https://oss.example/video.mp4' }]);
  assert.equal(payload.status, 0);
  assert.equal(payload.type, 'reels');
  assert.equal(payload.scheduled_at, undefined);
});

test('scheduled campaign payload uses SocialEcho status 1 with an explicit China-time schedule', () => {
  const draft = draftFromRun(campaignFinishedRun());
  draft.scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  draft.deliveryMode = 'scheduled';
  draft.provider.publicUrl = 'https://oss.example/video.mp4';
  const payload = publishPayload(draft);
  assert.equal(payload.status, 1);
  assert.match(payload.scheduled_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  assert.ok(Date.parse(payload.scheduled_at) > Date.now());
});

test('scheduled payload rejects a stale campaign time instead of falling back to immediate publish', () => {
  const draft = draftFromRun(campaignFinishedRun());
  draft.scheduledAt = new Date(Date.now() - 60 * 1000).toISOString();
  draft.deliveryMode = 'scheduled';
  draft.provider.publicUrl = 'https://oss.example/video.mp4';
  assert.throws(() => publishPayload(draft), /at least one minute in the future/);
});

test('TikTok drafts include the required platform-draft decision', () => {
  const draft = draftFromRun(finishedRun());
  Object.assign(draft, { accountId: 13943940, platform: 'tiktok', publishType: 'video' });
  draft.provider.publicUrl = 'https://oss.example/video.mp4';
  const payload = publishPayload(draft);
  assert.deepEqual(payload.extra, { draft: false });
  assert.equal(payload.status, 0);
});

test('P7 submission reuses the configured route instead of calling the billable account-list API', async (t) => {
  const socialecho = require('../api/_lib/socialecho');
  const original = { getAccount: socialecho.getAccount, createUpload: socialecho.createUpload, putVideo: socialecho.putVideo, publishArticle: socialecho.publishArticle };
  t.after(() => Object.assign(socialecho, original));
  socialecho.getAccount = async () => { throw new Error('Account listing must not run during P7'); };
  socialecho.createUpload = async () => ({ uploadUrl: 'https://uploads.example/video.mp4', publicUrl: 'https://cdn.example/uploaded.mp4', fileId: 'file-1', requestId: 'upload-1' });
  socialecho.putVideo = async () => {};
  socialecho.publishArticle = async () => ({ data: { id: 'draft-1' }, requestId: 'publish-1' });
  const redis = new MemoryRedis();
  const draft = draftFromRun(finishedRun());
  Object.assign(draft, { accountId: 13943914, accountTitle: 'Storyca', platform: 'instagram', publishType: 'reels' });
  await saveDraft(redis, draft);
  const submitted = await submitDraft(redis, draft);
  assert.equal(submitted.status, 'external_draft');
  assert.equal(submitted.accountTitle, 'Storyca');
  assert.equal(submitted.provider.externalDraftId, 'draft-1');
});

test('SocialEcho invalid-request 422 is definitive while provider failures remain ambiguous', () => {
  assert.equal(ambiguousFailure(422, { error: { type: 'invalid_request' } }, true), false);
  assert.equal(ambiguousFailure(422, { error: { type: 'provider_error' } }, true), true);
  assert.equal(ambiguousFailure(504, {}, true), true);
});

test('legacy TikTok missing-draft-field errors are safe to repair after reconciliation', () => {
  assert.equal(deterministicDraftValidationError({ error: '是否保存平台草稿 不能为空' }), true);
  assert.equal(deterministicDraftValidationError({ error: 'SocialEcho request timed out' }), false);
});

test('scheduled intent never silently falls back to a status 0 draft', () => {
  const draft = draftFromRun(finishedRun());
  draft.provider.publicUrl = 'https://oss.example/video.mp4';
  draft.deliveryMode = 'scheduled';
  assert.throws(() => publishPayload(draft), /requires scheduledAt/);
  draft.scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  draft.deliveryMode = 'draft';
  assert.throws(() => publishPayload(draft), /cannot carry scheduledAt/);
});

test('ambiguous submission reconciliation requires the full route, schedule, caption, and attachment fingerprint', () => {
  const draft = draftFromRun(finishedRun());
  Object.assign(draft, { accountId: 13943508, platform: 'instagram', publishType: 'reels', deliveryMode: 'scheduled', scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() });
  draft.provider.publicUrl = 'https://cdn.example/uploaded.mp4';
  const expected = {
    id: 1, type: 'reels', status: 1, content: draft.caption, account: { id: 13943508 },
    scheduled_at: draft.scheduledAt, attachments: [{ url: draft.provider.publicUrl }]
  };
  assert.equal(matchingArticle([expected], draft).id, 1);
  assert.equal(matchingArticle([{ ...expected, type: 'video' }], draft), undefined);
  assert.equal(matchingArticle([{ ...expected, scheduled_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() }], draft), undefined);
  assert.equal(matchingArticle([{ ...expected, attachments: [{ url: 'https://cdn.example/other.mp4' }] }], draft), undefined);
  assert.equal(matchingArticle([{ ...expected, content: `${draft.caption}!` }], draft), undefined);
});

test('reconciliation keeps duplicate external fingerprints ambiguous', () => {
  const draft = draftFromRun(finishedRun());
  Object.assign(draft, { accountId: 13943914, accountTitle: 'Storyca', platform: 'instagram', publishType: 'reels' });
  draft.provider.publicUrl = 'https://cdn.example/uploaded.mp4';
  const article = {
    id: 'external-1', type: 'reels', status: 0, content: draft.caption,
    account: { id: draft.accountId }, attachments: [{ url: draft.provider.publicUrl }]
  };
  assert.equal(matchingArticle([article, { ...article, id: 'external-2' }], draft), undefined);
  assert.equal(matchingArticle([article], draft).id, 'external-1');
});

test('legacy external_draft without an external ID remains reconcilable', async (t) => {
  const socialecho = require('../api/_lib/socialecho');
  const original = { listArticles: socialecho.listArticles };
  t.after(() => Object.assign(socialecho, original));
  const redis = new MemoryRedis();
  const run = finishedRun();
  run.input.delivery = { accountId: 13943914, accountTitle: 'Storyca', platform: 'instagram', publishType: 'reels' };
  const draft = await ensureDraftForRun(redis, run);
  draft.status = 'external_draft';
  draft.provider = { publicUrl: 'https://cdn.example/uploaded.mp4', uploadStatus: 'uploaded', sourceVideoHash: draft.sourceVideoHash };
  await saveDraft(redis, draft);
  socialecho.listArticles = async () => ({
    requestId: 'legacy-reconcile',
    articles: [{
      id: 'legacy-external-1', type: draft.publishType, status: 0, content: draft.caption,
      account: { id: draft.accountId }, attachments: [{ url: draft.provider.publicUrl }]
    }]
  });
  assert.equal(await reconcileDraft(draft), true);
  assert.equal(draft.status, 'external_draft');
  assert.equal(draft.provider.externalDraftId, 'legacy-external-1');
});

test('verified Facebook, Instagram and TikTok routes are enabled', () => {
  assert.equal(publicAccount({ id: 1, title: 'NF', app: { title: 'Instagram' }, status: { value: 1 } }).supported, true);
  assert.equal(publicAccount({ id: 3, title: 'NF TikTok', app: { title: 'TikTok' }, status: { value: 1 } }).supported, true);
  assert.equal(publicAccount({ id: 2, title: 'Shop', app: { title: 'TikTokShop' }, status: { value: 1 } }).supported, false);
});

test('only unpublished internal drafts enter the SocialEcho backfill queue', () => {
  assert.equal(pendingExternalDraft({ status: 'ready_for_review' }), true);
  assert.equal(pendingExternalDraft({ status: 'failed' }), false);
  assert.equal(pendingExternalDraft({ status: 'external_draft' }), false);
  assert.equal(pendingExternalDraft({ status: 'publish_ambiguous' }), false);
});

test('P7 ambiguity blocks automatic retry and exact reconciliation completes the run', async () => {
  const redis = new MemoryRedis();
  const run = newRun({ title: 'P7 Romance', sku: 'p7-sku', delivery: { accountId: 13943508 } });
  run.state = 'completed';
  run.stages.P6 = { status: 'done' };
  await saveRun(redis, run);
  const draft = draftFromRun(finishedRun());
  draft.runId = run.id;
  draft.status = 'publish_ambiguous';
  draft.error = 'SocialEcho request timed out';
  await syncRunP7(redis, draft);
  let saved = await getRun(redis, run.id);
  assert.equal(saved.state, 'blocked');
  assert.equal(saved.stages.P7.status, 'ambiguous');
  draft.status = 'external_draft';
  draft.error = '';
  draft.provider.externalDraftId = 'socialecho-draft-1';
  await syncRunP7(redis, draft);
  saved = await getRun(redis, run.id);
  assert.equal(saved.state, 'completed');
  assert.equal(saved.stages.P7.status, 'done');
  assert.equal(saved.artifacts.review.socialEchoDraftId, 'socialecho-draft-1');
});

test('P7 never completes without a confirmed SocialEcho external ID', async () => {
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Missing External ID', sku: 'missing-external-id', delivery: { accountId: 13943483 } });
  run.state = 'running';
  run.stages.P6 = { status: 'done' };
  await saveRun(redis, run);
  const draft = draftFromRun(finishedRun());
  draft.runId = run.id;
  draft.status = 'external_draft';
  draft.provider = {};
  await syncRunP7(redis, draft);
  const saved = await getRun(redis, run.id);
  assert.equal(saved.state, 'blocked');
  assert.equal(saved.stages.P7.status, 'ambiguous');
});

test('an internal P7 draft stops the worker without pretending it is an external delivery', async () => {
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Internal P7', sku: 'internal-p7', delivery: { accountId: 13943483 } });
  run.state = 'running';
  run.stages.P6 = { status: 'done' };
  await saveRun(redis, run);
  const draft = draftFromRun(finishedRun());
  draft.runId = run.id;
  draft.status = 'ready_for_review';
  await syncRunP7(redis, draft);
  const saved = await getRun(redis, run.id);
  assert.equal(saved.state, 'completed');
  assert.equal(saved.stages.P7.status, 'waiting');
  assert.equal(saved.stages.P7.blockedReason, 'external_submission_required');
  assert.equal(saved.artifacts.review.socialEchoDraftId, '');
  assert.equal(runIsActive(saved), true);
});

test('missing SocialEcho data.id stays ambiguous instead of completing P7', async (t) => {
  const socialecho = require('../api/_lib/socialecho');
  const original = {
    createUpload: socialecho.createUpload,
    putVideo: socialecho.putVideo,
    publishArticle: socialecho.publishArticle,
    listArticles: socialecho.listArticles
  };
  t.after(() => Object.assign(socialecho, original));
  socialecho.createUpload = async () => ({ uploadUrl: 'https://uploads.example/video.mp4', publicUrl: 'https://cdn.example/uploaded.mp4', fileId: 'file-1', requestId: 'upload-1' });
  socialecho.putVideo = async () => {};
  socialecho.publishArticle = async () => ({ data: {}, requestId: 'publish-no-id' });
  socialecho.listArticles = async () => ({ articles: [], requestId: 'list-1' });
  const redis = new MemoryRedis();
  const draft = draftFromRun(finishedRun());
  Object.assign(draft, { accountId: 13943914, accountTitle: 'Storyca', platform: 'instagram', publishType: 'reels' });
  await saveDraft(redis, draft);
  await assert.rejects(submitDraft(redis, draft), /omitted data.id/);
  const saved = await getDraft(redis, draft.id);
  assert.equal(saved.status, 'publish_ambiguous');
  assert.equal(saved.provider.externalDraftId || '', '');
});

test('upload failure remains reconcilable and cannot skip bytes on a later P7 attempt', async (t) => {
  const socialecho = require('../api/_lib/socialecho');
  const original = { createUpload: socialecho.createUpload, putVideo: socialecho.putVideo };
  t.after(() => Object.assign(socialecho, original));
  let allocations = 0;
  socialecho.createUpload = async () => {
    allocations += 1;
    return { uploadUrl: 'https://uploads.example/video.mp4', publicUrl: 'https://cdn.example/uploaded.mp4', fileId: 'file-1', requestId: 'upload-1' };
  };
  socialecho.putVideo = async () => { throw Object.assign(new Error('upload transport ended'), { status: 502 }); };
  const redis = new MemoryRedis();
  const draft = draftFromRun(finishedRun());
  Object.assign(draft, { accountId: 13943914, accountTitle: 'Storyca', platform: 'instagram', publishType: 'reels' });
  await saveDraft(redis, draft);
  await assert.rejects(submitDraft(redis, draft), /upload transport ended/);
  const saved = await getDraft(redis, draft.id);
  assert.equal(saved.status, 'publish_ambiguous');
  assert.equal(saved.provider.uploadStatus, 'upload_ambiguous');
  await assert.rejects(submitDraft(redis, saved), /already exists in SocialEcho or requires reconciliation/);
  assert.equal(allocations, 1);
});

test('pending manual execution QA is visible but does not block a finished P7 delivery', async (t) => {
  const socialecho = require('../api/_lib/socialecho');
  const original = { createUpload: socialecho.createUpload, putVideo: socialecho.putVideo, publishArticle: socialecho.publishArticle };
  t.after(() => Object.assign(socialecho, original));
  socialecho.createUpload = async () => ({ uploadUrl: 'https://uploads.example/video.mp4', publicUrl: 'https://cdn.example/uploaded.mp4', fileId: 'file-1', requestId: 'upload-1' });
  socialecho.putVideo = async () => {};
  socialecho.publishArticle = async () => ({ data: { id: 'draft-pending-qa' }, requestId: 'publish-1' });
  const redis = new MemoryRedis();
  const run = campaignFinishedRun();
  run.artifacts.video.executionQa = { status: 'pending_manual_review' };
  await saveRun(redis, run);
  const draft = await ensureDraftForRun(redis, run);
  const submitted = await submitDraft(redis, draft);
  assert.equal(submitted.status, 'external_draft');
  assert.equal(submitted.provider.executionQaStatus, 'pending_manual_review');
  assert.match(submitted.provider.executionQaWarning, /pending_manual_review/);
});

test('reconciliation accepts a multi-page exact external task and saves its provider ID', async (t) => {
  const socialecho = require('../api/_lib/socialecho');
  const original = { listArticles: socialecho.listArticles };
  t.after(() => Object.assign(socialecho, original));
  const draft = draftFromRun(finishedRun());
  Object.assign(draft, { accountId: 13943914, accountTitle: 'Storyca', platform: 'instagram', publishType: 'reels', deliveryMode: 'scheduled', scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), status: 'submitting' });
  draft.provider = { publicUrl: 'https://cdn.example/uploaded.mp4', uploadStatus: 'uploaded', sourceVideoHash: draft.sourceVideoHash };
  socialecho.listArticles = async (_accountId, options) => {
    assert.equal(options.pages, 10);
    return {
      requestId: 'list-page-2',
      articles: [{
        id: 'external-page-two', type: 'reels', status: 1, content: draft.caption,
        account: { id: draft.accountId }, scheduled_at: draft.scheduledAt,
        attachments: [{ url: draft.provider.publicUrl }]
      }]
    };
  };
  assert.equal(await reconcileDraft(draft), true);
  assert.equal(draft.status, 'external_draft');
  assert.equal(draft.provider.externalDraftId, 'external-page-two');
});
