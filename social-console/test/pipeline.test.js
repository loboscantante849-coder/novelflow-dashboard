const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { processRun, processRunBatch, p1, p2, p3, selectedChapters, normalizeCreative, assertPremiumCopyOpening, sourceGroundedCreativeFallback, reserveCampaignCreativeUniqueness, recoverAmbiguousPostersFromExactSibling, recoverPreparedVideoFromExactSibling, videoContractFingerprint, chapterEvidenceQuote, summarizeAnalytics, videoPayload } = require('../api/_lib/pipeline');
const { processCreativePlan } = require('../api/_lib/creative-plans');
const { newRun, newCreativePlan, reserveVideoSlot, saveRun, registerActiveRun } = require('../api/_lib/store');
const { normalizeDelivery } = require('../api/_lib/distribution');
const acBudget = require('../api/_lib/ac-budget');

providers.generateDistributionPlan = async () => ({ plan: { universalHook: 'One choice changes everything.', zhUniversalHook: '一个选择改变一切。', channels: [{ name: 'NovelFlow推书', reason: 'General manual channel.', bestFor: ['copy', 'video', 'poster'] }] }, model: 'hy3', responseId: 'distribution-test', usage: { totalTokens: 40 } });

class MemoryRedis {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value, options = {}) { if (options.nx && this.values.has(key)) return null; this.values.set(key, value); return 'OK'; }
  async zrange() { return []; }
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

test('chapter selector obeys an exact scene lock and excludes the opening hook', () => {
  const chapters = Array.from({ length: 12 }, (_, index) => ({ id: `chapter-${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` }));
  const selected = selectedChapters(chapters, 8, [3, 4, 5]);
  assert.deepEqual(selected.map((item) => item.order), [3, 4, 5]);
  assert.ok(selected.every((item) => item.source === 'scene_lock'));
});

test('campaign scene lanes select non-overlapping chapter windows for a repeated book', () => {
  const chapters = Array.from({ length: 18 }, (_, index) => ({ id: `chapter-${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` }));
  const early = selectedChapters(chapters, 0, [], 0);
  const late = selectedChapters(chapters, 0, [], 2);
  assert.ok(early.length >= 3 && late.length >= 3);
  assert.equal(early.every((item) => item.source === 'scene_lane_0'), true);
  assert.equal(late.every((item) => item.source === 'scene_lane_2'), true);
  assert.equal(early.some((item) => late.some((other) => other.order === item.order)), false);
  assert.throws(() => selectedChapters(chapters.slice(0, 5), 0, [], 2), /at least six chapters/);
});

test('three repeated materials use three disjoint source windows', () => {
  const chapters = Array.from({ length: 12 }, (_, index) => ({ id: `chapter-${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` }));
  const windows = [1, 2, 3].map((repeatIndex) => selectedChapters(chapters, 0, [], repeatIndex - 1, repeatIndex, 3));
  assert.ok(windows.every((window) => window.length >= 3));
  for (let left = 0; left < windows.length; left += 1) {
    for (let right = left + 1; right < windows.length; right += 1) {
      assert.equal(windows[left].some((item) => windows[right].some((other) => other.order === item.order)), false);
    }
  }
  assert.throws(() => selectedChapters(chapters.slice(0, 8), 0, [], 0, 1, 3), /at least 9 chapters/);
});

test('source-grounded fallback stays inside locked scene chapters', () => {
  const run = {
    input: { creativeProfile: { modelChoice: 'deepseek', sceneChapters: [3, 4, 5], visualContinuity: 'Aina is a curvy adult woman with round eyeglasses. Osborne is a tall adult man with a mature beard.' }, delivery: normalizeDelivery({ accountId: 13751295 }) },
    artifacts: {
      code: '44560', shortUrl: 'https://social.example/s/locked',
      evidence: { chapters: [
        { order: 1, content: 'The public rejection silenced the square before anyone could defend her dignity.' },
        { order: 3, content: 'He had already claimed the woman whose quiet courage changed his decision.' },
        { order: 4, content: 'Be ready because I will come to meet you here tomorrow without another excuse.' },
        { order: 5, content: 'I will not go with Bella because I am seeing the woman I have already claimed.' }
      ] }
    }
  };
  const creative = sourceGroundedCreativeFallback(run);
  assert.deepEqual(creative.videoPrompt.evidenceChapters, [3, 4, 5]);
  assert.doesNotMatch(creative.videoPrompt.adCopy, /public rejection/i);
  assert.match(creative.posterPrompts[0].prompt, /Aina is a curvy adult woman with round eyeglasses/);
});

test('source-grounded fallback prefers a later concrete conflict over an unsafe opening excerpt', () => {
  const run = {
    input: { delivery: normalizeDelivery({ accountId: 13751295 }) },
    artifacts: { code: '44562', shortUrl: 'https://social.example/s/scored', evidence: { chapters: [
      { order: 1, content: 'A/N Warning: this chapter contains sexual content and a routine wake-up scene.' },
      { order: 2, content: 'She woke up in bed and stared at the ceiling, trying to remember the morning before.' },
      { order: 3, content: 'The signed contract hit the marble floor as he told the witnesses she had been betrayed.' },
      { order: 4, content: 'She locked the office door, held the evidence over the desk, and demanded the truth.' },
      { order: 5, content: 'The police arrived with the missing letter, forcing him to answer in front of everyone.' }
    ] } }
  };
  const creative = sourceGroundedCreativeFallback(run);
  assert.ok(creative);
  assert.deepEqual(creative.videoPrompt.evidenceChapters, [3, 4, 5]);
  assert.doesNotMatch(creative.videoPrompt.hook, /wake up|A\/N/i);
});

test('source-grounded fallback keeps video evidence within one six-chapter span', () => {
  const run = {
    input: { delivery: normalizeDelivery({ accountId: 13751295 }) },
    artifacts: { code: '44563', shortUrl: 'https://social.example/s/window', evidence: { chapters: [
      { order: 1, content: 'The first confrontation lands with a decisive document on the table and nobody can ignore it.' },
      { order: 2, content: 'She makes the next choice while every witness waits for the consequence to arrive.' },
      { order: 4, content: 'The answer changes the balance of power in the room before anyone can leave.' },
      { order: 10, content: 'A distant dramatic event must not split this video into unrelated scenes.' }
    ] } }
  };
  const creative = sourceGroundedCreativeFallback(run);
  const chapters = creative.videoPrompt.evidenceChapters;
  assert.ok(Math.max(...chapters) - Math.min(...chapters) <= 5);
});

test('scene lock never widens to unrelated chapters when its evidence is insufficient', () => {
  const run = {
    input: { creativeProfile: { sceneChapters: [4, 5] }, delivery: normalizeDelivery({ accountId: 13751295 }) },
    artifacts: {
      evidence: { chapters: [
        { order: 1, content: 'The opening confrontation contains enough literal source material for a fallback quote but is outside the requested scene.' },
        { order: 2, content: 'A second opening event also contains enough literal source material but must remain unavailable to the locked scene.' },
        { order: 3, content: 'A third unrelated event contains enough literal source material but cannot fill a missing scene citation.' },
        { order: 4, content: 'The locked scene begins with a documented letter changing hands at the threshold.' },
        { order: 5, content: 'The second locked chapter shows the supported refusal and its immediate consequence.' }
      ] }
    }
  };
  const result = sourceGroundedCreativeFallback(run, { diagnostics: true });
  assert.equal(result.creative, null);
  assert.equal(result.error, 'Locked chapter evidence needs three usable excerpts');
});

test('source-grounded fallback exposes only the validation category in diagnostic mode', () => {
  const run = {
    artifacts: {
      code: '44561', shortUrl: 'https://social.example/s/diagnostic',
      evidence: { chapters: [
        { order: 1, content: 'A short fragment.' },
        { order: 2, content: 'Another short fragment.' },
        { order: 3, content: 'A third short fragment.' }
      ] }
    }
  };
  const result = sourceGroundedCreativeFallback(run, { diagnostics: true });
  assert.equal(result.creative, null);
  assert.equal(result.error, 'Locked chapter evidence needs three usable excerpts');
});

test('creative normalization rejects repeated bridge templates and label-only openings', () => {
  assert.throws(
    () => assertPremiumCopyOpening('"A grounded line."\n\nThat one line changes the air around every choice that follows.'),
    /repeated mechanical bridge template/i
  );
  assert.throws(
    () => assertPremiumCopyOpening('Chapter 1\n"A grounded line."\n\nThe contract leaves a physical mark on every decision that follows.'),
    /chapter label|Note to Readers|bare POV/i
  );
  assert.throws(
    () => assertPremiumCopyOpening('POV: Aina\n\nThe contract leaves a physical mark on every decision that follows.'),
    /chapter label|Note to Readers|bare POV/i
  );
});

test('campaign uniqueness registry rejects duplicate scene and copy skeleton only inside the same campaign', async () => {
  const redis = new MemoryRedis();
  const makeRun = (id, campaignId) => ({
    id,
    input: {
      sku: 'same-story-sku',
      campaign: { id: campaignId },
      delivery: { accountId: id === 'run-one' ? 13751295 : 13943450 },
      creativeProfile: { uniquenessRequired: true, creativeForm: 'evidence_discovery' }
    }
  });
  const packageOne = creative();
  const first = await reserveCampaignCreativeUniqueness(redis, makeRun('run-one', 'campaign-a'), packageOne);
  assert.match(first.sceneFingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () => reserveCampaignCreativeUniqueness(redis, makeRun('run-two', 'campaign-a'), packageOne),
    /missing required campaign uniqueness/i
  );
  const crossCampaign = await reserveCampaignCreativeUniqueness(redis, makeRun('run-three', 'campaign-b'), packageOne);
  assert.equal(crossCampaign.threshold, 0.72);
});

test('malformed creative routes can continue from exact saved chapter evidence without paid submission', () => {
  const quotes = [
    'She found the signed contract before dawn, and every promise she had trusted suddenly felt like a trap.',
    'He closed the office door behind her and said the final clause had never been an offer at all.',
    'She placed the evidence on his desk before he could destroy it, then waited for him to look up.'
  ];
  const run = {
    artifacts: {
      code: '44486', shortUrl: 'https://social.example/s/rescue',
      evidence: { chapters: quotes.map((content, index) => ({ order: index + 1, content })) }
    }
  };
  const creative = sourceGroundedCreativeFallback(run);
  assert.ok(creative);
  assert.equal(creative.posts.length, 2);
  assert.equal(creative.videoPrompt.sourceEvidence.length, 3);
  assert.equal(creative.posterPrompts.length, 2);
  assert.equal(creative.qualityReview.status, 'unverified');
  assert.match(creative.posts[0].content, /Code 44486/);
});

test('source-grounded fallback honours the explicit 3-5 emoji copy profile', () => {
  const quotes = [
    'She found the signed contract before dawn, and every promise she had trusted suddenly felt like a trap.',
    'He closed the office door behind her and said the final clause had never been an offer at all.',
    'She placed the evidence on his desk before he could destroy it, then waited for him to look up.'
  ];
  const run = {
    input: { creativeProfile: { emojiRange: '3-5' } },
    artifacts: {
      code: '44488', shortUrl: 'https://social.example/s/emoji-profile',
      evidence: { chapters: quotes.map((content, index) => ({ order: index + 1, content })) }
    }
  };
  const creative = sourceGroundedCreativeFallback(run);
  assert.ok(creative);
  for (const post of creative.posts) {
    const narrative = post.content.split(/\n\n/).slice(0, 3).join('\n');
    assert.equal((narrative.match(/[\u{2600}-\u{27BF}\u{1F300}-\u{1FAFF}]/gu) || []).length, 3);
  }
});

