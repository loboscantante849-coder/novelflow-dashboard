const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SOCIAL_CONSOLE_SESSION_SECRET = process.env.SOCIAL_CONSOLE_SESSION_SECRET || 'daily-campaign-test-secret-with-32-characters';

const {
  DEFAULT_DAILY_ACCOUNT_IDS,
  CREATIVE_FORMS,
  titleKey,
  scoreCandidates,
  hasCoreQualitySignal,
  selectCampaignBooks
} = require('../api/_lib/daily-campaign');
const {
  createHandler,
  resolveLiveRoutes,
  campaignKey,
  runtimeCapabilities,
  loadRealtimeRankings,
  scheduledAtForAssignment,
  makeRunInput
} = require('../api/daily-campaign');
const { normalizeDelivery } = require('../api/_lib/distribution');
const { issueP0Receipt, p0SelectionFromReceipt } = require('../api/_lib/p0-receipts');

class MemoryRedis {
  constructor() {
    this.values = new Map();
    this.sorted = new Map();
    this.writes = [];
  }
  async get(key) { return this.values.get(key) ?? null; }
  async mget(...keys) { return Promise.all(keys.map((key) => this.get(key))); }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    this.writes.push({ key, value });
    return 'OK';
  }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async incr(key) {
    const next = Number(this.values.get(key) || 0) + 1;
    this.values.set(key, String(next));
    return next;
  }
  async zadd(key, entry) {
    if (!this.sorted.has(key)) this.sorted.set(key, new Map());
    this.sorted.get(key).set(entry.member, entry.score);
    return 1;
  }
  async zrange(key, start, end, options = {}) {
    const entries = [...(this.sorted.get(key) || new Map()).entries()]
      .sort((left, right) => options.rev ? right[1] - left[1] : left[1] - right[1])
      .map(([member]) => member);
    return entries.slice(start, end + 1);
  }
}

test('scheduled campaign slots preserve Beijing 14:00 and 20:00 on UTC workers', () => {
  const start = '2026-08-28T14:00:00+08:00';
  assert.equal(scheduledAtForAssignment({ slot: 1, accountIndex: 0 }, start), '2026-08-28T06:00:00.000Z');
  assert.equal(scheduledAtForAssignment({ slot: 2, accountIndex: 3 }, start), '2026-08-28T12:30:00.000Z');
  assert.equal(scheduledAtForAssignment({ slot: 3, accountIndex: 10 }, start), '2026-08-29T07:40:00.000Z');
  assert.equal(scheduledAtForAssignment({ slot: 4, accountIndex: 10 }, start), '2026-08-29T13:40:00.000Z');
});

