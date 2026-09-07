const crypto = require('crypto');
const { deliveryForRun } = require('./distribution');

const POLICY_VERSION = 1;
const MAX_CHAPTER_SPAN = 5;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,119}$/i;
const THREAD_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{2,179}$/i;

// Only templates with a documented reference-image contract belong here. The
// UI may expose an experimental option, but the worker must never quietly turn
// it into a production submission.
const TEMPLATE_POLICIES = Object.freeze({
  Ad_Plot_Seedance: Object.freeze({ id: 'Ad_Plot_Seedance', label: 'Seedance', production: true, maxReferences: 1 }),
  Ad_Plot_Video_V4: Object.freeze({ id: 'Ad_Plot_Video_V4', label: 'Short drama pre-roll V4', production: false, maxReferences: 9 })
});

class VideoControlError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'VideoControlError';
    this.status = status;
  }
}

function clean(value, limit = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stableValue(value[key])]));
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || typeof value === 'string' || value === null) return value;
  return null;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function payloadWithoutRemark(payload) {
  const copy = { ...(payload || {}) };
  delete copy.remark;
  return copy;
}

function payloadFingerprint(payload) {
  return sha(stableJson(payloadWithoutRemark(payload)));
}

function templatePolicy(template) {
  const policy = TEMPLATE_POLICIES[String(template || '')];
  if (!policy) throw new VideoControlError('Unsupported AC video template');
  return policy;
}

function publicTemplatePolicies() {
  return Object.values(TEMPLATE_POLICIES).map((policy) => ({ ...policy }));
}

function characterAssets(run) {
  return Array.isArray(run?.artifacts?.characterAssets) ? run.artifacts.characterAssets : [];
}

function validHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function referenceIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new VideoControlError('Reference assets must be an ordered list of asset IDs');
  if (value.length > 9) throw new VideoControlError('At most 9 reference assets can be selected');
  const ids = value.map((item) => clean(item, 120));
  if (ids.some((id) => !ID_PATTERN.test(id))) throw new VideoControlError('Reference asset ID is invalid');
  if (new Set(ids).size !== ids.length) throw new VideoControlError('A reference asset may be selected only once');
  return ids;
}

function knownLineage(run, source, requestedThreadId = '') {
  const videos = {
    video: run?.artifacts?.video,
    videoRevision: run?.artifacts?.videoRevision,
    referenceVideo: run?.artifacts?.referenceVideo
  };
  const candidate = videos[source];
  const threadId = clean(candidate?.threadId, 180);
  if (candidate?.status !== 'completed' || !THREAD_ID_PATTERN.test(threadId) || (requestedThreadId && requestedThreadId !== threadId)) return null;
  const lineage = candidate?.lineage && typeof candidate.lineage === 'object' ? candidate.lineage : {};
  const copyParentThreadId = clean(lineage.copyParentThreadId, 180);
  const copyThreadId = clean(lineage.copyThreadId, 180);
  return {
    source,
    threadId,
    ...(THREAD_ID_PATTERN.test(copyParentThreadId) && THREAD_ID_PATTERN.test(copyThreadId) ? { copyParentThreadId, copyThreadId } : {})
  };
}

function sanitizeLineage(run, value) {
  if (value == null || value === '') return null;
  if (!value || typeof value !== 'object') throw new VideoControlError('Lineage must select an already recorded local material trace');
  const source = clean(value.source, 40);
  const threadId = clean(value.threadId, 180);
  if (!THREAD_ID_PATTERN.test(threadId)) throw new VideoControlError('Lineage must select a completed local material trace');
  const lineage = knownLineage(run, source, threadId);
  if (!lineage) throw new VideoControlError('The selected lineage is not a completed local material trace', 409);
  return lineage;
}

function resolveReferences(run, ids, policy) {
  if (ids.length > policy.maxReferences) throw new VideoControlError(`${policy.label} accepts at most ${policy.maxReferences} approved reference image${policy.maxReferences === 1 ? '' : 's'}`);
  const assets = new Map(characterAssets(run).map((asset) => [String(asset?.id || ''), asset]));
  return ids.map((id) => {
    const asset = assets.get(id);
    if (!asset || !['iiit', 'meitu'].includes(String(asset.provider || '')) || asset.kind !== 'character_reference') throw new VideoControlError(`Reference asset ${id} is not a managed IIIT character asset`, 409);
    if (asset.status !== 'ready' || asset.approved !== true) throw new VideoControlError(`Reference asset ${id} must be visually approved before it can control AC`, 409);
    if (!validHttpsUrl(asset.url)) throw new VideoControlError(`Reference asset ${id} has no usable managed image URL`, 409);
    return {
      id,
      characterId: clean(asset.characterId, 120),
      characterName: clean(asset.characterName, 160),
      role: clean(asset.role, 80),
      url: clean(asset.url, 4000),
      view: clean(asset.view, 40)
    };
  });
}