test('source-grounded fallback accepts literal long prose even when upstream omitted sentence punctuation', () => {
  const chunks = [
    'She found the sealed contract under the stairs and held it tightly while every promise in the house changed its meaning before sunrise',
    'He waited beside the locked office door knowing the document in her hand could expose the choice he had hidden from everyone in the family',
    'She stepped into the packed hall and placed the proof on the table because silence could no longer protect the people she loved most'
  ];
  const run = { artifacts: { code: '44487', shortUrl: 'https://social.example/s/chunked', evidence: { chapters: chunks.map((content, index) => ({ order: index + 1, content })) } } };
  const creative = sourceGroundedCreativeFallback(run);
  assert.ok(creative);
  assert.equal(creative.videoPrompt.sourceEvidence.length, 3);
  assert.equal(chapterEvidenceQuote(chunks[0]).endsWith('.'), false);
});

test('source-grounded fallback omits deferred attribution for a non-live application route', () => {
  const run = {
    input: { delivery: normalizeDelivery({ accountId: 13943764 }) },
    artifacts: {
      evidence: {
        chapters: [
          { order: 1, content: 'The contract made every promise feel suddenly fragile and uncertain.' },
          { order: 2, content: 'He closed the door before she could decide whether to leave.' },
          { order: 3, content: 'She kept the one document that could change everything between them.' }
        ]
      }
    }
  };
  const creative = sourceGroundedCreativeFallback(run);
  assert.ok(creative);
  assert.equal(creative.posts[0].evidence.length, 2);
  assert.ok((creative.posts[0].content.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length >= 70);
  assert.doesNotMatch(creative.posts[0].content, /Search Code|promotion code/i);
  assert.doesNotMatch(creative.posts[0].content, /https?:\/\//);
});

test('deferred attribution accepts a blank Code without an empty-regex false positive', () => {
  const run = {
    input: { delivery: normalizeDelivery({ accountId: 13943482 }), creativeProfile: { emojiRange: '3-5' } },
    artifacts: {
      code: '', shortUrl: '',
      evidence: { chapters: [
        { order: 1, content: 'She found the signed contract before dawn, and every promise she trusted suddenly felt like a trap.' },
        { order: 2, content: 'He closed the office door behind her, then admitted the final clause had never been an offer.' },
        { order: 3, content: 'She placed the evidence on his desk before he could destroy it, and waited for him to look up.' }
      ] }
    }
  };
  const creative = sourceGroundedCreativeFallback(run);
  assert.ok(creative);
  assert.doesNotMatch(creative.posts[0].content, /Search Code|https?:\/\//i);
});

test('source-grounded fallback keeps Portuguese copy and code guidance in Portuguese', () => {
  const run = {
    input: { delivery: normalizeDelivery({ accountId: 13943940 }), creativeProfile: { outputLanguage: 'pt' } },
    artifacts: {
      book: { description: 'Um amor precisa sobreviver a uma decisao impossivel.' },
      code: '44499',
      evidence: {
        chapters: [
          { order: 1, content: 'Ela guardou a carta porque sabia que aquela verdade destruiria o casamento.' },
          { order: 2, content: 'Ele fechou a porta e pediu que ela esquecesse cada promessa antiga.' },
          { order: 3, content: 'A ultima mensagem mudou o risco de todos naquela casa silenciosa.' }
        ]
      }
    }
  };
  const creative = sourceGroundedCreativeFallback(run);
  assert.ok(creative);
  assert.match(creative.posts[0].content, /Veja o que acontece quando/);
  assert.match(creative.posts[0].content, /Pesquise o Codigo 44499 no NovelFlow/);
  assert.match(creative.videoPrompt.buildRequirement, /abra no conflito documentado/);
  assert.doesNotMatch(creative.posts[0].content, /Search Code|https?:\/\//);
});

test('ad-creative fallback keeps the separately allocated Code out of visible copy', () => {
  const quotes = [
    'She found the signed contract before dawn, and every promise she had trusted suddenly felt like a trap.',
    'He closed the office door behind her and said the final clause had never been an offer at all.',
    'She placed the evidence on his desk before he could destroy it, then waited for him to look up.'
  ];
  const run = {
    input: { delivery: { accountId: 13943486 }, creativeProfile: { adCreativeNoTracking: true } },
    artifacts: { code: '80042', evidence: { chapters: quotes.map((content, index) => ({ order: index + 1, content })) } }
  };
  const creative = sourceGroundedCreativeFallback(run);
  assert.ok(creative);
  assert.doesNotMatch(creative.posts[0].content, /80042|search code/i);
  assert.doesNotMatch(creative.posts[1].content, /80042|search code/i);
});

test('video payload follows the book language instead of always sending English', () => {
  const base = { id: 'language-run', input: { sku: 'sku-pt', title: 'Sem Segunda Chance, Despreocupada e Próspera' }, artifacts: { book: { title: 'Sem Segunda Chance, Despreocupada e Próspera', tags: ['Traição'] }, evidence: { chapters: [{ order: 1 }] }, videoPrompt: { evidenceChapters: [1], adCopy: 'Narracao em portugues.', buildRequirement: 'Plano em portugues.' } } };
  assert.deepEqual(Object.fromEntries(Object.entries(videoPayload(base).payload).filter(([key]) => ['language', 'country'].includes(key))), { language: 'Portuguese', country: 'BR' });
  const spanish = JSON.parse(JSON.stringify(base));
  spanish.input.title = 'La Esposa Contractual del CEO Contraataca';
  spanish.artifacts.book = { title: spanish.input.title, tags: ['Venganza'] };
  assert.deepEqual(Object.fromEntries(Object.entries(videoPayload(spanish).payload).filter(([key]) => ['language', 'country'].includes(key))), { language: 'Spanish', country: 'ES' });
});

test('routed social video defaults to English and uses the exact account platform', () => {
  const run = {
    id: 'routed-video',
    input: { sku: 'sku-routed', title: 'Sem Segunda Chance', delivery: { accountId: 13943940 } },
    artifacts: {
      book: { title: 'Sem Segunda Chance', tags: ['Lobisomem'] },
      evidence: { chapters: [{ order: 1 }] },
      videoPrompt: { evidenceChapters: [1], adCopy: 'English narration.', buildRequirement: 'English shot plan.' }
    }
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(videoPayload(run).payload).filter(([key]) => ['language', 'country', 'ad_platform'].includes(key))),
    { language: 'English', country: 'US', ad_platform: 'TikTok' }
  );

  run.input.delivery = { accountId: 13943486 };
  run.input.creativeProfile = { outputLanguage: 'pt' };
  assert.deepEqual(
    Object.fromEntries(Object.entries(videoPayload(run).payload).filter(([key]) => ['language', 'country', 'ad_platform'].includes(key))),
    { language: 'Portuguese', country: 'BR', ad_platform: 'Facebook' }
  );
});

test('English social routes reject probable Portuguese or Spanish visible copy', () => {
  const portuguese = 'Ela não podia voltar, porque uma escolha já tinha mudado tudo. Quando a verdade chegou, o silêncio ficou mais pesado, mas ela decidiu enfrentar quem havia escondido seu nome. Então cada promessa se tornou uma ameaça, e ninguém conseguiu fingir que isso não importava para ela.';
  const spanish = 'Ella no podía volver, porque una decisión ya había cambiado todo. Cuando llegó la verdad, el silencio pesó más, pero ella decidió enfrentar a quien había escondido su nombre. Entonces cada promesa se convirtió en amenaza y nadie pudo fingir que esto no importaba para ella.';
  assert.throws(() => require('../api/_lib/pipeline').assertVisibleLanguage(portuguese, 'en'), /requires clearly English|probable Portuguese/);
  assert.throws(() => require('../api/_lib/pipeline').assertVisibleLanguage(spanish, 'en'), /probable Portuguese or Spanish|requires clearly English/);
  assert.doesNotThrow(() => require('../api/_lib/pipeline').assertVisibleLanguage('She could not walk away because the sealed letter had changed what the entire room believed. When he reached for it, she held the proof above the table and asked who would dare deny her name now. The crowd stayed silent, but her next choice was already clear.', 'en'));
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
  assert.equal(resumed.input.productionRunId, undefined);
});

test('creative planning exact-book lookup follows the locked application route', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let lookupOptions;
  Object.assign(providers, {
    findExactBook: async (_title, _sku, options) => { lookupOptions = options; return { bookSkuId: 'max-plan-sku', cityBookId: 'max-plan-city', title: 'Max Plan Romance', payPoint: 8 }; },
    listChapters: async () => Array.from({ length: 12 }, (_, index) => ({ id: `max-plan-${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` }))
  });
  const plan = newCreativePlan({
    title: 'Max Plan Romance', sku: 'max-plan-sku', modelChoice: 'hy3', autoStartProduction: false,
    delivery: normalizeDelivery({ accountId: 13943482 }),
    p0Selection: { target: { accountId: 13943482 } }
  });
  await processCreativePlan(new MemoryRedis(), plan);
  assert.equal(lookupOptions.applicationId, '69a172040a2d5813dec3bff7');
  assert.equal(plan.artifacts.book.bookSkuId, 'max-plan-sku');
});

test('completed smart planning automatically queues one production task', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  Object.assign(providers, {
    findExactBook: async () => ({ bookSkuId: 'auto-plan-sku', cityBookId: 'auto-plan-city', title: 'Auto Plan Romance', payPoint: 8 }),
    listChapters: async () => Array.from({ length: 30 }, (_, index) => ({ id: `auto-c${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` })),
    chapterContent: async (id) => `${id} grounded chapter evidence`,
    analyzeCreativePlan: async () => ({ plan: { editorialThesis: 'The verified betrayal becomes the campaign hook.', recommendedProfile: {} }, model: 'hy3', responseId: 'auto-plan-response', usage: { totalTokens: 800 } })
  });
  const redis = new MemoryRedis();
  const plan = newCreativePlan({ title: 'Auto Plan Romance', sku: 'auto-plan-sku', modelChoice: 'hy3', preferredModelChoice: 'hy3', autoStartProduction: true, paidAuthorized: true, promoter: 'xujt' });

  for (let index = 0; index < 8 && !plan.input.productionRunId; index += 1) await processCreativePlan(redis, plan);

  assert.equal(plan.state, 'completed');
  assert.ok(plan.input.productionRunId);
  const created = JSON.parse(await redis.get(`nf_social:run:${plan.input.productionRunId}`));
  assert.equal(created.input.planning.planId, plan.id);
  assert.equal(created.input.paidAuthorized, true);
  assert.equal(created.input.planning.strategy.editorialThesis, 'The verified betrayal becomes the campaign hook.');

  await processCreativePlan(redis, plan);
  assert.equal([...redis.values.keys()].filter((key) => key.startsWith('nf_social:run:')).length, 1);
});

test('completed planning links to an existing book run instead of creating a second paid path', async () => {
  const redis = new MemoryRedis();
  const existing = await saveRun(redis, newRun({ title: 'Shared Romance', sku: 'shared-sku', paidAuthorized: true, automationMode: 'one_click' }));
  await registerActiveRun(redis, existing);
  const plan = newCreativePlan({ title: 'Shared Romance', sku: 'shared-sku', modelChoice: 'hy3', autoStartProduction: true, paidAuthorized: true });
  plan.state = 'completed';
  plan.artifacts.book = { title: 'Shared Romance', bookSkuId: 'shared-sku' };
  plan.artifacts.plan = { editorialThesis: 'Use the verified source conflict.', recommendedProfile: {} };

  await processCreativePlan(redis, plan);

  assert.equal(plan.input.productionRunId, existing.id);
  assert.equal(plan.input.autoStartState, 'linked_existing');
  assert.equal([...redis.values.keys()].filter((key) => key.startsWith('nf_social:run:')).length, 1);
});

test('planning uses one fixed reserve model after a primary timeout without losing evidence', async (t) => {
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

test('a saved creative section clears an obsolete failed run state', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  const packageData = creative();
  providers.generateCreative = async (...args) => ({ creative: { [args[6]]: packageData[args[6]] }, model: 'hy3', responseId: 'saved-after-failure', usage: { totalTokens: 60 } });
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Recovery Romance', sku: 'recovery-sku', promoter: 'xujt', paidAuthorized: true });
  run.state = 'failed';
  run.artifacts.book = { bookSkuId: 'recovery-sku' };
  run.artifacts.evidence = { chapters: [] };
  run.artifacts.code = '44500';
  run.artifacts.shortUrl = 'https://social.example/s/recovery';
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run, null, false, 'posts');
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P3.status, 'waiting');
  assert.ok(run.artifacts.creativeDraft.parts.posts);
});