test('scheduled campaign input carries explicit schedule intent into the durable run input', () => {
  const delivery = normalizeDelivery({ accountId: 13943483 });
  const rankedBook = {
    title: 'Scheduled Astra Book', bookSkuId: 'scheduled-astra-sku', ownershipVerified: true,
    automationReady: true, baseReadUnt: 1000, firstReadUntRate: 0.4, read20wRate: 0.1
  };
  const assignment = {
    index: 0, slot: 1, selectionTier: 'unique_high', accountId: 13943483,
    title: rankedBook.title, sku: rankedBook.bookSkuId,
    p0Receipt: issueP0Receipt(rankedBook, {
      target: delivery, source: 'content_dashboard_performance', dataQuality: 'verified_metrics',
      sourceHealth: 'healthy', stale: false, windowDays: 7, generatedAt: new Date().toISOString()
    }),
    creativeProfile: {}
  };
  const input = makeRunInput(assignment, {
    id: 'campaign_20260903_abcdefghij', day: '2026-09-03',
    scheduledAtForAssignment: () => '2026-09-05T06:00:00.000Z'
  }, {
    buildRunInput: (_book, body) => body
  });
  assert.equal(input.campaign.deliveryMode, 'scheduled');
  assert.equal(input.campaign.scheduledAt, '2026-09-05T06:00:00.000Z');
  assert.equal(input.campaign.autoSocialEchoDraft, true);
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
}

async function invoke(handler, method, body = {}, query = {}) {
  const res = responseRecorder();
  await handler({ method, body, query, headers: {}, socket: {} }, res);
  return res;
}

function routeBook(index, options = {}) {
  return {
    title: options.title || `Quality Book ${String(index).padStart(3, '0')}`,
    bookSkuId: options.sku || `quality-sku-${index}`,
    p0Receipt: options.p0Receipt || `receipt-${index}`,
    ownershipVerified: true,
    automationReady: true,
    source: 'content_dashboard',
    rank: Number(options.rank || index + 1),
    baseReadUnt: Number(options.baseReadUnt ?? (200000 - index * 1000)),
    firstReadUntRate: Number(options.firstReadUntRate ?? 0.52),
    gt2FirstReadUntRate: Number(options.gt2FirstReadUntRate ?? 0.7),
    read20wRate: Number(options.read20wRate ?? 0.22),
    read10wRate: Number(options.read10wRate ?? 0.35),
    ttProfit: Number(options.ttProfit ?? 5000),
    exposureUV: 100000,
    bookDetailUV: 8000
  };
}

test('12 × 3 selection is globally unique when the verified quality pool is sufficient', () => {
  const routes = DEFAULT_DAILY_ACCOUNT_IDS.map((accountId) => normalizeDelivery({ accountId }));
  const pool = Array.from({ length: 50 }, (_, index) => routeBook(index));
  const booksByAccount = new Map(routes.map((route) => [route.accountId, pool]));
  const result = selectCampaignBooks({ routes, booksByAccount, itemsPerAccount: 3 });

  assert.equal(result.assignments.length, 36);
  assert.equal(result.summary.uniqueTitles, 36);
  assert.equal(result.summary.maxGlobalTitleReuse, 1);
  for (const route of routes) {
    const accountBooks = result.assignments.filter((item) => item.accountId === route.accountId);
    assert.equal(accountBooks.length, 3);
    assert.equal(new Set(accountBooks.map((item) => titleKey(item.title))).size, 3);
  }
  assert.ok(result.assignments.every((item) => item.creativeProfile.uniquenessRequired === true));
  assert.ok(result.assignments.every((item) => item.qualityScore >= 45));
  const formCounts = new Map();
  const postIndexCounts = new Map();
  for (const item of result.assignments) {
    const profile = item.creativeProfile;
    formCounts.set(profile.creativeForm, Number(formCounts.get(profile.creativeForm) || 0) + 1);
    postIndexCounts.set(profile.draftPostIndex, Number(postIndexCounts.get(profile.draftPostIndex) || 0) + 1);
  }
  assert.equal(formCounts.size, CREATIVE_FORMS.length);
  assert.ok([...formCounts.values()].every((count) => count === 3));
  assert.deepEqual(Object.fromEntries(postIndexCounts), { 0: 18, 1: 18 });
  for (const route of routes) {
    const profiles = result.assignments.filter((item) => item.accountId === route.accountId).map((item) => item.creativeProfile);
    for (const field of ['creativeForm', 'openingGrammar', 'videoGrammar', 'ctaMode']) {
      assert.equal(new Set(profiles.map((profile) => profile[field])).size, 3, `${route.accountId} must have three distinct ${field} values`);
    }
    assert.equal(new Set(profiles.map((profile) => profile.draftPostIndex)).size, 2);
  }
});

test('candidate shortage repeats quality across accounts but never within one account', () => {
  const routes = [13751295, 13943450].map((accountId) => normalizeDelivery({ accountId }));
  const pool = [routeBook(0), routeBook(1), routeBook(2)];
  const result = selectCampaignBooks({
    routes,
    booksByAccount: new Map(routes.map((route) => [route.accountId, pool])),
    itemsPerAccount: 3
  });
  assert.equal(result.assignments.length, 6);
  assert.equal(result.summary.uniqueTitles, 3);
  assert.equal(result.summary.maxGlobalTitleReuse, 2);
  assert.ok(result.summary.repeatedForQuality > 0 || result.summary.backfilled > 0);
  for (const route of routes) {
    const accountTitles = result.assignments.filter((item) => item.accountId === route.accountId).map((item) => titleKey(item.title));
    assert.equal(new Set(accountTitles).size, 3);
  }
});

test('two qualified live books may fill a third slot only through a distinct chapter lane', () => {
  const route = normalizeDelivery({ accountId: 13943482 });
  const pool = [
    routeBook(0, { title: 'Omega Bound', sku: 'omega', baseReadUnt: 6221, firstReadUntRate: 0.6828, read20wRate: 0.1088 }),
    routeBook(1, { title: 'Married to My Ex Uncle', sku: 'married', baseReadUnt: 40, firstReadUntRate: 0.2828, read20wRate: 0.15 })
  ];
  const result = selectCampaignBooks({
    routes: [route], booksByAccount: new Map([[route.accountId, pool]]), itemsPerAccount: 3
  });
  assert.equal(result.assignments.length, 3);
  assert.equal(result.summary.uniqueTitles, 2);
  assert.equal(result.summary.sceneRepeatedForQuality, 1);
  const repeated = result.assignments.filter((item) => item.sku === 'omega').sort((left, right) => left.slot - right.slot);
  assert.equal(repeated.length, 2);
  assert.deepEqual(repeated.map((item) => item.creativeProfile.sceneLane), [0, 2]);
  assert.deepEqual(repeated.map((item) => item.creativeProfile.sceneRepeatIndex), [1, 2]);
  assert.ok(repeated.every((item) => item.creativeProfile.sceneRepeatCount === 2));
  assert.equal(new Set(result.assignments.map((item) => item.creativeProfile.creativeForm)).size, 3);
});

test('a two-book app pool fills three accounts without lowering quality', () => {
  const appRoutes = [13943484, 13943914, 13943918].map((accountId) => normalizeDelivery({ accountId }));
  const pool = [
    routeBook(0, { title: 'Storyca Quality Alpha', sku: 'storyca-quality-a', baseReadUnt: 8000, firstReadUntRate: 0.44, read20wRate: 0.12 }),
    routeBook(1, { title: 'Storyca Quality Beta', sku: 'storyca-quality-b', baseReadUnt: 5000, firstReadUntRate: 0.39, read20wRate: 0.1 })
  ];
  const result = selectCampaignBooks({
    routes: appRoutes,
    booksByAccount: new Map(appRoutes.map((item) => [item.accountId, pool])),
    itemsPerAccount: 3
  });
  assert.equal(result.assignments.length, 9);
  assert.ok(result.assignments.every((item) => item.qualityScore >= 45));
  assert.ok(result.summary.maxGlobalTitleReuse <= 5);
  for (const item of appRoutes) {
    const assignments = result.assignments.filter((assignment) => assignment.accountId === item.accountId);
    assert.equal(assignments.length, 3);
    assert.equal(new Set(assignments.map((assignment) => assignment.title)).size, 2);
    const repeated = assignments.filter((assignment, index, all) => all.some((other, otherIndex) => otherIndex !== index && other.title === assignment.title));
    assert.deepEqual(repeated.map((assignment) => assignment.creativeProfile.sceneLane).sort(), [0, 2]);
  }
});

test('one strong book may fill one account only through three chapter lanes', () => {
  const target = normalizeDelivery({ accountId: 13943484 });
  const only = routeBook(0, { title: 'Only Live Storyca Winner', sku: 'storyca-only', baseReadUnt: 9000, firstReadUntRate: 0.48, read20wRate: 0.14 });
  const result = selectCampaignBooks({ routes: [target], booksByAccount: new Map([[target.accountId, [only]]]), itemsPerAccount: 3 });
  assert.equal(result.assignments.length, 3);
  assert.equal(new Set(result.assignments.map((item) => item.title)).size, 1);
  assert.deepEqual(result.assignments.map((item) => item.creativeProfile.sceneLane), [0, 1, 2]);
  assert.deepEqual(result.assignments.map((item) => item.creativeProfile.sceneRepeatIndex), [1, 2, 3]);
  assert.ok(result.assignments.every((item) => item.creativeProfile.sceneRepeatCount === 3));
});

test('a low-quality book is not admitted when a strong book can use another chapter lane', () => {
  const route = normalizeDelivery({ accountId: 13751295 });
  const high = routeBook(0, { title: 'Proven High Quality', sku: 'high', baseReadUnt: 1_000_000_000, firstReadUntRate: 0.8, read20wRate: 0.4 });
  const low = routeBook(1, { title: 'Unproven Low Quality', sku: 'low', baseReadUnt: 1, firstReadUntRate: 0, gt2FirstReadUntRate: 0, read20wRate: 0, read10wRate: 0, ttProfit: 0, exposureUV: 0, bookDetailUV: 0 });
  const result = selectCampaignBooks({
    routes: [route], booksByAccount: new Map([[route.accountId, [high, low]]]), itemsPerAccount: 2
  });
  assert.equal(result.assignments.length, 2);
  assert.ok(result.assignments.every((item) => item.sku === 'high'));
  assert.equal(result.assignments.some((item) => item.sku === 'low'), false);
  assert.deepEqual(result.assignments.map((item) => item.creativeProfile.sceneLane), [0, 2]);
});

test('automatic selection rejects tiny samples and plainly unsafe titles before scoring', () => {
  const route = normalizeDelivery({ accountId: 13943482 });
  const safe = routeBook(0, { title: 'The Alpha Who Chose Her', sku: 'safe', baseReadUnt: 2000 });
  const tiny = routeBook(1, { title: 'Tiny Sample Mirage', sku: 'tiny', baseReadUnt: 3, firstReadUntRate: 1, read20wRate: 1 });
  const unsafe = routeBook(2, { title: 'Cunt Of Demand', sku: 'unsafe', baseReadUnt: 100000 });
  const fetish = routeBook(3, { title: 'The Billionaire Who Needed My Milk', sku: 'fetish', baseReadUnt: 100000 });
  const erotic = routeBook(4, { title: 'Filth Files: an erotic compilation', sku: 'erotic', baseReadUnt: 100000 });
  const incest = routeBook(5, { title: 'Mated To My Bully Stepbrothers', sku: 'incest', baseReadUnt: 100000 });
  const daddy = routeBook(6, { title: 'Ruin Me Step Daddy: Forbidden Cravings', sku: 'daddy', baseReadUnt: 100000 });
  const taboo = routeBook(7, { title: '100 Shades of Lust: A Pack of Taboo Stories', sku: 'taboo', baseReadUnt: 100000 });
  const nude = routeBook(8, { title: 'It Started With A Nude', sku: 'nude', baseReadUnt: 100000 });
  const minor = routeBook(9, { title: 'His Untouchable High School Girl', sku: 'minor', baseReadUnt: 100000 });
  const result = selectCampaignBooks({
    routes: [route], booksByAccount: new Map([[route.accountId, [safe, tiny, unsafe, fetish, erotic, incest, daddy, taboo, nude, minor]]]), itemsPerAccount: 1
  });
  assert.equal(result.assignments[0].sku, 'safe');
  assert.equal(result.summary.minimumReaderSample, 20);
  assert.equal(result.summary.sampleRejected, 1);
  assert.equal(result.summary.unsafeTitleRejected, 8);
});

test('a reported zero 20w rate does not silently fall back to a positive 10w rate', () => {
  const scored = scoreCandidates([routeBook(0, { read20wRate: 0, read10wRate: 0.9 })]);
  assert.equal(scored[0].campaignSignals.longReadRate, 0);
});

test('a statistically meaningful app leader can clear the floor on reader scale when optional rates are absent', () => {
  const scored = scoreCandidates([
    routeBook(0, { title: 'Scale Leader', sku: 'scale-leader', baseReadUnt: 2678, firstReadUntRate: 0, gt2FirstReadUntRate: 0, read20wRate: 0, ttProfit: 0 }),
    routeBook(1, { title: 'Scale Follower', sku: 'scale-follower', baseReadUnt: 200, firstReadUntRate: 0, gt2FirstReadUntRate: 0, read20wRate: 0, ttProfit: 0 })
  ]);
  assert.ok(scored.find((book) => book.bookSkuId === 'scale-leader').campaignScore >= 45);
  assert.equal(hasCoreQualitySignal(scored.find((book) => book.bookSkuId === 'scale-leader')), true);
});

test('live route resolution enforces the server-owned 12-account contract', () => {
  const defaultLive = DEFAULT_DAILY_ACCOUNT_IDS.map((id) => ({ id, status: 1, supported: true }));
  const routes = resolveLiveRoutes(defaultLive, 12);
  assert.equal(routes.length, 12);
  assert.ok(routes.every((route) => route.online === true && route.accountHealthSource === 'socialecho_live'));
  defaultLive.find((account) => account.id === 13943450).status = 0;
  defaultLive.push({ id: 15401748, status: 1, supported: true });
  assert.throws(() => resolveLiveRoutes(defaultLive, 12), /Only 11\/12/);
});

test('real-time ranking fallback expands only the short app and keeps every P0 receipt on its own source window', async () => {
  const now = Date.now();
  const routes = [13751295, 13943482, 13943764].map((accountId) => normalizeDelivery({ accountId }));
  const calls = [];
  const payload = (books, days) => ({
    books,
    generatedAt: new Date(now - 30 * 1000).toISOString(),
    source: 'content_dashboard_performance',
    selectionMode: 'catalog',
    dataQuality: 'verified_metrics',
    stale: false,
    sourceHealth: { status: 'healthy' },
    snapshotVersion: 'p0_multi_axis_test',
    window: { days },
    metrics: {
      candidateAxes: ['baseReadUnt', 'firstReadUntRate', 'read20wRate'],
      axisFetched: { baseReadUnt: books.length, firstReadUntRate: books.length, read20wRate: books.length },
      filters: { language: 'EN', length: 'all' }
    }
  });
  const leaderboard = async (req, res) => {
    calls.push({ line: req.query.line, days: Number(req.query.days), complete: req.query.complete });
    let books;
    if (req.query.line === 'novelflow') {
      books = Array.from({ length: 12 }, (_, index) => routeBook(100 + index, { title: `NovelFlow Live ${index}`, sku: `nf-live-${index}` }));
    } else if (Number(req.query.days) === 7 && req.query.complete === '已完结') {
      books = [
        routeBook(200, { title: 'Max Completed One', sku: 'max-complete-1', baseReadUnt: 500 }),
        routeBook(201, { title: 'Max Completed Two', sku: 'max-complete-2', baseReadUnt: 400 })
      ];
    } else if (Number(req.query.days) === 30 && req.query.complete === '已完结') {
      books = Array.from({ length: 4 }, (_, index) => routeBook(230 + index, {
        title: `Max 30d Completed ${index}`, sku: `max-30-complete-${index}`, baseReadUnt: 2000 - index * 100
      }));
    } else if (Number(req.query.days) === 30) {
      books = Array.from({ length: 20 }, (_, index) => routeBook(240 + index, {
        title: `Max 30d Serial ${index}`, sku: `max-30-serial-${index}`, baseReadUnt: 6000 - index * 100
      }));
    } else {
      books = Array.from({ length: 7 }, (_, index) => routeBook(210 + index, {
        title: `Max Serial Winner ${index}`, sku: `max-serial-${index}`, baseReadUnt: 5000 - index * 100
      }));
    }
    return res.status(200).json(payload(books, Number(req.query.days)));
  };
  const result = await loadRealtimeRankings({ headers: {} }, routes, 7, {
    leaderboardHandler: leaderboard,
    now: () => now
  });

  assert.deepEqual(calls.filter((call) => call.line === 'novelflow'), [
    { line: 'novelflow', days: 7, complete: '已完结' }
  ]);
  assert.deepEqual(calls.filter((call) => call.line === 'maxnovel'), [
    { line: 'maxnovel', days: 7, complete: '已完结' },
    { line: 'maxnovel', days: 7, complete: '连载中' },
    { line: 'maxnovel', days: 30, complete: '已完结' },
    { line: 'maxnovel', days: 30, complete: '连载中' }
  ]);
  assert.deepEqual(result.meta.novelflow.effectiveDays, [7]);
  assert.equal(result.meta.novelflow.fallbackReason, '');
  assert.deepEqual(result.meta.maxnovel.effectiveDays, [7, 30]);
  assert.match(result.meta.maxnovel.fallbackReason, /desired_unique_candidates/);
  assert.equal(result.meta.maxnovel.sourceBuckets.length, 4);
  assert.equal(result.meta.maxnovel.desiredUniqueCandidates, 18);
  assert.ok(result.meta.maxnovel.qualityCandidateCount >= 18);

  const maxBooks = result.booksByAccount.get(13943482);
  const serial = maxBooks.find((book) => book.bookSkuId === 'max-serial-0');
  assert.equal(serial.campaignRanking.bucket, '7d_serial');
  const receipt = p0SelectionFromReceipt(serial.p0Receipt, {
    delivery: routes.find((route) => route.accountId === 13943482), title: serial.title, sku: serial.bookSkuId
  });
  assert.equal(receipt.windowDays, 7);
  assert.equal(receipt.filters.complete, '连载中');
});

test('preview is non-paid and create durably reserves all 36 IDs before releasing workers', async () => {
  const redis = new MemoryRedis();
  const now = Date.now();
  const liveAccounts = DEFAULT_DAILY_ACCOUNT_IDS.map((id) => ({ id, status: 1, supported: true }));
  let accountReads = 0;
  const exactLookups = [];
  const loadRankings = async (_req, routes) => {
    // An older-but-still-fresh snapshot proves the confirmation expiry is
    // bounded by the P0 receipt, not always advertised as a full 15 minutes.
    const generatedAt = new Date(now - 10 * 60 * 1000).toISOString();
    const booksByAccount = new Map(routes.map((route) => {
      const pool = route.accountId === 13943482
        ? [
          routeBook(0, { title: 'Omega Bound', sku: 'max-omega', baseReadUnt: 6221, firstReadUntRate: 0.6828, read20wRate: 0.1088 }),
          routeBook(1, { title: 'Married to My Ex Uncle', sku: 'max-married', baseReadUnt: 40, firstReadUntRate: 0.2828, read20wRate: 0.15 })
        ]
        : route.accountId === 13943764
          ? Array.from({ length: 3 }, (_, index) => routeBook(60 + index, { title: `Max TikTok Winner ${index}`, sku: `max-tiktok-${index}` }))
        : Array.from({ length: 50 }, (_, index) => routeBook(index));
      const books = pool.map((book) => {
        return {
          ...book,
          p0Receipt: issueP0Receipt(book, {
            target: route,
            source: 'content_dashboard_performance',
            dataQuality: 'verified_metrics',
            sourceHealth: 'healthy',
            stale: false,
            generatedAt,
            windowDays: 7,
            filters: { language: 'EN', length: 'all' }
          })
        };
      });
      return [route.accountId, books];
    }));
    return {
      booksByAccount,
      meta: Object.fromEntries([...new Set(routes.map((route) => route.appKey))]
        .map((appKey) => [appKey, { generatedAt, candidateCount: appKey === 'maxnovel' ? 5 : 50 }]))
    };
  };
  const handler = createHandler({
    getRedis: () => redis,
    requireSession: () => true,
    requireOperatorMutation: () => true,
    listAccounts: async () => { accountReads += 1; return liveAccounts; },
    findExactBook: async (title, sku, options) => {
      exactLookups.push({ title, sku, applicationId: options.applicationId });
      return {
        title: title === 'Married to My Ex Uncle' ? "Married to My Ex's Uncle" : title,
        bookSkuId: sku,
        cityBookId: `city-${sku}`
      };
    },
    loadRankings,
    capabilities: () => ({ paidMediaAvailable: true, videoGenerationPaused: false }),
    now: () => now,
    randomId: () => 'a'.repeat(32)
  });

  const preview = await invoke(handler, 'POST', { action: 'preview', accountCount: 12, slotsPerAccount: 3 });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.total, 36);
  assert.equal(preview.body.zeroPaidSubmissions, true);
  assert.equal(preview.body.accounts.length, 12);
  assert.ok(preview.body.accounts.every((account) => account.online === true && account.status === 1 && account.active === true));
  assert.ok(Number.isFinite(Date.parse(preview.body.snapshotGeneratedAt)));
  assert.ok(Number.isFinite(Date.parse(preview.body.receiptExpiresAt)));
  assert.ok(Date.parse(preview.body.expiresAt) <= Date.parse(preview.body.receiptExpiresAt));
  assert.equal(preview.body.expiresAt, preview.body.receiptExpiresAt);
  assert.equal(preview.body.capabilities.paidMediaAvailable, true);
  assert.equal(preview.body.selectionSummary.exactIdentityVerified, 36);
  assert.equal(preview.body.selectionSummary.uniqueExactLookups, exactLookups.length);
  assert.ok(preview.body.assignments.every((item) => item.exactIdentityVerified === true));
  assert.ok(preview.body.selectionSummary.canonicalTitleCorrections >= 1);
  assert.equal(preview.body.selectionSummary.sceneRepeatedForQuality, 1);
  assert.ok(preview.body.selectionSummary.maxGlobalTitleReuse <= 2);
  assert.equal(preview.body.assignments.some((item) => item.p0Receipt), false);
  assert.equal([...redis.values.keys()].some((key) => key.startsWith('nf_social:run:')), false);

  const createBody = {
    action: 'create',
    accountCount: 12,
    slotsPerAccount: 3,
    paidAuthorized: true,
    confirmPaid: true,
    autoSubmit: true,
    confirmationToken: preview.body.confirmationToken
  };
  const created = await invoke(handler, 'POST', createBody);
  assert.equal(created.statusCode, 202);
  assert.equal(created.body.runIds.length, 36);
  assert.equal(created.body.campaign.authorization.socialEchoStatus, 0);
  assert.equal(accountReads, 2, 'create rechecks that the preview routes are still online');

  const runWrites = redis.writes
    .map((write, index) => ({ ...write, index }))
    .filter((write) => /^nf_social:run:run_/.test(write.key))
    .map((write) => ({ ...write, run: JSON.parse(write.value) }));
  const firstQueuedWrite = runWrites.find((write) => write.run.state === 'queued');
  assert.ok(firstQueuedWrite);
  const reservedBeforeRelease = new Set(runWrites
    .filter((write) => write.index < firstQueuedWrite.index && write.run.state === 'reserved')
    .map((write) => write.run.id));
  assert.equal(reservedBeforeRelease.size, 36);

  for (const runId of created.body.runIds) {
    const run = JSON.parse(await redis.get(`nf_social:run:${runId}`));
    assert.equal(run.state, 'queued');
    assert.equal(run.input.paidMediaSubmissionAuthorized, true);
    assert.equal(run.input.campaign.autoSocialEchoDraft, true);
    assert.equal(run.input.campaign.id, created.body.campaign.id);
  }
  const maxRuns = await Promise.all(created.body.runIds.map(async (runId) => JSON.parse(await redis.get(`nf_social:run:${runId}`))))
    .then((runs) => runs.filter((run) => run.input.delivery.appKey === 'maxnovel'));
  assert.equal(maxRuns.length, 6);
  for (const accountId of [13943482, 13943764]) {
    const accountRuns = maxRuns.filter((run) => run.input.delivery.accountId === accountId);
    const repeated = accountRuns.filter((run) => run.input.sku === 'max-omega');
    if (accountId === 13943482) {
      assert.equal(repeated.length, 2);
      assert.deepEqual(repeated.map((run) => run.input.creativeProfile.sceneLane).sort(), [0, 2]);
      assert.equal(new Set(repeated.map((run) => run.input.campaign.itemIndex)).size, 2);
    } else {
      assert.equal(repeated.length, 0);
      assert.equal(new Set(accountRuns.map((run) => run.input.sku)).size, 3);
    }
  }

  const duplicate = await invoke(handler, 'POST', createBody);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.deepEqual(duplicate.body.runIds, created.body.runIds);

  const status = await invoke(handler, 'GET', {}, { campaignId: created.body.campaign.id });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.slots.length, 36);
  assert.equal(status.body.campaign.assignments.length, 36);
  assert.equal(status.body.campaign.stageCounts.P0.done, 36);
  assert.equal(status.body.counts.runStates.queued, 36);
  assert.ok(await redis.get(campaignKey(created.body.campaign.id)));
});

