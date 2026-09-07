const { getRedis } = require('./_lib/store');
const { requireSession, safeEqual, openAccess } = require('./_lib/auth');
const { consumeRateLimit, requestIdentity } = require('./_lib/rate-limit');
const providers = require('./_lib/providers');
const { APPS } = require('./_lib/distribution');
const { ensureDraftForRun, getDraft } = require('./_lib/publications');
const { submitDraft } = require('./publications');

const CAMPAIGN_ID = 'whatsapp-ads-20260806';
const CAMPAIGN_INDEX = 'nf_social:ad_video_campaigns';
const campaignKey = (id) => `nf_social:ad_video_campaign:${id}`;
const campaignLockKey = (id) => `${campaignKey(id)}:advance_lock`;
const VERSIONS = new Set(['original', 'paced', 'optimized']);
const now = () => new Date().toISOString();
const clean = (value, limit = 16000) => String(value || '').trim().slice(0, limit);
const threadId = (value) => String(providers.taskIdOf(value) || '');

function requireCampaignMutation(req, res) {
  if (!openAccess()) return true;
  const expected = [
    process.env.SOCIAL_AD_CAMPAIGN_TOKEN_V2,
    process.env.SOCIAL_AD_CAMPAIGN_TOKEN
  ].map((value) => String(value || '')).filter((value) => value.length >= 32);
  const supplied = String(req.headers?.['x-nf-campaign-token'] || '');
  if (expected.some((value) => safeEqual(supplied, value))) return true;
  res.status(401).json({ error: 'Campaign operator authorization required' });
  return false;
}

function normalizedCampaignId(value) {
  const id = String(value || CAMPAIGN_ID).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(id)) throw Object.assign(new Error('Invalid campaign ID'), { status: 400 });
  return id;
}