test('quality review failure does not discard already saved creative outputs', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  const packageData = creative();
  providers.generateCreative = async (...args) => {
    if (args[6] === 'qualityReview') {
      const error = new providers.ProviderError('Primary invalid JSON; fallback invalid JSON');
      error.fallbackModel = 'hy3';
      error.fallbackFrom = 'deepseek';
      throw error;
    }
    return { creative: { [args[6]]: packageData[args[6]] }, model: 'deepseek', responseId: 'response', usage: { totalTokens: 60 } };
  };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Quality Gap Romance', sku: 'quality-gap', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done'; run.stages.P2.status = 'done'; run.stages.P5.status = 'done';
  run.artifacts.book = { bookSkuId: 'quality-gap' };
  run.artifacts.evidence = { chapters: [{ order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' }, { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.' }] };
  run.artifacts.code = '44444'; run.artifacts.shortUrl = 'https://social.example/s/abc';
  run.artifacts.creativeDraft = { parts: { posts: packageData.posts, videoPrompt: packageData.videoPrompt, posterPrompts: packageData.posterPrompts }, usage: [], failures: {}, inFlight: {} };
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run, null, false, 'qualityReview');
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P3.status, 'done', JSON.stringify({ stage: run.stages.P3, events: run.events.slice(-4), parts: Object.keys(run.artifacts.creativeDraft?.parts || {}) }));
  assert.equal(run.artifacts.posts.length, 2);
  assert.equal(run.artifacts.qualityReview.status, 'unverified');
});

test('an incomplete poster response schedules repair instead of looping as a saved section', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.generateCreative = async () => ({ creative: { posterPrompts: [{ variant: 'luminous_cinema', prompt: 'too short' }, { variant: 'editorial_romance', prompt: '' }] }, model: 'hy3', responseId: 'empty-posters', usage: { totalTokens: 10 } });
  const packageData = creative();
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Poster Recovery Romance', sku: 'poster-recovery', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done'; run.stages.P2.status = 'done'; run.stages.P5.status = 'done';
  run.artifacts.book = { bookSkuId: 'poster-recovery' };
  run.artifacts.evidence = { chapters: [{ order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' }, { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom.' }] };
  run.artifacts.code = '44444'; run.artifacts.shortUrl = 'https://social.example/s/abc';
  run.artifacts.creativeDraft = { parts: { posts: packageData.posts, videoPrompt: packageData.videoPrompt }, usage: [], failures: {}, inFlight: {}, modelRoute: { preferredModel: 'hy3', activeModel: 'hy3', fallbackUsed: true } };
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run, null, false, 'posterPrompts');
  assert.equal(run.stages.P3.status, 'waiting');
  assert.equal(run.stages.P3.phase, 'model_output_repairing');
  assert.equal(run.artifacts.creativeDraft.parts.posterPrompts, undefined);
});

test('poster output falls back to locked evidence after reserve exhaustion', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.generateCreative = async () => {
    const error = new providers.ProviderError('Creative model returned incomplete creative posterPrompts');
    error.fallbackModel = 'hy3'; error.fallbackFrom = 'deepseek';
    throw error;
  };
  const packageData = creative();
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Poster Evidence Fallback', sku: 'poster-evidence', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done'; run.stages.P2.status = 'done'; run.stages.P5.status = 'done';
  run.artifacts.book = { bookSkuId: 'poster-evidence' };
  run.artifacts.evidence = { chapters: [
    { order: 3, content: 'He had already claimed the woman whose quiet courage changed his decision.' },
    { order: 4, content: 'Be ready because I will come to meet you here tomorrow without another excuse.' },
    { order: 5, content: 'I will not go with Bella because I am seeing the woman I have already claimed.' }
  ] };
  run.artifacts.code = '44445'; run.artifacts.shortUrl = 'https://social.example/s/abc';
  run.artifacts.creativeDraft = {
    parts: { posts: packageData.posts, videoPrompt: packageData.videoPrompt },
    usage: [], failures: { posterPrompts: { attempt: 3 } }, repairAttempts: { posterPrompts: 2 }, inFlight: {},
    modelRoute: { preferredModel: 'deepseek', activeModel: 'hy3', fallbackUsed: true }
  };
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run, null, false, 'posterPrompts');
  assert.equal(run.stages.P3.status, 'waiting');
  assert.equal(run.stages.P3.phase, 'poster_evidence_fallback');
  assert.equal(run.artifacts.creativeDraft.parts.posterPrompts.length, 2);
  assert.ok(run.artifacts.creativeDraft.parts.posterPrompts.every((item) => item.prompt.length > 80));
});

test('video prompt falls back to saved AI copy and exact evidence after both model routes fail', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  const packageData = creative();
  providers.generateCreative = async () => {
    const error = new providers.ProviderError('Primary invalid JSON; fallback invalid JSON');
    error.fallbackModel = 'hy3'; error.fallbackFrom = 'deepseek';
    throw error;
  };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Video Recovery Romance', sku: 'video-recovery', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.artifacts.book = { bookSkuId: 'video-recovery' };
  run.artifacts.evidence = { chapters: [{ order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' }, { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.' }, { order: 3, content: 'The rain hit the glass while she refused to lower her eyes.' }] };
  run.artifacts.code = '44444'; run.artifacts.shortUrl = 'https://social.example/s/abc';
  run.artifacts.creativeDraft = { parts: { posts: packageData.posts, posterPrompts: packageData.posterPrompts }, usage: [], failures: {}, inFlight: {} };
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run, null, false, 'videoPrompt');
  assert.equal(run.state, 'running');
  assert.equal(run.artifacts.creativeDraft.parts.videoPrompt.fallbackStatus, 'derived_from_ai_copy_and_source_evidence');
  assert.equal(run.artifacts.creativeDraft.parts.videoPrompt.sourceEvidence.length, 3);
  assert.match(run.events.map((item) => item.type).join(' '), /creative_video_evidence_fallback/);
});

test('video prompt uses the full evidence package when malformed posts cannot support the narrow fallback', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.generateCreative = async () => {
    const error = new providers.ProviderError('Primary invalid JSON; fallback invalid JSON');
    error.fallbackModel = 'hy3'; error.fallbackFrom = 'deepseek';
    throw error;
  };
  const packageData = creative();
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Video Full Evidence Recovery', sku: 'video-full-evidence-recovery', promoter: 'xujt', paidAuthorized: true, creativeProfile: { emojiRange: '3-5' } });
  run.state = 'running';
  run.artifacts.book = { bookSkuId: 'video-full-evidence-recovery' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' },
    { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.' },
    { order: 3, content: 'The rain hit the glass while she refused to lower her eyes and nobody could make her surrender the truth.' }
  ] };
  run.artifacts.code = '44448'; run.artifacts.shortUrl = 'https://social.example/s/full-evidence';
  run.artifacts.creativeDraft = {
    parts: { posts: [{ type: 'hook', sixSteps: {} }], posterPrompts: packageData.posterPrompts },
    usage: [], failures: {}, inFlight: {}, modelRoute: { preferredModel: 'deepseek', activeModel: 'hy3', fallbackUsed: true }
  };
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run, null, false, 'videoPrompt');
  assert.equal(run.state, 'failed');
  assert.equal(run.stages.P3.status, 'failed');
  assert.equal(run.stages.P3.phase, 'evidence_continuation_review');
  assert.equal(run.artifacts.posts, undefined);
  assert.equal(run.artifacts.evidenceContinuationCandidate.status, 'awaiting_operator_review');
  assert.equal(run.artifacts.creativeDraft, undefined);
  assert.match(run.events.map((item) => item.type).join(' '), /creative_evidence_candidate_saved/);
});

test('batch worker reaches evidence-only recovery for a structured terminal P3 failure with deferred attribution', async () => {
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Batch Evidence Recovery', sku: 'batch-evidence-recovery', promoter: 'xujt', paidAuthorized: true, creativeProfile: { emojiRange: '3-5' } });
  run.input.delivery = normalizeDelivery({ accountId: 13943485 });
  run.state = 'failed';
  run.stages.P1.status = 'done'; run.stages.P2.status = 'done'; run.stages.P5.status = 'done';
  run.stages.P3 = {
    ...run.stages.P3,
    status: 'failed', phase: 'waiting_for_operator', recoverable: false,
    error: 'Creative model returned incomplete creative videoPrompt'
  };
  run.artifacts.book = { bookSkuId: 'batch-evidence-recovery' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'She found the signed contract before dawn, and every promise she trusted suddenly felt like a trap.' },
    { order: 2, content: 'He closed the office door behind her and said the final clause had never been an offer at all.' },
    { order: 3, content: 'She placed the evidence on his desk before he could destroy it, then waited for him to look up.' }
  ] };
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  const batch = await processRun(redis, run, { batch: true, maxSteps: 1 });
  assert.equal(batch.progressed, true);
  assert.equal(batch.run.state, 'failed');
  assert.equal(batch.run.stages.P3.status, 'failed');
  assert.equal(batch.run.stages.P3.phase, 'evidence_continuation_review');
  assert.equal(batch.run.artifacts.posts, undefined);
  assert.equal(batch.run.artifacts.evidenceContinuationCandidate.status, 'awaiting_operator_review');
  assert.ok(!(batch.run.artifacts.images || []).some((asset) => asset.taskId));
  assert.equal(batch.run.artifacts.video?.threadId || '', '');
});

test('manual P3 retry calls the configured model instead of looping to locked evidence', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let modelCalls = 0;
  providers.generateCreative = async (_book, _evidence, _code, _url, _revision, _profile, section) => { modelCalls += 1; return { creative: packageForSection(section), model: 'deepseek-v4-flash-0731', responseId: `manual-${section}`, usage: { totalTokens: 10 } }; };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Manual Evidence Recovery', sku: 'manual-evidence-recovery', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done'; run.stages.P2.status = 'done'; run.stages.P5.status = 'done';
  run.stages.P3 = { ...run.stages.P3, status: 'waiting', phase: 'manual_retry' };
  run.input.delivery = normalizeDelivery({ accountId: 13943485 });
  run.artifacts.book = { bookSkuId: 'manual-evidence-recovery' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'She found the signed contract before dawn, and every promise she trusted suddenly felt like a trap.' },
    { order: 2, content: 'He closed the office door behind her and said the final clause had never been an offer at all.' },
    { order: 3, content: 'She placed the evidence on his desk before he could destroy it, then waited for him to look up.' }
  ] };
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run, null, false, 'posts');
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P3.status, 'waiting');
  assert.equal(modelCalls, 1);
  assert.equal(run.artifacts.evidenceContinuationCandidate, undefined);
  assert.equal(run.artifacts.video?.threadId || '', '');
});

test('P3 skips another model call when P2 evidence continuation already saw a malformed post section', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.generateCreative = async () => { throw new Error('P3 should use the saved evidence circuit breaker before requesting a model'); };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Evidence Circuit Breaker', sku: 'evidence-circuit-breaker', promoter: 'xujt', paidAuthorized: true, creativeProfile: { emojiRange: '3-5' } });
  run.state = 'running';
  run.stages.P1.status = 'done'; run.stages.P2 = { ...run.stages.P2, status: 'done', phase: 'evidence_continuation' }; run.stages.P5.status = 'done';
  run.stages.P3 = { ...run.stages.P3, status: 'waiting', phase: 'model_output_repairing', error: 'Creative model returned incomplete creative posts' };
  run.artifacts.book = { bookSkuId: 'evidence-circuit-breaker' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'She found the signed contract before dawn, and every promise she trusted suddenly felt like a trap.' },
    { order: 2, content: 'He closed the office door behind her and said the final clause had never been an offer at all.' },
    { order: 3, content: 'She placed the evidence on his desk before he could destroy it, then waited for him to look up.' }
  ] };
  run.artifacts.code = '44450'; run.artifacts.shortUrl = 'https://social.example/s/evidence-circuit-breaker';
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run);
  assert.equal(run.state, 'failed');
  assert.equal(run.stages.P3.status, 'failed');
  assert.equal(run.stages.P3.phase, 'evidence_continuation_review');
  assert.equal(run.artifacts.posts, undefined);
  assert.equal(run.artifacts.evidenceContinuationCandidate.status, 'awaiting_operator_review');
  assert.match(run.events.map((item) => item.type).join(' '), /creative_posts_evidence_circuit_breaker/);
});