test('exact preflight replaces a definitive missing candidate before signing the non-paid preview', async () => {
  const redis = new MemoryRedis();
  const now = Date.now();
  const liveAccounts = DEFAULT_DAILY_ACCOUNT_IDS.map((id) => ({ id, status: 1, supported: true }));
  const badSku = 'quality-sku-0';
  const handler = createHandler({
    getRedis: () => redis,
    requireSession: () => true,
    requireOperatorMutation: () => true,
    consumeRateLimit: async () => ({ allowed: true, retryAfter: 1 }),
    listAccounts: async () => liveAccounts,
    listRunSummaries: async () => [],
    loadRankings: async (_req, routes) => {
      const generatedAt = new Date(now - 1000).toISOString();
      const pool = Array.from({ length: 60 }, (_, index) => routeBook(index));
      const booksByAccount = new Map(routes.map((route) => [route.accountId, pool.map((book) => ({
        ...book,
        p0Receipt: issueP0Receipt(book, {
          target: route, source: 'content_dashboard_performance', dataQuality: 'verified_metrics',
          sourceHealth: 'healthy', stale: false, generatedAt, windowDays: 7,
          filters: { language: 'EN', length: 'all' }
        })
      }))]));
      return {
        booksByAccount,
        meta: Object.fromEntries([...new Set(routes.map((route) => route.appKey))]
          .map((appKey) => [appKey, { generatedAt, candidateCount: pool.length }]))
      };
    },
    findExactBook: async (title, sku) => {
      if (sku === badSku) throw Object.assign(new Error('missing'), { status: 404, code: 'exact_not_found' });
      return { title, bookSkuId: sku, cityBookId: `city-${sku}` };
    },
    capabilities: () => ({ paidMediaAvailable: true }),
    videoCapacity: async () => ({ limit: 100, remaining: 100 }),
    now: () => now,
    randomId: () => 'b'.repeat(32)
  });
  const preview = await invoke(handler, 'POST', { action: 'preview', accountCount: 12, slotsPerAccount: 3 });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.total, 36);
  assert.equal(preview.body.zeroPaidSubmissions, true);
  assert.equal(preview.body.assignments.some((item) => item.sku === badSku), false);
  assert.ok(preview.body.selectionSummary.rejectedExactCandidates >= 1);
  assert.equal(preview.body.selectionSummary.exactIdentityVerified, 36);
  assert.equal([...redis.values.keys()].some((key) => key.startsWith('nf_social:run:')), false);
});

