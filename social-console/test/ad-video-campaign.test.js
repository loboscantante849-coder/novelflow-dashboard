const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateItems, publicCampaign, assertLocalizedPrompt, unchangedSourcePhrases, retryLocalizationFailures,
  submitOne, pollOne, repairFailedOne, attributionAppFor, attributionOptions, attributeOne, draftRun,
  nextAdvanceAction, requireCampaignMutation, normalizedCampaignId, campaignSummary, bindMetaMapping
} = require('../api/ad-video-campaign');

class MemoryRedis {
  constructor() { this.values = new Map(); this.savedStatuses = []; this.savedCampaigns = []; }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    const campaign = String(value).startsWith('{') ? JSON.parse(value) : null;
    if (campaign?.items) {
      this.savedStatuses.push(campaign.items[0]?.status || '');
      this.savedCampaigns.push(campaign);
    }
    return 'OK';
  }
  async incr(key) {
    const value = Number(this.values.get(key) || 0) + 1;
    this.values.set(key, String(value));
    return value;
  }
}

function sourceItems() {
  const languages = ['en', 'en', 'pt', 'pt', 'es', 'es'];
  return languages.flatMap((language, index) => ['original', 'paced', 'optimized'].map((version) => ({
    id: `book-${index + 1}-${version}`,
    title: `Book ${index + 1}`,
    sku: `sku-${index + 1}`,
    version,
    language,
    prompt: `Production prompt ${index + 1} ${version} `.repeat(30),
    caption: `Caption ${index + 1} ${version}`
  })));
}

test('initialization accepts only six books with three versions and fixed language routing', () => {
  const items = validateItems(sourceItems());
  assert.equal(items.length, 18);
  assert.deepEqual(items.filter((item) => item.language === 'en').map((item) => item.country), Array(6).fill('US'));
  assert.deepEqual(items.filter((item) => item.language === 'pt').map((item) => item.acLanguage), Array(6).fill('Portuguese'));
  assert.deepEqual(items.filter((item) => item.language === 'es').map((item) => item.country), Array(6).fill('MX'));
  assert.throws(() => validateItems(sourceItems().slice(0, 17)), /exactly 18/);
  const duplicate = sourceItems();
  duplicate[1].id = duplicate[0].id;
  assert.throws(() => validateItems(duplicate), /invalid or duplicate/);
});

test('public campaign excludes captions and full prompts', () => {
  const campaign = { id: 'campaign', createdAt: 'a', updatedAt: 'b', items: validateItems(sourceItems()) };
  const result = publicCampaign(campaign);
  assert.equal(result.counts.prepared, 6);
  assert.equal(result.counts.localization_pending, 12);
  assert.equal('prompt' in result.items[0], false);
  assert.equal('localizedPrompt' in result.items[0], false);
  assert.equal('caption' in result.items[0], false);
});

test('localized Portuguese and Spanish prompts reject probable English dialogue or overlays', () => {
  assert.doesNotThrow(() => assertLocalizedPrompt('Cena inicial. Ela fecha a porta. Texto na tela: agora ou nunca. A camera aproxima lentamente.', 'pt'));
  assert.throws(() => assertLocalizedPrompt('She opens the door and then says that this is her final choice.', 'pt'), /visible or audible English/);
  assert.throws(() => assertLocalizedPrompt('Texto: "This is where she finds her real power".', 'es'), /visible or audible English/);
  const source = 'Subtitle (her): "I am free."\nCTA: Read the full story';
  assert.deepEqual(unchangedSourcePhrases(source, 'Cena final. Texto: I am free.'), ['i am free']);
  assert.throws(() => assertLocalizedPrompt('Cena final. Texto: I am free.', 'pt', source), /visible or audible English/);
  assert.deepEqual(unchangedSourcePhrases('Legenda: "Agora ele vai reivindicar o que e seu"', 'Agora ele vai reivindicar o que e seu'), []);
});

test('localization recovery resets only text failures and never paid submission states', async () => {
  const redis = new MemoryRedis();
  const items = validateItems(sourceItems()).slice(0, 3);
  Object.assign(items[0], { status: 'localization_failed', localizedPrompt: 'bad', error: 'missing config' });
  Object.assign(items[1], { status: 'submit_ambiguous', error: 'timeout' });
  Object.assign(items[2], { status: 'submit_failed', error: 'invalid request' });
  const reset = await retryLocalizationFailures(redis, { id: 'campaign', items });
  assert.equal(reset, 1);
  assert.equal(items[0].status, 'localization_pending');
  assert.equal(items[0].localizedPrompt, 'bad');
  assert.equal(items[1].status, 'submit_ambiguous');
  assert.equal(items[2].status, 'submit_failed');
});