test('P3 skips a third malformed post request after its one JSON repair', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.generateCreative = async () => { throw new Error('P3 should not make a third malformed post request'); };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'P3 Repair Circuit Breaker', sku: 'p3-repair-circuit-breaker', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done'; run.stages.P2 = { ...run.stages.P2, status: 'done', phase: 'story_intelligence' }; run.stages.P5.status = 'done';
  run.stages.P3 = { ...run.stages.P3, status: 'waiting', phase: 'model_output_repairing', error: 'Creative model returned incomplete creative posts' };
  run.artifacts.book = { bookSkuId: 'p3-repair-circuit-breaker' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'She found the signed contract before dawn, and every promise she trusted suddenly felt like a trap.' },
    { order: 2, content: 'He closed the office door behind her and said the final clause had never been an offer at all.' },
    { order: 3, content: 'She placed the evidence on his desk before he could destroy it, then waited for him to look up.' }
  ] };
  run.artifacts.code = '44451'; run.artifacts.shortUrl = 'https://social.example/s/p3-repair-circuit-breaker';
  run.artifacts.creativeDraft = { parts: {}, usage: [], failures: { posts: { repairAttempts: 1, error: 'Creative model returned incomplete creative posts' } }, repairAttempts: { posts: 1 }, inFlight: {} };
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run);
  assert.equal(run.state, 'failed');
  assert.equal(run.stages.P3.status, 'failed');
  assert.equal(run.stages.P3.phase, 'evidence_continuation_review');
  assert.equal(run.artifacts.posts, undefined);
  assert.equal(run.artifacts.evidenceContinuationCandidate.status, 'awaiting_operator_review');
  assert.match(run.events.map((item) => item.type).join(' '), /creative_posts_evidence_circuit_breaker/);
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
    validateImage: async (url) => ({ contentType: 'image/jpeg', contentLength: 1234, resolvedUrl: url }),
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
  assert.equal(run.stages.P7.status, 'waiting');
  assert.equal(run.stages.P7.blockedReason, 'external_submission_required');
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

test('premium runs carry pending fidelity review as a warning while allowing draft packaging', async () => {
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.input.creativeProfile = { ...(run.input.creativeProfile || {}), qualityMode: 'premium' };
  run.stages.P4 = { status: 'done' };
  run.stages.P3_5 = { status: 'done' };
  run.stages.P6 = { status: 'waiting' };
  run.stages.P7 = { status: 'waiting' };
  run.artifacts.video = {
    status: 'completed',
    videoUrls: ['https://cdn.example/premium.mp4'],
    executionQa: { status: 'pending_manual_review', score: null }
  };

  await processRun(redis, run);

  assert.equal(run.state, 'running');
  assert.equal(run.stages.P6.status, 'done');
  assert.equal(run.stages.P6.blockedReason || '', '');
  assert.equal(run.stages.P7.status, 'waiting');
  assert.equal(run.artifacts.review.mediaWarnings[0].status, 'pending_manual_review');
});

test('video-only delivery skips the optional poster branch without submitting images', async () => {
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.input.posterGenerationRequired = false;
  run.stages.P4 = { status: 'done' };
  run.stages.P3_5 = { status: 'waiting' };
  let imageSubmissions = 0;
  const originalSubmitImage = providers.submitImage;
  providers.submitImage = async () => { imageSubmissions += 1; return { id: 'must-not-submit' }; };
  try {
    await processRun(redis, run);
  } finally {
    providers.submitImage = originalSubmitImage;
  }
  assert.equal(imageSubmissions, 0);
  assert.equal(run.stages.P3_5.status, 'partial');
  assert.equal(run.stages.P3_5.nonBlocking, true);
  assert.match(run.stages.P3_5.label, /不需要海报/);
});

test('a completed revision carries fresh pending QA as a warning for draft packaging', async () => {
  const { reviewVideoFidelity } = require('../api/runs');
  const { completeRevision } = require('../api/video-revision');
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.input.creativeProfile = { ...(run.input.creativeProfile || {}), qualityMode: 'premium' };
  run.stages.P4 = { status: 'done' };
  run.stages.P3_5 = { status: 'done' };
  run.stages.P6 = { status: 'waiting' };
  run.stages.P7 = { status: 'waiting' };
  run.artifacts.video = { status: 'completed', threadId: 'original-thread', payloadFingerprint: 'contract-1', videoUrls: ['https://cdn.example/original.mp4'] };
  const criteria = { eventImmediacy: 5, socialStakes: 4, conflictObject: 5, powerDelta: 4, visualSpecificity: 4, brandPremium: 4 };
  reviewVideoFidelity(run, { decision: 'approve', score: 87, criteria, openingClass: 'public_confrontation' });

  run.artifacts.videoRevision = { status: 'running', threadId: 'revision-thread', payloadFingerprint: 'contract-2', videoUrls: ['https://cdn.example/revision.mp4'] };
  completeRevision(run, run.artifacts.videoRevision, { contentType: 'video/mp4', contentLength: 1234 });
  await processRun(redis, run);
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P6.status, 'done');
  assert.equal(run.artifacts.review.mediaWarnings[0].status, 'pending_manual_review');

  reviewVideoFidelity(run, { decision: 'approve', score: 87, criteria, openingClass: 'public_confrontation' });
  assert.equal(run.stages.P6.status, 'done');
  assert.equal(run.artifacts.videoRevision.executionQa.status, 'approved');
});

test('English posts cannot hide Portuguese narration or shot instructions in the video package', () => {
  const run = mediaReadyRun();
  run.input.creativeProfile = { ...(run.input.creativeProfile || {}), forceEnglish: true, outputLanguage: 'en' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' },
    { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.' }
  ] };
  const packageData = creative();
  packageData.videoPrompt.adCopy = 'Ela não aceita mais uma escolha feita para ela, porque a verdade estava com ela quando tudo mudou. Uma promessa sem amor não pode esconder o que foi feito, mas ela estava pronta para mostrar a verdade para todos.';
  packageData.videoPrompt.buildRequirement = 'Comece com ela segurando o contrato, quando ele entra na sala e percebe que ela não vai recuar. Mostre a escolha, a verdade, a reação e então termine com ela diante de todos sem esconder o documento.';
  assert.throws(() => normalizeCreative({ creative: packageData }, run), /English social route received probable Portuguese or Spanish visible creative copy/);
});

test('operator video pause persists a prepared payload without submitting AC', async (t) => {
  const previous = process.env.SOCIAL_VIDEO_GENERATION_PAUSED;
  const originalSubmit = providers.submitAc;
  const originalFind = providers.findAcTask;
  t.after(() => {
    if (previous === undefined) delete process.env.SOCIAL_VIDEO_GENERATION_PAUSED;
    else process.env.SOCIAL_VIDEO_GENERATION_PAUSED = previous;
    providers.submitAc = originalSubmit;
    providers.findAcTask = originalFind;
  });
  process.env.SOCIAL_VIDEO_GENERATION_PAUSED = 'true';
  let submissions = 0;
  providers.submitAc = async () => { submissions += 1; return { threadId: 'must-not-exist' }; };
  providers.findAcTask = async () => null;
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P3_5 = { status: 'waiting' };

  await processRun(redis, run);
  await processRun(redis, run);

  assert.equal(submissions, 0);
  assert.equal(run.stages.P4.status, 'prepared');
  assert.equal(run.stages.P4.blockedReason, 'operator_video_pause');
  assert.equal(run.artifacts.video.threadId, '');
  assert.equal(run.stages.P3_5.status, 'prepared');
});

test('an explicitly authorized new run may submit video in production without waking legacy prepared runs', async (t) => {
  const previousPause = process.env.SOCIAL_VIDEO_GENERATION_PAUSED;
  const previousEnvironment = process.env.VERCEL_ENV;
  const originals = { ...providers };
  t.after(() => {
    if (previousPause === undefined) delete process.env.SOCIAL_VIDEO_GENERATION_PAUSED;
    else process.env.SOCIAL_VIDEO_GENERATION_PAUSED = previousPause;
    if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousEnvironment;
    Object.assign(providers, originals);
  });
  delete process.env.SOCIAL_VIDEO_GENERATION_PAUSED;
  process.env.VERCEL_ENV = 'production';
  let submissions = 0;
  Object.assign(providers, {
    findAcTask: async () => null,
    submitAc: async () => { submissions += 1; return { threadId: 'authorized-media-thread' }; }
  });
  const redis = new MemoryRedis();
  const authorized = mediaReadyRun();
  authorized.input.paidMediaSubmissionAuthorized = true;
  authorized.stages.P3_5 = { status: 'done' };
  await processRun(redis, authorized);
  await processRun(redis, authorized);
  assert.equal(submissions, 1);
  assert.equal(authorized.stages.P4.status, 'running');

  const legacy = mediaReadyRun();
  legacy.stages.P3_5 = { status: 'done' };
  await processRun(redis, legacy);
  assert.equal(submissions, 1);
  assert.equal(legacy.stages.P4.status, 'prepared');
  assert.equal(legacy.stages.P4.blockedReason, 'operator_video_pause');
});

test('an explicitly authorized new run may submit posters in production', async (t) => {
  const previousPause = process.env.SOCIAL_IMAGE_GENERATION_PAUSED;
  const previousEnvironment = process.env.VERCEL_ENV;
  const originals = { ...providers };
  t.after(() => {
    if (previousPause === undefined) delete process.env.SOCIAL_IMAGE_GENERATION_PAUSED;
    else process.env.SOCIAL_IMAGE_GENERATION_PAUSED = previousPause;
    if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousEnvironment;
    Object.assign(providers, originals);
  });
  delete process.env.SOCIAL_IMAGE_GENERATION_PAUSED;
  process.env.VERCEL_ENV = 'production';
  let submissions = 0;
  providers.submitImage = async (asset) => { submissions += 1; return { id: `authorized-${asset.variant}`, status: 'queued' }; };
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.input.paidMediaSubmissionAuthorized = true;
  run.stages.P4 = { status: 'done' };
  run.stages.P3_5 = { status: 'waiting' };
  await processRun(redis, run);
  await processRun(redis, run);
  assert.equal(submissions, 1);
  assert.notEqual(run.stages.P3_5.blockedReason, 'operator_image_pause');
});

function preparedPausedVideoRun(id = 'prepared-video-target') {
  const run = mediaReadyRun();
  run.id = id;
  run.input.sku = 'same-video-sku';
  run.stages.P3_5 = { status: 'done' };
  run.stages.P4 = { status: 'prepared', blockedReason: 'operator_video_pause', lastReconciledAt: '2026-08-19T00:00:00.000Z' };
  run.artifacts.video = {
    status: 'prepared',
    remark: 'nf_prepared_contract',
    payloadFingerprint: 'prepared-payload-fingerprint',
    threadId: '',
    videoUrls: []
  };
  return run;
}

function completedSiblingVideoRun(target, id = 'completed-video-sibling') {
  const sibling = mediaReadyRun();
  sibling.id = id;
  sibling.input.sku = target.input.sku;
  sibling.artifacts.videoPrompt = JSON.parse(JSON.stringify(target.artifacts.videoPrompt));
  sibling.stages.P4 = { status: 'done', threadId: 'thread-historical' };
  sibling.artifacts.video = {
    status: 'completed',
    threadId: 'thread-historical',
    videoUrls: ['https://cdn.example/historical.mp4'],
    mediaValidation: { contentType: 'video/mp4', contentLength: 4321 },
    videoModel: 'seedance-historical'
  };
  return sibling;
}