test('a transient exact preflight failure signs no preview and preserves its HTTP status', async () => {
  const redis = new MemoryRedis();
  const now = Date.now();
  const liveAccounts = DEFAULT_DAILY_ACCOUNT_IDS.map((id) => ({ id, status: 1, supported: true }));
  const handler = createHandler({
    getRedis: () => redis,
    requireSession: () => true,
    consumeRateLimit: async () => ({ allowed: true, retryAfter: 1 }),
    listAccounts: async () => liveAccounts,
    listRunSummaries: async () => [],
    loadRankings: async (_req, routes) => {
      const generatedAt = new Date(now - 1000).toISOString();
      const pool = Array.from({ length: 60 }, (_, index) => routeBook(index));
      return {
        booksByAccount: new Map(routes.map((route) => [route.accountId, pool.map((book) => ({
          ...book,
          p0Receipt: issueP0Receipt(book, {
            target: route, source: 'content_dashboard_performance', dataQuality: 'verified_metrics',
            sourceHealth: 'healthy', stale: false, generatedAt, windowDays: 7,
            filters: { language: 'EN', length: 'all' }
          })
        }))])),
        meta: Object.fromEntries([...new Set(routes.map((route) => route.appKey))]
          .map((appKey) => [appKey, { generatedAt, candidateCount: pool.length }]))
      };
    },
    findExactBook: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); },
    capabilities: () => ({ paidMediaAvailable: true }),
    videoCapacity: async () => ({ limit: 100, remaining: 100 }),
    now: () => now,
    randomId: () => 'c'.repeat(32)
  });
  const preview = await invoke(handler, 'POST', { action: 'preview', accountCount: 12, slotsPerAccount: 3 });
  assert.equal(preview.statusCode, 429);
  assert.equal([...redis.values.keys()].some((key) => key.startsWith('nf_social:campaign_preview:')), false);
  assert.equal([...redis.values.keys()].some((key) => key.startsWith('nf_social:run:')), false);
});