test('paid submission persists submitting before provider call and never retries ambiguity', async () => {
  const redis = new MemoryRedis();
  const campaign = { id: 'campaign', items: [validateItems(sourceItems())[0]] };
  let calls = 0;
  const adapter = {
    findAcTask: async () => null,
    submitAc: async () => {
      calls += 1;
      assert.equal(redis.savedStatuses.at(-1), 'submitting');
      throw Object.assign(new Error('timeout'), { status: 504, ambiguous: true });
    }
  };
  assert.equal(await submitOne(redis, campaign, adapter), true);
  assert.equal(campaign.items[0].status, 'submit_ambiguous');
  assert.equal(await submitOne(redis, campaign, adapter), false);
  assert.equal(calls, 1);
});

test('submission reconciles by durable remark without a second paid call', async () => {
  const redis = new MemoryRedis();
  const campaign = { id: 'campaign', items: [validateItems(sourceItems())[0]] };
  let submitted = false;
  await submitOne(redis, campaign, {
    findAcTask: async (remark) => ({ thread_id: `thread-for-${remark}` }),
    submitAc: async () => { submitted = true; }
  });
  assert.equal(submitted, false);
  assert.equal(campaign.items[0].status, 'running');
  assert.match(campaign.items[0].threadId, /^thread-for-nf_ad_/);
});

test('polling rotates over running tasks instead of starving later videos', async () => {
  const redis = new MemoryRedis();
  const items = validateItems(sourceItems()).slice(0, 2);
  Object.assign(items[0], { status: 'running', threadId: 'old', lastCheckedAt: '2026-08-06T02:00:00.000Z' });
  Object.assign(items[1], { status: 'running', threadId: 'never', lastCheckedAt: '' });
  const checked = [];
  await pollOne(redis, { id: 'campaign', items }, {
    acResult: async (id) => { checked.push(id); return { status: 'running' }; },
    validateVideo: async () => ({})
  });
  assert.deepEqual(checked, ['never']);
});

test('special ad attribution routes English to NovelFlow and localized books to AstraNovel', () => {
  const items = validateItems(sourceItems());
  assert.equal(attributionAppFor(items[0]).applicationId, '642fc1ace309494378a774a6');
  assert.equal(attributionAppFor(items[6]).applicationId, '678dfef75344a83d71e56932');
  assert.equal(attributionOptions(items[6]).channelNameId, '6a2021a4554323f68cac4096');
  assert.equal(attributionOptions(items[6]).promoter, 'xujt');
});

test('attribution persists Code and link creation states before external writes', async () => {
  const redis = new MemoryRedis();
  const item = validateItems(sourceItems())[0];
  const campaign = { id: 'campaign', items: [item] };
  let codeCreated = false;
  let linkCreated = false;
  await attributeOne(redis, campaign, {
    keywordRecord: async () => codeCreated ? { id: 'kw-1', bookSkuId: item.sku, applicationId: '642fc1ace309494378a774a6', channel: 'FB', isEnable: true } : null,
    createKeyword: async () => {
      assert.equal(redis.savedCampaigns.at(-1).items[0].attributionStatus, 'code_creating');
      codeCreated = true;
    },
    enabled: (value) => value === true,
    findLink: async () => linkCreated ? { id: 'link-1', shortUrl: 'https://short.example/one' } : null,
    createLink: async () => {
      assert.equal(redis.savedCampaigns.at(-1).items[0].attributionStatus, 'link_creating');
      linkCreated = true;
      return { id: 'link-1' };
    },
    absoluteUrl: (value) => value
  });
  assert.equal(item.attributionStatus, 'ready');
  assert.match(item.code, /^4\d{4}$/);
  assert.equal(item.shortUrl, 'https://short.example/one');
});

test('attribution can target one campaign item without advancing earlier items', async () => {
  const redis = new MemoryRedis();
  const items = validateItems(sourceItems()).slice(6, 8);
  const campaign = { id: 'campaign', items };
  let codeCreated = false;
  let linkCreated = false;
  const target = items[1];
  await attributeOne(redis, campaign, {
    keywordRecord: async () => codeCreated ? { id: 'kw-2', bookSkuId: target.sku, applicationId: '678dfef75344a83d71e56932', channel: 'FB', isEnable: true } : null,
    createKeyword: async () => { codeCreated = true; },
    enabled: (value) => value === true,
    findLink: async () => linkCreated ? { id: 'link-2', shortUrl: 'https://short.example/two' } : null,
    createLink: async () => { linkCreated = true; return { id: 'link-2' }; },
    absoluteUrl: (value) => value
  }, target.id);
  assert.equal(items[0].attributionStatus, 'pending');
  assert.equal(target.attributionStatus, 'ready');
  assert.match(target.code, /^6\d{4}$/);
});

