const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { processRun, selectedChapters, summarizeAnalytics } = require('../api/_lib/pipeline');
const { newRun } = require('../api/_lib/store');

class MemoryRedis {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value, options = {}) { if (options.nx && this.values.has(key)) return null; this.values.set(key, value); return 'OK'; }
  async zadd() { return 1; }
  async incr(key) { const value = Number(this.values.get(key) || 0) + 1; this.values.set(key, value); return value; }
}

function creative() {
  const steps = { hook: 'She found the signed contract before dawn.', pain: 'The promise trapped her between duty and freedom.', sensory: 'Rain tapped the glass while the ink bled beneath her thumb.', contrast: 'He expected silence; she placed the evidence on his desk.', deepDesire: 'She wanted a life chosen in her own name.', emotionalCta: 'Read the turning point on NovelFlow.' };
  const post = (type) => ({ type, sixSteps: steps, content: `${steps.hook} ${steps.pain} ${steps.sensory} ${steps.contrast} ${steps.deepDesire} ${steps.emotionalCta} 💔✨`, zhContent: '她在黎明前找到了那份合同。', evidence: [{ chapter: 1, quote: 'A sufficiently long exact quote copied from chapter one.' }, { chapter: 2, quote: 'A sufficiently long exact quote copied from chapter two.' }] });
  const safety = ' No readable text, title, logo, watermark, QR code, UI, collage, duplicated people, or extra limbs.';
  return { posts: [post('hook'), post('escalation')], videoPrompt: { adCopy: 'CHARACTER LOCK: two adults. STORY: one supported confrontation.', buildRequirement: '0-3s evidence close-up. 3-7s confrontation. 7-12s reversal. No subtitles.', zhAdCopy: '角色锁定。', zhBuildRequirement: '十二秒镜头。', evidenceChapters: [1, 2] }, posterPrompts: [{ variant: 'luminous_cinema', prompt: `A premium luminous romantic editorial scene grounded in the signed-contract confrontation, two adult characters, jewel-tone rain light, controlled eye contact, decisive desk composition, negative space for later overlay.${safety}`, zhPrompt: '明亮电影感海报。' }, { variant: 'editorial_romance', prompt: `A premium fashion-forward romance key art grounded in the evidence reveal, two adult characters across a polished desk, saturated magazine lighting, emotional restraint, elegant negative space for later overlay.${safety}`, zhPrompt: '时尚杂志感海报。' }] };
}

test('chapter selector produces complete opening and escalation evidence without duplicates', () => {
  const chapters = Array.from({ length: 30 }, (_, index) => ({ id: `c${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` }));
  const selected = selectedChapters(chapters, 8);
  assert.equal(selected.length, 10);
  assert.equal(new Set(selected.map((item) => item.id)).size, 10);
  assert.equal(selected.filter((item) => item.source === 'opening').length, 6);
  assert.equal(selected.filter((item) => item.source === 'escalation').length, 4);
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
    chapterContent: async (id) => `${id} evidence content with enough grounded story material for creative generation.`,
    keywordRecord: async (code) => keywordCreated ? { id: 'kw-1', keyword: code, bookId: 'sku-1', channel: 'FB', isEnable: true } : null,
    createKeyword: async () => { keywordCreated = true; },
    findLink: async () => linkCreated ? { id: 'link-1', shortUrl: 'https://social.example/s/abc', isEnabled: true } : null,
    createLink: async () => { linkCreated = true; return { id: 'link-1' }; },
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
  assert.equal(run.state, 'completed');
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

test('analytics labels insufficient samples instead of overclaiming', () => {
  const result = summarizeAnalytics([{ adId: '55555', pullUv: 20, activeUv: 4, newUv: 3, d7Income: 0 }], '55555', '', { from: '2026-07-01', to: '2026-07-17' });
  assert.equal(result.summary.sampleState, 'insufficient');
  assert.match(result.findings.join(' '), /样本量不足/);
});