test('prepared video recovers from an exact-SKU exact-contract verified sibling without submitting AC', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let submissions = 0;
  providers.submitAc = async () => { submissions += 1; throw new Error('Exact sibling recovery must not submit AC'); };
  providers.validateVideo = async (url) => ({ contentType: 'video/mp4', contentLength: 4321, resolvedUrl: url });
  const redis = new MemoryRedis();
  const target = preparedPausedVideoRun();
  const sibling = completedSiblingVideoRun(target);

  const recovered = await recoverPreparedVideoFromExactSibling(redis, target, [sibling]);

  assert.equal(recovered, true);
  assert.equal(submissions, 0);
  assert.equal(target.stages.P4.status, 'done');
  assert.equal(target.artifacts.video.status, 'completed');
  assert.equal(target.artifacts.video.reusedFromRunId, sibling.id);
  assert.equal(target.artifacts.video.sourceThreadId, 'thread-historical');
  assert.equal(target.artifacts.video.contractFingerprint, videoContractFingerprint(target));
  assert.equal(target.artifacts.video.videoUrls[0], 'https://cdn.example/historical.mp4');
  assert.equal(target.artifacts.video.preparedAudit.remark, 'nf_prepared_contract');
  assert.match(target.events.map((event) => event.type).join(' '), /prepared_video_recovered_from_exact_sibling/);
});

test('prepared video recovery never reuses media inside a uniqueness-required campaign', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let validations = 0;
  providers.validateVideo = async () => { validations += 1; return { contentType: 'video/mp4' }; };
  const target = preparedPausedVideoRun();
  target.input.campaign = { id: 'campaign-36' };
  target.input.creativeProfile = { ...(target.input.creativeProfile || {}), uniquenessRequired: true };
  const sibling = completedSiblingVideoRun(target);
  sibling.input.campaign = { id: 'campaign-36' };

  const recovered = await recoverPreparedVideoFromExactSibling(new MemoryRedis(), target, [sibling]);

  assert.equal(recovered, false);
  assert.equal(validations, 0);
  assert.equal(target.stages.P4.status, 'prepared');
});

test('prepared video recovery refuses a same-SKU sibling whose creative contract differs', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let validations = 0;
  providers.validateVideo = async () => { validations += 1; return { contentType: 'video/mp4' }; };
  const redis = new MemoryRedis();
  const target = preparedPausedVideoRun('prepared-contract-mismatch');
  const sibling = completedSiblingVideoRun(target, 'completed-contract-mismatch');
  sibling.artifacts.videoPrompt.reversal = 'A different documented reversal changes the scene contract.';

  const recovered = await recoverPreparedVideoFromExactSibling(redis, target, [sibling]);

  assert.equal(recovered, false);
  assert.equal(validations, 0);
  assert.equal(target.stages.P4.status, 'prepared');
  assert.equal(target.artifacts.video.status, 'prepared');
});

test('prepared video recovery refuses a historical URL that fails live video validation', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.validateVideo = async () => ({ contentType: 'text/html', contentLength: 88 });
  const redis = new MemoryRedis();
  const target = preparedPausedVideoRun('prepared-invalid-media');
  const sibling = completedSiblingVideoRun(target, 'completed-invalid-media');

  const recovered = await recoverPreparedVideoFromExactSibling(redis, target, [sibling]);

  assert.equal(recovered, false);
  assert.equal(target.stages.P4.status, 'prepared');
  assert.equal(target.artifacts.video.videoUrls.length, 0);
  assert.equal(target.artifacts.video.reusedFromRunId, undefined);
});

test('prepared video recovery cools down an empty deep-history scan without moving production progress', async () => {
  const redis = new MemoryRedis();
  let historyScans = 0;
  redis.zrange = async () => { historyScans += 1; return []; };
  const target = preparedPausedVideoRun('prepared-no-history-match');
  target.updatedAt = '2026-08-18T00:00:00.000Z';

  assert.equal(await recoverPreparedVideoFromExactSibling(redis, target), false);
  const firstCheck = target.stages.P4.lastDeepReuseCheckedAt;
  assert.ok(firstCheck);
  assert.equal(target.updatedAt, '2026-08-18T00:00:00.000Z');
  const siblingTarget = preparedPausedVideoRun('prepared-no-history-match-sibling');
  assert.equal(await recoverPreparedVideoFromExactSibling(redis, siblingTarget), false);
  assert.equal(siblingTarget.stages.P4.lastDeepReuseCheckedAt, undefined);
  assert.equal(historyScans, 3);
});

test('one-click batch crosses free stage boundaries and stops after one paid video submission', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let videoSubmits = 0;
  let videoPolls = 0;
  Object.assign(providers, {
    findAcTask: async () => null,
    submitAc: async () => { videoSubmits += 1; return { threadId: 'thread-batch-one-click' }; },
    acResult: async () => {
      videoPolls += 1;
      return { status: 'running', threadId: 'thread-batch-one-click', videoUrls: [] };
    }
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P3_5 = { status: 'done' };

  const first = await processRunBatch(redis, run, { maxSteps: 8, maxRuntimeMs: 30000 });

  assert.equal(first.progressed, true);
  assert.equal(first.steps, 2);
  assert.equal(first.stopReason, 'media_submitted');
  assert.equal(run.stages.P4.status, 'running');
  assert.equal(run.artifacts.video.threadId, 'thread-batch-one-click');
  assert.equal(videoSubmits, 1);
  assert.equal(videoPolls, 0);

  const second = await processRunBatch(redis, run, { maxSteps: 8, maxRuntimeMs: 30000 });
  assert.equal(second.steps, 1);
  assert.equal(second.stopReason, 'media_poll');
  assert.equal(videoSubmits, 1);
  assert.equal(videoPolls, 1);
  assert.equal(run.artifacts.video.threadId, 'thread-batch-one-click');
});

test('one-click batch stops on a future retry instead of spinning', async () => {
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P3 = {
    status: 'waiting',
    phase: 'fallback_scheduled',
    nextAttemptAt: new Date(Date.now() + 60000).toISOString()
  };
  const result = await processRunBatch(redis, run, { maxSteps: 20, maxRuntimeMs: 30000 });
  assert.equal(result.steps, 0);
  assert.equal(result.progressed, false);
  assert.equal(result.stopReason, 'backoff');
});

test('one-click batch ignores retry timestamps retained on completed stages', async () => {
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P1.nextAttemptAt = new Date(Date.now() + 60000).toISOString();
  run.stages.P1.status = 'done';
  run.stages.P3_5 = { status: 'done' };
  run.stages.P4 = { status: 'done' };
  run.stages.P6 = { status: 'done' };
  run.state = 'completed';
  const result = await processRunBatch(redis, run, { maxSteps: 20, maxRuntimeMs: 30000 });
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.steps, 0);
});

test('one-click batch completes every P3 model section without another browser kick', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  const packageData = creative();
  const sections = [];
  providers.generateCreative = async (...args) => {
    const section = args[6];
    sections.push(section);
    return {
      creative: { [section]: section === 'qualityReview' ? {} : packageData[section] },
      model: 'hy3', responseId: `batch-${section}`, usage: { totalTokens: 50 }
    };
  };
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P3 = { status: 'waiting' };
  run.stages.P3_5 = { status: 'done' };
  run.stages.P4 = { status: 'done' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' },
    { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.' }
  ] };
  run.artifacts.posts = [];
  run.artifacts.videoPrompt = null;
  run.artifacts.posterPrompts = [];
  run.artifacts.video = { status: 'completed', threadId: 'batch-video', videoUrls: ['https://cdn.example/batch-video.mp4'] };
  delete run.artifacts.qualityReview;
  delete run.artifacts.optimization;

  const result = await processRunBatch(redis, run, { maxSteps: 10, maxRuntimeMs: 30000 });

  assert.deepEqual(sections, ['posts', 'videoPrompt', 'posterPrompts', 'qualityReview']);
  assert.equal(run.stages.P3.status, 'done');
  assert.equal(run.state, 'completed');
  assert.equal(result.stopReason, 'completed');
  assert.ok(result.steps >= 5);
});

test('video polling backoff does not block the independent poster branch', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let imageSubmits = 0;
  let videoPolls = 0;
  Object.assign(providers, {
    submitImage: async (asset) => { imageSubmits += 1; return { id: `image-${asset.variant}`, status: 'queued' }; },
    acResult: async () => { videoPolls += 1; return { status: 'running', threadId: 'video-in-flight', videoUrls: [] }; }
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'running', nextAttemptAt: new Date(Date.now() + 60000).toISOString() };
  run.artifacts.video = { status: 'running', threadId: 'video-in-flight', videoUrls: [] };
  run.stages.P3_5 = { status: 'waiting' };

  const result = await processRunBatch(redis, run, { maxSteps: 8, maxRuntimeMs: 30000 });

  assert.equal(result.stopReason, 'media_submitted');
  assert.equal(imageSubmits, 1);
  assert.equal(videoPolls, 0);
  assert.equal(run.artifacts.images[0].taskId, 'image-luminous_cinema');
  assert.equal(run.artifacts.video.threadId, 'video-in-flight');
});

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

test('ambiguous posters recover atomically from exact-SKU exact-prompt verified sibling assets without a provider call', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.submitImage = async () => { throw new Error('Sibling recovery must not submit another paid image request'); };
  const redis = new MemoryRedis();
  const target = mediaReadyRun();
  target.id = 'target-ambiguous-posters';
  target.input.sku = 'same-sku';
  target.stages.P3_5 = { status: 'ambiguous', error: 'IIIT timed out' };
  target.artifacts.images = target.artifacts.posterPrompts.map((prompt, index) => ({
    variant: prompt.variant, prompt: prompt.prompt, status: index === 0 ? 'submitting' : 'prepared', taskId: '', providerRequestId: '', submitAttemptedAt: new Date().toISOString()
  }));
  const sibling = mediaReadyRun();
  sibling.id = 'sibling-verified-posters';
  sibling.input.sku = 'same-sku';
  sibling.artifacts.images = sibling.artifacts.posterPrompts.map((prompt) => ({
    variant: prompt.variant, prompt: prompt.prompt, status: 'success', url: `https://cdn.example/${prompt.variant}.jpg`,
    mediaValidation: { contentType: 'image/jpeg', contentLength: 1234, resolvedUrl: `https://cdn.example/${prompt.variant}.jpg` }
  }));
  await redis.set(`nf_social:run:${target.id}`, JSON.stringify(target));
  const recovered = await recoverAmbiguousPostersFromExactSibling(redis, target, [sibling]);
  assert.equal(recovered, true);
  assert.equal(target.stages.P3_5.status, 'done');
  assert.ok(target.artifacts.images.every((asset) => asset.status === 'success' && asset.reusedFromRunId === sibling.id));
  assert.ok(target.artifacts.images.every((asset) => asset.ambiguousSubmission));
  assert.match(target.events.map((event) => event.type).join(' '), /ambiguous_posters_recovered_from_exact_sibling/);
});

test('uniqueness-required campaigns keep ambiguous posters fail-closed instead of reusing sibling media', async () => {
  const redis = new MemoryRedis();
  const target = mediaReadyRun();
  target.id = 'target-unique-ambiguous-posters';
  target.input.sku = 'same-campaign-sku';
  target.input.campaign = { id: 'campaign-unique-posters', itemIndex: 1 };
  target.input.creativeProfile = { ...(target.input.creativeProfile || {}), uniquenessRequired: true };
  target.stages.P3_5 = { status: 'ambiguous', error: 'IIIT timed out after submission' };
  target.artifacts.images = target.artifacts.posterPrompts.map((prompt) => ({
    variant: prompt.variant,
    prompt: prompt.prompt,
    status: 'submitting',
    taskId: '',
    providerRequestId: '',
    submitAttemptedAt: new Date().toISOString()
  }));
  const originalImages = JSON.parse(JSON.stringify(target.artifacts.images));

  const sibling = mediaReadyRun();
  sibling.id = 'sibling-unique-verified-posters';
  sibling.input.sku = 'same-campaign-sku';
  sibling.input.campaign = { id: 'campaign-unique-posters', itemIndex: 0 };
  sibling.artifacts.images = sibling.artifacts.posterPrompts.map((prompt) => ({
    variant: prompt.variant,
    prompt: prompt.prompt,
    status: 'success',
    url: `https://cdn.example/${prompt.variant}.jpg`,
    mediaValidation: { contentType: 'image/jpeg', contentLength: 1234 }
  }));

  const recovered = await recoverAmbiguousPostersFromExactSibling(redis, target, [sibling]);

  assert.equal(recovered, false);
  assert.equal(target.stages.P3_5.status, 'ambiguous');
  assert.deepEqual(target.artifacts.images, originalImages);
  assert.doesNotMatch(target.events.map((event) => event.type).join(' '), /ambiguous_posters_recovered_from_exact_sibling/);
});

