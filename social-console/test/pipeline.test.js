const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { processRun, p3, selectedChapters, summarizeAnalytics } = require('../api/_lib/pipeline');
const { processCreativePlan } = require('../api/_lib/creative-plans');
const { newRun, newCreativePlan, reserveVideoSlot } = require('../api/_lib/store');

providers.generateDistributionPlan = async () => ({ plan: { universalHook: 'One choice changes everything.', zhUniversalHook: '一个选择改变一切。', channels: [{ name: 'NovelFlow推书', reason: 'General manual channel.', bestFor: ['copy', 'video', 'poster'] }] }, model: 'hy3', responseId: 'distribution-test', usage: { totalTokens: 40 } });

class MemoryRedis {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value, options = {}) { if (options.nx && this.values.has(key)) return null; this.values.set(key, value); return 'OK'; }
  async zadd() { return 1; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async incr(key) { const value = Number(this.values.get(key) || 0) + 1; this.values.set(key, value); return value; }
  async incrby(key, amount) { const value = Number(this.values.get(key) || 0) + Number(amount || 0); this.values.set(key, value); return value; }
}

function creative() {
  const steps = { hook: 'She found the signed contract before dawn.', pain: 'The promise trapped her between duty and freedom.', sensory: 'Rain tapped the glass while the ink bled beneath her thumb.', contrast: 'He expected silence; she placed the evidence on his desk.', deepDesire: 'She wanted a life chosen in her own name.', emotionalCta: 'See what happens when she puts the evidence where he cannot destroy it.' };
  const post = (type) => ({ type, sixSteps: steps, content: `${type === 'hook' ? '"You thought I would stay silent."' : steps.hook}\n\n${steps.pain} ${steps.sensory} Her fingers shook above the wet page while the house held its breath. 💔\n\n${steps.contrast} ${steps.deepDesire} The one person who could ruin her finally had to listen. ✨\n\nOutside, the storm kept hammering the windows, but she refused to fold the paper or lower her eyes.`, zhContent: '她在黎明前找到了那份合同。', evidence: [{ chapter: 1, quote: 'A sufficiently long exact quote copied from chapter one.' }, { chapter: 2, quote: 'A sufficiently long exact quote copied from chapter two.' }] });
  const safety = ' No readable text, title, logo, watermark, QR code, UI, collage, duplicated people, or extra limbs.';
  const finalPost = (type) => ({ ...post(type), content: `${post(type).content}\n\n${steps.emotionalCta}\nSearch Code 44444 in NovelFlow to continue the story.\nhttps://social.example/s/abc\n#Romance #ContractRomance #SlowBurn #StrongHeroine #BookTok` });
  return { posts: [finalPost('hook'), finalPost('escalation')], videoPrompt: { hook: 'She finds the signed contract before dawn.', valuePromise: 'One choice can finally put her name back in her own hands.', escalation: 'He closes the door and says the contract was never an offer.', reversal: 'She puts the evidence on his desk before he can destroy it.', cliffhanger: 'Why did he keep the one page that could ruin them both?', sourceEvidence: [{ chapter: 1, quote: 'She found the signed contract before dawn.' }, { chapter: 2, quote: 'The promise trapped her between duty and freedom.' }, { chapter: 2, quote: 'She placed the evidence on his desk.' }], adCopy: 'She thought the contract could save her. Then she learned who wrote the final clause.', buildRequirement: '0-2s contract close-up. 2-5s her hand shakes. 5-8s he blocks the door. 8-11s she reveals the evidence. 11-15s his face changes as the page turns. Character lock, no subtitles.', zhHook: '她在黎明前发现了那份签好的合约。', zhValuePromise: '这一次，她终于可能夺回自己的人生。', zhEscalation: '他关上门，告诉她这从来不是交易。', zhReversal: '她抢在他毁掉证据前把它放在桌上。', zhCliffhanger: '他为什么保留了那一页？', zhAdCopy: '她以为合约能救她，却发现最后条款出自最不该写下它的人。', zhBuildRequirement: '0-2秒合约特写，2-5秒手指颤抖，5-8秒他挡住门，8-11秒她亮出证据，11-15秒他翻页后脸色骤变。角色锁定，无字幕。', evidenceChapters: [1, 2] }, posterPrompts: [{ variant: 'luminous_cinema', prompt: `A premium luminous romantic editorial scene grounded in the signed-contract confrontation, two adult characters, jewel-tone rain light, controlled eye contact, decisive desk composition, negative space for later overlay.${safety}`, zhPrompt: '明亮电影感海报。' }, { variant: 'editorial_romance', prompt: `A premium fashion-forward romance key art grounded in the evidence reveal, two adult characters across a polished desk, saturated magazine lighting, emotional restraint, elegant negative space for later overlay.${safety}`, zhPrompt: '时尚杂志感海报。' }] };
}

