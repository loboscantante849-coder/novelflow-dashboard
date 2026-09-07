const crypto = require('crypto');

const DEFAULT_DAILY_ACCOUNT_IDS = Object.freeze([
  13751295, 13943450, 13943940,
  13943483, 13944009,
  13943482, 13943764,
  13943484, 13943914, 13943918,
  13943485, 18185914
]);

const CREATIVE_FORMS = Object.freeze([
  { id: 'witnessed_confrontation', secondary: 'private_consequence', hookDevice: 'dialogue_cut', openingGrammar: 'dialogue_verdict', videoGrammar: 'wide_action_crowd_reaction', ctaMode: 'cost_of_choice', voiceStyle: 'confrontation', copyStyle: 'system_best', ctaStyle: 'story_cliffhanger', videoStyle: 'reversal', posterStyle: 'luminous_cinema' },
  { id: 'evidence_discovery', secondary: 'accusation_aftershock', hookDevice: 'object_closeup', openingGrammar: 'conflict_object_action', videoGrammar: 'discovery_consequence_reaction', ctaMode: 'unresolved_question', voiceStyle: 'mystery', copyStyle: 'dark_redemption', ctaStyle: 'identity_reveal', videoStyle: 'five_beat', posterStyle: 'editorial_romance' },
  { id: 'pursuit_in_motion', secondary: 'blocked_escape', hookDevice: 'motion_open', openingGrammar: 'movement_interruption', videoGrammar: 'movement_block_countermove', ctaMode: 'next_move', voiceStyle: 'punchy', copyStyle: 'dark_redemption', ctaStyle: 'story_cliffhanger', videoStyle: 'five_beat', posterStyle: 'luminous_cinema' },
  { id: 'public_power_reversal', secondary: 'status_aftershock', hookDevice: 'reaction_cut', openingGrammar: 'public_reaction', videoGrammar: 'wide_action_crowd_reaction', ctaMode: 'power_reversal', voiceStyle: 'cinematic', copyStyle: 'revenge_comeback', ctaStyle: 'revenge_payoff', videoStyle: 'revenge', posterStyle: 'editorial_romance' },
  { id: 'protective_interruption', secondary: 'boundary_choice', hookDevice: 'blocked_action', openingGrammar: 'movement_interruption', videoGrammar: 'arrival_intercept_power_shift', ctaMode: 'relationship_boundary', voiceStyle: 'yearning', copyStyle: 'forbidden_tension', ctaStyle: 'romantic_tension', videoStyle: 'slow_burn', posterStyle: 'luminous_cinema' },
  { id: 'ceremony_rupture', secondary: 'symbolic_departure', hookDevice: 'public_symbol', openingGrammar: 'conflict_object_action', videoGrammar: 'object_action_reaction_reversal', ctaMode: 'identity_reveal', voiceStyle: 'confrontation', copyStyle: 'revenge_comeback', ctaStyle: 'identity_reveal', videoStyle: 'reversal', posterStyle: 'editorial_romance' },
  { id: 'deadline_choice', secondary: 'cost_reveal', hookDevice: 'countdown_object', openingGrammar: 'choice_countdown', videoGrammar: 'two_shot_choice_distance_shift', ctaMode: 'cost_of_choice', voiceStyle: 'punchy', copyStyle: 'system_best', ctaStyle: 'story_cliffhanger', videoStyle: 'five_beat', posterStyle: 'luminous_cinema' },
  { id: 'authority_arrival', secondary: 'room_reaction', hookDevice: 'entrance_reaction', openingGrammar: 'arrival_disruption', videoGrammar: 'arrival_intercept_power_shift', ctaMode: 'power_reversal', voiceStyle: 'cinematic', copyStyle: 'dark_redemption', ctaStyle: 'identity_reveal', videoStyle: 'reversal', posterStyle: 'editorial_romance' },
  { id: 'secret_overheard', secondary: 'silent_decision', hookDevice: 'reaction_then_source', openingGrammar: 'public_reaction', videoGrammar: 'discovery_consequence_reaction', ctaMode: 'unresolved_question', voiceStyle: 'mystery', copyStyle: 'forbidden_tension', ctaStyle: 'story_cliffhanger', videoStyle: 'slow_burn', posterStyle: 'luminous_cinema' },
  { id: 'contract_or_letter_break', secondary: 'doorway_consequence', hookDevice: 'document_action', openingGrammar: 'conflict_object_action', videoGrammar: 'object_action_reaction_reversal', ctaMode: 'next_move', voiceStyle: 'confessional', copyStyle: 'revenge_comeback', ctaStyle: 'revenge_payoff', videoStyle: 'revenge', posterStyle: 'editorial_romance' },
  { id: 'identity_recognition', secondary: 'choice_after_reveal', hookDevice: 'visual_recognition', openingGrammar: 'arrival_disruption', videoGrammar: 'two_shot_choice_distance_shift', ctaMode: 'identity_reveal', voiceStyle: 'reflective', copyStyle: 'system_best', ctaStyle: 'identity_reveal', videoStyle: 'reversal', posterStyle: 'luminous_cinema' },
  { id: 'departure_challenge', secondary: 'pursuer_reaction', hookDevice: 'doorway_motion', openingGrammar: 'movement_interruption', videoGrammar: 'movement_block_countermove', ctaMode: 'relationship_boundary', voiceStyle: 'punchy', copyStyle: 'dark_redemption', ctaStyle: 'story_cliffhanger', videoStyle: 'five_beat', posterStyle: 'editorial_romance' }
]);