test('ambiguous poster recovery refuses a sibling whose prompt differs', async () => {
  const redis = new MemoryRedis();
  const target = mediaReadyRun();
  target.id = 'target-no-prompt-match';
  target.input.sku = 'same-sku';
  target.stages.P3_5 = { status: 'ambiguous' };
  target.artifacts.images = [{ variant: 'luminous_cinema', prompt: 'exact prompt A', status: 'submitting', taskId: '' }];
  const sibling = mediaReadyRun();
  sibling.id = 'sibling-no-prompt-match';
  sibling.input.sku = 'same-sku';
  sibling.artifacts.images = [{ variant: 'luminous_cinema', prompt: 'different prompt B', status: 'success', url: 'https://cdn.example/a.jpg', mediaValidation: { contentType: 'image/jpeg' } }];
  const recovered = await recoverAmbiguousPostersFromExactSibling(redis, target, [sibling]);
  assert.equal(recovered, false);
  assert.equal(target.stages.P3_5.status, 'ambiguous');
  assert.equal(target.artifacts.images[0].status, 'submitting');
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

test('MaxNovel defers Code allocation until its attribution development is live', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let created = false;
  let linkCalls = 0;
  Object.assign(providers, {
    keywordRecord: async (code, options) => created ? { id: `kw-${code}`, applicationId: options.applicationId, keyword: code, bookId: 'max-sku', channel: 'FB', isEnable: true } : null,
    createKeyword: async (_sku, _code, options) => { assert.equal(options.applicationId, '69a172040a2d5813dec3bff7'); created = true; },
    findLink: async () => { linkCalls += 1; return null; },
    createLink: async () => { linkCalls += 1; return null; }
  });
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Max Romance', sku: 'max-sku', promoter: 'xujt', paidAuthorized: true, delivery: normalizeDelivery({ accountId: 13943482 }) });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  await processRun(redis, run);
  assert.equal(run.artifacts.code, '');
  assert.equal(run.stages.P5.status, 'done');
  assert.equal(run.stages.P5.phase, 'attribution_deferred');
  assert.equal(run.artifacts.shortUrl, '');
  assert.equal(linkCalls, 0);
  assert.equal(created, false);
});

test('AstraNovel Facebook uses the verified Astra application and link template', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let created = false;
  let linkCreated = false;
  let captured;
  Object.assign(providers, {
    keywordRecord: async (code, options) => created ? { id: `kw-${code}`, applicationId: options.applicationId, keyword: code, bookId: 'astra-sku', channel: 'FB', isEnable: true } : null,
    createKeyword: async (_sku, _code, options) => { captured = options; created = true; },
    findLink: async (_sku, _promoter, _code, options) => { captured = options; return linkCreated ? { id: 'astra-link', shortUrl: 'https://social.novelplus.vip/s/test', isEnabled: true } : null; },
    createLink: async (_book, promoter, _code, options) => { assert.equal(promoter, 'xujt'); captured = options; linkCreated = true; return { id: 'astra-link' }; }
  });
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Astra Romance', sku: 'astra-sku', promoter: 'xujt', paidAuthorized: true, delivery: normalizeDelivery({ accountId: 13943483 }) });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  await processRun(redis, run);
  await processRun(redis, run);
  await processRun(redis, run);
  assert.equal(run.artifacts.code, '60000');
  assert.equal(run.artifacts.shortUrl, 'https://social.novelplus.vip/s/test');
  assert.equal(captured.applicationId, '678dfef75344a83d71e56932');
  assert.equal(captured.channelNameId, '6a2021a4554323f68cac4096');
  assert.equal(captured.operatorName, '徐敬涛');
  assert.equal(captured.landingTemplateId, '6a20224383724a9e0204ac2f');
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
  assert.equal(run.stages.P3.phase, 'fallback_scheduled');
  assert.equal(run.stages.P3.recoverable, true);
  assert.equal(run.artifacts.creativeDraft.failures.posts.attempt, 1);
  assert.equal(run.artifacts.modelRoute.preferredModel, 'hy3');
  assert.equal(run.artifacts.modelRoute.activeModel, 'deepseek');
  assert.equal(run.artifacts.modelRoute.fallbackUsed, true);
  assert.equal(run.input.creativeProfile.modelChoice, 'deepseek');
  assert.match(run.events.map((event) => event.type).join(' '), /creative_section_started.*creative_section_fallback_scheduled/);
});

test('a task-wide model switch regenerates completed core sections instead of mixing models', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  const packageData = creative();
  const calls = [];
  providers.generateCreative = async (...args) => {
    const profile = args[5];
    const section = args[6];
    const modelChoice = profile.modelChoice;
    calls.push(`${modelChoice}:${section}`);
    if (modelChoice === 'hy3' && section === 'posts') {
      return {
        creative: { posts: packageData.posts.map((post) => ({ ...post, zhContent: 'HY3 discarded copy' })) },
        model: 'hy3', responseId: 'hy3-posts', usage: { inputTokens: 70, outputTokens: 41, totalTokens: 111 }
      };
    }
    if (modelChoice === 'hy3' && section === 'videoPrompt') throw new providers.ProviderError('HY3 video prompt timed out', { status: 504 });
    const value = section === 'qualityReview'
      ? { recommendation: 'keep', status: 'verified', conclusion: 'The reserve package is coherent.', why: 'Every core section uses the same source evidence and model route.', target: 'package' }
      : section === 'posts'
        ? packageData.posts.map((post) => ({ ...post, zhContent: 'DeepSeek final copy' }))
        : packageData[section];
    return { creative: { [section]: value }, model: 'deepseek', responseId: `deepseek-${section}`, usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } };
  };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Unified Route Romance', sku: 'route-sku', promoter: 'xujt', paidAuthorized: true, creativeProfile: { modelChoice: 'hy3' } });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  run.stages.P5.status = 'done';
  run.artifacts.book = { bookSkuId: 'route-sku', title: 'Unified Route Romance' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'A sufficiently long exact quote copied from chapter one. She found the signed contract before dawn.' },
    { order: 2, content: 'A sufficiently long exact quote copied from chapter two. The promise trapped her between duty and freedom. She placed the evidence on his desk.' }
  ] };
  run.artifacts.code = '44444';
  run.artifacts.shortUrl = 'https://social.example/s/abc';
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));

  await p3(redis, run, null, false, 'posts');
  assert.equal(run.artifacts.creativeDraft.parts.posts[0].zhContent, 'HY3 discarded copy');
  assert.equal(run.artifacts.creativeDraft.usage[0].totalTokens, 111);

  await p3(redis, run, null, false, 'videoPrompt');
  assert.equal(run.artifacts.modelRoute.activeModel, 'deepseek');
  assert.deepEqual(run.artifacts.creativeDraft.parts, {});
  assert.deepEqual(run.artifacts.creativeDraft.usage, []);
  assert.deepEqual(run.artifacts.creativeDraft.discardedGenerations[0].sections, ['posts']);
  assert.equal(run.artifacts.modelActivity.at(-1).validationStatus, 'discarded_model_switch');
  assert.equal(run.artifacts.modelActivity.at(-1).totalTokens, 111);

  for (let step = 0; step < 4; step += 1) await p3(redis, run);

  assert.equal(run.stages.P3.status, 'done');
  assert.equal(run.artifacts.posts[0].zhContent, 'DeepSeek final copy');
  assert.equal(run.artifacts.posts.some((post) => post.zhContent === 'HY3 discarded copy'), false);
  assert.equal(run.artifacts.usage.creative.totalTokens, 40);
  assert.deepEqual(calls, [
    'hy3:posts',
    'hy3:videoPrompt',
    'deepseek:posts',
    'deepseek:videoPrompt',
    'deepseek:posterPrompts',
    'deepseek:qualityReview'
  ]);
  assert.deepEqual(run.artifacts.modelActivity.filter((item) => item.validationStatus !== 'discarded_model_switch').map((item) => item.model), ['deepseek', 'deepseek', 'deepseek', 'deepseek']);
});

test('invalid DeepSeek creative draft is regenerated on DeepSeek without using HY3 credits', async (t) => {
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
  assert.equal(run.input.creativeProfile.modelChoice, 'deepseek');
  assert.deepEqual(run.artifacts.creativeDraft.parts, {});
  assert.equal(run.artifacts.creativeDraft.failures.posts.attempt, 1);
  assert.match(run.events.map((event) => event.type).join(' '), /creative_validation_fallback_scheduled/);
});

test('a twice-invalid package uses validated source evidence instead of shipping unverified copy', async () => {
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Evidence Continuation', sku: 'evidence-sku', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  run.stages.P5.status = 'done';
  run.artifacts.book = { bookSkuId: 'evidence-sku', title: 'Evidence Continuation' };
  run.artifacts.evidence = { chapters: [
    { order: 1, content: 'She found the signed contract before dawn, and every promise she trusted suddenly felt like a trap.' },
    { order: 2, content: 'He closed the office door behind her, then admitted the final clause had never been an offer.' },
    { order: 3, content: 'She placed the evidence on his desk before he could destroy it, and waited for him to look up.' }
  ] };
  run.artifacts.code = '44444';
  run.artifacts.shortUrl = 'https://social.example/s/evidence';
  run.artifacts.creativeDraft = {
    parts: { posts: [{ content: 'invalid' }], videoPrompt: {}, posterPrompts: [], qualityReview: {} },
    usage: [], failures: {}, inFlight: {}, validationFallbackUsed: true
  };
  await redis.set(`nf_social:run:${run.id}`, JSON.stringify(run));
  await p3(redis, run);
  assert.equal(run.state, 'failed');
  assert.equal(run.stages.P3.status, 'failed');
  assert.equal(run.stages.P3.phase, 'evidence_continuation_review');
  assert.equal(run.artifacts.posts, undefined);
  assert.equal(run.artifacts.evidenceContinuationCandidate.status, 'awaiting_operator_review');
  assert.equal(run.artifacts.optimization.status, 'evidence_continuation_review');
  assert.doesNotMatch(run.events.map((event) => event.type).join(' '), /creative_validation_nonblocking/);
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

test('video submission capacity reserves no more than forty slots per Beijing business day', async () => {
  const redis = new MemoryRedis();
  const slots = [];
  for (let index = 0; index < 41; index += 1) slots.push(await reserveVideoSlot(redis));
  assert.equal(slots.filter((slot) => slot.granted).length, 40);
  assert.equal(slots.at(-1).granted, false);
  assert.equal(slots.at(-1).used, 40);
  assert.match(slots[0].key, /^nf_social:video_day:/);
  assert.equal(slots[0].timeZone, 'Asia/Shanghai');
  assert.ok(Date.parse(slots[0].resetAt) > Date.now());
});

test('a full video day queues the video but keeps the poster branch moving', async () => {
  const redis = new MemoryRedis();
  for (let index = 0; index < 40; index += 1) assert.equal((await reserveVideoSlot(redis)).granted, true);
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'prepared' };
  run.stages.P3_5 = { status: 'waiting' };
  run.artifacts.video = { status: 'prepared', remark: 'capacity-wait', payload: {}, threadId: '', videoUrls: [] };

  await processRun(redis, run);
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P4.status, 'prepared');
  assert.equal(run.stages.P4.blockedReason, 'daily_video_limit');
  assert.ok(Date.parse(run.stages.P4.nextAttemptAt) > Date.now());

  await processRun(redis, run);
  assert.equal(run.stages.P3_5.status, 'prepared');
  assert.equal(run.artifacts.images.length, 2);
});