test('chapter selector produces complete opening and escalation evidence without duplicates', () => {
  const chapters = Array.from({ length: 30 }, (_, index) => ({ id: `c${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` }));
  const selected = selectedChapters(chapters, 8);
  assert.equal(selected.length, 10);
  assert.equal(new Set(selected.map((item) => item.id)).size, 10);
  assert.equal(selected.filter((item) => item.source === 'opening').length, 6);
  assert.equal(selected.filter((item) => item.source === 'escalation').length, 4);
});

test('background creative planning resumes from saved chapter evidence', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  const downloaded = [];
  Object.assign(providers, {
    findExactBook: async () => ({ bookSkuId: 'plan-sku', cityBookId: 'plan-city', title: 'Plan Romance', payPoint: 8 }),
    listChapters: async () => Array.from({ length: 30 }, (_, index) => ({ id: `plan-c${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` })),
    chapterContent: async (id) => { downloaded.push(id); return `${id} grounded chapter evidence`; },
    analyzeCreativePlan: async () => ({ plan: { editorialThesis: 'Use the first confrontation as the truthful hook.', recommendedProfile: {} }, model: 'hy3', responseId: 'plan-response', usage: { totalTokens: 1200 } })
  });
  const redis = new MemoryRedis();
  const plan = newCreativePlan({ title: 'Plan Romance', sku: 'plan-sku', modelChoice: 'hy3' });
  await processCreativePlan(redis, plan); // identity
  await processCreativePlan(redis, plan); // first evidence
  assert.equal(downloaded.length, 1);
  const resumed = JSON.parse(JSON.stringify(plan));
  for (let index = 0; index < 5 && resumed.state !== 'completed'; index += 1) await processCreativePlan(redis, resumed);
  assert.equal(resumed.state, 'completed');
  assert.equal(downloaded.length, 4);
  assert.equal(new Set(downloaded).size, 4);
  assert.equal(resumed.artifacts.plan.editorialThesis, 'Use the first confrontation as the truthful hook.');
});

test('planning rotates to a reserve model after a primary timeout without losing evidence', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  const downloaded = [];
  let calls = 0;
  Object.assign(providers, {
    findExactBook: async () => ({ bookSkuId: 'plan-fallback-sku', cityBookId: 'plan-fallback-city', title: 'Fallback Romance', payPoint: 8 }),
    listChapters: async () => Array.from({ length: 20 }, (_, index) => ({ id: `fallback-c${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` })),
    chapterContent: async (id) => { downloaded.push(id); return `${id} grounded evidence`; },
    analyzeCreativePlan: async (_book, _evidence, _chapters, model) => {
      calls += 1;
      if (model === 'deepseek') throw new providers.ProviderError('model timeout', { status: 504 });
      return { plan: { editorialThesis: 'Reserve model found the source-backed angle.', recommendedProfile: {} }, model, responseId: 'fallback-plan-response', usage: { totalTokens: 99 } };
    }
  });
  const redis = new MemoryRedis();
  const plan = newCreativePlan({ title: 'Fallback Romance', sku: 'plan-fallback-sku', modelChoice: 'deepseek' });
  for (let index = 0; index < 12 && plan.state !== 'completed'; index += 1) {
    if (plan.stages.analysis.nextAttemptAt) plan.stages.analysis.nextAttemptAt = new Date(0).toISOString();
    await processCreativePlan(redis, plan);
  }
  assert.equal(plan.state, 'completed');
  assert.equal(plan.input.modelChoice, 'hy3');
  assert.equal(plan.input.fallbackUsed, true);
  assert.equal(calls, 2);
  assert.equal(downloaded.length, 4);
});