// Slot-major campaign iteration would otherwise give account N the same form
// at indexes N, N+12 and N+24. This reviewed matrix gives every account three
// distinct creative grammars while using every form exactly three times.
const ACCOUNT_FORM_MATRIX = Object.freeze([
  [0, 1, 2], [1, 2, 3], [2, 3, 5], [3, 4, 5],
  [4, 5, 6], [6, 7, 8], [6, 7, 8], [7, 8, 9],
  [9, 10, 11], [9, 10, 11], [0, 10, 11], [0, 1, 4]
].map((row) => Object.freeze(row)));

const MIN_CAMPAIGN_READERS = 20;
// This is deliberately narrow: it blocks titles that are plainly unsafe for
// unattended brand channels without treating ordinary dark romance,
// werewolf, pregnancy, rejection, or revenge themes as unsafe.
const UNSAFE_TITLE_PATTERN = /\b(?:cunt|incest|underage|barely\s+legal|child\s+bride|high\s+school\s+(?:girl|boy)|schoolgirl|schoolboy|erotic(?:a)?|lust|taboo|nude|sex(?:ual)?\s+slave|porn(?:star|ographic)?|gangbang|rape(?:d|ist)?|step\s*daddy|step(?:brother|sister|father|mother)s?|breast\s*milk|needed\s+my\s+milk|lactat(?:e|ing|ion)|wet\s+nurse)\b/i;

function titleKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function bookIdentity(book = {}) {
  const sku = String(book?.bookSkuId || book?.sku || '').trim().toLowerCase();
  return sku ? `sku:${sku}` : `title:${titleKey(book?.title)}`;
}

function brandSafeTitle(book = {}) {
  return Boolean(titleKey(book?.title)) && !UNSAFE_TITLE_PATTERN.test(String(book?.title || ''));
}

function rate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number > 1 ? number / 100 : number, 1);
}

function normalizedPositive(value, maximum) {
  const number = Math.max(0, Number(value) || 0);
  return maximum > 0 ? Math.min(number / maximum, 1) : 0;
}

function longReadRate(book = {}) {
  // A reported 20w rate of exactly zero is real data, not a missing value.
  // Only fall back to the older 10w metric when the 20w field is absent.
  return Object.prototype.hasOwnProperty.call(book, 'read20wRate')
    ? rate(book.read20wRate)
    : rate(book.read10wRate);
}

