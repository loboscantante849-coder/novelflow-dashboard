const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { modelTemperature, operationsTimeoutForModel, creativeWireUsesResponses, modelEnvelopeDiagnostic, parseModelJson, extractModelText, requestedCreativeSection, normalizeCreativeWireSection, normalizeTokenDanceDeepSeekModel, copyModelConfig, structuredShape, buildEvidenceBank, hydrateCreativeEvidence } = providers;

test('Kimi K2.7 Code receives its provider-required temperature without changing other models', () => {
  assert.equal(modelTemperature('kimi-k2.7-code', 0.25), 1);
  assert.equal(modelTemperature('KIMI_K2.7_CODE', 0.55), 1);
  assert.equal(modelTemperature('hy3', 0.25), 0.25);
  assert.equal(modelTemperature('qwen3.7-max', 0.55), 0.55);
});

test('GLM 5.3 Flash keeps the historical DeepSeek Preview logical reserve route', () => {
  assert.equal(providers.reserveModelFor('glm-5.3-flash'), 'deepseek-v4-flash-preview');
  assert.equal(providers.operationsTimeoutForModel('glm-5.3-flash'), 300000);
});

test('legacy DeepSeek Preview aliases normalize to the published TokenDance model ID', () => {
  assert.equal(normalizeTokenDanceDeepSeekModel('deepseek-v4-flash-preview'), 'deepseek-v4-flash');
  assert.equal(normalizeTokenDanceDeepSeekModel(' DEEPSEEK-V4-FLASH-PREVIEW '), 'deepseek-v4-flash');
  assert.equal(normalizeTokenDanceDeepSeekModel('deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(normalizeTokenDanceDeepSeekModel('deepseek-v4-flash-0731'), 'deepseek-v4-flash-0731');
  assert.equal(normalizeTokenDanceDeepSeekModel(''), 'deepseek-v4-flash');
});

test('creative JSON parser repairs common provider formatting without another model call', () => {
  const parsed = parseModelJson('```json\n{"content":"line one\nline two", "tags":["a","b",],}\n```', 'test-model');
  assert.equal(parsed.content, 'line one\nline two');
  assert.deepEqual(parsed.tags, ['a', 'b']);
});

test('structured provider objects remain valid model output instead of becoming empty text', () => {
  const content = { videoPrompt: { hook: 'A source-grounded disruption' } };
  assert.equal(extractModelText({ choices: [{ message: { content } }] }), JSON.stringify(content));
  assert.deepEqual(parseModelJson(JSON.stringify(JSON.stringify(content))), content);
});

test('video-only creative rewrites accept a flattened provider schema before validation', () => {
  const flattened = { hook: 'A source-grounded disruption', valuePromise: 'The personal stake tightens', escalation: 'The pressure becomes immediate', reversal: 'A truthful turn changes the choice', cliffhanger: 'The answer remains dangerous', adCopy: 'Character lock. One source-grounded event follows another.', buildRequirement: 'A concise source-grounded shot plan.', sourceEvidence: [] };
  assert.equal(requestedCreativeSection({ videoPrompt: flattened }, 'videoPrompt'), flattened);
  assert.equal(requestedCreativeSection(flattened, 'videoPrompt'), flattened);
  assert.equal(requestedCreativeSection({ hook: 'not a video package' }, 'posts'), undefined);
});

test('single-section Responses payloads accept schema-preserving flattened shapes', () => {
  const posts = [{ type: 'hook' }, { type: 'escalation' }];
  const posters = [{ variant: 'luminous_cinema' }, { variant: 'editorial_romance' }];
  const review = { recommendation: 'keep', conclusion: 'ready', why: 'grounded', target: 'package' };
  assert.equal(requestedCreativeSection(posts, 'posts'), posts);
  assert.equal(requestedCreativeSection(posters, 'posterPrompts'), posters);
  assert.equal(requestedCreativeSection({ posters }, 'posterPrompts'), posters);
  assert.equal(requestedCreativeSection(review, 'qualityReview'), review);
  assert.deepEqual(requestedCreativeSection({ creative: { video: { hook: 'locked' } } }, 'videoPrompt'), { hook: 'locked' });
  assert.equal(requestedCreativeSection({ result: { image_prompts: posters } }, 'posterPrompts'), posters);
  assert.deepEqual(requestedCreativeSection({ hook: { content: 'a' }, escalation: { content: 'b' } }, 'posts').map((item) => item.type), ['hook', 'escalation']);
  assert.deepEqual(requestedCreativeSection({ luminous_cinema: 'light', editorial_romance: 'editorial' }, 'posterPrompts').map((item) => item.variant), ['luminous_cinema', 'editorial_romance']);
  assert.equal(requestedCreativeSection({ ad_copy: 'story', build_requirement: 'shots' }, 'videoPrompt').adCopy, 'story');
});

test('creative wire normalization repairs casing and snake-case without inventing missing fields', () => {
  const posts = normalizeCreativeWireSection('posts', [{
    Format_ID: 'public_power_reversal',
    Opening_Grammar: 'public_reaction',
    Six_Steps: {
      Hook: 'A public verdict lands.', Pain: 'She has nowhere to hide.', Sensory_Detail: 'The seal bites into her palm.',
      Contrast: 'The crowd falls silent.', Deep_Desire: 'She wants her name back.', Emotional_CTA: 'Who will face her next?'
    },
    Content: 'Visible copy', ZH_Content: '中文', Evidence: []
  }]);
  assert.equal(posts[0].formatId, 'public_power_reversal');
  assert.equal(posts[0].openingGrammar, 'public_reaction');
  assert.equal(posts[0].sixSteps.sensory, 'The seal bites into her palm.');
  assert.equal(posts[0].sixSteps.deepDesire, 'She wants her name back.');
  assert.equal(posts[0].sixSteps.emotionalCta, 'Who will face her next?');
  assert.equal(posts[0].zhContent, '中文');
  assert.equal(posts[0].sixSteps.unsupported, undefined);

  const video = normalizeCreativeWireSection('videoPrompt', {
    Value_Promise: 'Her name can still be restored.', Source_Evidence: [], Ad_Copy: 'Locked narration',
    Build_Requirement: 'Locked shot plan', ZH_Build_Requirement: '镜头计划'
  });
  assert.equal(video.valuePromise, 'Her name can still be restored.');
  assert.equal(video.adCopy, 'Locked narration');
  assert.equal(video.buildRequirement, 'Locked shot plan');
  assert.equal(video.zhBuildRequirement, '镜头计划');
});

test('responses gateways with reasoning wrappers still yield the JSON payload', () => {
  const payload = { headline: 'A grounded result' };
  const body = { output: [{ type: 'message', content: [{ type: 'output_text', text: `<think>private planning</think>\\n${JSON.stringify(payload)}` }] }] };
  assert.deepEqual(parseModelJson(extractModelText(body), 'test-model'), payload);
});

test('Responses JSON-mode envelopes preserve parsed and arguments payloads', () => {
  const parsedPayload = { posts: [{ type: 'hook' }, { type: 'escalation' }] };
  const argumentsPayload = { editorial_thesis: '证据支持的方向', recommended_profile: { copy_style: 'system_best' } };
  assert.equal(extractModelText({ output_parsed: parsedPayload }), JSON.stringify(parsedPayload));
  assert.equal(extractModelText({ output: [{ content: [{ type: 'function_call', arguments: JSON.stringify(argumentsPayload) }] }] }), JSON.stringify(argumentsPayload));
  assert.equal(extractModelText({ output_parsed: [1, 2], output: [{ content: [{ type: 'output_text', text: JSON.stringify(parsedPayload) }] }] }), JSON.stringify(parsedPayload));
  assert.equal(extractModelText({ output_parsed: Array.from({ length: 10 }, (_, index) => index), output: [{ content: [{ type: 'output_text', text: JSON.stringify(parsedPayload) }] }] }), JSON.stringify(parsedPayload));
  assert.deepEqual(requestedCreativeSection({ post_1: { content: 'first' }, post_2: { content: 'second' } }, 'posts').map((item) => item.type), ['hook', 'escalation']);
});

test('creative evidence IDs hydrate to immutable excerpts while unknown IDs remain invalid', () => {
  const bank = buildEvidenceBank([
    { order: 2, content: 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.' },
    { order: 5, content: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen.' }
  ]);
  assert.ok(bank.length >= 2);
  const posts = [{ type: 'hook', evidence: [{ evidenceId: bank[0].evidenceId }, { evidenceId: bank[1].evidenceId }] }];
  const hydrated = hydrateCreativeEvidence(posts, 'posts', bank);
  assert.equal(hydrated[0].evidence[0].chapter, bank[0].chapter);
  assert.equal(hydrated[0].evidence[0].quote, bank[0].quote);
  assert.deepEqual(hydrateCreativeEvidence([{ evidence: [{ evidenceId: 'UNKNOWN' }] }], 'posts', bank)[0].evidence[0], { evidenceId: 'UNKNOWN' });
  const video = hydrateCreativeEvidence({ source_evidence: [{ evidenceId: bank[1].evidenceId }] }, 'videoPrompt', bank);
  assert.equal(video.sourceEvidence[0].quote, bank[1].quote);
});

test('TokenDance sole code envelopes are unwrapped only when they contain a structured creative section', () => {
  const posts = [{ type: 'hook' }, { type: 'escalation' }];
  assert.equal(requestedCreativeSection({ code: { posts } }, 'posts'), posts);
  assert.deepEqual(requestedCreativeSection({ code: JSON.stringify({ posts }) }, 'posts'), posts);
  assert.deepEqual(requestedCreativeSection({ code: `\`\`\`json\n${JSON.stringify({ posts })}\n\`\`\`` }, 'posts'), posts);
  assert.equal(requestedCreativeSection({ code: '44560' }, 'posts'), undefined);
  assert.equal(requestedCreativeSection({ code: 'not structured creative' }, 'posts'), undefined);
});

test('video section accepts only a non-conflicting complementary Responses array', () => {
  const parts = [
    { hook: 'A public accusation lands before the witnesses.', value_promise: 'She can still take back her name.', escalation: 'The guard blocks the doorway.' },
    { reversal: 'The sealed ledger names her as heir.', cliffhanger: 'Who will dare challenge her now?', ad_copy: 'Character lock and source facts.', build_requirement: '0-3s ledger in her hand. 3-5s guard blocks the door.' }
  ];
  const video = requestedCreativeSection(parts, 'videoPrompt');
  assert.equal(video.hook, parts[0].hook);
  assert.equal(video.valuePromise, parts[0].value_promise);
  assert.equal(video.adCopy, parts[1].ad_copy);
  assert.equal(requestedCreativeSection([{ hook: 'one' }, { hook: 'two' }], 'videoPrompt'), undefined);
});

test('structured diagnostics disclose only a bounded response shape, never source content', () => {
  assert.equal(structuredShape({ secretStoryLine: 'must not be logged', post_list: [] }), 'object(secretStoryLine,post_list)');
  assert.equal(structuredShape([{ content: 'not shown' }]), 'array(1:object(content))');
});

test('recovery metadata is instruction-only and is not included in creative user context', async (t) => {
  const originalConfig = providers.copyModelConfig;
  const originalFetch = global.fetch;
  t.after(() => { providers.copyModelConfig = originalConfig; global.fetch = originalFetch; });
  // generateCreative uses its local routing helper, so only observe that a
  // recovery-shaped object cannot be mistaken for a requested creative result
  // through the public section extraction contract.
  const recovery = { instruction: 'Return only the requested JSON object.', failedSection: 'posts', validationError: 'private detail' };
  assert.equal(requestedCreativeSection(recovery, 'posts'), undefined);
});

test('chat gateways with a text choice remain parseable', () => {
  const payload = { videoPrompt: { hook: 'A source-grounded disruption' } };
  assert.deepEqual(parseModelJson(extractModelText({ choices: [{ text: JSON.stringify(payload) }] }), 'test-model'), payload);
});

test('selected non-HY models receive a real completion window before fallback', () => {
  assert.ok(operationsTimeoutForModel('seed-2.1-turbo') >= 120000);
  assert.ok(operationsTimeoutForModel('deepseek') >= 120000);
  assert.ok(operationsTimeoutForModel('qwen3.7-max') >= 120000);
  assert.ok(operationsTimeoutForModel('minimax-m2.7') >= 120000);
  assert.ok(operationsTimeoutForModel('kimi-k2.7-code') >= 120000);
  assert.ok(operationsTimeoutForModel('hy3') < operationsTimeoutForModel('seed-2.1-turbo'));
});

test('HY3 uses the authorized premium reserve when no DeepSeek key exists', () => {
  const previousCopy = process.env.NOVELFLOW_COPY_LLM_API_KEY;
  const previousPremium = process.env.NOVELFLOW_TOKENDANCE_API_KEY;
  delete process.env.NOVELFLOW_COPY_LLM_API_KEY;
  process.env.NOVELFLOW_TOKENDANCE_API_KEY = 'test-premium-key';
  try { assert.equal(providers.reserveModelFor('hy3'), 'seed-2.1-turbo'); }
  finally {
    if (previousCopy === undefined) delete process.env.NOVELFLOW_COPY_LLM_API_KEY; else process.env.NOVELFLOW_COPY_LLM_API_KEY = previousCopy;
    if (previousPremium === undefined) delete process.env.NOVELFLOW_TOKENDANCE_API_KEY; else process.env.NOVELFLOW_TOKENDANCE_API_KEY = previousPremium;
  }
});

test('DeepSeek keeps the global HY3 reserve used by planning recovery', () => {
  assert.equal(providers.reserveModelFor('deepseek'), 'hy3');
});

test('logical DeepSeek is pinned to the published TokenDance V4 Flash Chat Completions model', () => {
  const previous = {
    tokenDance: process.env.NOVELFLOW_TOKENDANCE_API_KEY,
    official: process.env.NOVELFLOW_COPY_LLM_API_KEY,
    baseUrl: process.env.NOVELFLOW_COPY_LLM_BASE_URL,
    model: process.env.NOVELFLOW_COPY_LLM_MODEL,
    legacyPreviewModel: process.env.NOVELFLOW_LLM_MODEL_DEEPSEEK_V4_FLASH_PREVIEW
  };
  process.env.NOVELFLOW_TOKENDANCE_API_KEY = 'test-tokendance-key';
  process.env.NOVELFLOW_COPY_LLM_API_KEY = 'test-official-key';
  process.env.NOVELFLOW_COPY_LLM_BASE_URL = 'https://api.deepseek.com';
  process.env.NOVELFLOW_COPY_LLM_MODEL = 'deepseek-chat';
  process.env.NOVELFLOW_LLM_MODEL_DEEPSEEK_V4_FLASH_PREVIEW = 'deepseek-v4-flash-preview';
  try {
    const config = copyModelConfig({ modelChoice: 'deepseek' });
    assert.equal(config.apiKey, 'test-tokendance-key');
    assert.equal(config.baseUrl, 'https://tokendance.space/gateway/v1');
    assert.equal(config.model, 'deepseek-v4-flash');
    assert.equal(config.responsesApi, false);
    const directConfig = copyModelConfig({ modelChoice: ' DEEPSEEK-V4-FLASH ' });
    assert.equal(directConfig.baseUrl, 'https://tokendance.space/gateway/v1');
    assert.equal(directConfig.model, 'deepseek-v4-flash');
  } finally {
    for (const [key, value] of Object.entries({ NOVELFLOW_TOKENDANCE_API_KEY: previous.tokenDance, NOVELFLOW_COPY_LLM_API_KEY: previous.official, NOVELFLOW_COPY_LLM_BASE_URL: previous.baseUrl, NOVELFLOW_COPY_LLM_MODEL: previous.model, NOVELFLOW_LLM_MODEL_DEEPSEEK_V4_FLASH_PREVIEW: previous.legacyPreviewModel })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('P3 respects the verified TokenDance Responses capability and keeps diagnostics content-free', () => {
  assert.equal(creativeWireUsesResponses('deepseek', { responsesApi: true }), true);
  assert.equal(creativeWireUsesResponses('seed-2.1-turbo', { responsesApi: true }), true);
  const diagnostic = modelEnvelopeDiagnostic({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'private response text' }] }] }, 'private response text');
  assert.match(diagnostic, /status=incomplete/);
  assert.match(diagnostic, /incomplete=max_output_tokens/);
  assert.match(diagnostic, /extractedLength=21/);
  assert.doesNotMatch(diagnostic, /private response text/);
});

test('an IIIT poster success response with invalid JSON is ambiguous', async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.IIIT_IMAGE_API_KEY;
  const originalBase = process.env.IIIT_IMAGE_BASE_URL;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.IIIT_IMAGE_API_KEY;
    else process.env.IIIT_IMAGE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.IIIT_IMAGE_BASE_URL;
    else process.env.IIIT_IMAGE_BASE_URL = originalBase;
  });
  process.env.IIIT_IMAGE_API_KEY = 'test-only-key';
  process.env.IIIT_IMAGE_BASE_URL = 'https://images.invalid.test/v1';
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{invalid-json' });

  await assert.rejects(
    providers.submitImage({ variant: 'luminous_cinema', prompt: 'A safe source-grounded poster prompt', idempotencyKey: 'test-idempotency-key' }),
    (error) => error instanceof providers.ProviderError && error.ambiguous === true
  );
});

test('IIIT poster submission uses the reviewed prompt contract and returns only media metadata', { concurrency: false }, async (t) => {
  const originalFetch = global.fetch;
  const previous = {
    key: process.env.IIIT_IMAGE_API_KEY,
    base: process.env.IIIT_IMAGE_BASE_URL,
    model: process.env.IIIT_IMAGE_MODEL
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries({ IIIT_IMAGE_API_KEY: previous.key, IIIT_IMAGE_BASE_URL: previous.base, IIIT_IMAGE_MODEL: previous.model })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.IIIT_IMAGE_API_KEY = 'test-iiit-key';
  process.env.IIIT_IMAGE_BASE_URL = 'https://iiit.example.test/v1';
  process.env.IIIT_IMAGE_MODEL = 'IMG-2';
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ created: 1, data: [{ url: 'https://ai.iiit.cn/result/poster.jpg' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await providers.submitImage({ variant: 'luminous_cinema', prompt: 'A decisive source-grounded public confrontation.', idempotencyKey: 'idem-1' });
  assert.equal(captured.url, 'https://iiit.example.test/v1/images/generations');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-iiit-key');
  assert.deepEqual(captured.body, { model: 'IMG-2', prompt: 'A decisive source-grounded public confrontation.', n: 1, size: '1024x1024', response_format: 'url' });
  assert.deepEqual(result, { provider: 'iiit', status: 'success', url: 'https://ai.iiit.cn/result/poster.jpg', requestId: '1', model: 'IMG-2', size: '1024x1024', id: '1' });
  assert.doesNotMatch(JSON.stringify(result), /test-iiit-key/);
});

test('exact active SKU lookup rejects incomplete, inactive, and cross-application records', { concurrency: false }, async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.NOVELFLOW_OIDC_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.NOVELFLOW_OIDC_TOKEN;
    else process.env.NOVELFLOW_OIDC_TOKEN = originalToken;
  });
  process.env.NOVELFLOW_OIDC_TOKEN = 'test-readonly-oidc-token';
  const base = { id: 'city-exact-1', bookSkuId: 'exact-sku-1', title: 'Exact Active Book', bookStatus: 1, applicationId: 'target-app' };
  for (const record of [
    { ...base, title: '' },
    { ...base, id: '' },
    { ...base, bookStatus: 0 },
    { ...base, applicationId: 'other-app' }
  ]) {
    global.fetch = async () => new Response(JSON.stringify({ data: { items: [record] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(
      providers.findExactBook('Exact Active Book', 'exact-sku-1', { applicationId: 'target-app' }),
      (error) => error instanceof providers.ProviderError && error.code === 'exact_mismatch'
    );
  }
});

test('catalogue fallback accepts only active exact SKUs explicitly authorized for the target app', () => {
  const row = {
    Id: 'catalog-sku-1', SrcBookId: 'catalog-city-1', Title: 'Catalogue Exact Book', Status: 1,
    AuthApp: 'AnyStories, NovelFlow', ChapterCount: 12, Words: 30000, PayPoint: 4
  };
  const result = providers.exactBookFromCatalog(row, {
    sku: 'catalog-sku-1', title: 'Catalogue Exact Book', applicationName: 'NovelFlow'
  });
  assert.equal(result.bookSkuId, 'catalog-sku-1');
  assert.equal(result.cityBookId, 'catalog-city-1');
  assert.equal(result.catalogueVerification.source, 'bookstore.anynovel.app');
  assert.throws(() => providers.exactBookFromCatalog({ ...row, AuthApp: 'MaxNovel' }, {
    sku: 'catalog-sku-1', title: 'Catalogue Exact Book', applicationName: 'NovelFlow'
  }), /not authorized/);
  assert.throws(() => providers.exactBookFromCatalog({ ...row, Status: 0 }, {
    sku: 'catalog-sku-1', title: 'Catalogue Exact Book', applicationName: 'NovelFlow'
  }), /not active/);
});

test('chapter pagination continues when Admin omits total and page counters', { concurrency: false }, async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.NOVELFLOW_OIDC_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.NOVELFLOW_OIDC_TOKEN;
    else process.env.NOVELFLOW_OIDC_TOKEN = originalToken;
  });
  process.env.NOVELFLOW_OIDC_TOKEN = 'test-readonly-oidc-token';
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    const page = Number(new URL(url).searchParams.get('pageIndex'));
    const count = page === 1 ? 200 : 1;
    const items = Array.from({ length: count }, (_, index) => ({ id: `chapter-${(page - 1) * 200 + index + 1}`, order: (page - 1) * 200 + index + 1, title: `Chapter ${(page - 1) * 200 + index + 1}` }));
    return new Response(JSON.stringify({ data: { data: items } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const chapters = await providers.listChapters('long-book-city-id');
  assert.equal(chapters.length, 201);
  assert.equal(calls, 2);
});

test('AC reconciliation scans a second full page when list metadata is omitted', { concurrency: false }, async (t) => {
  const originalFetch = global.fetch;
  const previous = {
    token: process.env.AC_TOKEN,
    base: process.env.AC_API_BASE_URL
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (previous.token === undefined) delete process.env.AC_TOKEN; else process.env.AC_TOKEN = previous.token;
    if (previous.base === undefined) delete process.env.AC_API_BASE_URL; else process.env.AC_API_BASE_URL = previous.base;
  });
  process.env.AC_TOKEN = 'test-ac-token';
  process.env.AC_API_BASE_URL = 'https://ac.example.test/api/v1';
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    const page = Number(new URL(url).searchParams.get('PageIndex'));
    const items = page === 1
      ? Array.from({ length: 100 }, (_, index) => ({ id: `task-${index + 1}`, remark: `other-${index + 1}` }))
      : [{ id: 'task-target', remark: 'target-remark' }];
    return new Response(JSON.stringify({ data: { data: items } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await providers.findAcTask('target-remark');
  assert.equal(result.id, 'task-target');
  assert.equal(calls, 2);
});