test('campaign capabilities use the same fail-closed video and image pause semantics as the workers', (t) => {
  const previousVideo = process.env.SOCIAL_VIDEO_GENERATION_PAUSED;
  const previousImage = process.env.SOCIAL_IMAGE_GENERATION_PAUSED;
  t.after(() => {
    if (previousVideo === undefined) delete process.env.SOCIAL_VIDEO_GENERATION_PAUSED;
    else process.env.SOCIAL_VIDEO_GENERATION_PAUSED = previousVideo;
    if (previousImage === undefined) delete process.env.SOCIAL_IMAGE_GENERATION_PAUSED;
    else process.env.SOCIAL_IMAGE_GENERATION_PAUSED = previousImage;
  });
  process.env.SOCIAL_VIDEO_GENERATION_PAUSED = 'yes';
  process.env.SOCIAL_IMAGE_GENERATION_PAUSED = '1';
  assert.equal(runtimeCapabilities().videoGenerationPaused, true);
  assert.equal(runtimeCapabilities().imageGenerationPaused, true);
  process.env.SOCIAL_VIDEO_GENERATION_PAUSED = 'off';
  process.env.SOCIAL_IMAGE_GENERATION_PAUSED = 'false';
  assert.equal(runtimeCapabilities().videoGenerationPaused, false);
  assert.equal(runtimeCapabilities().imageGenerationPaused, false);
});

