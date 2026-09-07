const test = require('node:test');
const assert = require('node:assert/strict');
const { copyAssetPayload, listRunsPayload, loadRunView, buildRunInput, exactLookupFailure, archiveFailedRuns, archiveUnstartedRun, holdRunForP0Review, releaseP0ReviewHold, rewriteModelChoice, resetManualCreativeRetry, reusableSiblingVideo, authorizePaidMediaSubmission, reviewVideoFidelity, skipUnsubmittedPosters, attachOperatorCatalogueEvidence } = require('../api/runs');

test('exact bookstore failures preserve identity versus transient HTTP semantics', () => {
  assert.equal(exactLookupFailure(Object.assign(new Error('missing'), { status: 404, code: 'exact_not_found' }), 'Book', 'NovelFlow').status, 422);
  assert.equal(exactLookupFailure(Object.assign(new Error('upstream route missing'), { status: 404, code: 'provider_http' }), 'Book', 'NovelFlow').status, 502);
  assert.equal(exactLookupFailure(Object.assign(new Error('unauthorized'), { status: 401 }), 'Book', 'NovelFlow').status, 503);
  assert.equal(exactLookupFailure(Object.assign(new Error('limited'), { status: 429 }), 'Book', 'NovelFlow').status, 429);
  assert.equal(exactLookupFailure(Object.assign(new Error('timeout'), { status: 408 }), 'Book', 'NovelFlow').status, 504);
  assert.equal(exactLookupFailure(new Error('network timeout'), 'Book', 'NovelFlow').status, 504);
  assert.equal(exactLookupFailure(Object.assign(new Error('upstream'), { status: 500 }), 'Book', 'NovelFlow').status, 502);
  assert.equal(exactLookupFailure(Object.assign(new Error('mismatch'), { status: 409, code: 'exact_mismatch' }), 'Book', 'NovelFlow').status, 409);
  for (const status of [400, 404, 409, 422]) {
    assert.equal(exactLookupFailure(Object.assign(new Error('upstream rejected request'), { status, code: 'provider_http' }), 'Book', 'NovelFlow').status, 502);
  }
  assert.equal(exactLookupFailure(Object.assign(new Error('bad json'), { status: 502, code: 'provider_invalid_json' }), 'Book', 'NovelFlow').status, 502);
  assert.equal(exactLookupFailure(Object.assign(new Error('bad envelope'), { status: 502, code: 'provider_protocol' }), 'Book', 'NovelFlow').status, 502);
});

test('video-prompt repair can use an explicit model without changing the task route', () => {
  const run = { input: { creativeProfile: { modelChoice: 'hy3' } }, artifacts: { modelRoute: { activeModel: 'hy3' } } };
  assert.equal(rewriteModelChoice({ modelChoice: 'seed-2.1-turbo' }, run), 'seed-2.1-turbo');
  assert.equal(run.input.creativeProfile.modelChoice, 'hy3');
  assert.throws(() => rewriteModelChoice({ modelChoice: 'unknown-model' }, run), /Unsupported creative model/);
});

test('a definitive video failure may reuse only verified media from the exact same SKU', () => {
  const target = { id: 'run-target', input: { sku: 'same-sku' }, stages: { P4: { status: 'failed' } }, artifacts: { video: { payloadFingerprint: 'contract-1' } } };
  const source = { id: 'run-source', input: { sku: 'same-sku' }, stages: { P4: { status: 'done' } }, artifacts: { video: { status: 'completed', payloadFingerprint: 'contract-1', videoUrls: ['https://media.example/video.mp4'] } } };
  assert.equal(reusableSiblingVideo(target, source).videoUrl, 'https://media.example/video.mp4');
  assert.throws(() => reusableSiblingVideo(target, { ...source, input: { sku: 'other-sku' } }), /exact same SKU/);
  assert.throws(() => reusableSiblingVideo({ ...target, stages: { P4: { status: 'running' } } }, source), /definitively failed/);
});

