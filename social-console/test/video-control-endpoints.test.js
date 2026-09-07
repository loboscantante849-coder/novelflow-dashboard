const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../api/_lib/providers');

const ROOT = '..';
const OPERATOR_TOKEN = 'unit-test-operator-token-0123456789';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function response() {
  const state = { statusCode: 200, body: undefined, headers: {} };
  return {
    state,
    status(statusCode) {
      state.statusCode = statusCode;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value;
    }
  };
}

function request(body, headers = {}) {
  return {
    method: 'POST',
    headers,
    body,
    socket: { remoteAddress: '127.0.0.1' }
  };
}

function baseRun(extra = {}) {
  const run = {
    id: 'run_endpoint_contract_001',
    input: {
      sku: 'sku-endpoint-contract',
      title: 'A Source Grounded Romance',
      videoControl: {}
    },
    stages: { P4: { status: 'waiting' } },
    artifacts: {
      book: {
        title: 'A Source Grounded Romance',
        description: 'An adult waitress has to decide whom she can trust before the diner closes.'
      },
      evidence: { chapters: [{ order: 7, content: 'The adult lead steadies herself and walks into the diner kitchen.' }, { order: 8, content: 'The adult love interest protects her without speaking for her.' }] },
      videoPrompt: {
        evidenceChapters: [7, 8],
        adCopy: 'An adult waitress realizes that one quiet customer is protecting her.',
        buildRequirement: '0-3 seconds: she notices the threat. 3-8 seconds: she makes a choice. 8-12 seconds: cut on the diner door closing.'
      },
      characterAssets: []
    },
    events: []
  };
  return {
    ...run,
    ...extra,
    input: { ...run.input, ...(extra.input || {}) },
    stages: { ...run.stages, ...(extra.stages || {}) },
    artifacts: { ...run.artifacts, ...(extra.artifacts || {}) }
  };
}

function addEvent(run, type, message, meta) {
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push({ type, message, meta });
}

function setEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function loadHandler(endpoint, overrides = {}) {
  const restores = [];
  for (const [relativePath, replacement] of Object.entries(overrides)) {
    const resolved = require.resolve(`${ROOT}/${relativePath}`);
    require(resolved);
    const entry = require.cache[resolved];
    const original = entry.exports;
    entry.exports = { ...original, ...replacement };
    restores.push(() => { entry.exports = original; });
  }
  const endpointPath = require.resolve(`${ROOT}/${endpoint}`);
  delete require.cache[endpointPath];
  const handler = require(endpointPath);
  return {
    handler,
    restore() {
      delete require.cache[endpointPath];
      restores.reverse().forEach((restore) => restore());
    }
  };
}

function memoryStore(run, redis = { marker: 'memory' }) {
  const saves = [];
  return {
    saves,
    api: {
      getRedis: () => redis,
      getRun: async (_redis, runId) => (runId === run.id ? run : null),
      saveRun: async (_redis, savedRun) => { saves.push(clone(savedRun)); },
      addEvent
    }
  };
}

function openAccess(t) {
  setEnvironment(t, {
    SOCIAL_CONSOLE_OPEN_ACCESS: 'true',
    SOCIAL_CONSOLE_OPERATOR_TOKEN: OPERATOR_TOKEN,
    NOVELFLOW_OPERATOR_TOKEN: undefined
  });
}

function operatorHeaders() {
  return { 'x-social-operator-token': OPERATOR_TOKEN };
}

test('video-control rejects low-quality action and run IDs before loading a run', { concurrency: false }, async (t) => {
  openAccess(t);
  const run = baseRun();
  const store = memoryStore(run);
  let getRunCalls = 0;
  store.api.getRun = async () => { getRunCalls += 1; return run; };
  const loaded = loadHandler('api/video-control.js', { 'api/_lib/store.js': store.api });
  t.after(() => loaded.restore());

  const badAction = response();
  await loaded.handler(request({ action: 'submitAc', runId: run.id }, operatorHeaders()), badAction);
  assert.equal(badAction.state.statusCode, 400);
  assert.match(badAction.state.body.error, /unsupported/i);

  const badId = response();
  await loaded.handler(request({ action: 'preview_video_contract', runId: 'x' }, operatorHeaders()), badId);
  assert.equal(badId.state.statusCode, 400);
  assert.match(badId.state.body.error, /valid production run ID/i);
  assert.equal(getRunCalls, 0);
});