function scoreCandidates(books = []) {
  const valid = books.filter((book) => Number(book?.baseReadUnt || 0) > 0);
  const maxReaders = Math.max(1, ...valid.map((book) => Number(book.baseReadUnt || 0)));
  const maxProfit = Math.max(1, ...valid.map((book) => Math.max(0, Number(book.ttProfit || 0))));
  return valid.map((book) => {
    const readers = Number(book.baseReadUnt || 0);
    const scale = Math.log1p(readers) / Math.log1p(maxReaders);
    const firstRead = Math.min(rate(book.firstReadUntRate) / 0.6, 1);
    const continuation = Math.min(rate(book.gt2FirstReadUntRate) / 0.8, 1);
    const longRead = Math.min(longReadRate(book) / 0.25, 1);
    const profit = normalizedPositive(book.ttProfit, maxProfit);
    const detailRate = Number(book.exposureUV || 0) > 0
      ? Math.min((Number(book.bookDetailUV || 0) / Number(book.exposureUV)) / 0.08, 1)
      : 0;
    // Reader scale is the primary cross-platform selection signal. Keep half
    // the score for downstream quality, but let a statistically meaningful
    // app-leading book remain selectable when a live report omits one of the
    // conversion columns instead of making 45 mathematically unreachable.
    const raw = scale * 0.50 + firstRead * 0.20 + continuation * 0.10 + longRead * 0.12 + profit * 0.04 + detailRate * 0.04;
    const confidence = 0.76 + scale * 0.24;
    return {
      ...book,
      campaignScore: Math.round(raw * confidence * 1000) / 10,
      campaignSignals: {
        readers,
        firstReadRate: Math.round(rate(book.firstReadUntRate) * 10000) / 100,
        longReadRate: Math.round(longReadRate(book) * 10000) / 100,
        continuationRate: Math.round(rate(book.gt2FirstReadUntRate) * 10000) / 100
      }
    };
  }).sort((left, right) => Number(right.campaignScore || 0) - Number(left.campaignScore || 0)
    || Number(left.rank || 1e9) - Number(right.rank || 1e9));
}

function recentUsage(recentRuns = [], avoidDays = 14, now = Date.now()) {
  const cutoff = now - Math.max(1, Math.min(Number(avoidDays) || 14, 90)) * 24 * 60 * 60 * 1000;
  const global = new Map();
  const byAccount = new Map();
  const activeByAccount = new Map();
  for (const run of recentRuns) {
    const key = titleKey(run?.input?.title || run?.artifacts?.book?.title);
    if (!key) continue;
    const accountId = Number(run?.input?.delivery?.accountId || 0);
    if (accountId && ['queued', 'running', 'blocked', 'reserved'].includes(String(run?.state || ''))) {
      if (!activeByAccount.has(accountId)) activeByAccount.set(accountId, new Set());
      activeByAccount.get(accountId).add(key);
    }
    const created = Date.parse(run?.createdAt || run?.updatedAt || '');
    if (!Number.isFinite(created) || created < cutoff) continue;
    global.set(key, Number(global.get(key) || 0) + 1);
    if (!accountId) continue;
    if (!byAccount.has(accountId)) byAccount.set(accountId, new Set());
    byAccount.get(accountId).add(key);
  }
  return { global, byAccount, activeByAccount };
}

function eligibleBook(book) {
  return Boolean(book && book.p0Receipt && book.ownershipVerified === true
    && book.automationReady !== false && String(book.source || '') === 'content_dashboard'
    && Number(book.baseReadUnt || 0) > 0);
}

function selectionTiers(topScore) {
  return [
    { id: 'unique_high', uniqueGlobal: true, uniqueApp: true, avoidRecent: true, maxRank: 60, minScore: Math.max(45, topScore - 24) },
    { id: 'unique_expanded', uniqueGlobal: true, uniqueApp: true, avoidRecent: true, maxRank: 110, minScore: Math.max(45, topScore - 38) },
    { id: 'unique_current', uniqueGlobal: true, uniqueApp: true, avoidRecent: false, maxRank: 160, minScore: Math.max(45, topScore - 50) },
    // Repetition is an explicit quality-preserving degradation. Prefer a new
    // title first; a later scene-lock fallback may repeat one strong title
    // inside a short account pool instead of admitting a weak book.
    { id: 'quality_repeat', uniqueGlobal: false, uniqueApp: false, avoidRecent: true, maxRank: 100, minScore: Math.max(45, topScore - 34) },
    // The final tier still has a real quality floor. A weak title is never
    // admitted merely to make an all-unique dashboard counter look better.
    { id: 'quality_backfill', uniqueGlobal: false, uniqueApp: false, avoidRecent: false, maxRank: 200, minScore: Math.max(45, topScore - 45) }
  ];
}