test('independent creative sections merge safely when started in parallel', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  const packageData = creative();
  Object.assign(providers, {
    generateCreative: async (...args) => {
      const section = args[6];
      await new Promise((resolve) => setTimeout(resolve, section === 'posts' ? 12 : 3));
      return { creative: { [section]: packageData[section] }, model: `model-${section}`, responseId: `response-${section}`, usage: { totalTokens: 100 } };
    }
  });
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Verified Romance', sku: 'sku-1', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done'; run.stages.P2.status = 'done'; run.stages.P5.status = 'done';
  run.artifacts.book = { bookSkuId: 'sku-1' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' },
    { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.' }
  ] };
  run.artifacts.code = '44444'; run.artifacts.shortUrl = 'https://social.example/s/abc';
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await Promise.all(['posts', 'videoPrompt', 'posterPrompts'].map((section) => p3(redis, JSON.parse(JSON.stringify(run)), null, false, section)));
  const stored = JSON.parse(await redis.get(`nf_social:run:${run.id}`));
  assert.deepEqual(Object.keys(stored.artifacts.creativeDraft.parts).sort(), ['posterPrompts', 'posts', 'videoPrompt']);
  assert.equal(stored.artifacts.creativeDraft.usage.length, 3);
  assert.equal(stored.artifacts.creativeDraft.parts.posts.length, 2);
  assert.equal(stored.artifacts.creativeDraft.parts.videoPrompt.hook, packageData.videoPrompt.hook);
});

test('one-click pipeline persists tracking and never duplicates paid submissions', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let keywordCreated = false;
  let linkCreated = false;
  let videoSubmits = 0;
  let imageSubmits = 0;
  Object.assign(providers, {
    findExactBook: async () => ({ bookSkuId: 'sku-1', cityBookId: 'city-1', title: 'Verified Romance', cover: 'https://cdn.example/cover.jpg', category: 'Romance', tags: ['Contract'], payPoint: 8 }),
    listChapters: async () => Array.from({ length: 30 }, (_, index) => ({ id: `c${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` })),
    chapterContent: async (id) => id === 'c1'
      ? 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.'
      : 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.',
    keywordRecord: async (code) => keywordCreated ? { id: 'kw-1', keyword: code, bookId: 'sku-1', channel: 'FB', isEnable: true } : null,
    createKeyword: async () => { keywordCreated = true; },
    findLink: async () => linkCreated ? { id: 'link-1', shortUrl: 'https://social.example/s/abc', isEnabled: true } : null,
    createLink: async () => { linkCreated = true; return { id: 'link-1' }; },
    analyzeCreativePlan: async () => ({ plan: { editorialThesis: 'A source-grounded conflict is ready for production.', recommendedProfile: {} }, model: 'hy3', responseId: 'story-brief-1', usage: { totalTokens: 120 } }),
    generateCreative: async () => ({ creative: creative(), model: 'deepseek-test', responseId: 'resp-1', usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 } }),
    findAcTask: async () => null,
    submitAc: async () => { videoSubmits += 1; return { threadId: 'thread-1' }; },
    acResult: async () => ({ status: 'completed', threadId: 'thread-1', videoUrls: ['https://cdn.example/video.mp4'], coverImageUrl: '' }),
    validateVideo: async () => ({ contentType: 'video/mp4', contentLength: 1234 }),
    submitImage: async (asset) => { imageSubmits += 1; return { id: `image-${asset.variant}`, status: 'queued' }; },
    imageResult: async (id) => ({ status: 'success', result: { url: `https://cdn.example/${id}.jpg` } }),
    reportRows: async () => ({ from: '2026-04-01', to: '2026-07-17', rows: [{ dt: '2026-07-17', adId: '44444', pullUv: 100, activeUv: 40, newUv: 30, d7Income: 12 }] })
  });
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Verified Romance', sku: 'sku-1', promoter: 'xujt', paidAuthorized: true });
  for (let step = 0; step < 40 && run.state !== 'completed'; step += 1) await processRun(redis, run);
  assert.equal(run.state, 'completed', JSON.stringify(run.stages));
  assert.equal(run.artifacts.code, '44444');
  assert.equal(run.artifacts.shortUrl, 'https://social.example/s/abc');
  assert.equal(videoSubmits, 1);
  assert.equal(imageSubmits, 2);
  assert.equal(run.artifacts.video.videoUrls[0], 'https://cdn.example/video.mp4');
  assert.equal(run.artifacts.images.filter((item) => item.status === 'success').length, 2);
  assert.equal(run.artifacts.review.facebook.automaticPublishing, false);
  await processRun(redis, run);
  assert.equal(videoSubmits, 1);
  assert.equal(imageSubmits, 2);
});