test('character-assets rejects low-quality action and run IDs before loading a run', { concurrency: false }, async (t) => {
  openAccess(t);
  const run = baseRun();
  const store = memoryStore(run);
  let getRunCalls = 0;
  store.api.getRun = async () => { getRunCalls += 1; return run; };
  const loaded = loadHandler('api/character-assets.js', { 'api/_lib/store.js': store.api });
  t.after(() => loaded.restore());

  const badAction = response();
  await loaded.handler(request({ action: 'generate-and-pay', runId: run.id }, operatorHeaders()), badAction);
  assert.equal(badAction.state.statusCode, 400);
  assert.match(badAction.state.body.error, /unsupported/i);

  const badId = response();
  await loaded.handler(request({ action: 'list', runId: '../../anything' }), badId);
  assert.equal(badId.state.statusCode, 400);
  assert.match(badId.state.body.error, /valid production run ID/i);
  assert.equal(getRunCalls, 0);
});

test('both director endpoints return 503 when durable storage is unavailable', { concurrency: false }, async (t) => {
  openAccess(t);
  const missingStore = { getRedis: () => null, getRun: async () => { throw new Error('must not read'); }, saveRun: async () => { throw new Error('must not save'); }, addEvent };
  for (const [endpoint, body] of [
    ['api/video-control.js', { action: 'get', runId: 'run_endpoint_contract_001' }],
    ['api/character-assets.js', { action: 'list', runId: 'run_endpoint_contract_001' }]
  ]) {
    const loaded = loadHandler(endpoint, { 'api/_lib/store.js': missingStore });
    const res = response();
    await loaded.handler(request(body), res);
    assert.equal(res.state.statusCode, 503);
    assert.match(res.state.body.error, /storage is not configured/i);
    loaded.restore();
  }
});

test('open access still rejects video-control and character image mutations without an operator token', { concurrency: false }, async (t) => {
  openAccess(t);
  const run = baseRun();
  const store = memoryStore(run);
  const rateLimit = { consumeRateLimit: async () => { throw new Error('must not rate limit unauthorised request'); }, requestIdentity: () => 'test' };
  const video = loadHandler('api/video-control.js', { 'api/_lib/store.js': store.api });
  const character = loadHandler('api/character-assets.js', { 'api/_lib/store.js': store.api, 'api/_lib/rate-limit.js': rateLimit });
  t.after(() => character.restore());
  t.after(() => video.restore());

  const videoRes = response();
  await video.handler(request({ action: 'set_video_control', runId: run.id, control: {} }), videoRes);
  assert.equal(videoRes.state.statusCode, 401);
  assert.match(videoRes.state.body.error, /operator mutation/i);

  const characterRes = response();
  await character.handler(request({ action: 'generate', runId: run.id, character: { name: 'Persephone Vale' } }), characterRes);
  assert.equal(characterRes.state.statusCode, 401);
  assert.match(characterRes.state.body.error, /operator mutation/i);
  assert.equal(store.saves.length, 0);
});