function hasCoreQualitySignal(book = {}) {
  const signals = book.campaignSignals || {};
  if (Number(signals.readers || book.baseReadUnt || 0) < MIN_CAMPAIGN_READERS) return false;
  return Number(signals.readers || 0) >= 1000
    || Number(signals.firstReadRate || 0) >= 20
    || Number(signals.longReadRate || 0) >= 5;
}

function creativeProfileForAssignment(route, accountIndex, slot, campaignIndex) {
  const row = ACCOUNT_FORM_MATRIX[accountIndex % ACCOUNT_FORM_MATRIX.length];
  const formIndex = row[slot % row.length];
  const form = CREATIVE_FORMS[formIndex];
  return {
    modelChoice: 'glm-5.3-flash',
    outputLanguage: 'en',
    forceEnglish: true,
    emojiRange: '3-5',
    qualityMode: 'premium',
    copyStyle: form.copyStyle,
    ctaStyle: form.ctaStyle,
    videoStyle: form.videoStyle,
    posterStyle: form.posterStyle,
    voiceStyle: form.voiceStyle,
    creativeForm: form.id,
    secondaryForm: form.secondary,
    hookDevice: form.hookDevice,
    openingGrammar: form.openingGrammar,
    videoGrammar: form.videoGrammar,
    ctaMode: form.ctaMode,
    uniquenessRequired: true,
    draftPostIndex: (accountIndex + slot) % 2,
    sceneVariant: `${route.appKey}_${route.platform}_${accountIndex + 1}_${slot + 1}_${form.id}`.slice(0, 120)
  };
}