test('paid-media authorization is durable, per-run, and refuses existing tasks', () => {
  const run = { input: {}, artifacts: { images: [] }, events: [], stages: { P3: { status: 'done' }, P4: { status: 'waiting' }, P3_5: { status: 'waiting' }, P7: { status: 'waiting' } } };
  authorizePaidMediaSubmission(run);
  assert.equal(run.input.paidMediaSubmissionAuthorized, true);
  assert.equal(run.artifacts.mediaAuthorization.scope, 'video_and_posters');
  assert.match(run.events.at(-1).type, /paid_media_authorized/);
  assert.throws(() => authorizePaidMediaSubmission({ input: {}, artifacts: { video: { threadId: 'thread-1' }, images: [] }, stages: { P3: { status: 'done' }, P4: { status: 'running' } } }), /already exists/);
  assert.throws(() => authorizePaidMediaSubmission({ input: {}, artifacts: { images: [] }, stages: { P3: { status: 'waiting' }, P4: { status: 'waiting' } } }), /Finish the validated/);
});

test('video-only delivery can skip only unsubmitted poster work', () => {
  const run = { artifacts: { images: [{ status: 'prepared', variant: 'luminous_cinema' }] }, events: [], stages: { P3_5: { status: 'prepared' } } };
  skipUnsubmittedPosters(run);
  assert.equal(run.artifacts.images[0].status, 'skipped');
  assert.equal(run.stages.P3_5.status, 'partial');
  assert.equal(run.stages.P3_5.nonBlocking, true);
  assert.throws(() => skipUnsubmittedPosters({ artifacts: { images: [{ status: 'running', taskId: 'paid-image' }] }, stages: {} }), /paid poster task already exists/);
});

test('catalogue evidence recovery is limited to the verified blocked campaign and never reopens media', () => {
  const chapters = [1, 2, 3].map((order) => ({ id: `chapter-${order}`, order, title: `Chapter ${order}`, content: `Verified source content for chapter ${order}.` }));
  const run = {
    state: 'failed',
    input: { sku: '6a30ed3696382e5ba84ba770', source: 'weekly_20260901_novelflow_42', verifiedBook: {} },
    events: [],
    stages: { P1: { status: 'done' }, P2: { status: 'failed' }, P3: { status: 'waiting' }, P3_5: { status: 'waiting' }, P4: { status: 'waiting' }, P6: { status: 'waiting' }, P7: { status: 'waiting' } },
    artifacts: { evidence: { chapters: [] }, videoPrompt: { adCopy: 'stale' }, images: [] }
  };
  attachOperatorCatalogueEvidence(run, { bookSkuId: run.input.sku, chapters, chapterStructure: chapters.map(({ order, title }) => ({ order, title })) });
  assert.equal(run.state, 'running');
  assert.equal(run.input.verifiedBook.catalogueEvidence.chapters.length, 3);
  assert.equal(run.stages.P2.status, 'waiting');
  assert.equal(run.stages.P3.status, 'waiting');
  assert.equal(run.artifacts.evidence, undefined);
  assert.throws(() => attachOperatorCatalogueEvidence({ ...run, input: { ...run.input, sku: 'different' } }, { bookSkuId: 'different', chapters }), /not available/);
  assert.throws(() => attachOperatorCatalogueEvidence({ ...run, artifacts: { video: { threadId: 'paid-video' }, images: [] } }, { bookSkuId: run.input.sku, chapters }), /after media work/);
});