test('video-control preview is read-only and cannot invoke AC submission or create a paid task', { concurrency: false }, async (t) => {
  openAccess(t);
  const run = baseRun();
  const store = memoryStore(run);
  const originalSubmitAc = providers.submitAc;
  let submitCalls = 0;
  providers.submitAc = async () => { submitCalls += 1; throw new Error('AC submission must never run from preview'); };
  t.after(() => { providers.submitAc = originalSubmitAc; });
  const loaded = loadHandler('api/video-control.js', { 'api/_lib/store.js': store.api });
  t.after(() => loaded.restore());

  const res = response();
  await loaded.handler(request({ action: 'preview_video_contract', runId: run.id }, operatorHeaders()), res);
  assert.equal(res.state.statusCode, 200);
  assert.equal(res.state.body.preview.submissionAllowed, true);
  assert.equal(res.state.body.preview.payloadSummary.enableSubtitles, false);
  assert.equal(store.saves.length, 0);
  assert.equal(submitCalls, 0);
  assert.equal(run.artifacts.video, undefined);
  assert.equal(run.stages.P4.threadId, undefined);
});

test('video-control saves only an unsubmitted P4 contract and locks once a paid task exists', { concurrency: false }, async (t) => {
  openAccess(t);
  const preparedRun = baseRun({ artifacts: { video: { status: 'prepared', threadId: '', videoUrls: [] } }, stages: { P4: { status: 'prepared', threadId: '' } } });
  const preparedStore = memoryStore(preparedRun);
  const editable = loadHandler('api/video-control.js', { 'api/_lib/store.js': preparedStore.api });
  t.after(() => editable.restore());

  const saved = response();
  await editable.handler(request({ action: 'set_video_control', runId: preparedRun.id, control: { template: 'Ad_Plot_Seedance' } }, operatorHeaders()), saved);
  assert.equal(saved.state.statusCode, 200);
  assert.equal(preparedStore.saves.length, 1);
  assert.equal(preparedRun.artifacts.video.status, 'prepared');
  assert.equal(preparedRun.artifacts.video.threadId, '');
  assert.equal(preparedRun.artifacts.video.submitAttemptedAt, undefined);
  assert.equal(preparedRun.stages.P4.status, 'prepared');
  assert.match(preparedRun.events.map((event) => event.type).join(' '), /video_control_saved/);

  const paidRun = baseRun({
    input: { videoControl: { template: 'Ad_Plot_Seedance' } },
    artifacts: { video: { status: 'running', threadId: 'ac_paid_task_001', submitAttemptedAt: '2026-08-16T00:00:00.000Z', videoUrls: [] } },
    stages: { P4: { status: 'running', threadId: 'ac_paid_task_001' } }
  });
  const paidStore = memoryStore(paidRun);
  const locked = loadHandler('api/video-control.js', { 'api/_lib/store.js': paidStore.api });
  t.after(() => locked.restore());
  const rejected = response();
  await locked.handler(request({ action: 'set_video_control', runId: paidRun.id, control: { template: 'Ad_Plot_Seedance' } }, operatorHeaders()), rejected);
  assert.equal(rejected.state.statusCode, 409);
  assert.match(rejected.state.body.error, /locked after a paid submission/i);
  assert.equal(paidStore.saves.length, 0);
  assert.equal(paidRun.input.videoControl.template, 'Ad_Plot_Seedance');
});

test('character image generation persists submitting intent before mocked Meitu generation', { concurrency: false }, async (t) => {
  openAccess(t);
  const run = baseRun();
  const store = memoryStore(run);
  const rateLimit = { consumeRateLimit: async () => ({ allowed: true, retryAfter: 60 }), requestIdentity: () => 'test' };
  let meituCalls = 0;
  const providerMock = {
    generateIIITImage: async () => {
      meituCalls += 1;
      assert.equal(store.saves.length, 1);
      assert.equal(store.saves[0].artifacts.characterAssets.length, 1);
      assert.equal(store.saves[0].artifacts.characterAssets[0].status, 'submitting');
      assert.ok(store.saves[0].artifacts.characterAssets[0].submitAttemptedAt);
      return { requestId: 'meitu_test_request_001', model: 'IMG-2', size: '1024x1024', url: 'https://cdn.example.test/persephone-four-view.png' };
    },
    validateImage: async (url) => ({ contentType: 'image/png', contentLength: 2048, resolvedUrl: url })
  };
  const loaded = loadHandler('api/character-assets.js', {
    'api/_lib/store.js': store.api,
    'api/_lib/rate-limit.js': rateLimit,
    'api/_lib/providers.js': providerMock
  });
  t.after(() => loaded.restore());

  const res = response();
  await loaded.handler(request({ action: 'generate', runId: run.id, character: { name: 'Persephone Vale', role: 'lead', visualAnchors: 'Adult red hair, green eyes, diner uniform.' } }, operatorHeaders()), res);
  assert.equal(res.state.statusCode, 200);
  assert.equal(res.state.body.status, 'ready');
  assert.equal(meituCalls, 1);
  assert.equal(store.saves.length, 2);
  assert.equal(run.artifacts.characterAssets[0].status, 'ready');
  assert.equal(run.artifacts.characterAssets[0].provider, 'iiit');
  assert.equal(run.artifacts.characterAssets[0].approved, true);
});