function sanitizeVideoControl(run, value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const template = clean(input.template || 'Ad_Plot_Seedance', 80);
  const policy = templatePolicy(template);
  if (input.enableSubtitles === true) throw new VideoControlError('AC subtitles are disabled for this contract; add readable text in deterministic post-production');
  const subtitleWireValue = input.subtitleWireValue === 'number_zero' ? 'number_zero' : 'string_false';
  const ids = referenceIds(input.referenceAssetIds);
  const references = resolveReferences(run, ids, policy);
  const lineage = sanitizeLineage(run, input.lineage);
  return {
    version: POLICY_VERSION,
    template,
    enableSubtitles: false,
    subtitleWireValue,
    referenceAssetIds: ids,
    references,
    lineage,
    policy: { id: policy.id, production: policy.production, maxReferences: policy.maxReferences }
  };
}

function chapterWindow(run, prompt) {
  const locked = Array.isArray(run?.input?.creativeProfile?.sceneChapters) ? run.input.creativeProfile.sceneChapters : [];
  const raw = locked.length
    ? locked
    : Array.isArray(prompt?.evidenceChapters) && prompt.evidenceChapters.length
    ? prompt.evidenceChapters
    : (run?.artifacts?.evidence?.chapters || []).map((item) => item?.order);
  const chapters = [...new Set(raw.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
  if (!chapters.length) throw new VideoControlError('Video contract needs a source-grounded chapter window', 409);
  // Evidence collection may cover a wider story arc than the director
  // contract needs. Keep the earliest contiguous window that satisfies the
  // AC limit instead of failing P4 after paid pre-production is complete.
  const start = chapters[0];
  const end = Math.min(chapters[chapters.length - 1], start + MAX_CHAPTER_SPAN);
  return { start, end, chapters: chapters.filter((chapter) => chapter <= end) };
}

function sourceLanguageForRun(run) {
  const specified = String(run?.input?.creativeProfile?.outputLanguage || '').toLowerCase();
  if (['en', 'pt', 'es'].includes(specified)) return specified;
  if (run?.input?.creativeProfile?.forceEnglish === true) return 'en';
  if (deliveryForRun(run)?.accountId) return 'en';
  const book = run?.artifacts?.book || {};
  const value = `${book.title || run?.input?.title || ''} ${book.description || ''} ${(book.tags || []).join(' ')}`.toLowerCase();
  if (/[\u00f1\u00bf\u00a1]|\b(el|la|esposa|heredero|olvidado|alfa|contraataca|regreso)\b/.test(value)) return 'es';
  if (/[\u00e3\u00f5\u00e1\u00e9\u00ed\u00f3\u00fa\u00e7]|\b(sem|segunda|chance|despreocupada|pr\u00f3spera|amor|lobisomem)\b/.test(value)) return 'pt';
  return 'en';
}

function platformForRun(run) {
  const platform = String(deliveryForRun(run)?.platform || 'facebook').toLowerCase();
  return ({ facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' })[platform] || 'Facebook';
}

// Generic "wake up in bed" openers are cheap-looking for short-form fiction
// ads. Keep this gate narrow enough to allow a source-supported bed prop (for
// example, finding a letter on a bed), while rejecting the familiar
// bedroom/eyes-opening establishing shot. The same check is used before P4
// compilation and by P3 normalization, so weak model output is repaired
// before any paid media submission can happen.
const WAKE_OR_EYES_OPENING = /(?:\b(?:wake(?:s|n|ning)?\s+up|waking\s+up|woke\s+up|awoke|awakens?|awakening|jolted\s+awake|bolted\s+upright|opens?\s+(?:her|his|their|the)\s+eyes?|eyes?\s+(?:open|flutter|blink)|falls?\s+asleep|is\s+asleep|lying\s+(?:in|on)\s+(?:the\s+)?bed|sits?\s+up\s+(?:in|on)\s+(?:the\s+)?bed|alarm(?:-| )?clock)\b|\b(?:se\s+despierta|despierta|despertando|abre\s+(?:los|sus)\s+ojos|ojos\s+se\s+abren|acostad[oa]\s+en\s+la\s+cama|se\s+sienta\s+en\s+la\s+cama)\b|\b(?:acorda|acordando|desperta|despertando|abre\s+(?:os|seus)\s+olhos|olhos\s+se\s+abrem|deitad[oa]\s+na\s+cama|senta(?:-se)?\s+na\s+cama)\b)/i;
const BEDROOM_SETTING = /\b(?:bedroom|bed|mattress|pillow|sheets?)\b/i;
// Reading, holding or opening a phone is not a decisive first-shot action.
// Keep this set limited to visible choices, collisions and changes of control.
const DECISIVE_ACTION = /\b(?:finds?|find|grabs?|grab|snatches?|snatch|slams?|slam|throws?|throw|draws?|draw|pulls?|pull|tears?|tear|runs?|run|enters?|enter|blocks?|block|confronts?|confront|reveals?|reveal|signs?|sign|drags?|drag|drops?|drop|intercepts?|intercept|shoves?|shove|strikes?|strike|steps?\s+between|cuts?\s+off|walks?\s+out|turns?\s+away)\b/i;
const PASSIVE_ESTABLISHING_OPENING = /\b(?:stares?\s+at\s+(?:the\s+)?(?:phone|screen)|checks?\s+(?:the\s+)?phone|reads?\s+(?:a|the|her|his)?\s*(?:message|text)\b[^.]{0,80}\b(?:phone|screen)|scrolls?\s+(?:on|through)\s+(?:the\s+)?phone|holds?\s+(?:the\s+)?phone\s+(?:alone|in\s+silence)|touches?\s+(?:the\s+)?(?:bruise|scar|wound)\s+(?:in|on)\s+(?:the\s+)?mirror|cries?|weeps?|sobs?|gasps?|pants?|an?\s+empty\s+(?:room|window)|empty\s+(?:room|window)|walks?\s+(?:down|through)\s+(?:the\s+)?(?:ordinary\s+)?hall(?:way)?|ordinary\s+hall(?:way)?(?:\s+walk)?|sits?\s+(?:silently\s+)?at\s+(?:a|the)\s+(?:dinner\s+)?table|(?:quiet|ordinary|static)\s+(?:dinner|table)\s+(?:talk|conversation)|talks?\s+across\s+(?:a|the)\s+(?:dinner\s+)?table)\b/i;
const ACTOR_CUE = /\b(?:he|she|they|man|woman|alpha|hero|heroine|another\s+(?:person|figure)|both|two)\b/gi;

function firstShotBlock(buildRequirement) {
  const normalized = String(buildRequirement || '').replace(/[\u2010-\u2015\u2212]/g, '-');
  const marker = normalized.search(/\b0\s*-\s*(?:2|3)\s*s?\b/i);
  const body = marker >= 0 ? normalized.slice(marker) : normalized.slice(0, 700);
  const next = body.search(/\b(?:2\s*-\s*5|3\s*-\s*5|5\s*-\s*9|9\s*-\s*12|11\s*-\s*15)\s*s?\b/i);
  return (next > 0 ? body.slice(0, next) : body.slice(0, 700)).trim();
}

function premiumOpeningViolation(buildRequirement) {
  const opening = firstShotBlock(buildRequirement);
  if (!opening) return '';
  if (WAKE_OR_EYES_OPENING.test(opening)) {
    return 'Video opening cannot be a generic wake-up/eyes-opening scene; start on a decisive source-grounded conflict or action';
  }
  // A bedroom-only establishing shot is also weak when it has no concrete
  // action or conflict object. Permit a bed as context when the shot contains
  // a documented action (finding a letter, grabbing a phone, revealing proof,
  // etc.) so source-supported plot beats remain valid.
  if (BEDROOM_SETTING.test(opening) && !DECISIVE_ACTION.test(opening)) {
    return 'Video opening cannot be a static bedroom/bed establishing shot; show a concrete source-grounded action or conflict object';
  }
  if (PASSIVE_ESTABLISHING_OPENING.test(opening) && !DECISIVE_ACTION.test(opening)) {
    const cues = opening.match(ACTOR_CUE) || [];
    const distinctCues = new Set(cues.map((cue) => cue.toLowerCase())).size;
    if (distinctCues < 2 && !/\b(?:another|both|two)\b/i.test(opening)) {
      return 'Video opening is a passive establishing shot; include a second actor, conflict object in active use, or a decisive action in the first beat';
    }
  }
  return '';
}

function assertPremiumVideoOpening(buildRequirement) {
  const violation = premiumOpeningViolation(buildRequirement);
  if (violation) throw new VideoControlError(violation, 422);
  return true;
}

function remarkFor(run, kind, fingerprint) {
  const prefix = ({ original: 'nf', revision: 'nf_re', reference: 'nf_ref' })[kind] || 'nf';
  return `${prefix}_${sha(`${run?.id || 'unknown'}:${kind}:${fingerprint}`).slice(0, 24)}`;
}

function compileVideoContract(run, options = {}) {
  if (!run?.id || !run?.input?.sku) throw new VideoControlError('A persisted run and exact book SKU are required before compiling AC control', 409);
  const kind = ['original', 'revision', 'reference'].includes(options.kind) ? options.kind : 'original';
  const prompt = options.prompt || run?.artifacts?.videoPrompt;
  const sceneBrief = clean(run?.input?.creativeProfile?.sceneBrief, 2400);
  const visualContinuity = clean(run?.input?.creativeProfile?.visualContinuity, 1800);
  const baseAdCopy = clean(prompt?.adCopy, 8500);
  const baseBuildRequirement = clean(prompt?.buildRequirement, 8500);
  const adCopy = clean([
    baseAdCopy,
    sceneBrief ? `CAMPAIGN SCENE LOCK\n${sceneBrief}` : '',
    visualContinuity ? `VISUAL CONTINUITY LOCK\n${visualContinuity}` : ''
  ].filter(Boolean).join('\n\n'), 12000);
  const buildRequirement = clean([
    baseBuildRequirement,
    sceneBrief ? `DIRECTOR SCENE LOCK\nEvery shot must remain inside this source-grounded scene: ${sceneBrief}` : '',
    visualContinuity ? `VISUAL CONTINUITY LOCK\n${visualContinuity}\nKeep every named adult identity and visual anchor exactly as supplied. Do not replace either primary adult with a secondary character, merge identities, or introduce an unnamed substitute lead.` : ''
  ].filter(Boolean).join('\n\n'), 12000);
  if (!adCopy || !buildRequirement) throw new VideoControlError('A reviewed video prompt is required before compiling AC control', 409);
  assertPremiumVideoOpening(buildRequirement);
  const controlInput = { ...(run?.input?.videoControl || {}), ...(options.controlOverride || {}) };
  if (options.referenceAssetIds !== undefined) controlInput.referenceAssetIds = options.referenceAssetIds;
  const control = sanitizeVideoControl(run, controlInput);
  const chapter = chapterWindow(run, prompt);
  const language = sourceLanguageForRun(run);
  const payload = {
    template: control.template,
    relatedBook: { book_id: String(run.input.sku) },
    num: 1,
    language: language === 'pt' ? 'Portuguese' : language === 'es' ? 'Spanish' : 'English',
    country: language === 'pt' ? 'BR' : language === 'es' ? 'ES' : 'US',
    ad_platform: platformForRun(run),
    start_chapter: String(chapter.start),
    end_chapter: String(chapter.end),
    tts_audio_voice: 'Female_cur1',
    aspect_ratio: '9:16',
    is_generate_img: 'true',
    copy_type: 'original',
    build_requirement: buildRequirement,
    ad_copy: adCopy,
    word_count: '200',
    // AC's JSON gateway treats a boolean false as an omitted default. Its
    // result contract correctly preserves the explicit string value.
    enable_subtitles: control.subtitleWireValue === 'number_zero' ? 0 : 'false',
    reference_picture_list: control.references.map((reference) => reference.url)
  };
  if (control.lineage?.copyParentThreadId && control.lineage?.copyThreadId) {
    payload.copy_parent_thread_id = control.lineage.copyParentThreadId;
    payload.copy_thread_id = control.lineage.copyThreadId;
  }
  const fingerprint = payloadFingerprint(payload);
  const remark = remarkFor(run, kind, fingerprint);
  payload.remark = remark;
  const warnings = [];
  if (!control.policy.production) warnings.push('experimental_template_dry_run_only');
  if (!control.references.length) warnings.push('no_character_reference_selected');
  return {
    version: POLICY_VERSION,
    kind,
    remark,
    payload,
    payloadFingerprint: fingerprint,
    control: {
      version: control.version,
      template: control.template,
      enableSubtitles: control.enableSubtitles,
      subtitleWireValue: control.subtitleWireValue,
      referenceAssetIds: control.referenceAssetIds,
      references: control.references,
      lineage: control.lineage,
      policy: control.policy,
      chapterWindow: chapter
    },
    warnings,
    submissionAllowed: control.policy.production
  };
}

function executionWarnings(control, executionControls) {
  const warnings = [];
  if (control?.enableSubtitles === false && executionControls?.enableSubtitles === true) warnings.push('server_enable_subtitles_true');
  if (control?.references?.length && Number(executionControls?.referenceCount || 0) !== control.references.length) warnings.push('server_reference_count_mismatch');
  return warnings;
}

module.exports = {
  POLICY_VERSION,
  TEMPLATE_POLICIES,
  VideoControlError,
  stableJson,
  payloadFingerprint,
  templatePolicy,
  publicTemplatePolicies,
  sanitizeVideoControl,
  compileVideoContract,
  executionWarnings,
  firstShotBlock,
  premiumOpeningViolation,
  assertPremiumVideoOpening
};