test('premium video fidelity review gates low-quality media and approves only clean 80+ results', () => {
  const makeRun = () => ({
    state: 'running',
    input: { creativeProfile: { qualityMode: 'premium' } },
    events: [],
    stages: { P4: { status: 'done' }, P6: { status: 'waiting' }, P7: { status: 'waiting' } },
    artifacts: { video: { videoUrls: ['https://media.example/verified.mp4'], executionQa: { status: 'pending_manual_review' } } }
  });
  const approved = makeRun();
  const completeCriteria = { eventImmediacy: 5, socialStakes: 4, conflictObject: 5, powerDelta: 4, visualSpecificity: 4, brandPremium: 4 };
  const qa = reviewVideoFidelity(approved, { decision: 'approve', score: 88, criteria: completeCriteria, openingClass: 'public_confrontation' });
  assert.equal(qa.status, 'approved');
  assert.equal(approved.state, 'running');
  assert.match(approved.events.at(-1).type, /video_fidelity_approved/);
  assert.throws(() => reviewVideoFidelity(makeRun(), { decision: 'approve', score: 79 }), /80\+/);
  assert.throws(() => reviewVideoFidelity(makeRun(), { decision: 'approve', score: 90, defects: ['bedroom_wake_opening'] }), /no recorded fidelity defects/);
  assert.throws(() => reviewVideoFidelity(makeRun(), { decision: 'approve', score: 90, criteria: { eventImmediacy: 5 }, openingClass: 'public_confrontation' }), /all six fidelity criteria/);
  assert.throws(() => reviewVideoFidelity(makeRun(), { decision: 'approve', score: 90, criteria: { eventImmediacy: 0, socialStakes: 0, conflictObject: 0, powerDelta: 0, visualSpecificity: 0, brandPremium: 0 }, openingClass: 'public_confrontation' }), /compute to 80\+/);
  assert.throws(() => reviewVideoFidelity(makeRun(), { decision: 'approve', score: 90, defects: ['severe_visual_glitch'], criteria: completeCriteria, openingClass: 'public_confrontation' }), /no recorded fidelity defects/);
  const rejectedUnknown = makeRun();
  const rejectedQa = reviewVideoFidelity(rejectedUnknown, { decision: 'reject', score: 35, defects: ['severe_visual_glitch'], notes: 'Visible frame tearing.', criteria: completeCriteria, openingClass: 'public_confrontation' });
  assert.deepEqual(rejectedQa.unknownDefects, ['severe_visual_glitch']);
  const planned = makeRun();
  planned.input.creativeProfile.openingGrammar = 'conflict_object_action';
  assert.throws(() => reviewVideoFidelity(planned, { decision: 'approve', score: 90, criteria: completeCriteria, openingClass: 'public_confrontation' }), /does not match the campaign opening grammar/);
  const rejected = makeRun();
  reviewVideoFidelity(rejected, { decision: 'reject', score: 45, defects: ['low_information_opening'] });
  assert.equal(rejected.state, 'blocked');
  assert.equal(rejected.stages.P6.blockedReason, 'video_fidelity_review');
});

test('manual P3 retry discards only stale creative state and keeps locked evidence and tracking', () => {
  const run = {
    state: 'failed',
    input: { creativeProfile: { modelChoice: 'deepseek' } },
    stages: { P3: { status: 'failed', retryCount: 2, phase: 'validation_waiting_for_operator' } },
    artifacts: {
      code: '50003',
      shortUrl: '',
      evidence: { chapters: [{ order: 1, content: 'Locked source evidence.' }] },
      modelRoute: { preferredModel: 'hy3', activeModel: 'deepseek', fallbackUsed: true },
      creativeDraft: { validationFallbackUsed: true, parts: { posts: [] } },
      posts: [{ content: 'invalid' }],
      videoPrompt: { adCopy: 'invalid' },
      posterPrompts: [{ prompt: 'invalid' }],
      qualityReview: { status: 'invalid' },
      optimization: { status: 'invalid' }
    }
  };
  resetManualCreativeRetry(run, run.stages.P3);
  assert.equal(run.stages.P3.status, 'waiting');
  assert.equal(run.stages.P3.retryCount, 3);
  assert.equal(run.stages.P3.phase, 'manual_retry');
  assert.equal(run.input.creativeProfile.modelChoice, 'hy3');
  assert.equal(run.artifacts.modelRoute.fallbackUsed, false);
  assert.equal(run.artifacts.code, '50003');
  assert.equal(run.artifacts.evidence.chapters.length, 1);
  assert.equal(run.artifacts.creativeDraft, undefined);
  assert.equal(run.artifacts.posts, undefined);
  assert.equal(run.artifacts.videoPrompt, undefined);
});

test('copy asset payload excludes full-book evidence and provider diagnostics', () => {
  const run = {
    id: 'run-copy',
    artifacts: {
      posts: [{ type: 'hook', content: 'English finished copy', zhContent: 'Chinese review copy', evidence: [{ quote: 'q'.repeat(5000) }] }],
      evidence: { chapters: [{ content: 'chapter'.repeat(10000) }] },
      videoPrompt: { buildRequirement: 'video'.repeat(10000) }
    }
  };
  const payload = copyAssetPayload(run);
  assert.deepEqual(payload.posts, [{ type: 'hook', content: 'English finished copy', zhContent: 'Chinese review copy' }]);
  assert.equal(payload.evidence, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1000);
});

