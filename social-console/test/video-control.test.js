const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../api/_lib/providers');
const videoControl = require('../api/_lib/video-control');

function asset(id, extra = {}) {
  return {
    id,
    provider: 'iiit',
    kind: 'character_reference',
    status: 'ready',
    approved: true,
    characterId: `character_${id}`,
    characterName: `Character ${id}`,
    role: 'lead',
    view: 'four_view_sheet',
    url: `https://assets.example.test/${id}.png`,
    ...extra
  };
}

function controlRun({ control = {}, assets = [], prompt = {}, video = null } = {}) {
  return {
    id: 'run_control_contract_test',
    input: {
      sku: 'sku-control-test',
      title: 'A Source-Grounded Romance',
      videoControl: control
    },
    artifacts: {
      book: { title: 'A Source-Grounded Romance', cover: 'https://covers.example.test/default-cover.jpg' },
      evidence: { chapters: [{ order: 7 }, { order: 8 }] },
      videoPrompt: {
        evidenceChapters: [7, 8],
        adCopy: 'An adult lead makes one source-grounded choice before the door closes.',
        buildRequirement: '0-3s the adult lead sees the letter. 3-8s she acts. 8-12s end on the locked door.',
        ...prompt
      },
      characterAssets: assets,
      ...(video ? { video } : {})
    }
  };
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

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function expectedRemark(run, kind, fingerprint) {
  const prefix = ({ original: 'nf', revision: 'nf_re', reference: 'nf_ref' })[kind] || 'nf';
  return `${prefix}_${crypto.createHash('sha256').update(`${run.id}:${kind}:${fingerprint}`).digest('hex').slice(0, 24)}`;
}

test('Seedance control has no implicit book-cover reference and fingerprints the whole stable payload', () => {
  const baselineRun = controlRun();
  const baseline = videoControl.compileVideoContract(baselineRun);
  const repeated = videoControl.compileVideoContract(controlRun());

  assert.deepEqual(baseline.payload.reference_picture_list, []);
  assert.equal(baseline.payload.enable_subtitles, 'false');
  assert.equal(baseline.submissionAllowed, true);
  assert.equal(baseline.payloadFingerprint, repeated.payloadFingerprint);
  assert.equal(baseline.remark, repeated.remark);
  assert.equal(baseline.remark, expectedRemark(baselineRun, 'original', baseline.payloadFingerprint));

  const promptChanged = videoControl.compileVideoContract(controlRun({ prompt: { adCopy: 'The adult lead makes a different source-grounded choice before the door closes.' } }));
  const referenceChanged = videoControl.compileVideoContract(controlRun({
    assets: [asset('char_alpha')],
    control: { referenceAssetIds: ['char_alpha'] }
  }));
  const templateChanged = videoControl.compileVideoContract(controlRun({ control: { template: 'Ad_Plot_Video_V4' } }));

  for (const changed of [promptChanged, referenceChanged, templateChanged]) {
    assert.notEqual(changed.payloadFingerprint, baseline.payloadFingerprint);
    assert.notEqual(changed.remark, baseline.remark);
  }

  const subtitlesEnabled = { ...baseline.payload, enable_subtitles: 'true' };
  assert.notEqual(videoControl.payloadFingerprint(subtitlesEnabled), baseline.payloadFingerprint);
  assert.equal(videoControl.payloadFingerprint({ ...baseline.payload, remark: 'ignored' }), baseline.payloadFingerprint);
  assert.throws(
    () => videoControl.compileVideoContract(controlRun({ control: { enableSubtitles: true } })),
    /subtitles are disabled/i
  );
  const numericZero = videoControl.compileVideoContract(controlRun({ control: { subtitleWireValue: 'number_zero' } }));
  assert.equal(numericZero.payload.enable_subtitles, 0);
  assert.notEqual(numericZero.payloadFingerprint, baseline.payloadFingerprint);
});

test('premium opening gate rejects generic wake-up shots but permits a concrete bed action', () => {
  for (const opener of [
    'she opens her eyes in bed as morning light fills the bedroom',
    'she is waking up in bed while the alarm clock rings',
    'she jolted awake and bolted upright in bed',
    'she woke up lying in bed and stared at the ceiling',
    'she opens her eyes on a couch',
    'ella se despierta y abre los ojos en el sofá',
    'ela acorda e abre os olhos no sofá'
  ]) {
    assert.throws(
      () => videoControl.compileVideoContract(controlRun({ prompt: {
        buildRequirement: `0-3s ${opener}. 3-5s she sits up. 5-9s she looks around. 9-12s the door opens.`
      } })),
      /generic wake-up\/eyes-opening scene/i,
      opener
    );
  }
  assert.throws(
    () => videoControl.compileVideoContract(controlRun({ prompt: {
      buildRequirement: '0-3s a static bedroom with the bed and pillows in frame. 3-5s the camera drifts. 5-9s a figure enters. 9-12s the door closes.'
    } })),
    /static bedroom\/bed establishing shot/i
  );
  for (const opener of [
    'she stares at the phone in silence',
    'she reads a message alone on her phone',
    'she touches the bruise in the mirror',
    'she cries alone in an empty room',
    'she walks down the ordinary hallway',
    'she sits silently at the dinner table and talks across it'
  ]) {
    assert.throws(
      () => videoControl.compileVideoContract(controlRun({ prompt: {
        buildRequirement: `0-3s ${opener}. 3-5s the camera lingers. 5-9s the room stays quiet. 9-12s the door closes.`
      } })),
      /passive establishing shot/i,
      opener
    );
  }
  const activePhone = videoControl.compileVideoContract(controlRun({ prompt: {
    buildRequirement: '0-3s she reads the threatening message as he steps into frame and blocks the exit. 3-5s she locks the phone. 5-9s he reaches for it. 9-12s she reveals the evidence.'
  } }));
  assert.equal(activePhone.submissionAllowed, true);
  const concrete = videoControl.compileVideoContract(controlRun({ prompt: {
    buildRequirement: '0-3s she grabs the blood-stained letter from the bed before anyone can stop her. 3-5s he blocks the doorway. 5-9s she reveals the seal. 9-12s his expression breaks.'
  } }));
  assert.equal(concrete.submissionAllowed, true);
});

test('scene and visual locks are deterministically embedded in the paid AC payload', () => {
  const run = controlRun();
  run.input.creativeProfile = {
    sceneChapters: [3, 4, 5],
    sceneBrief: 'Osborne refuses Bella and chooses the woman he already claimed.',
    visualContinuity: 'A curvy adult woman with round glasses; a tall adult man with dark hair and a mature beard.'
  };
  const compiled = videoControl.compileVideoContract(run);
  assert.deepEqual(compiled.control.chapterWindow, { start: 3, end: 5, chapters: [3, 4, 5] });
  assert.match(compiled.payload.ad_copy, /CAMPAIGN SCENE LOCK/);
  assert.match(compiled.payload.ad_copy, /round glasses/);
  assert.match(compiled.payload.build_requirement, /DIRECTOR SCENE LOCK/);
  assert.match(compiled.payload.build_requirement, /mature beard/);
  assert.match(compiled.payload.build_requirement, /Keep every named adult identity/);
  assert.doesNotMatch(compiled.payload.build_requirement, /Aina and Osborne must both appear clearly/);
});

test('only approved managed IIIT character assets can be AC references and template limits are enforced', () => {
  assert.throws(
    () => videoControl.compileVideoContract(controlRun({
      assets: [asset('char_legacy', { provider: 'unsupported_legacy' })],
      control: { referenceAssetIds: ['char_legacy'] }
    })),
    /managed IIIT character asset/i
  );
  assert.throws(
    () => videoControl.compileVideoContract(controlRun({
      assets: [asset('char_unapproved', { approved: false })],
      control: { referenceAssetIds: ['char_unapproved'] }
    })),
    /visually approved/i
  );

  const first = asset('char_first');
  const second = asset('char_second');
  assert.throws(
    () => videoControl.compileVideoContract(controlRun({
      assets: [first, second],
      control: { referenceAssetIds: [first.id, second.id] }
    })),
    /accepts at most 1 approved reference image/i
  );

  const v4Assets = Array.from({ length: 9 }, (_, index) => asset(`char_v4_${index + 1}`));
  const v4 = videoControl.compileVideoContract(controlRun({
    assets: v4Assets,
    control: { template: 'Ad_Plot_Video_V4', referenceAssetIds: v4Assets.map((item) => item.id) }
  }));
  assert.equal(v4.payload.reference_picture_list.length, 9);
  assert.equal(v4.submissionAllowed, false);
  assert.deepEqual(v4.warnings, ['experimental_template_dry_run_only']);

  assert.throws(
    () => videoControl.compileVideoContract(controlRun({
      assets: [...v4Assets, asset('char_v4_10')],
      control: { template: 'Ad_Plot_Video_V4', referenceAssetIds: [...v4Assets.map((item) => item.id), 'char_v4_10'] }
    })),
    /At most 9 reference assets/i
  );
});

test('lineage can only use completed local material traces and ignores injected parent IDs', () => {
  const completedVideo = {
    status: 'completed',
    threadId: 'local_thread_42',
    lineage: { copyParentThreadId: 'local_parent_42', copyThreadId: 'local_child_42' }
  };
  const run = controlRun({
    video: completedVideo,
    control: {
      lineage: {
        source: 'video',
        threadId: 'local_thread_42',
        copyParentThreadId: 'attacker_parent_99',
        copyThreadId: 'attacker_child_99'
      }
    }
  });
  const compiled = videoControl.compileVideoContract(run);
  assert.equal(compiled.payload.copy_parent_thread_id, 'local_parent_42');
  assert.equal(compiled.payload.copy_thread_id, 'local_child_42');

  assert.throws(
    () => videoControl.compileVideoContract(controlRun({
      video: completedVideo,
      control: { lineage: { source: 'video', threadId: 'attacker_thread_99' } }
    })),
    /completed local material trace/i
  );
  assert.throws(
    () => videoControl.compileVideoContract(controlRun({
      video: completedVideo,
      control: { lineage: { source: 'referenceVideo', threadId: 'local_thread_42' } }
    })),
    /completed local material trace/i
  );
});

test('AC execution controls parse object, string, and invalid result_json without hiding forced subtitles', { concurrency: false }, async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  setEnvironment(t, { NOVELFLOW_AC_TOKEN: 'ac-test-token-only' });

  global.fetch = async () => jsonResponse({
    run_status: 'completed',
    base_info: { status: 'completed' },
    final_result: [{
      video_url: 'https://videos.example.test/object.mp4',
      result_json: {
        enable_subtitles: true,
        is_generate_img: 'true',
        video_model: 'server-object-model',
        tts_audio_voice: 'Female_cur1',
        word_count: '200',
        reference_picture_list: ['https://assets.example.test/lead.png'],
        base_storyboard: { shots: ['opening', 'reversal'] },
        copy_parent_thread_id: 'parent_trace_1'
      }
    }]
  });
  const objectResult = await providers.acResult('ac_object_1');
  assert.equal(objectResult.status, 'completed');
  assert.equal(objectResult.executionControls.enableSubtitles, true);
  assert.equal(objectResult.executionControls.isGenerateImage, true);
  assert.equal(objectResult.executionControls.effectiveVideoModel, 'server-object-model');
  assert.equal(objectResult.executionControls.referenceCount, 1);
  assert.equal(objectResult.executionControls.storyboard.sha256.length, 64);
  assert.deepEqual(objectResult.executionControls.materialTraceIds, ['parent_trace_1']);

  global.fetch = async () => jsonResponse({
    run_status: 'completed',
    base_info: { status: 'completed' },
    final_result: [{
      video_url: 'https://videos.example.test/string.mp4',
      result_json: JSON.stringify({
        enable_subtitles: 'false',
        is_generate_img: false,
        video_model: 'server-string-model',
        reference_picture_list: ['https://assets.example.test/one.png', 'https://assets.example.test/two.png'],
        base_storyboard: 'two locked shots'
      })
    }]
  });
  const stringResult = await providers.acResult('ac_string_1');
  assert.equal(stringResult.executionControls.enableSubtitles, false);
  assert.equal(stringResult.executionControls.isGenerateImage, false);
  assert.equal(stringResult.executionControls.effectiveVideoModel, 'server-string-model');
  assert.equal(stringResult.executionControls.referenceCount, 2);

  global.fetch = async () => jsonResponse({
    run_status: 'completed',
    base_info: { status: 'completed' },
    final_result: [{
      video_url: 'https://videos.example.test/invalid.mp4',
      enable_subtitles: true,
      reference_picture_list: ['https://assets.example.test/fallback.png'],
      result_json: '{not valid JSON'
    }]
  });
  const invalidResult = await providers.acResult('ac_invalid_1');
  assert.equal(invalidResult.status, 'completed');
  assert.equal(invalidResult.executionControls.enableSubtitles, true);
  assert.equal(invalidResult.executionControls.referenceCount, 1);
  assert.equal(invalidResult.executionControls.effectiveVideoModel, '');
});