test('SocialEcho historical ad draft package keeps its legacy account and tracking out of caption', () => {
  const item = validateItems(sourceItems())[0];
  Object.assign(item, { status: 'completed', videoUrl: 'https://video.example/one.mp4', code: '44444', shortUrl: 'https://short.example/one', linkId: 'link-1' });
  const run = draftRun(item);
  assert.equal(run.input.delivery.accountId, 13943486);
  assert.equal(run.input.delivery.platform, 'facebook');
  assert.equal(run.artifacts.posts[0].content, item.caption);
  assert.doesNotMatch(run.artifacts.posts[0].content, /44444|short\.example/);
  assert.equal(run.artifacts.code, '44444');
});

test('failed AC repair creates a new remark and preserves the prior paid task without resubmitting', async () => {
  const redis = new MemoryRedis();
  const item = validateItems(sourceItems())[17];
  Object.assign(item, { status: 'failed', threadId: 'old-thread', error: 'failed' });
  const campaign = { id: 'campaign', items: [item] };
  let submitted = false;
  await repairFailedOne(redis, campaign, {
    repairAdVideoPrompt: async (_prompt, language, reason) => {
      assert.equal(language, 'es');
      assert.equal(reason, 'failed');
      return 'Prompt reparado en espanol. '.repeat(30);
    },
    sha: (value) => `hash-${value}`
  });
  assert.equal(item.status, 'prepared');
  assert.equal(item.priorThreadId, 'old-thread');
  assert.notEqual(item.remark, `nf_ad_${require('../api/_lib/providers').sha('whatsapp-ads-20260806:book-6-optimized:sku-6').slice(0, 24)}`);
  assert.equal(item.threadId, '');
  assert.equal(submitted, false);
  assert.equal(item.revision, 1);
});

test('advance action follows the durable stage order and never chooses a failed paid task', () => {
  const items = validateItems(sourceItems());
  assert.equal(nextAdvanceAction({ items }), 'localize');
  items.forEach((item) => { item.status = 'prepared'; });
  assert.equal(nextAdvanceAction({ items }), 'submit');
  items.forEach((item) => { item.status = 'running'; item.threadId = `thread-${item.id}`; });
  assert.equal(nextAdvanceAction({ items }), 'poll');
  items.forEach((item) => { item.status = 'completed'; item.attributionStatus = 'pending'; });
  assert.equal(nextAdvanceAction({ items }), 'attribute');
  items.forEach((item) => { item.attributionStatus = 'ready'; item.draftStatus = 'pending'; });
  assert.equal(nextAdvanceAction({ items }), 'draft');
  items.forEach((item) => { item.draftStatus = 'external_draft'; });
  assert.equal(nextAdvanceAction({ items }), '');
});

test('open-access viewing still requires a hidden operator token for campaign mutations', () => {
  const previousOpen = process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
  const previousToken = process.env.SOCIAL_AD_CAMPAIGN_TOKEN;
  process.env.SOCIAL_CONSOLE_OPEN_ACCESS = 'true';
  process.env.SOCIAL_AD_CAMPAIGN_TOKEN = 'a'.repeat(40);
  const response = { statusCode: 0, status(code) { this.statusCode = code; return this; }, json() {} };
  assert.equal(requireCampaignMutation({ headers: {} }, response), false);
  assert.equal(response.statusCode, 401);
  assert.equal(requireCampaignMutation({ headers: { 'x-nf-campaign-token': 'a'.repeat(40) } }, response), true);
  process.env.SOCIAL_CONSOLE_OPEN_ACCESS = previousOpen;
  if (previousToken === undefined) delete process.env.SOCIAL_AD_CAMPAIGN_TOKEN;
  else process.env.SOCIAL_AD_CAMPAIGN_TOKEN = previousToken;
});

test('general campaigns accept variable multilingual item counts while legacy validation stays strict', () => {
  const items = sourceItems().slice(0, 5);
  assert.equal(validateItems(items, { strictLegacy: false, campaignId: 'spring-meta-ads' }).length, 5);
  assert.throws(() => validateItems(items), /exactly 18/);
  assert.equal(normalizedCampaignId('Spring_Meta-Ads'), 'spring_meta-ads');
  assert.throws(() => normalizedCampaignId('../bad'), /Invalid campaign ID/);
});

test('campaign summaries and Meta mappings expose readiness without changing delivery state', async () => {
  const redis = new MemoryRedis();
  const items = validateItems(sourceItems());
  const campaign = { id: 'campaign', createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z', items };
  items[0].status = 'completed';
  items[0].draftStatus = 'external_draft';
  await bindMetaMapping(redis, campaign, { itemId: items[0].id, metaCampaignId: 'cmp-1', adsetId: 'set-1', adId: 'ad-1', creativeId: 'creative-1', copywritingId: 'copy-1' });
  assert.equal(items[0].meta.status, 'bound');
  assert.equal(items[0].meta.adId, 'ad-1');
  assert.equal(items[0].draftStatus, 'external_draft');
  const summary = campaignSummary(campaign);
  assert.equal(summary.itemCount, 18);
  assert.equal(summary.bookCount, 6);
  assert.equal(summary.metaBound, 1);
});