test('default runs payload uses bounded summaries instead of full chapter evidence', async () => {
  const redis = { marker: 'redis' };
  let receivedRedis;
  let receivedLimit;
  const payload = await listRunsPayload(redis, async (value, limit) => {
    receivedRedis = value;
    receivedLimit = limit;
    return [{ id: 'run-summary', _summary: true }];
  });

  assert.equal(receivedRedis, redis);
  assert.equal(receivedLimit, 50);
  assert.deepEqual(payload, { runs: [{ id: 'run-summary', _summary: true }] });
});

test('run detail reads the compact summary first and falls back when its snapshot is unavailable', async () => {
  const calls = [];
  const result = await loadRunView({ marker: 'redis' }, 'run-slow',
    async () => { calls.push('detail'); return null; },
    async () => { calls.push('summary'); return { id: 'run-slow', _summary: true, stages: { P3: { status: 'running' } } }; });
  assert.deepEqual(calls, ['summary', 'detail']);
  assert.equal(result.partial, true);
  assert.equal(result.run._summary, false);
  assert.equal(result.run._detailPartial, true);
  assert.equal(result.run.stages.P3.status, 'running');
});

test('run detail returns the summary projection when a legacy snapshot exceeds its deadline', async () => {
  const result = await loadRunView({ marker: 'redis' }, 'run-late',
    async () => new Promise((resolve) => setTimeout(() => resolve({ id: 'run-late', full: true }), 30)),
    async () => ({ id: 'run-late', _summary: true, stages: { P3: { status: 'waiting' } } }),
    5);
  assert.equal(result.partial, true);
  assert.equal(result.run._detailPartial, true);
  assert.equal(result.run.stages.P3.status, 'waiting');
});

test('one-click run input keeps source and full-book evidence decisions', () => {
  const input = buildRunInput({ title: 'Exact Romance', bookSkuId: 'sku-42' }, {
    source: 'catalog_30d',
    fullBookEvidence: true,
    paidAuthorized: true,
    promoter: 'xujt'
  }, null);
  assert.equal(input.source, 'catalog_30d');
  assert.equal(input.automationMode, 'one_click');
  assert.equal(input.fullBookEvidence, true);
  assert.equal(input.paidAuthorized, true);
});

test('one-click mode is enforced even when a caller sends a different mode', () => {
  const input = buildRunInput({ title: 'Exact Romance', bookSkuId: 'sku-42' }, {
    automationMode: 'manual',
    paidAuthorized: true
  }, null);
  assert.equal(input.automationMode, 'one_click');
});

test('run input persists an explicit account-level output language', () => {
  const portuguese = buildRunInput({ title: 'English Source', bookSkuId: 'sku-language' }, {
    accountId: 13943486,
    creativeProfile: { modelChoice: 'hy3', outputLanguage: 'pt', emojiRange: '3-5' }
  });
  assert.equal(portuguese.creativeProfile.outputLanguage, 'pt');
  assert.equal(portuguese.creativeProfile.forceEnglish, false);
  assert.equal(portuguese.creativeProfile.emojiRange, '3-5');

  const english = buildRunInput({ title: 'English Source', bookSkuId: 'sku-english' }, {
    accountId: 13751295,
    creativeProfile: { modelChoice: 'hy3', outputLanguage: 'en' }
  });
  assert.equal(english.creativeProfile.outputLanguage, 'en');
  assert.equal(english.creativeProfile.forceEnglish, true);
  assert.equal(english.creativeProfile.emojiRange, '2-4');
});

test('run input sanitizes and persists a source-grounded scene lock', () => {
  const input = buildRunInput({ title: 'Locked Scene', bookSkuId: 'scene-sku' }, {
    accountId: 13751295,
    creativeProfile: {
      modelChoice: 'deepseek',
      sceneBrief: ' Chapters 3-5: the future Alpha refuses the arranged match. ',
      sceneChapters: [5, '3', 4, 4, -1, 'bad'],
      visualContinuity: 'Adult woman with round glasses; tall adult man with a mature beard.',
      sceneVariant: 'facebook-confrontation'
    }
  });
  assert.equal(input.creativeProfile.sceneBrief, 'Chapters 3-5: the future Alpha refuses the arranged match.');
  assert.deepEqual(input.creativeProfile.sceneChapters, [3, 4, 5]);
  assert.match(input.creativeProfile.visualContinuity, /round glasses/);
  assert.equal(input.creativeProfile.sceneVariant, 'facebook-confrontation');
});