async function load(redis, id = CAMPAIGN_ID) {
  const value = await redis.get(campaignKey(normalizedCampaignId(id)));
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function save(redis, campaign) {
  campaign.updatedAt = now();
  await redis.set(campaignKey(normalizedCampaignId(campaign.id)), JSON.stringify(campaign));
  return campaign;
}

async function indexCampaign(redis, campaign) {
  await redis.zadd(CAMPAIGN_INDEX, { score: Date.parse(campaign.createdAt) || Date.now(), member: campaign.id });
}

function publicCampaign(campaign) {
  if (!campaign) return null;
  return {
    id: campaign.id,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    counts: campaign.items.reduce((counts, item) => {
      counts[item.status] = Number(counts[item.status] || 0) + 1;
      return counts;
    }, {}),
    items: campaign.items.map((item) => ({
      id: item.id, title: item.title, version: item.version, language: item.language,
      country: item.country, status: item.status, remark: item.remark,
      threadId: item.threadId || '', videoUrl: item.videoUrl || '', error: item.error || '',
      revision: Number(item.revision || 0), priorThreadId: item.priorThreadId || '', priorRemark: item.priorRemark || '',
      captionLength: String(item.caption || '').length, previewImageUrl: item.coverImageUrl || item.cover || '',
      localizationAudit: item.localizationAudit || null,
      attribution: {
        application: item.attributionApp || '', code: item.code || '', keywordId: item.keywordId || '',
        linkId: item.linkId || '', shortUrl: item.shortUrl || '', status: item.attributionStatus || 'pending',
        error: item.attributionError || ''
      },
      draft: {
        accountId: 13943486, status: item.draftStatus || 'pending', internalId: item.internalDraftId || '',
        externalId: item.externalDraftId || '', error: item.draftError || ''
      },
      meta: {
        status: item.meta?.status || 'unbound', campaignId: item.meta?.campaignId || '',
        adsetId: item.meta?.adsetId || '', adId: item.meta?.adId || '',
        creativeId: item.meta?.creativeId || '', copywritingId: item.meta?.copywritingId || '',
        updatedAt: item.meta?.updatedAt || ''
      },
      adCreative: item.adCreative || null
    }))
  };
}

function validateItems(items, options = {}) {
  const strictLegacy = options.strictLegacy !== false;
  if (!Array.isArray(items) || (strictLegacy ? items.length !== 18 : items.length < 1 || items.length > 60)) {
    throw Object.assign(new Error(strictLegacy ? 'Campaign requires exactly 18 video items' : 'Campaign requires between 1 and 60 video items'), { status: 400 });
  }
  const campaignId = normalizedCampaignId(options.campaignId || CAMPAIGN_ID);
  const ids = new Set();
  const titleVersions = new Map();
  const validated = items.map((item) => {
    const id = clean(item.id, 100);
    const language = clean(item.language, 8).toLowerCase();
    if (!id || ids.has(id) || !['en', 'pt', 'es'].includes(language)) throw Object.assign(new Error('Campaign contains an invalid or duplicate item'), { status: 400 });
    ids.add(id);
    const title = clean(item.title, 300);
    const sku = clean(item.sku, 100);
    const version = clean(item.version, 60).toLowerCase();
    const prompt = clean(item.prompt, 16000);
    const caption = clean(item.caption, 12000);
    if (!title || !sku || !VERSIONS.has(version) || prompt.length < 300 || !caption) throw Object.assign(new Error(`Campaign item ${id} is incomplete`), { status: 400 });
    const identity = `${title}\u0000${sku}\u0000${language}`;
    const versions = titleVersions.get(identity) || new Set();
    if (versions.has(version)) throw Object.assign(new Error(`Campaign contains a duplicate ${version} version for ${title}`), { status: 400 });
    versions.add(version);
    titleVersions.set(identity, versions);
    return {
      id, title, sku, version, language,
      country: language === 'pt' ? 'BR' : language === 'es' ? 'MX' : 'US',
      acLanguage: language === 'pt' ? 'Portuguese' : language === 'es' ? 'Spanish' : 'English',
      prompt, localizedPrompt: language === 'en' ? prompt : '', caption,
      cover: clean(item.cover, 4000), status: language === 'en' ? 'prepared' : 'localization_pending',
      remark: `nf_ad_${providers.sha(`${campaignId}:${id}:${sku}`).slice(0, 24)}`,
      threadId: '', videoUrl: '', error: '', attributionStatus: 'pending', draftStatus: 'pending',
      meta: { status: 'unbound', campaignId: '', adsetId: '', adId: '', creativeId: '', copywritingId: '', updatedAt: '' }
    };
  });
  if (strictLegacy && (titleVersions.size !== 6 || [...titleVersions.values()].some((versions) => versions.size !== 3))) {
    throw Object.assign(new Error('Campaign must contain three unique versions for each of six books'), { status: 400 });
  }
  const languageCounts = validated.reduce((counts, item) => ({ ...counts, [item.language]: Number(counts[item.language] || 0) + 1 }), {});
  if (strictLegacy && (languageCounts.en !== 6 || languageCounts.pt !== 6 || languageCounts.es !== 6)) {
    throw Object.assign(new Error('Campaign must contain six English, six Portuguese, and six Spanish videos'), { status: 400 });
  }
  return validated;
}

const ENGLISH_MARKERS = new Set([
  'the', 'and', 'with', 'from', 'into', 'then', 'while', 'where', 'when', 'she', 'her', 'hers',
  'his', 'him', 'they', 'their', 'this', 'that', 'these', 'those', 'your', 'you', 'voiceover',
  'subtitle', 'subtitles', 'overlay', 'screen', 'reads', 'says', 'whispers', 'shows', 'appears',
  'i', 'am', 'is', 'are', 'was', 'were', 'not', 'just', 'business', 'free', 'reject', 'bond',
  'will', 'kneel', 'everything', 'game', 'read', 'story', 'mate', 'family', 'mine', 'taking',
  'belongs', 'watch', 'now'
]);
const STRONG_ENGLISH_MARKERS = new Set([
  'the', 'and', 'with', 'from', 'into', 'then', 'while', 'where', 'when', 'she', 'her', 'hers',
  'his', 'him', 'they', 'their', 'this', 'that', 'these', 'those', 'your', 'you', 'business',
  'free', 'reject', 'bond', 'will', 'kneel', 'everything', 'game', 'read', 'story', 'mate',
  'family', 'mine', 'taking', 'belongs', 'watch', 'now'
]);

function englishResiduals(prompt) {
  const words = String(prompt || '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
  const markers = words.filter((word) => ENGLISH_MARKERS.has(word));
  const quoted = [...String(prompt || '').matchAll(/["“”']([^"“”']{4,240})["“”']/g)]
    .map((match) => match[1])
    .filter((value) => ((value.toLowerCase().match(/[a-z]+/g) || []).filter((word) => ENGLISH_MARKERS.has(word))).length >= 2);
  return { markerCount: markers.length, quoted };
}

function normalizedPhrase(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function unchangedSourcePhrases(sourcePrompt, localizedPrompt) {
  const localized = normalizedPhrase(localizedPrompt);
  const quoted = [...String(sourcePrompt || '').matchAll(/["“”']([^"“”']{3,240})["“”']/g)].map((match) => match[1]);
  const labelled = String(sourcePrompt || '').split(/\r?\n/)
    .filter((line) => /(?:dialogue|subtitle|overlay|on[- ]screen|title|cta|voiceover|narration|text)\s*[:：]/i.test(line))
    .map((line) => line.replace(/^.*?[:：]\s*/, ''));
  return [...new Set([...quoted, ...labelled].map(normalizedPhrase).filter((phrase) => {
    const words = phrase.split(' ');
    const markerCount = words.filter((word) => ENGLISH_MARKERS.has(word)).length;
    return words.length >= 2 && (markerCount >= 2 || words.some((word) => STRONG_ENGLISH_MARKERS.has(word)));
  }))]
    .filter((phrase) => localized.includes(phrase));
}

function assertLocalizedPrompt(prompt, language, sourcePrompt = '') {
  if (language === 'en') return;
  const audit = englishResiduals(prompt);
  const unchanged = unchangedSourcePhrases(sourcePrompt, prompt);
  if (audit.markerCount >= 6 || audit.quoted.length || unchanged.length) {
    throw Object.assign(new Error('Localized prompt still contains probable visible or audible English'), {
      status: 422,
      localizationAudit: {
        englishMarkerCount: audit.markerCount,
        englishQuoted: audit.quoted.slice(0, 6).map((value) => clean(value, 160)),
        unchangedSourcePhrases: unchanged.slice(0, 8).map((value) => clean(value, 160))
      }
    });
  }
}

async function localizeOne(redis, campaign, adapter = providers) {
  const item = campaign.items.find((value) => value.status === 'localization_pending');
  if (!item) return false;
  item.status = 'localizing'; item.error = ''; await save(redis, campaign);
  try {
    item.localizedPrompt = await adapter.localizeAdVideoPrompt(item.localizedPrompt || item.prompt, item.language);
    assertLocalizedPrompt(item.localizedPrompt, item.language, item.prompt);
    item.status = 'prepared'; item.localizedAt = now(); item.localizationAudit = null; await save(redis, campaign);
  } catch (error) {
    item.status = 'localization_failed'; item.error = clean(error.message, 500);
    item.localizationAudit = error.localizationAudit || null; await save(redis, campaign);
  }
  return true;
}

async function retryLocalizationFailures(redis, campaign) {
  let reset = 0;
  for (const item of campaign.items) {
    if (item.status !== 'localization_failed') continue;
    item.status = 'localization_pending';
    item.error = '';
    reset += 1;
  }
  if (reset) await save(redis, campaign);
  return reset;
}

async function auditLocalizationFailures(redis, campaign) {
  let audited = 0;
  for (const item of campaign.items) {
    if (item.status !== 'localization_failed' || !item.localizedPrompt) continue;
    try {
      assertLocalizedPrompt(item.localizedPrompt, item.language, item.prompt);
      item.localizationAudit = null;
      item.status = 'prepared';
      item.error = '';
      item.localizedAt = item.localizedAt || now();
    } catch (error) {
      item.localizationAudit = error.localizationAudit || null;
    }
    audited += 1;
  }
  if (audited) await save(redis, campaign);
  return audited;
}

function definitiveSubmissionError(error) {
  const status = Number(error?.status || 0);
  return status >= 400 && status < 500 && error?.ambiguous !== true;
}

async function submitOne(redis, campaign, adapter = providers) {
  const item = campaign.items.find((value) => value.status === 'prepared');
  if (!item) return false;
  const existing = await adapter.findAcTask(item.remark);
  if (existing) {
    item.threadId = threadId(existing);
    item.status = item.threadId ? 'running' : 'submit_ambiguous';
    item.error = item.threadId ? '' : 'AC reconciliation found a task without a thread ID';
    item.reconciledAt = now(); await save(redis, campaign); return true;
  }
  try {
    assertLocalizedPrompt(item.localizedPrompt, item.language, item.prompt);
  } catch (error) {
    item.status = 'localization_failed';
    item.error = clean(error.message, 500);
    await save(redis, campaign);
    return true;
  }
  const payload = {
    template: 'Ad_Plot_Seedance', relatedBook: { book_id: item.sku }, num: 1,
    language: item.acLanguage, country: item.country, ad_platform: 'Facebook',
    start_chapter: '1', end_chapter: '1', tts_audio_voice: 'Female_cur1', aspect_ratio: '9:16',
    is_generate_img: 'true', copy_type: '原创', build_requirement: item.localizedPrompt,
    ad_copy: item.localizedPrompt, word_count: '200词', enable_subtitles: false,
    // This legacy campaign cannot represent a named character asset, so it
    // must not silently use a book cover as a face/control reference.
    reference_picture_list: [], remark: item.remark
  };
  item.status = 'submitting'; item.submitAttemptedAt = now(); await save(redis, campaign);
  try {
    const response = await adapter.submitAc(payload);
    item.threadId = threadId(response);
    if (!item.threadId) throw Object.assign(new Error('AC accepted the request without a thread ID'), { ambiguous: true });
    item.status = 'running'; item.submittedAt = now(); await save(redis, campaign);
  } catch (error) {
    item.status = definitiveSubmissionError(error) ? 'submit_failed' : 'submit_ambiguous';
    item.error = clean(error.message, 500); await save(redis, campaign);
  }
  return true;
}

async function repairFailedOne(redis, campaign, adapter = providers) {
  const item = campaign.items.find((value) => value.status === 'failed' && !value.repairAttemptedAt);
  if (!item) return false;
  const previousThreadId = item.threadId;
  const previousRemark = item.remark;
  const failureReason = item.error || 'AC definitive failure';
  item.repairAttemptedAt = now();
  item.repairStatus = 'repairing';
  item.error = '';
  await save(redis, campaign);
  try {
    const repaired = await adapter.repairAdVideoPrompt(item.localizedPrompt || item.prompt, item.language, failureReason);
    assertLocalizedPrompt(repaired, item.language, item.prompt);
    item.priorThreadId = previousThreadId;
    item.priorRemark = previousRemark;
    item.revision = Number(item.revision || 0) + 1;
    item.remark = `nf_ad_${adapter.sha(`${campaign.id}:${item.id}:${item.sku}:revision:${item.revision}`).slice(0, 24)}`;
    item.localizedPrompt = repaired;
    item.threadId = '';
    item.videoUrl = '';
    item.coverImageUrl = '';
    item.status = 'prepared';
    item.repairStatus = 'prepared';
    item.repairedAt = now();
    item.error = '';
    await save(redis, campaign);
  } catch (error) {
    item.repairStatus = 'repair_failed';
    item.error = clean(error.message, 500);
    await save(redis, campaign);
  }
  return true;
}

async function pollOne(redis, campaign, adapter = providers) {
  const item = campaign.items
    .filter((value) => value.status === 'running' && value.threadId)
    .sort((left, right) => Date.parse(left.lastCheckedAt || 0) - Date.parse(right.lastCheckedAt || 0))[0];
  if (!item) return false;
  try {
    const result = await adapter.acResult(item.threadId);
    item.lastCheckedAt = now();
    if (result.status === 'completed') {
      await adapter.validateVideo(result.videoUrls[0]);
      item.status = 'completed'; item.videoUrl = result.videoUrls[0]; item.coverImageUrl = result.coverImageUrl || '';
    } else if (['failed', 'partial', 'completed_missing_media'].includes(result.status)) {
      item.status = 'failed'; item.error = clean(result.error || result.status, 500);
    }
    await save(redis, campaign);
  } catch (error) {
    item.error = clean(error.message, 500); item.lastCheckedAt = now(); await save(redis, campaign);
  }
  return true;
}

function attributionAppFor(item) {
  return item.language === 'en' ? APPS.novelflow : APPS.astranovel;
}

function attributionOptions(item) {
  const app = attributionAppFor(item);
  const link = app.facebookLink || {};
  return {
    applicationId: app.applicationId,
    brandName: app.name,
    channel: link.channelCode || 'FB',
    channelSource: link.channelSource,
    channelNameId: link.channelNameId,
    redirectConfigId: link.redirectConfigId,
    landingTemplateId: link.landingTemplateId,
    landingTemplateName: link.landingTemplateName,
    operatorName: link.operatorName,
    promoter: link.promoter || 'xujt',
    platform: 'facebook',
    languageCode: item.language
  };
}

async function allocateCode(redis, item) {
  const app = attributionAppFor(item);
  await redis.set(app.counterKey, String(app.counterStart || app.codeMin - 1), { nx: true });
  const value = Number(await redis.incr(app.counterKey));
  if (!Number.isSafeInteger(value) || value < app.codeMin || value > app.codeMax) {
    throw Object.assign(new Error(`${app.name} promotion Code pool is exhausted`), { status: 409 });
  }
  item.attributionApp = app.name;
  item.applicationId = app.applicationId;
  item.code = String(value);
  item.attributionStatus = 'code_allocated';
}

function ownsCode(record, item) {
  const bookIds = [record?.bookId, record?.bookSkuId].map(String);
  return bookIds.includes(String(item.sku))
    && (!record?.applicationId || String(record.applicationId) === String(item.applicationId))
    && String(record?.channel || 'FB').toUpperCase() === 'FB';
}

async function attributeOne(redis, campaign, adapter = providers, itemId = '') {
  const terminal = new Set(['ready', 'attribution_failed', 'attribution_ambiguous']);
  const requestedId = clean(itemId, 100);
  const item = requestedId
    ? campaign.items.find((value) => value.id === requestedId && !terminal.has(String(value.attributionStatus || 'pending')))
    : campaign.items.find((value) => !terminal.has(String(value.attributionStatus || 'pending')));
  if (requestedId && !campaign.items.some((value) => value.id === requestedId)) {
    throw Object.assign(new Error('Campaign item not found'), { status: 404 });
  }
  if (!item) return false;
  const options = attributionOptions(item);
  try {
    if (!item.code) {
      await allocateCode(redis, item);
      await save(redis, campaign);
    }
    let record = await adapter.keywordRecord(item.code, options);
    if (record && !ownsCode(record, item)) {
      item.code = '';
      item.keywordId = '';
      item.attributionStatus = 'pending';
      item.attributionError = 'Allocated Code was already owned by another book; advanced safely';
      await save(redis, campaign);
      return true;
    }
    if (!record) {
      if (item.attributionStatus === 'code_creating') {
        throw Object.assign(new Error('Promotion Code creation outcome is ambiguous; automatic retry is disabled'), { ambiguous: true });
      }
      item.attributionStatus = 'code_creating';
      item.attributionAttemptedAt = now();
      await save(redis, campaign);
      await adapter.createKeyword(item.sku, item.code, options);
      item.attributionStatus = 'code_created';
      await save(redis, campaign);
      record = await adapter.keywordRecord(item.code, options);
    }
    if (!record || !ownsCode(record, item) || !adapter.enabled(record.isEnable)) {
      throw new Error('Created promotion Code could not be verified remotely');
    }
    item.keywordId = String(record.id || '');
    item.attributionStatus = 'link_pending';
    await save(redis, campaign);

    let link = await adapter.findLink(item.sku, options.promoter, item.code, options);
    if (!link) {
      if (item.linkCreateAttemptedAt) {
        throw Object.assign(new Error('Attribution link creation outcome is ambiguous; automatic retry is disabled'), { ambiguous: true });
      }
      item.attributionStatus = 'link_creating';
      item.linkCreateAttemptedAt = now();
      await save(redis, campaign);
      const created = await adapter.createLink({ title: item.title, bookSkuId: item.sku }, options.promoter, item.code, options);
      item.linkId = String(created.id || '');
      item.attributionStatus = 'link_created';
      await save(redis, campaign);
      link = await adapter.findLink(item.sku, options.promoter, item.code, options);
    }
    if (!link?.shortUrl) throw Object.assign(new Error('Attribution link was not readable after creation'), { ambiguous: true });
    item.linkId = String(link.id || item.linkId || '');
    item.shortUrl = adapter.absoluteUrl(link.shortUrl);
    item.attributionStatus = 'ready';
    item.attributionError = '';
    item.attributedAt = now();
    await save(redis, campaign);
  } catch (error) {
    item.attributionStatus = error.ambiguous ? 'attribution_ambiguous' : 'attribution_failed';
    item.attributionError = clean(error.message, 500);
    await save(redis, campaign);
  }
  return true;
}

function draftRun(item) {
  if (/https?:\/\/|\bcode\b|\[insert short link\]/i.test(item.caption)) {
    throw Object.assign(new Error('Ad caption must not contain a link or Code'), { status: 422 });
  }
  return {
    id: `ad_${providers.sha(`${item.campaignId || CAMPAIGN_ID}:${item.id}`).slice(0, 32)}`,
    input: {
      title: item.title,
      sku: item.sku,
      delivery: { accountId: 13943486, accountTitle: 'Romance Story House', platform: 'facebook', publishType: 'reels' }
    },
    artifacts: {
      book: { title: item.title, bookSkuId: item.sku, cover: item.cover || '' },
      code: item.code || '', shortUrl: item.shortUrl || '', linkId: item.linkId || '',
      posts: [{ type: item.version, content: item.caption, zhContent: '' }],
      video: { status: 'completed', videoUrls: [item.videoUrl], coverImageUrl: item.coverImageUrl || '' }
    }
  };
}

async function draftOne(redis, campaign, submit = submitDraft) {
  const item = campaign.items.find((value) => value.status === 'completed'
    && !['external_draft', 'publish_ambiguous', 'draft_failed'].includes(String(value.draftStatus || 'pending')));
  if (!item) return false;
  try {
    let draft = await ensureDraftForRun(redis, draftRun(item));
    if (!draft) throw new Error('Unable to create the internal SocialEcho draft');
    item.internalDraftId = draft.id;
    item.draftStatus = draft.status;
    await save(redis, campaign);
    if (draft.status === 'external_draft') {
      item.externalDraftId = draft.provider?.externalDraftId || '';
      await save(redis, campaign);
      return true;
    }
    if (draft.status === 'publish_ambiguous') {
      item.draftStatus = 'publish_ambiguous';
      item.draftError = draft.error || '';
      await save(redis, campaign);
      return true;
    }
    draft = await submit(redis, draft);
    item.draftStatus = draft.status;
    item.externalDraftId = draft.provider?.externalDraftId || '';
    item.draftError = draft.error || '';
    await save(redis, campaign);
  } catch (error) {
    const durable = item.internalDraftId ? await getDraft(redis, item.internalDraftId).catch(() => null) : null;
    item.draftStatus = durable?.status === 'publish_ambiguous' ? 'publish_ambiguous' : 'draft_failed';
    item.externalDraftId = durable?.provider?.externalDraftId || '';
    item.draftError = clean(durable?.error || error.message, 500);
    await save(redis, campaign);
  }
  return true;
}

function nextAdvanceAction(campaign) {
  const items = campaign.items || [];
  if (items.some((item) => item.status === 'localization_pending')) return 'localize';
  if (items.some((item) => item.status === 'failed' && !item.repairAttemptedAt)) return 'repair_failed';
  if (items.some((item) => item.status === 'prepared')) return 'submit';
  if (items.some((item) => item.status === 'running' && item.threadId)) return 'poll';
  if (items.some((item) => item.status === 'completed' && !['ready', 'attribution_failed', 'attribution_ambiguous'].includes(String(item.attributionStatus || 'pending')))) return 'attribute';
  if (items.some((item) => item.status === 'completed' && !['external_draft', 'publish_ambiguous', 'draft_failed'].includes(String(item.draftStatus || 'pending')))) return 'draft';
  return '';
}

async function advanceCampaign(redis, campaign, limit = 6) {
  const maxSteps = Math.max(1, Math.min(Number(limit) || 6, 12));
  const progress = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const action = nextAdvanceAction(campaign);
    if (!action) break;
    const worked = action === 'localize' ? await localizeOne(redis, campaign)
      : action === 'repair_failed' ? await repairFailedOne(redis, campaign)
      : action === 'submit' ? await submitOne(redis, campaign)
      : action === 'poll' ? await pollOne(redis, campaign)
      : action === 'attribute' ? await attributeOne(redis, campaign)
      : await draftOne(redis, campaign);
    progress.push({ action, worked });
    if (!worked) break;
  }
  return { progress, nextAction: nextAdvanceAction(campaign) };
}

function campaignSummary(campaign) {
  const publicValue = publicCampaign(campaign);
  const titles = new Set(publicValue.items.map((item) => item.title));
  return {
    id: publicValue.id, createdAt: publicValue.createdAt, updatedAt: publicValue.updatedAt,
    itemCount: publicValue.items.length, bookCount: titles.size, counts: publicValue.counts,
    drafts: publicValue.items.filter((item) => item.draft.status === 'external_draft').length,
    metaBound: publicValue.items.filter((item) => item.meta.status === 'bound').length
  };
}

async function listCampaigns(redis, limit = 20) {
  let ids = await redis.zrange(CAMPAIGN_INDEX, 0, Math.max(0, Math.min(Number(limit) || 20, 50) - 1), { rev: true });
  if (!ids.includes(CAMPAIGN_ID) && await load(redis, CAMPAIGN_ID)) ids = [CAMPAIGN_ID, ...ids];
  const campaigns = await Promise.all(ids.map((id) => load(redis, id)));
  return campaigns.filter(Boolean).map(campaignSummary);
}

async function bindMetaMapping(redis, campaign, input = {}) {
  const itemId = clean(input.itemId, 100);
  const item = campaign.items.find((value) => value.id === itemId);
  if (!item) throw Object.assign(new Error('Campaign item not found'), { status: 404 });
  const field = (name) => clean(input[name], 120);
  item.meta = {
    status: field('adId') || field('copywritingId') ? 'bound' : 'partial',
    campaignId: field('metaCampaignId'), adsetId: field('adsetId'), adId: field('adId'),
    creativeId: field('creativeId'), copywritingId: field('copywritingId'), updatedAt: now()
  };
  await save(redis, campaign);
  return item;
}

module.exports = async (req, res) => {
  if (!requireSession(req, res)) return;
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'Storage not configured' });
  try {
    const requestedCampaignId = normalizedCampaignId(req.query?.campaignId || req.body?.campaignId || CAMPAIGN_ID);
    if (req.method === 'GET' && String(req.query?.action || '') === 'list') return res.status(200).json({ campaigns: await listCampaigns(redis, req.query?.limit) });
    if (req.method === 'GET') return res.status(200).json({ campaign: publicCampaign(await load(redis, requestedCampaignId)) });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireCampaignMutation(req, res)) return;
    const action = clean(req.body?.action, 40);
    const limit = await consumeRateLimit(redis, `ad-campaign-${action || 'unknown'}`, requestIdentity(req), action === 'submit' ? 30 : 120, 60);
    if (!limit.allowed) return res.status(429).json({ error: 'Campaign action rate limit reached', retryAfter: limit.retryAfter });
    if (action === 'initialize') {
      const existing = await load(redis, requestedCampaignId);
      if (existing) return res.status(200).json({ campaign: publicCampaign(existing), unchanged: true });
      const strictLegacy = requestedCampaignId === CAMPAIGN_ID;
      const items = validateItems(req.body?.items, { strictLegacy, campaignId: requestedCampaignId });
      items.forEach((item) => { item.campaignId = requestedCampaignId; });
      const campaign = { id: requestedCampaignId, createdAt: now(), updatedAt: now(), accountId: 13943486, items };
      await save(redis, campaign);
      await indexCampaign(redis, campaign);
      return res.status(201).json({ campaign: publicCampaign(campaign) });
    }
    const campaign = await load(redis, requestedCampaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not initialized' });
    if (action === 'retry_localization') {
      const reset = await retryLocalizationFailures(redis, campaign);
      return res.status(200).json({ reset, campaign: publicCampaign(campaign) });
    }
    if (action === 'audit_localization') {
      const audited = await auditLocalizationFailures(redis, campaign);
      return res.status(200).json({ audited, campaign: publicCampaign(campaign) });
    }
    if (action === 'advance') {
      const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const lockKey = campaignLockKey(campaign.id);
      const acquired = await redis.set(lockKey, token, { nx: true, ex: 240 });
      if (!acquired) return res.status(409).json({ error: 'Campaign advance is already running; poll the saved campaign state' });
      try {
        const result = await advanceCampaign(redis, campaign, req.body?.limit);
        return res.status(200).json({ ...result, campaign: publicCampaign(campaign) });
      } finally {
        const current = await redis.get(lockKey).catch(() => '');
        if (String(current) === token) await redis.del(lockKey).catch(() => {});
      }
    }
    if (action === 'bind_meta') {
      const item = await bindMetaMapping(redis, campaign, req.body || {});
      return res.status(200).json({ item: publicCampaign({ ...campaign, items: [item] }).items[0], campaign: publicCampaign(campaign) });
    }
    if (action === 'save_ad_creative') {
      const itemId = clean(req.body?.itemId, 100);
      const item = campaign.items.find((value) => value.id === itemId);
      if (!item) return res.status(404).json({ error: 'Campaign item not found' });
      if (item.status !== 'completed' || !item.videoUrl) return res.status(409).json({ error: 'A completed video is required before saving ad creative' });
      const adBody = clean(req.body?.body, 12000);
      const headline = clean(req.body?.headline, 255);
      const description = clean(req.body?.description, 5000);
      const cta = clean(req.body?.cta, 80);
      const link = clean(req.body?.link || item.shortUrl, 4000);
      if (!adBody || !headline || !description || !cta || !/^https:\/\//i.test(link)) return res.status(400).json({ error: 'Ad body, headline, description, CTA and HTTPS link are required' });
      item.adCreative = { body: adBody, headline, description, cta, link, language: item.language, application: item.attributionApp || 'AstraNovel', savedAt: now() };
      await save(redis, campaign);
      return res.status(200).json({ item: publicCampaign({ ...campaign, items: [item] }).items[0], campaign: publicCampaign(campaign) });
    }
    const worked = action === 'localize' ? await localizeOne(redis, campaign)
      : action === 'submit' ? await submitOne(redis, campaign)
      : action === 'poll' ? await pollOne(redis, campaign)
      : action === 'repair_failed' ? await repairFailedOne(redis, campaign)
      : action === 'attribute' ? await attributeOne(redis, campaign, providers, req.body?.itemId)
      : action === 'draft' ? await draftOne(redis, campaign) : false;
    if (!['localize', 'submit', 'poll', 'repair_failed', 'attribute', 'draft'].includes(action)) return res.status(400).json({ error: 'Unsupported action' });
    return res.status(200).json({ worked, campaign: publicCampaign(campaign) });
  } catch (error) {
    return res.status(Number(error.status || 500)).json({ error: clean(error.message, 500) });
  }
};

module.exports.CAMPAIGN_ID = CAMPAIGN_ID;
module.exports.normalizedCampaignId = normalizedCampaignId;
module.exports.requireCampaignMutation = requireCampaignMutation;
module.exports.validateItems = validateItems;
module.exports.publicCampaign = publicCampaign;
module.exports.englishResiduals = englishResiduals;
module.exports.unchangedSourcePhrases = unchangedSourcePhrases;
module.exports.assertLocalizedPrompt = assertLocalizedPrompt;
module.exports.localizeOne = localizeOne;
module.exports.retryLocalizationFailures = retryLocalizationFailures;
module.exports.auditLocalizationFailures = auditLocalizationFailures;
module.exports.submitOne = submitOne;
module.exports.repairFailedOne = repairFailedOne;
module.exports.pollOne = pollOne;
module.exports.attributionAppFor = attributionAppFor;
module.exports.attributionOptions = attributionOptions;
module.exports.attributeOne = attributeOne;
module.exports.draftRun = draftRun;
module.exports.draftOne = draftOne;
module.exports.nextAdvanceAction = nextAdvanceAction;
module.exports.advanceCampaign = advanceCampaign;
module.exports.campaignSummary = campaignSummary;
module.exports.bindMetaMapping = bindMetaMapping;