test('nonrecoverable P2 model configuration errors stop background recovery', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.analyzeCreativePlan = async () => { throw new providers.ProviderError('The selected model is not configured', { status: 503 }); };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Verified Romance', sku: 'sku-1', promoter: 'xujt', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.artifacts.book = { bookSkuId: 'sku-1', chapterCount: 2 };
  run.artifacts.evidence = { requested: 0, completed: 0, refs: [], chapters: [], chapterStructure: [] };

  await processRun(redis, run);

  assert.equal(run.state, 'failed');
  assert.equal(run.stages.P2.status, 'failed');
  assert.equal(run.stages.P2.recoverable, false);
  assert.equal(run.stages.P2.nextAttemptAt, '');
});

test('P2 model capacity errors wait and keep the active route', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.analyzeCreativePlan = async () => { throw new providers.ProviderError('达到用户并发上限(10)', { status: 429 }); };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Capacity Romance', sku: 'capacity-sku', promoter: 'xujt', paidAuthorized: true, creativeProfile: { modelChoice: 'hy3' } });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.artifacts.book = { bookSkuId: 'capacity-sku', chapterCount: 2 };
  run.artifacts.evidence = { requested: 0, completed: 0, refs: [], chapters: [], chapterStructure: [] };
  await processRun(redis, run);
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P2.status, 'waiting');
  assert.equal(run.stages.P2.phase, 'story_intelligence_capacity_wait');
  assert.ok(Date.parse(run.stages.P2.nextAttemptAt) > Date.now());
  assert.equal(run.artifacts.modelRoute.activeModel, 'hy3');
  assert.equal(run.artifacts.evidence.storyBrief.status, 'recovering');
});

test('P2 chapter-list transport failures wait and preserve a resumable cursor', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let listCalls = 0;
  providers.listChapters = async () => {
    listCalls += 1;
    if (listCalls === 1) throw new providers.ProviderError('Writer Admin temporarily unavailable', { status: 503 });
    return Array.from({ length: 8 }, (_, index) => ({ id: `retry-c${index + 1}`, order: index + 1, title: `Chapter ${index + 1}` }));
  };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Evidence Retry', sku: 'evidence-retry', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.artifacts.book = { bookSkuId: 'evidence-retry', cityBookId: 'city-evidence-retry', payPoint: 0 };

  await p2(redis, run);
  assert.equal(run.stages.P2.status, 'waiting');
  assert.equal(run.stages.P2.phase, 'evidence_catalogue_wait');
  assert.equal(run.stages.P2.recoverable, true);
  assert.ok(Date.parse(run.stages.P2.nextAttemptAt) > Date.now());
  assert.equal(run.artifacts.evidence, null);

  run.stages.P2.nextAttemptAt = new Date(0).toISOString();
  await p2(redis, run);
  assert.equal(run.stages.P2.status, 'running');
  assert.equal(run.artifacts.evidence.requested, 8);
  assert.equal(run.stages.P2.cursor, 0);
});

test('P1 identity transport failures wait without losing the exact SKU', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let lookups = 0;
  providers.findExactBook = async (_title, sku) => {
    lookups += 1;
    if (lookups === 1) throw new providers.ProviderError('bookstore timeout', { status: 504, code: 'provider_timeout' });
    return { bookSkuId: sku, cityBookId: 'identity-city', title: 'Identity Retry', payPoint: 0 };
  };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Identity Retry', sku: 'identity-retry', paidAuthorized: true });
  run.state = 'running';

  await p1(redis, run);
  assert.equal(run.stages.P1.status, 'waiting');
  assert.equal(run.stages.P1.phase, 'identity_provider_wait');
  assert.equal(run.input.sku, 'identity-retry');
  assert.ok(Date.parse(run.stages.P1.nextAttemptAt) > Date.now());

  run.stages.P1.nextAttemptAt = new Date(0).toISOString();
  await p1(redis, run);
  assert.equal(run.stages.P1.status, 'done');
  assert.equal(run.artifacts.book.bookSkuId, 'identity-retry');
  assert.equal(run.stages.P1.identityRetryCount, 0);
});

test('P2 chapter-content transport failures retry the same batch without skipping evidence', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let contentCalls = 0;
  providers.chapterContent = async (id) => {
    contentCalls += 1;
    if (contentCalls === 1) throw new providers.ProviderError('chapter read timed out', { status: 504, code: 'provider_timeout' });
    return `${id} contains a sufficiently long, exact source-grounded chapter event for the campaign.`;
  };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Evidence Content Retry', sku: 'evidence-content-retry', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.artifacts.book = { bookSkuId: 'evidence-content-retry', cityBookId: 'city-evidence-content-retry', payPoint: 0 };
  run.artifacts.evidence = {
    requested: 2, completed: 0, cursor: 0,
    refs: [{ id: 'retry-a', order: 1, title: 'A' }, { id: 'retry-b', order: 2, title: 'B' }],
    chapters: [], chapterStructure: []
  };
  run.stages.P2 = { status: 'running', cursor: 0 };

  await p2(redis, run);
  assert.equal(run.stages.P2.status, 'waiting');
  assert.equal(run.stages.P2.phase, 'evidence_content_wait');
  assert.equal(run.stages.P2.cursor, 0);
  assert.equal(run.artifacts.evidence.completed, 0);
  assert.equal(run.artifacts.evidence.chapters.length, 0);

  run.stages.P2.nextAttemptAt = new Date(0).toISOString();
  await p2(redis, run);
  assert.equal(run.artifacts.evidence.completed, 2);
  assert.equal(run.stages.P2.cursor, 2);
  assert.equal(run.stages.P2.evidenceRetryCount, 0);
});

test('P2 rebuilds a stale cursor from already persisted chapter IDs', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  const calls = [];
  providers.chapterContent = async (id) => { calls.push(id); return `${id} contains a sufficiently long exact source-grounded chapter event for recovery.`; };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Stale Cursor Evidence', sku: 'stale-cursor-evidence', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2 = { status: 'running', cursor: 0 };
  run.artifacts.book = { bookSkuId: 'stale-cursor-evidence', cityBookId: 'city-stale-cursor', payPoint: 0 };
  run.artifacts.evidence = {
    requested: '3', completed: '2', cursor: 0,
    refs: [
      { id: 'stale-c1', order: 1, title: 'A' },
      { id: 'stale-c2', order: 2, title: 'B' },
      { id: 'stale-c3', order: 3, title: 'C' }
    ],
    chapters: [
      { id: 'stale-c1', order: 1, title: 'A', content: 'already persisted evidence for chapter one' },
      { id: 'stale-c2', order: 2, title: 'B', content: 'already persisted evidence for chapter two' }
    ], chapterStructure: []
  };

  await p2(redis, run);

  assert.deepEqual(calls, ['stale-c3']);
  assert.equal(run.stages.P2.cursor, 3);
  assert.equal(run.artifacts.evidence.completed, 3);
});

test('P2 empty chapter content remains a deterministic failure, not an endless retry', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let calls = 0;
  providers.chapterContent = async () => {
    calls += 1;
    throw new providers.ProviderError('Chapter retry-empty returned empty content');
  };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Empty Evidence', sku: 'empty-evidence', paidAuthorized: true });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.artifacts.book = { bookSkuId: 'empty-evidence', cityBookId: 'city-empty', payPoint: 0 };
  run.artifacts.evidence = { requested: 1, completed: 0, cursor: 0, refs: [{ id: 'retry-empty', order: 1, title: 'A' }], chapters: [], chapterStructure: [] };
  run.stages.P2 = { status: 'running', cursor: 0 };

  await assert.rejects(() => p2(redis, run), /empty content/i);
  assert.equal(calls, 1);
  assert.equal(run.stages.P2.status, 'running');
});

test('P2 TokenDance story analysis shares the four-slot gate with creative workers', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let active = 0;
  let peak = 0;
  providers.analyzeCreativePlan = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return {
      plan: { editorialThesis: 'A grounded conflict is ready.', recommendedProfile: {} },
      model: 'deepseek-v4-flash-preview', responseId: 'gate-test', usage: { totalTokens: 1 }
    };
  };
  const redis = new MemoryRedis();
  const make = (id) => {
    const run = newRun({ title: `Gate ${id}`, sku: `gate-${id}`, creativeProfile: { modelChoice: 'deepseek-v4-flash-preview' } });
    run.id = id;
    run.state = 'running';
    run.stages.P1.status = 'done';
    run.artifacts.book = { bookSkuId: run.input.sku, title: run.input.title, chapterCount: 3 };
    run.artifacts.evidence = { requested: 3, completed: 3, chapters: [
      { order: 1, content: 'She found the signed contract before dawn and every promise became a question.' },
      { order: 2, content: 'He blocked the doorway while witnesses waited for her answer.' },
      { order: 3, content: 'She placed the evidence on his desk before he could destroy it.' }
    ], chapterStructure: [] };
    return run;
  };
  // `run_a` and `run_e` hash to the same gate slot (character codes differ by
  // four), making the contention deterministic for this regression.
  const first = make('run_a');
  const second = make('run_e');
  await Promise.all([p2(redis, first), p2(redis, second)]);
  assert.equal(peak, 1);
  assert.ok([first, second].some((run) => run.stages.P2.status === 'done'));
  assert.ok([first, second].some((run) => run.stages.P2.phase === 'story_intelligence_capacity_wait'));
});

test('premium P2 keeps complete source evidence and skips the optional strategy-model call', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let strategyCalls = 0;
  providers.analyzeCreativePlan = async () => { strategyCalls += 1; throw new Error('Premium P2 must not call the optional strategy model'); };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Premium Evidence', sku: 'premium-evidence-sku', promoter: 'xujt', paidAuthorized: true, creativeProfile: { modelChoice: 'deepseek', qualityMode: 'premium' } });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.artifacts.book = { bookSkuId: 'premium-evidence-sku', chapterCount: 3 };
  run.artifacts.evidence = {
    requested: 3, completed: 3, refs: [], chapterStructure: [],
    chapters: [
      { order: 1, content: 'She placed the sealed ledger on the council table before anyone could stop her.' },
      { order: 2, content: 'The guard blocked the doorway as every witness turned toward the broken seal.' },
      { order: 3, content: 'She reclaimed the empty chair while the room fell silent around her choice.' }
    ]
  };

  await processRun(redis, run);

  assert.equal(strategyCalls, 0);
  assert.equal(run.stages.P2.status, 'done');
  assert.equal(run.stages.P2.phase, 'evidence_ready_premium');
  assert.equal(run.artifacts.evidence.storyBrief.model, 'source-grounded-plan');
});

test('P2 DeepSeek structured-output failures repair on TokenDance before any HY3 reserve', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.analyzeCreativePlan = async () => { throw new providers.ProviderError('deepseek-v4-flash-0731 returned invalid structured output'); };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Structured Retry Romance', sku: 'structured-retry-sku', promoter: 'xujt', paidAuthorized: true, creativeProfile: { modelChoice: 'deepseek' } });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.artifacts.book = { bookSkuId: 'structured-retry-sku', chapterCount: 2 };
  run.artifacts.evidence = { requested: 0, completed: 0, refs: [], chapters: [], chapterStructure: [] };

  await processRun(redis, run);

  assert.equal(run.state, 'running');
  assert.equal(run.stages.P2.phase, 'story_intelligence_repairing');
  assert.equal(run.artifacts.modelRoute.activeModel, 'deepseek');
  assert.equal(run.artifacts.evidence.storyBrief.modelChoice, 'deepseek');
  assert.equal(run.artifacts.evidence.storyBrief.fallbackUsed, undefined);
});