test('run input preserves the campaign creative-variety contract', () => {
  const input = buildRunInput({ title: 'Portfolio Book', bookSkuId: 'portfolio-sku' }, {
    accountId: 13751295,
    creativeProfile: {
      modelChoice: 'deepseek',
      voiceStyle: 'mystery',
      creativeForm: 'evidence_discovery',
      secondaryForm: 'accusation_aftershock',
      hookDevice: 'object_closeup',
      openingGrammar: 'conflict_object_action',
      videoGrammar: 'object_action_reaction_reversal',
      ctaMode: 'unresolved_question',
      uniquenessRequired: true,
      campaignId: 'campaign_20260823_1234567890',
      campaignSlot: 17,
      accountSlot: 2,
      sceneLane: 2,
      sceneRepeatIndex: 2,
      sceneRepeatCount: 2,
      draftPostIndex: 1,
      qualityMode: 'premium'
    }
  });
  assert.equal(input.creativeProfile.voiceStyle, 'mystery');
  assert.equal(input.creativeProfile.creativeForm, 'evidence_discovery');
  assert.equal(input.creativeProfile.secondaryForm, 'accusation_aftershock');
  assert.equal(input.creativeProfile.openingGrammar, 'conflict_object_action');
  assert.equal(input.creativeProfile.videoGrammar, 'object_action_reaction_reversal');
  assert.equal(input.creativeProfile.ctaMode, 'unresolved_question');
  assert.equal(input.creativeProfile.uniquenessRequired, true);
  assert.equal(input.creativeProfile.campaignId, 'campaign_20260823_1234567890');
  assert.equal(input.creativeProfile.campaignSlot, 17);
  assert.equal(input.creativeProfile.accountSlot, 2);
  assert.equal(input.creativeProfile.sceneLane, 2);
  assert.equal(input.creativeProfile.sceneRepeatIndex, 2);
  assert.equal(input.creativeProfile.sceneRepeatCount, 2);
  assert.equal(input.creativeProfile.draftPostIndex, 1);
});

test('switching a uniqueness-required run model fills only missing format locks', async () => {
  // The endpoint-specific persistence is covered by integration tests; retain
  // this small contract test next to the input tests so batch callers cannot
  // again create an empty required format identifier.
  const run = { input: { creativeProfile: { uniquenessRequired: true } } };
  const profile = run.input.creativeProfile;
  const patched = {
    ...profile,
    modelChoice: 'glm-5.3-flash',
    creativeForm: profile.creativeForm || 'evidence_discovery',
    secondaryForm: profile.secondaryForm || 'accusation_aftershock',
    openingGrammar: profile.openingGrammar || 'conflict_object_action',
    hookDevice: profile.hookDevice || 'object_closeup'
  };
  assert.equal(patched.creativeForm, 'evidence_discovery');
  assert.equal(patched.secondaryForm, 'accusation_aftershock');
  assert.equal(patched.modelChoice, 'glm-5.3-flash');
});

test('run input keeps the verified SocialEcho delivery route', () => {
  const input = buildRunInput({ title: 'Astra Romance', bookSkuId: 'astra-42' }, {
    accountId: 15401748,
    paidAuthorized: true
  }, null);
  assert.equal(input.delivery.accountId, 15401748);
  assert.equal(input.delivery.appName, 'AstraNovel');
  assert.equal(input.delivery.platform, 'instagram');
  assert.equal(input.delivery.includeLink, false);
});

test('run input preserves explicit scheduled delivery rather than dropping it to a draft', () => {
  const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const input = buildRunInput({ title: 'Scheduled Route', bookSkuId: 'scheduled-route-sku' }, {
    accountId: 13943483,
    campaign: {
      id: 'campaign_20260903_abcdefghij', itemIndex: 0, slot: 1,
      autoSocialEchoDraft: true, paidMediaAuthorized: true,
      deliveryMode: 'scheduled', scheduledAt
    }
  });
  assert.equal(input.campaign.deliveryMode, 'scheduled');
  assert.equal(input.campaign.scheduledAt, scheduledAt);
  assert.throws(() => buildRunInput({ title: 'Broken Schedule', bookSkuId: 'broken-schedule-sku' }, {
    accountId: 13943483,
    campaign: { id: 'campaign_20260903_abcdefghij', deliveryMode: 'scheduled' }
  }), /requires scheduledAt/);
});