test('IIIT generation uses server-only env credentials and returns no credential material', { concurrency: false }, async (t) => {
  const originalFetch = global.fetch;
  let captured;
  t.after(() => { global.fetch = originalFetch; });
  setEnvironment(t, {
    IIIT_IMAGE_API_KEY: 'unit-test-iiit-key',
    IIIT_IMAGE_BASE_URL: 'https://iiit-api.example.test/v1/',
    IIIT_IMAGE_MODEL: 'IMG-2-test'
  });
  global.fetch = async (url, options) => {
    captured = { url, options };
    return jsonResponse({ id: 'meitu-request-1', data: [{ url: 'https://cdn.example.test/meitu-output.png' }] });
  };

  const result = await providers.generateIIITImage({
    prompt: 'Adult fictional character turnaround, no text.',
    size: '1024x1536'
  });
  assert.equal(captured.url, 'https://iiit-api.example.test/v1/images/generations');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer unit-test-iiit-key');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.options.body), {
    model: 'IMG-2-test',
    prompt: 'Adult fictional character turnaround, no text.',
    n: 1,
    size: '1024x1536',
    response_format: 'url'
  });
  assert.deepEqual(result, {
    provider: 'iiit',
    status: 'success',
    url: 'https://cdn.example.test/meitu-output.png',
    requestId: 'meitu-request-1',
    model: 'IMG-2-test',
    size: '1024x1536'
  });
  assert.doesNotMatch(JSON.stringify(result), /unit-test-iiit-key/);
});

test('Meitu refuses missing credentials before fetch and treats a missing image URL as ambiguous', { concurrency: false }, async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ data: [] });
  };

  setEnvironment(t, {
    IIIT_IMAGE_API_KEY: undefined,
    IIIT_IMAGE_BASE_URL: 'https://iiit-api.example.test/v1',
    IIIT_IMAGE_MODEL: 'IMG-2'
  });
  await assert.rejects(
    providers.generateIIITImage({ prompt: 'Adult fictional character turnaround.' }),
    (error) => error instanceof providers.ProviderError && error.status === 503 && !/unit-test-iiit-key/.test(error.message)
  );
  assert.equal(calls, 0);

  process.env.IIIT_IMAGE_API_KEY = 'unit-test-iiit-key-not-in-error';
  await assert.rejects(
    providers.generateIIITImage({ prompt: 'Adult fictional character turnaround.' }),
    (error) => error instanceof providers.ProviderError
      && error.ambiguous === true
      && !error.message.includes('unit-test-iiit-key-not-in-error')
  );
  assert.equal(calls, 1);
});