test('P2 uses locked evidence after one malformed DeepSeek repair instead of a third request', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let calls = 0;
  providers.analyzeCreativePlan = async () => {
    calls += 1;
    throw new providers.ProviderError('deepseek-v4-flash-0731 returned invalid structured output');
  };
  const redis = new MemoryRedis();
  const run = newRun({ title: 'Bounded Structured Retry', sku: 'bounded-structured-retry', promoter: 'xujt', paidAuthorized: true, creativeProfile: { modelChoice: 'deepseek' } });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.artifacts.book = { bookSkuId: 'bounded-structured-retry', chapterCount: 3 };
  run.artifacts.evidence = {
    requested: 3, completed: 3, refs: [], chapterStructure: [],
    chapters: [
      { order: 1, content: 'She found the signed contract before dawn and every promise she trusted suddenly felt like a trap.' },
      { order: 2, content: 'He closed the office door behind her and said the final clause had never been an offer at all.' },
      { order: 3, content: 'She placed the evidence on his desk before he could destroy it, then waited for him to look up.' }
    ]
  };
  await processRun(redis, run);
  assert.equal(run.stages.P2.status, 'waiting');
  run.artifacts.evidence.storyBrief.nextAttemptAt = new Date(0).toISOString();
  await processRun(redis, run);
  assert.equal(calls, 2);
  assert.equal(run.stages.P2.status, 'done');
  assert.equal(run.stages.P2.phase, 'evidence_continuation');
  assert.equal(run.artifacts.modelRoute.activeModel, 'deepseek');
});

test('nonrecoverable P3 model configuration errors stop background recovery', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.generateCreative = async () => { throw new providers.ProviderError('DeepSeek copy model is not configured', { status: 503 }); };
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P3 = { status: 'waiting' };
  delete run.artifacts.creativeDraft;

  await processRun(redis, run);

  assert.equal(run.state, 'failed');
  assert.equal(run.stages.P3.status, 'failed');
  assert.equal(run.stages.P3.recoverable, false);
  assert.equal(run.stages.P3.nextAttemptAt, '');
});

test('P3 model capacity errors wait without discarding completed sections or switching models', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.generateCreative = async () => { throw new providers.ProviderError('rate limit: concurrent requests', { status: 429 }); };
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P3 = { status: 'waiting' };
  delete run.artifacts.creativeDraft;
  await p3(redis, run, null, false, 'posts');
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P3.status, 'waiting');
  assert.equal(run.stages.P3.phase, 'model_capacity_wait');
  assert.ok(Date.parse(run.stages.P3.nextAttemptAt) > Date.now());
  assert.equal(run.artifacts.modelRoute.activeModel, 'hy3');
  assert.equal(run.artifacts.creativeDraft.failures.posts.capacityWait, true);
  assert.deepEqual(run.artifacts.creativeDraft.parts, {});
});

test('a transient video poll error keeps the durable thread and resumes polling', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let polls = 0;
  Object.assign(providers, {
    acResult: async () => {
      polls += 1;
      if (polls === 1) throw new providers.ProviderError('AC result timed out', { status: 504 });
      return { status: 'completed', threadId: 'thread-existing', videoUrls: ['https://cdn.example/video.mp4'] };
    },
    validateVideo: async () => ({ contentType: 'video/mp4', contentLength: 1234 })
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'running' };
  run.stages.P3_5 = { status: 'done' };
  run.artifacts.video = { status: 'running', threadId: 'thread-existing', videoUrls: [] };

  await processRun(redis, run);
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P4.status, 'running');
  assert.equal(run.artifacts.video.threadId, 'thread-existing');
  assert.equal(run.stages.P4.recoverable, true);
  run.stages.P4.nextAttemptAt = new Date(0).toISOString();
  await processRun(redis, run);

  assert.equal(run.stages.P4.status, 'done');
  assert.equal(polls, 2);
});

test('P4 persists and settles one AC points reservation around the paid submit', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let receivedReservation = null;
  Object.assign(providers, {
    findAcTask: async () => null,
    submitAc: async (_payload, options) => {
      receivedReservation = options?.budgetReservation || null;
      return { threadId: 'thread-budgeted-p4' };
    },
    acResult: async () => ({ status: 'completed', threadId: 'thread-budgeted-p4', videoUrls: ['https://cdn.example/video.mp4'] }),
    validateVideo: async () => ({ contentType: 'video/mp4', contentLength: 1234 })
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'prepared' };
  run.stages.P3_5 = { status: 'done' };
  run.artifacts.video = { status: 'prepared', remark: 'nf-budgeted-p4', payload: {}, threadId: '', videoUrls: [] };

  await processRun(redis, run);

  assert.equal(run.stages.P4.status, 'running');
  assert.equal(run.artifacts.video.threadId, 'thread-budgeted-p4');
  assert.ok(receivedReservation?.reservationId);
  assert.equal(run.artifacts.video.budgetReservation.settlementStatus, 'submitted');
  assert.ok(run.artifacts.video.budgetReservation.settledAt);
  const dayKey = `nf_social:ac_points:${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '')}`;
  assert.equal(Number(await redis.get(dayKey)), 1);

  // A worker restart/poll must reuse the same external task and never reserve
  // or submit a second paid request.
  await processRun(redis, run);
  assert.equal(Number(await redis.get(dayKey)), 1);
  assert.equal(run.artifacts.video.budgetReservation.reservationId, receivedReservation.reservationId);
});

test('P4 releases both reservations when AC rejects before creating a task', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let submits = 0;
  Object.assign(providers, {
    findAcTask: async () => null,
    submitAc: async () => { submits += 1; throw new providers.ProviderError('AC points cap reached', { status: 429, code: 'ac_points_budget_exceeded' }); }
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'prepared' };
  run.stages.P3_5 = { status: 'done' };
  run.artifacts.video = { status: 'prepared', remark: 'nf-budget-release', payload: {}, threadId: '', videoUrls: [] };

  await processRun(redis, run);

  assert.equal(submits, 1);
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P4.status, 'prepared');
  assert.equal(run.stages.P4.blockedReason, 'ac_points_budget');
  assert.equal(run.artifacts.video.status, 'prepared');
  assert.equal(run.artifacts.video.budgetReservation.settlementStatus, 'released');
  const dayKey = `nf_social:ac_points:${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '')}`;
  assert.equal(Number(await redis.get(dayKey)), 0);
});

test('P4 reuses a persisted same-day video slot after a worker restart', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let submitCalls = 0;
  let submittedReservation = null;
  Object.assign(providers, {
    findAcTask: async () => null,
    submitAc: async (_payload, options) => {
      submitCalls += 1;
      submittedReservation = options?.budgetReservation || null;
      return { threadId: 'thread-reused-slot' };
    }
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'prepared' };
  run.stages.P3_5 = { status: 'done' };
  const info = require('../api/_lib/store').videoDayInfo();
  await redis.set(info.key, '1');
  const reservation = await acBudget.reserve(redis, 'video_create');
  run.artifacts.video = {
    status: 'prepared', remark: 'nf-reused-slot', payload: {}, threadId: '', videoUrls: [],
    slot: { key: info.key, day: info.label, resetAt: info.resetAt, position: 1, limit: info.limit, reservedAt: new Date().toISOString() },
    budgetReservation: reservation
  };

  await processRun(redis, run);

  assert.equal(submitCalls, 1);
  assert.equal(run.stages.P4.status, 'running');
  assert.equal(submittedReservation.reservationId, reservation.reservationId);
  assert.equal(Number(await redis.get(info.key)), 1, 'restart must not consume a second daily video slot');
});

test('an image success response without a URL becomes a definitive poster failure', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  providers.imageResult = async () => ({ status: 'success', result: {} });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'done' };
  run.stages.P3_5 = { status: 'running' };
  run.artifacts.video = { status: 'completed', threadId: 'thread-done', videoUrls: ['https://cdn.example/video.mp4'] };
  run.artifacts.images = [
    { variant: 'luminous_cinema', status: 'queued', taskId: 'image-no-url', url: '', repairCount: 1 },
    { variant: 'editorial_romance', status: 'success', taskId: 'image-ok', url: 'https://cdn.example/poster.jpg' }
  ];

  await processRun(redis, run);

  assert.equal(run.stages.P3_5.status, 'partial');
  assert.equal(run.artifacts.images[0].status, 'failed');
  assert.match(run.artifacts.images[0].error, /without a media URL/i);
});

test('a definitive AC 422 rejection is failed rather than ambiguous', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  Object.assign(providers, {
    findAcTask: async () => null,
    submitAc: async () => { throw new providers.ProviderError('AC rejected payload', { status: 422 }); }
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'prepared' };
  run.stages.P3_5 = { status: 'done' };
  run.artifacts.video = { status: 'prepared', remark: 'nf-test', payload: {}, threadId: '', videoUrls: [] };

  await processRun(redis, run);

  assert.equal(run.state, 'failed');
  assert.equal(run.stages.P4.status, 'failed');
  assert.equal(run.stages.P4.error, 'AC rejected payload');
});

test('an AC reconciliation outage before submission stays recoverable and observes cooldown', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  let reconciliationCalls = 0;
  let submissions = 0;
  Object.assign(providers, {
    findAcTask: async () => {
      reconciliationCalls += 1;
      throw new providers.ProviderError('AC task reconciliation returned invalid JSON', { status: 502, code: 'provider_invalid_json' });
    },
    submitAc: async () => { submissions += 1; return { threadId: 'must-not-submit' }; }
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'prepared' };
  run.stages.P3_5 = { status: 'done' };
  run.artifacts.video = { status: 'prepared', remark: 'nf-provider-outage', payload: {}, threadId: '', videoUrls: [] };

  await processRun(redis, run);

  assert.equal(run.state, 'running');
  assert.equal(run.stages.P4.status, 'prepared');
  assert.equal(run.stages.P4.blockedReason, 'ac_provider_unavailable');
  assert.ok(Date.parse(run.stages.P4.nextAttemptAt) > Date.now());
  assert.equal(reconciliationCalls, 1);
  assert.equal(submissions, 0);

  await processRun(redis, run);
  assert.equal(reconciliationCalls, 1);
  assert.equal(submissions, 0);
});

test('a malformed AC reconciliation row never starts polling an empty task ID', async (t) => {
  const originals = { ...providers };
  t.after(() => Object.assign(providers, originals));
  Object.assign(providers, {
    findAcTask: async () => ({ remark: 'nf-malformed-reconcile', status: 'running' }),
    submitAc: async () => { throw new Error('AC must not be resubmitted after a matching malformed row'); }
  });
  const redis = new MemoryRedis();
  const run = mediaReadyRun();
  run.stages.P4 = { status: 'prepared' };
  run.stages.P3_5 = { status: 'done' };
  run.artifacts.video = { status: 'prepared', remark: 'nf-malformed-reconcile', payload: {}, threadId: '', videoUrls: [] };

  await processRun(redis, run);

  assert.equal(run.state, 'blocked');
  assert.equal(run.stages.P4.status, 'ambiguous');
  assert.match(run.stages.P4.error, /valid task ID/i);
  assert.equal(run.artifacts.video.threadId, '');
});

test('analytics keeps Code and Link streams separate', () => {
  const result = summarizeAnalytics([
    { adId: '55555', pullUv: 20, activeUv: 4, newUv: 3, d7Income: 0 },
    { adId: 'link-abc', pullUv: 100, activeUv: 40, newUv: 20, d7Income: 12 }
  ], '55555', 'link-abc', { from: '2026-07-01', to: '2026-07-17' });
  assert.equal(result.primaryIdentifier, 'link');
  assert.equal(result.streams.code.pullUv, 20);
  assert.equal(result.streams.link.pullUv, 100);
  assert.equal(result.summary.pullUv, 100);
  assert.equal(result.quality.overlapWarning, true);
});

test('analytics labels insufficient samples instead of overclaiming', () => {
  const result = summarizeAnalytics([{ adId: '55555', pullUv: 20, activeUv: 4, newUv: 3, d7Income: 0 }], '55555', '', { from: '2026-07-01', to: '2026-07-17' });
  assert.equal(result.summary.sampleState, 'insufficient');
  assert.match(result.findings.join(' '), /样本量不足/);
});