test('run input persists a bounded P0 metric snapshot under the verified route', () => {
  const input = buildRunInput({ title: 'Max Ranked Romance', bookSkuId: 'max-ranked-1' }, {
    accountId: 13943482,
    p0Selection: {
      source: 'content_dashboard_performance', windowDays: 30, sourceRank: 8, recommendationRank: 3,
      readerBase: 12000, firstReadRate: 0.37, longReadRate: 0.16, trend7v30: null,
      filters: { language: 'EN', complete: '已完结', length: 'long', genre: 'werewolf', readBaseMin: 5000, firstReadMin: 0.3, longReadMin: 0.1 }
    }
  });
  assert.equal(input.p0Selection.target.appKey, 'maxnovel');
  assert.equal(input.p0Selection.target.accountId, 13943482);
  assert.equal(input.p0Selection.readerBase, 12000);
  assert.equal(input.p0Selection.filters.readBaseMin, 5000);
  assert.equal(input.p0Selection.trend7v30, null);
});

test('clearing failed tasks archives only failed runs and preserves their durable assets', async () => {
  const failed = {
    id: 'failed-run-1234', state: 'failed', stages: { P3: { status: 'failed' } },
    artifacts: { code: 'NF-123', shortLink: 'https://example.com/s/123', video: { threadId: 'paid-video-1', status: 'failed' } }, events: []
  };
  const completed = { id: 'complete-run-12', state: 'completed', stages: { P6: { status: 'done' } }, artifacts: { code: 'NF-456' }, events: [] };
  const saves = [];
  const redis = {
    async set(key, value) { saves.push({ key, value }); return 'OK'; },
    async zadd() { return 1; }
  };
  const archived = await archiveFailedRuns(redis, async () => [failed, completed]);
  assert.deepEqual(archived, [failed.id]);
  assert.equal(failed.state, 'archived');
  assert.equal(failed.artifacts.code, 'NF-123');
  assert.equal(failed.artifacts.video.threadId, 'paid-video-1');
  assert.equal(completed.state, 'completed');
  assert.equal(saves.length, 4);
});

test('unstarted selection can be cancelled but a media submission cannot be erased', () => {
  const queued = { id: 'queued-run-1234', state: 'queued', artifacts: {}, events: [] };
  archiveUnstartedRun(queued);
  assert.equal(queued.state, 'archived');
  assert.match(queued.events.at(-1).type, /unstarted_run_cancelled/);
  const paid = { id: 'paid-run-1234', state: 'queued', artifacts: { video: { threadId: 'video-task-1' } }, events: [] };
  assert.throws(() => archiveUnstartedRun(paid), /external media submission/);
});

test('P0 review hold blocks an unpaid active run and is explicitly reversible', () => {
  const run = {
    id: 'p0-review-run',
    state: 'running',
    stages: { P0: { status: 'done' }, P1: { status: 'done' }, P2: { status: 'waiting' }, P7: { status: 'waiting' } },
    artifacts: { images: [] },
    events: []
  };
  holdRunForP0Review(run);
  assert.equal(run.state, 'blocked');
  assert.equal(run.stages.P0.status, 'blocked');
  assert.equal(run.stages.P0.blockedReason, 'p0_verification_required');
  assert.equal(run.operatorHold.reason, 'p0_verification_required');
  assert.match(run.events.at(-1).type, /p0_verification_hold/);
  releaseP0ReviewHold(run);
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P0.status, 'done');
  assert.equal(run.operatorHold.resumable, false);
});

test('P0 review hold refuses a run that already has an external media task', () => {
  const run = {
    state: 'running',
    stages: { P0: { status: 'done' }, P7: { status: 'waiting' } },
    artifacts: { images: [{ taskId: 'poster-paid-1' }] },
    events: []
  };
  assert.throws(() => holdRunForP0Review(run), /external media submission/);
});