function mediaReadyRun() {
  const run = newRun({ title: 'Verified Romance', sku: 'sku-1', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  for (const stage of ['P1', 'P2', 'P3', 'P5']) run.stages[stage].status = 'done';
  const packageData = creative();
  run.artifacts.book = { bookSkuId: 'sku-1', title: 'Verified Romance', cover: 'https://cdn.example/cover.jpg' };
  run.artifacts.evidence = { chapters: [{ order: 1, content: 'chapter one evidence' }, { order: 2, content: 'chapter two evidence' }] };
  run.artifacts.code = '44444';
  run.artifacts.shortUrl = 'https://social.example/s/abc';
  run.artifacts.posts = packageData.posts;
  run.artifacts.videoPrompt = packageData.videoPrompt;
  run.artifacts.posterPrompts = packageData.posterPrompts;
  run.artifacts.optimization = { status: 'kept' };
  return run;
}

test('definitive poster failure is nonblocking and video still completes', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let videoSubmits = 0;
  let imageSubmits = 0;
  Object.assign(providers, {
    findAcTask: async () => null,
    submitAc: async () => { videoSubmits += 1; return { threadId: 'thread-poster-failure' }; },
    acResult: async () => ({ status: 'completed', threadId: 'thread-poster-failure', videoUrls: ['https://cdn.example/video.mp4'] }),
    validateVideo: async () => ({ contentType: 'video/mp4', contentLength: 1234 }),
    submitImage: async () => { imageSubmits += 1; throw new providers.ProviderError('Image request rejected', { status: 422 }); },
    reportRows: async () => ({ from: '2026-07-01', to: '2026-07-20', rows: [] })
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  for (let step = 0; step < 12 && run.state !== 'completed'; step += 1) await processRun(redis, run);
  assert.equal(run.state, 'completed');
  assert.equal(run.stages.P3_5.status, 'partial');
  assert.equal(run.stages.P4.status, 'done');
  assert.equal(videoSubmits, 1);
  assert.equal(imageSubmits, 1);
  assert.equal(run.artifacts.review.mediaWarnings[0].stage, 'P3_5');
});

test('ambiguous poster submission never retries and does not stop video polling', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let videoSubmits = 0;
  let imageSubmits = 0;
  Object.assign(providers, {
    findAcTask: async () => null,
    submitAc: async () => { videoSubmits += 1; return { threadId: 'thread-ambiguous-poster' }; },
    acResult: async () => ({ status: 'completed', threadId: 'thread-ambiguous-poster', videoUrls: ['https://cdn.example/video.mp4'] }),
    validateVideo: async () => ({ contentType: 'video/mp4', contentLength: 1234 }),
    submitImage: async () => { imageSubmits += 1; throw new providers.ProviderError('Image provider timed out', { ambiguous: true }); },
    reportRows: async () => ({ from: '2026-07-01', to: '2026-07-20', rows: [] })
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  for (let step = 0; step < 12 && run.state !== 'completed'; step += 1) await processRun(redis, run);
  assert.equal(run.state, 'completed');
  assert.equal(run.stages.P3_5.status, 'ambiguous');
  assert.equal(run.stages.P4.status, 'done');
  assert.equal(videoSubmits, 1);
  assert.equal(imageSubmits, 1);
  await processRun(redis, run);
  assert.equal(imageSubmits, 1);
});

test('legacy poster-only failed run is recovered and continues its video branch', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  Object.assign(providers, {
    findAcTask: async () => null,
    submitAc: async () => ({ threadId: 'thread-legacy-recovery' }),
    acResult: async () => ({ status: 'completed', threadId: 'thread-legacy-recovery', videoUrls: ['https://cdn.example/video.mp4'] }),
    validateVideo: async () => ({ contentType: 'video/mp4', contentLength: 1234 }),
    reportRows: async () => ({ from: '2026-07-01', to: '2026-07-20', rows: [] })
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.state = 'failed';
  run.stages.P3_5 = { status: 'failed', error: 'legacy image rejection' };
  for (let step = 0; step < 12 && run.state !== 'completed'; step += 1) await processRun(redis, run);
  assert.equal(run.state, 'completed');
  assert.equal(run.stages.P3_5.status, 'partial');
  assert.equal(run.stages.P4.status, 'done');
  assert.match(run.events.map((event) => event.type).join(' '), /legacy_poster_failure_recovered/);
});

test('code allocation initializes remote-compatible string storage', async () => {
  const redis = new MemoryRedis();
  const set = redis.set.bind(redis);
  let initialized;
  redis.set = async (key, value, options) => {
    if (key === 'nf_social:next_code') initialized = value;
    return set(key, value, options);
  };
  const run = newRun({ title: 'Verified Romance', sku: 'sku-1', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  await processRun(redis, run);
  assert.equal(initialized, '44443');
  assert.equal(run.artifacts.code, '44444');
});

test('code creation conflict advances to the next code instead of failing the run', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let createdCode = '';
  Object.assign(providers, {
    keywordRecord: async (code) => code === createdCode ? { id: `kw-${code}`, keyword: code, bookId: 'sku-1', channel: 'FB', isEnable: true } : null,
    createKeyword: async (_sku, code) => {
      if (code === '44444') throw new providers.ProviderError('Promotion code already exists', { status: 409 });
      createdCode = code;
    }
  });
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Verified Romance', sku: 'sku-1', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  await processRun(redis, run);
  await processRun(redis, run);
  await processRun(redis, run);
  assert.equal(run.state, 'running');
  assert.equal(run.artifacts.code, '44445');
  assert.equal(run.stages.P5.phase, 'link');
  assert.match(run.events.map((event) => event.type).join(' '), /code_advanced/);
});

test('title keys treat straight and curly apostrophes as the same book title', () => {
  assert.equal(providers.titleKey("The Lycan King's Treasured Luna"), providers.titleKey('The Lycan King\u2019s Treasured Luna'));
});

test('creative timeout is visible and schedules one safe automatic retry', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  Object.assign(providers, { generateCreative: async () => { throw new providers.ProviderError('DeepSeek creative generation did not return a definitive response'); } });
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Verified Romance', sku: 'sku-1', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  run.stages.P5.status = 'done';
  run.artifacts.book = { bookSkuId: 'sku-1' };
  run.artifacts.evidence = { chapters: [] };
  run.artifacts.code = '44444';
  run.artifacts.shortUrl = 'https://social.example/s/abc';
  await processRun(redis, run);
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P3.status, 'waiting');
  assert.equal(run.stages.P3.phase, 'recovering');
  assert.equal(run.stages.P3.recoverable, true);
  assert.equal(run.artifacts.creativeDraft.failures.posts.attempt, 1);
  assert.match(run.events.map((event) => event.type).join(' '), /creative_section_started.*creative_section_recovering/);
});

test('invalid model draft is discarded and regenerated with a reserve model', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  Object.assign(providers, { generateCreative: async () => {
    const packageData = creative();
    packageData.qualityReview = { recommendation: 'keep', conclusion: 'Ready.', why: 'Looks grounded.', target: 'package' };
    return { creative: packageData, model: 'deepseek-v4-pro', responseId: 'invalid-draft-response', usage: { totalTokens: 500 } };
  } });
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Verified Romance', sku: 'sku-1', promoter: 'xujt', paidAuthorized: true, creativeProfile: { modelChoice: 'deepseek' } });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  run.stages.P5.status = 'done';
  run.artifacts.book = { bookSkuId: 'sku-1' };
  run.artifacts.evidence = { chapters: [{ order: 1, content: 'Unrelated saved chapter text.' }, { order: 2, content: 'Another unrelated saved chapter text.' }] };
  run.artifacts.code = '44444';
  run.artifacts.shortUrl = 'https://social.example/s/abc';
  for (let step = 0; step < 4; step += 1) await processRun(redis, run);
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P3.status, 'waiting');
  assert.equal(run.stages.P3.phase, 'validation_recovering');
  assert.equal(run.input.creativeProfile.modelChoice, 'hy3');
  assert.deepEqual(run.artifacts.creativeDraft.parts, {});
  assert.equal(run.artifacts.creativeDraft.failures.posts.attempt, 1);
  assert.match(run.events.map((event) => event.type).join(' '), /creative_validation_recovering/);
});

test('legacy creative failure is recovered from durable tracking and evidence', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  Object.assign(providers, { generateCreative: async (...args) => {
    const packageData = creative();
    packageData.qualityReview = { recommendation: 'keep', conclusion: 'Evidence-grounded package is ready.', why: 'The hook and reversal are supported by the saved chapters.', target: 'package' };
    return { creative: { [args[6]]: packageData[args[6]] }, model: 'hy3', responseId: 'legacy-recovery-response', usage: { totalTokens: 42 } };
  } });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.state = 'failed';
  run.stages.P3 = { status: 'failed', error: 'legacy DeepSeek timeout' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' },
    { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.' }
  ] };
  delete run.artifacts.posts;
  delete run.artifacts.videoPrompt;
  delete run.artifacts.posterPrompts;
  delete run.artifacts.qualityReview;
  for (let step = 0; step < 6 && run.stages.P3.status !== 'done'; step += 1) await processRun(redis, run);
  assert.notEqual(run.state, 'failed', JSON.stringify({ stages: run.stages, events: run.events.slice(-8), draft: run.artifacts.creativeDraft }));
  assert.match(run.events.map((event) => event.type).join(' '), /legacy_creative_failure_recovered/);
  assert.equal(run.stages.P3.status, 'done');
});

test('DeepSeek refinement waits before any paid media submission and then auto-applies safely', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let generations = 0;
  let videoSubmits = 0;
  Object.assign(providers, {
    generateCreative: async (...args) => {
      if (args[6] === 'qualityReview') generations += 1;
      const result = creative();
      result.qualityReview = generations === 1
        ? { recommendation: 'refine', conclusion: '首屏钩子可以更聚焦。', why: '章节证据支持更直接的冲突开场。', target: 'copy' }
        : { recommendation: 'keep', conclusion: '优化版已满足要求。', why: '证据与叙事节奏一致。', target: 'package' };
      return { creative: result, model: 'deepseek-test', responseId: `resp-${generations}`, usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 } };
    },
    submitAc: async () => { videoSubmits += 1; return { threadId: 'thread-1' }; }
  });
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Verified Romance', sku: 'sku-1', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  run.stages.P5.status = 'done';
  run.artifacts.book = { bookSkuId: 'sku-1' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' },
    { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.' }
  ] };
  run.artifacts.code = '44444';
  run.artifacts.shortUrl = 'https://social.example/s/abc';
  for (let index = 0; index < 5; index += 1) await processRun(redis, run);
  assert.equal(run.artifacts.optimization.status, 'awaiting_confirmation');
  await processRun(redis, run);
  assert.equal(generations, 1);
  assert.equal(videoSubmits, 0);
  run.artifacts.optimization.dueAt = new Date(Date.now() - 1000).toISOString();
  for (let index = 0; index < 5; index += 1) await processRun(redis, run);
  assert.equal(generations, 2);
  assert.equal(run.artifacts.optimization.status, 'auto_applied');
  assert.equal(videoSubmits, 0);
});

test('video submission capacity reserves no more than five slots per hour', async () => {
  const redis = new MemoryRedis();
  const slots = [];
  for (let index = 0; index < 6; index += 1) slots.push(await reserveVideoSlot(redis));
  assert.equal(slots.filter((slot) => slot.granted).length, 5);
  assert.equal(slots.at(-1).granted, false);
  assert.equal(slots.at(-1).used, 5);
});

test('analytics labels insufficient samples instead of overclaiming', () => {
  const result = summarizeAnalytics([{ adId: '55555', pullUv: 20, activeUv: 4, newUv: 3, d7Income: 0 }], '55555', '', { from: '2026-07-01', to: '2026-07-17' });
  assert.equal(result.summary.sampleState, 'insufficient');
  assert.match(result.findings.join(' '), /样本量不足/);
});