function selectCampaignBooks({ routes = [], booksByAccount = new Map(), recentRuns = [], itemsPerAccount = 3, avoidDays = 14 }) {
  const count = Math.max(1, Math.min(Number(itemsPerAccount) || 3, 5));
  const usage = recentUsage(recentRuns, avoidDays);
  let sampleRejected = 0;
  let unsafeTitleRejected = 0;
  const scoredByAccount = new Map(routes.map((route) => {
    const verified = (booksByAccount.get(Number(route.accountId)) || []).filter(eligibleBook);
    sampleRejected += verified.filter((book) => Number(book.baseReadUnt || 0) < MIN_CAMPAIGN_READERS).length;
    unsafeTitleRejected += verified.filter((book) => !brandSafeTitle(book)).length;
    const books = verified.filter((book) => Number(book.baseReadUnt || 0) >= MIN_CAMPAIGN_READERS && brandSafeTitle(book));
    return [Number(route.accountId), scoreCandidates(books)];
  }));
  const qualityTitlesByApp = new Map();
  for (const route of routes) {
    if (!qualityTitlesByApp.has(route.appKey)) qualityTitlesByApp.set(route.appKey, new Set());
    for (const book of scoredByAccount.get(Number(route.accountId)) || []) {
      if (hasCoreQualitySignal(book) && Number(book.campaignScore || 0) >= 45) {
        qualityTitlesByApp.get(route.appKey).add(titleKey(book.title));
      }
    }
  }
  const appReuseLimits = new Map();
  for (const route of routes) {
    const appSlots = routes.filter((candidate) => candidate.appKey === route.appKey).length * count;
    const qualityTitles = Math.max(1, qualityTitlesByApp.get(route.appKey)?.size || 0);
    // Full pools retain the historical max-two campaign reuse. A genuinely
    // short live pool receives only the minimum extra reuse needed to fill
    // its own accounts, keeping the 45-point quality floor intact.
    appReuseLimits.set(route.appKey, Math.max(2, Math.ceil(appSlots / qualityTitles)));
  }
  const globalUsed = new Set();
  const globalUseCounts = new Map();
  const appTitleUseCounts = new Map();
  const appUsed = new Map();
  const accountUsed = new Map();
  const accountTitleUsed = new Map();
  const accountUseCounts = new Map();
  const assignments = [];
  routes.forEach((route) => {
    appUsed.set(route.appKey, appUsed.get(route.appKey) || new Set());
    appTitleUseCounts.set(route.appKey, appTitleUseCounts.get(route.appKey) || new Map());
    accountUsed.set(Number(route.accountId), new Set());
    accountTitleUsed.set(Number(route.accountId), new Set());
    accountUseCounts.set(Number(route.accountId), new Map());
  });
  let campaignIndex = 0;
  for (let slot = 0; slot < count; slot += 1) {
    for (let accountIndex = 0; accountIndex < routes.length; accountIndex += 1) {
      const route = routes[accountIndex];
      const candidates = scoredByAccount.get(Number(route.accountId)) || [];
      if (!candidates.length) throw new Error(`${route.appName} ${route.platform} has no verified real-time candidates`);
      const topScore = Number(candidates[0]?.campaignScore || 0);
      const recentForAccount = usage.byAccount.get(Number(route.accountId)) || new Set();
      const activeForAccount = usage.activeByAccount.get(Number(route.accountId)) || new Set();
      const appReuseLimit = Number(appReuseLimits.get(route.appKey) || 2);
      let selected = null;
      let selectedTier = '';
      for (const tier of selectionTiers(topScore)) {
        const eligible = candidates.filter((book) => {
          const key = titleKey(book.title);
          const identity = bookIdentity(book);
          if (!key || !identity || accountUsed.get(Number(route.accountId)).has(identity)
            || accountTitleUsed.get(Number(route.accountId)).has(key) || activeForAccount.has(key)) return false;
          if (!hasCoreQualitySignal(book)) return false;
          if (tier.uniqueApp && appUsed.get(route.appKey).has(key)) return false;
          if (tier.uniqueGlobal && globalUsed.has(key)) return false;
          if (!tier.uniqueGlobal && Number(appTitleUseCounts.get(route.appKey).get(key) || 0) >= appReuseLimit) return false;
          if (tier.avoidRecent && recentForAccount.has(key)) return false;
          return Number(book.rank || 1e9) <= tier.maxRank && Number(book.campaignScore || 0) >= tier.minScore;
        }).sort((left, right) => {
          const leftRecent = Number(usage.global.get(titleKey(left.title)) || 0);
          const rightRecent = Number(usage.global.get(titleKey(right.title)) || 0);
          const leftValue = Number(left.campaignScore || 0) - leftRecent * 9 - Number(left.rank || 0) * 0.03;
          const rightValue = Number(right.campaignScore || 0) - rightRecent * 9 - Number(right.rank || 0) * 0.03;
          return rightValue - leftValue;
        });
        if (eligible.length) {
          selected = eligible[0];
          selectedTier = tier.id;
          break;
        }
      }
      // Some young storefronts have only one or two books with defensible
      // live signals. Preserve book quality by reusing the strongest title
      // through hard-locked chapter lanes. Exact preflight later proves the
      // book has at least three chapters per requested lane before signing.
      if (!selected && accountUsed.get(Number(route.accountId)).size >= 1) {
        const repeatable = candidates.filter((book) => {
          const key = titleKey(book.title);
          const identity = bookIdentity(book);
          const used = Number(accountUseCounts.get(Number(route.accountId)).get(identity) || 0);
          return key
            && used >= 1
            && used < count
            && !activeForAccount.has(key)
            && Number(appTitleUseCounts.get(route.appKey).get(key) || 0) < appReuseLimit
            && hasCoreQualitySignal(book)
            && Number(book.rank || 1e9) <= 80
            && Number(book.campaignScore || 0) >= Math.max(45, topScore - 20);
        }).sort((left, right) => Number(right.campaignScore || 0) - Number(left.campaignScore || 0));
        if (repeatable.length) {
          selected = repeatable[0];
          selectedTier = 'quality_scene_repeat';
        }
      }
      if (!selected) throw new Error(`${route.appName} ${route.platform} cannot fill ${count} quality selections, even with source-locked scene repeats`);
      const key = titleKey(selected.title);
      const identity = bookIdentity(selected);
      globalUsed.add(key);
      globalUseCounts.set(key, Number(globalUseCounts.get(key) || 0) + 1);
      appTitleUseCounts.get(route.appKey).set(key, Number(appTitleUseCounts.get(route.appKey).get(key) || 0) + 1);
      appUsed.get(route.appKey).add(key);
      accountUsed.get(Number(route.accountId)).add(identity);
      accountTitleUsed.get(Number(route.accountId)).add(key);
      accountUseCounts.get(Number(route.accountId)).set(identity, Number(accountUseCounts.get(Number(route.accountId)).get(identity) || 0) + 1);
      assignments.push({
        index: campaignIndex,
        slot: slot + 1,
        accountIndex,
        accountId: Number(route.accountId),
        accountTitle: route.accountTitle,
        appKey: route.appKey,
        appName: route.appName,
        applicationId: route.applicationId,
        platform: route.platform,
        publishType: route.publishType,
        title: selected.title,
        sku: selected.bookSkuId,
        p0Receipt: selected.p0Receipt,
        sourceRank: Number(selected.rank || 0),
        qualityScore: Number(selected.campaignScore || 0),
        signals: selected.campaignSignals,
        rankingWindowDays: Number(selected.campaignRanking?.windowDays || 0),
        rankingBucket: String(selected.campaignRanking?.bucket || ''),
        completionStatus: String(selected.campaignRanking?.completionStatus || ''),
        selectionTier: selectedTier,
        creativeProfile: creativeProfileForAssignment(route, accountIndex, slot, campaignIndex)
      });
      campaignIndex += 1;
    }
  }
  // Assign non-overlapping evidence lanes only to titles that actually repeat
  // within one account. Unique books retain the normal full-story sampler.
  const repeatedGroups = new Map();
  for (const assignment of assignments) {
    const key = `${assignment.accountId}:${bookIdentity({ bookSkuId: assignment.sku, title: assignment.title })}`;
    if (!repeatedGroups.has(key)) repeatedGroups.set(key, []);
    repeatedGroups.get(key).push(assignment);
  }
  for (const group of repeatedGroups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) => left.slot - right.slot).forEach((assignment, index) => {
      assignment.creativeProfile.sceneLane = group.length === 2 ? (index === 0 ? 0 : 2) : index;
      assignment.creativeProfile.sceneRepeatIndex = index + 1;
      assignment.creativeProfile.sceneRepeatCount = group.length;
    });
  }
  return {
    assignments,
    summary: {
      requested: routes.length * count,
      selected: assignments.length,
      uniqueTitles: new Set(assignments.map((item) => titleKey(item.title))).size,
      highQualityUnique: assignments.filter((item) => item.selectionTier === 'unique_high').length,
      expandedUnique: assignments.filter((item) => ['unique_expanded', 'unique_current'].includes(item.selectionTier)).length,
      repeatedForQuality: assignments.filter((item) => item.selectionTier === 'quality_repeat').length,
      sceneRepeatedForQuality: assignments.filter((item) => item.selectionTier === 'quality_scene_repeat').length,
      backfilled: assignments.filter((item) => item.selectionTier === 'quality_backfill').length,
      minimumReaderSample: MIN_CAMPAIGN_READERS,
      sampleRejected,
      unsafeTitleRejected,
      maxGlobalTitleReuse: Math.max(0, ...globalUseCounts.values())
    }
  };
}

function campaignId(day, settings) {
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 10);
  return `campaign_${String(day || '').replace(/[^0-9]/g, '')}_${fingerprint}`;
}

module.exports = {
  DEFAULT_DAILY_ACCOUNT_IDS,
  CREATIVE_FORMS,
  ACCOUNT_FORM_MATRIX,
  titleKey,
  bookIdentity,
  brandSafeTitle,
  MIN_CAMPAIGN_READERS,
  longReadRate,
  scoreCandidates,
  recentUsage,
  creativeProfileForAssignment,
  hasCoreQualitySignal,
  selectCampaignBooks,
  campaignId
};