test('image pause does not block video campaign capability', (t) => {
  const names = [
    'NOVELFLOW_OIDC_TOKEN',
    'NOVELFLOW_OIDC_USERNAME',
    'NOVELFLOW_OIDC_PASSWORD',
    'AC_TOKEN',
    'NOVELFLOW_AC_TOKEN',
    'NOVELFLOW_TOKENDANCE_API_KEY',
    'SOCIALECHO_API_KEY',
    'IIIT_IMAGE_API_KEY',
    'SOCIAL_VIDEO_GENERATION_PAUSED',
    'SOCIAL_IMAGE_GENERATION_PAUSED'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  process.env.NOVELFLOW_OIDC_TOKEN = 'pipeline-test';
  process.env.AC_TOKEN = 'video-test';
  process.env.NOVELFLOW_TOKENDANCE_API_KEY = 'llm-test';
  process.env.SOCIALECHO_API_KEY = 'publishing-test';
  delete process.env.NOVELFLOW_OIDC_USERNAME;
  delete process.env.NOVELFLOW_OIDC_PASSWORD;
  delete process.env.NOVELFLOW_AC_TOKEN;
  delete process.env.IIIT_IMAGE_API_KEY;
  process.env.SOCIAL_VIDEO_GENERATION_PAUSED = 'false';
  process.env.SOCIAL_IMAGE_GENERATION_PAUSED = 'true';
  const capabilities = runtimeCapabilities();
  assert.equal(capabilities.image, false);
  assert.equal(capabilities.imageGenerationPaused, true);
  assert.equal(capabilities.paidMediaAvailable, true);

  process.env.SOCIAL_VIDEO_GENERATION_PAUSED = 'true';
  assert.equal(runtimeCapabilities().paidMediaAvailable, false);
});

test('every POST is authenticated and client-supplied account substitutions are rejected', async () => {
  const redis = new MemoryRedis();
  let sessionChecks = 0;
  const denied = createHandler({
    getRedis: () => redis,
    requireSession: (_req, res) => {
      sessionChecks += 1;
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }
  });
  const unsupported = await invoke(denied, 'POST', { action: 'anything' });
  assert.equal(unsupported.statusCode, 401);
  assert.equal(sessionChecks, 1);

  let accountReads = 0;
  const fixedContract = createHandler({
    getRedis: () => redis,
    requireSession: () => true,
    consumeRateLimit: async () => ({ allowed: true, retryAfter: 300 }),
    listAccounts: async () => { accountReads += 1; return []; }
  });
  const substituted = await invoke(fixedContract, 'POST', {
    action: 'preview',
    accountCount: 12,
    itemsPerAccount: 3,
    slotsPerAccount: 3,
    totalSlots: 36,
    accountIds: [...DEFAULT_DAILY_ACCOUNT_IDS.slice(0, 11), 99999999]
  });
  assert.equal(substituted.statusCode, 400);
  assert.equal(accountReads, 0, 'invalid client routing is rejected before any provider read');
});