test('an ambiguous Meitu submission becomes durable state and is never retried automatically', { concurrency: false }, async (t) => {
  openAccess(t);
  const run = baseRun();
  const store = memoryStore(run);
  const rateLimit = { consumeRateLimit: async () => ({ allowed: true, retryAfter: 60 }), requestIdentity: () => 'test' };
  let meituCalls = 0;
  const ambiguous = new providers.ProviderError('network outcome unknown', { ambiguous: true });
  const loaded = loadHandler('api/character-assets.js', {
    'api/_lib/store.js': store.api,
    'api/_lib/rate-limit.js': rateLimit,
    'api/_lib/providers.js': {
      generateIIITImage: async () => { meituCalls += 1; throw ambiguous; },
      validateImage: async () => { throw new Error('must not validate unknown submission'); }
    }
  });
  t.after(() => loaded.restore());
  const body = { action: 'generate', runId: run.id, character: { name: 'Persephone Vale', role: 'lead' } };

  const first = response();
  await loaded.handler(request(body, operatorHeaders()), first);
  assert.equal(first.state.statusCode, 409);
  assert.match(first.state.body.error, /ambiguous/i);
  assert.equal(run.artifacts.characterAssets[0].status, 'submit_ambiguous');

  const second = response();
  await loaded.handler(request(body, operatorHeaders()), second);
  assert.equal(second.state.statusCode, 200);
  assert.equal(second.state.body.status, 'submit_ambiguous');
  assert.equal(meituCalls, 1);
  assert.equal(store.saves.length, 2);
});

test('character asset list exposes operational metadata but never the generation prompt', { concurrency: false }, async (t) => {
  openAccess(t);
  const secretPrompt = 'operator-only prompt text that must never reach the browser';
  const run = baseRun({
    artifacts: {
      characterAssets: [{
        id: 'char_persephone_001',
        provider: 'iiit',
        kind: 'character_reference',
        status: 'ready',
        characterId: 'persephone_vale',
        characterName: 'Persephone Vale',
        label: 'Persephone Vale - four-view sheet',
        role: 'lead',
        view: 'four_view_sheet',
        url: 'https://cdn.example.test/persephone.png',
        approved: true,
        createdAt: '2026-08-16T00:00:00.000Z',
        prompt: secretPrompt,
        promptFingerprint: 'a'.repeat(64)
      }]
    }
  });
  const store = memoryStore(run);
  const loaded = loadHandler('api/character-assets.js', { 'api/_lib/store.js': store.api });
  t.after(() => loaded.restore());

  const res = response();
  await loaded.handler(request({ action: 'list', runId: run.id }), res);
  assert.equal(res.state.statusCode, 200);
  assert.equal(res.state.body.assets.length, 1);
  assert.equal(res.state.body.assets[0].characterName, 'Persephone Vale');
  assert.equal(Object.hasOwn(res.state.body.assets[0], 'prompt'), false);
  assert.equal(JSON.stringify(res.state.body).includes(secretPrompt), false);
});
