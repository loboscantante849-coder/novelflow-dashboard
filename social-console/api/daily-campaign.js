const crypto = require('crypto');
const store = require('./_lib/store');
const auth = require('./_lib/auth');
const socialecho = require('./_lib/socialecho');
const providers = require('./_lib/providers');
const leaderboardHandler = require('./leaderboard');
const runsApi = require('./runs');
const { consumeRateLimit, requestIdentity } = require('./_lib/rate-limit');
const { normalizeDelivery, ALL_ACCOUNT_ROUTES } = require('./_lib/distribution');
const {
  issueP0Receipt,
  p0SelectionFromReceipt,
  rebindP0ReceiptBook,
  RECEIPT_TTL_MS
} = require('./_lib/p0-receipts');
const {
  getDraft,
  draftIdForRun
} = require('./_lib/publications');
const {
  DEFAULT_DAILY_ACCOUNT_IDS,
  titleKey,
  bookIdentity,
  scoreCandidates,
  hasCoreQualitySignal,
  brandSafeTitle,
  MIN_CAMPAIGN_READERS,
  selectCampaignBooks,
  campaignId
} = require('./_lib/daily-campaign');

const CAMPAIGN_INDEX = 'nf_social:campaigns';
const CAMPAIGN_TOKEN_SCOPE = 'daily_campaign_v1';
const PREVIEW_TTL_SECONDS = 20 * 60;
const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const RANKING_AXES = Object.freeze(['baseReadUnt', 'firstReadUntRate', 'read20wRate']);
const CAMPAIGN_ID_PATTERN = /^campaign_[0-9]{8}_[a-f0-9]{10}$/;
const PREVIEW_ID_PATTERN = /^preview_[a-f0-9]{32}$/;
const EXACT_PREFLIGHT_CONCURRENCY = 4;
const EXACT_SELECTION_MAX_PASSES = 12;

function campaignKey(id) { return `nf_social:campaign:${id}`; }
function previewKey(id) { return `nf_social:campaign_preview:${id}`; }
function campaignLockKey(id) { return `nf_social:campaign_lock:${id}`; }

function parseStored(value) {
  if (!value) return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
}

function safeError(error, fallback = 'Daily campaign request failed') {
  return String(error?.message || fallback)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|se)_[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gi, '[redacted]')
    .slice(0, 500);
}

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function shanghaiDay(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(at);
}

function runtimeCapabilities() {
  const pipeline = Boolean(process.env.NOVELFLOW_OIDC_TOKEN
    || (process.env.NOVELFLOW_OIDC_USERNAME && process.env.NOVELFLOW_OIDC_PASSWORD));
  const video = Boolean(process.env.AC_TOKEN || process.env.NOVELFLOW_AC_TOKEN);
  const llm = Boolean(process.env.NOVELFLOW_TOKENDANCE_API_KEY);
  const image = Boolean(process.env.IIIT_IMAGE_API_KEY);
  const publishing = Boolean(process.env.SOCIALECHO_API_KEY);
  const pauseSetting = String(process.env.SOCIAL_VIDEO_GENERATION_PAUSED || '').trim().toLowerCase();
  const videoGenerationPaused = pauseSetting ? !['0', 'false', 'off'].includes(pauseSetting) : false;
  const imagePauseSetting = String(process.env.SOCIAL_IMAGE_GENERATION_PAUSED || '').trim().toLowerCase();
  const imageGenerationPaused = imagePauseSetting ? !['0', 'false', 'off'].includes(imagePauseSetting) : false;
  return {
    storage: true,
    pipeline,
    video,
    llm,
    image,
    publishing,
    videoGenerationPaused,
    imageGenerationPaused,
    // Video campaigns do not require poster/image generation. Keep the image
    // capability and its pause state visible for image-specific flows, but do
    // not let an intentionally paused image provider block P0-P7 video runs.
    paidMediaAvailable: pipeline && video && llm && publishing && !videoGenerationPaused
  };
}

function isOnlineAccount(account) {
  const status = String(account?.status ?? '').trim().toLowerCase();
  return account?.supported !== false && (account?.status === true || ['1', 'active', 'online'].includes(status));
}

function resolveLiveRoutes(liveAccounts = [], requestedCount = 12, options = {}) {
  const count = Number(requestedCount);
  const scheduledNonNovelFlow = options?.scheduledNonNovelFlow === true;
  if (scheduledNonNovelFlow && count !== 11) throw httpError('Scheduled production requires exactly 11 non-NovelFlow online accounts', 400);
  if (!scheduledNonNovelFlow && count !== 12) throw httpError('Daily production requires exactly 12 online accounts', 400);
  const liveById = new Map((Array.isArray(liveAccounts) ? liveAccounts : [])
    .filter(isOnlineAccount)
    .map((account) => [Number(account.id), account]));
  // The server owns this reviewed 12-route contract. A client cannot swap in
  // a different account, and one of the two intentionally excluded IG routes
  // coming online does not silently change campaign ownership.
  const configuredIds = scheduledNonNovelFlow
    ? ALL_ACCOUNT_ROUTES.filter((route) => route.appKey !== 'novelflow').map((route) => route.accountId)
    : DEFAULT_DAILY_ACCOUNT_IDS;
  const routes = configuredIds
    .filter((accountId) => liveById.has(Number(accountId)))
    .map((accountId) => ({
      ...normalizeDelivery({ accountId }),
      online: true,
      status: 1,
      active: true,
      available: true,
      accountHealth: 'online',
      accountHealthSource: 'socialecho_live'
    }))
    .filter(Boolean);
  if (routes.length !== count) {
    const offline = configuredIds.filter((accountId) => !liveById.has(Number(accountId)));
    throw httpError(`Only ${routes.length}/${count} verified SocialEcho routes are online; offline accounts: ${offline.join(', ') || 'unknown'}`, 409);
  }
  return routes;
}

function validateFreshRanking(payload, appKey, axis, now = Date.now()) {
  const generatedAt = Date.parse(payload?.generatedAt || '');
  // A cached response may still be the exact, signed, verified live snapshot.
  // It remains eligible only while the normal P0 receipt window is open; an
  // explicitly stale or expired cache still fails closed below.
  const healthy = ['healthy', 'cached'].includes(String(payload?.sourceHealth?.status || ''));
  if (payload?.stale === true
    || payload?.source !== 'content_dashboard_performance'
    || payload?.selectionMode !== 'catalog'
    || payload?.dataQuality !== 'verified_metrics'
    || !healthy
    || !Number.isFinite(generatedAt)
    || generatedAt > now + 60 * 1000
    || now - generatedAt > RECEIPT_TTL_MS
    || !Array.isArray(payload?.books)
    || !payload.books.length) {
    throw httpError(`${appKey} ${axis} ranking is not a fresh verified content-dashboard snapshot`, 409);
  }
  return generatedAt;
}

async function loadFreshCampaignRanking(req, route, spec, deps) {
  const query = {
    source: 'catalog', line: route.appKey, platform: route.platform,
    accountId: String(route.accountId), language: 'EN', complete: spec.complete,
    days: String(spec.days), sort: 'baseReadUnt', refresh: '0'
  };
  const cachedOrLive = await invokeJsonHandler(deps.leaderboardHandler, req, query);
  try {
    validateFreshRanking(cachedOrLive, route.appKey, spec.id, deps.now());
    return cachedOrLive;
  } catch {
    // The dashboard cache lives longer than a P0 receipt. Refresh only after
    // proving that the cached snapshot is outside the short P0 window rather
    // than forcing every campaign preview to stampede the live source.
    const refreshed = await invokeJsonHandler(deps.leaderboardHandler, req, { ...query, refresh: '1' });
    validateFreshRanking(refreshed, route.appKey, spec.id, deps.now());
    return refreshed;
  }
}

function mergeRankingPayloads(axisPayloads = {}, appKey = '', now = Date.now()) {
  const merged = new Map();
  const generatedTimes = [];
  let context = null;
  for (const axis of RANKING_AXES) {
    const payload = axisPayloads[axis];
    generatedTimes.push(validateFreshRanking(payload, appKey, axis, now));
    if (!context) context = payload;
    for (const book of payload.books) {
      const sku = String(book?.bookSkuId || '').trim();
      const key = sku ? `sku:${sku}` : `title:${titleKey(book?.title)}`;
      if (!sku || !titleKey(book?.title)) continue;
      const previous = merged.get(key);
      const axisRanks = { ...(previous?.axisRanks || {}), [axis]: Number(book.rank || 0) };
      merged.set(key, {
        ...(previous || {}),
        ...book,
        p0Receipt: undefined,
        axisRanks,
        rank: Math.min(...Object.values(axisRanks).filter((rank) => Number.isFinite(rank) && rank > 0))
      });
    }
  }
  const generatedAt = new Date(Math.min(...generatedTimes)).toISOString();
  return {
    books: [...merged.values()].filter((book) => book.ownershipVerified === true
      && book.automationReady !== false
      && book.source === 'content_dashboard'
      && Number(book.baseReadUnt || 0) > 0),
    generatedAt,
    windowDays: Number(context?.window?.days || 0),
    filters: context?.metrics?.filters || {},
    axes: Object.fromEntries(RANKING_AXES.map((axis) => [axis, {
      generatedAt: axisPayloads[axis].generatedAt,
      candidateCount: axisPayloads[axis].books.length
    }]))
  };
}

async function invokeJsonHandler(handler, req, query) {
  let statusCode = 200;
  let body;
  const response = {
    status(value) { statusCode = Number(value) || 500; return response; },
    json(value) { body = value; return value; }
  };
  await handler({
    ...req,
    method: 'GET',
    query,
    body: undefined,
    headers: { ...(req?.headers || {}) }
  }, response);
  if (statusCode < 200 || statusCode >= 300) {
    throw httpError(String(body?.error || `Ranking request failed with HTTP ${statusCode}`), statusCode);
  }
  if (!body || typeof body !== 'object') throw httpError('Ranking endpoint returned no JSON payload', 502);
  return body;
}

async function loadRealtimeRankings(req, routes, rankingDays, deps) {
  const representatives = [...new Map(routes.map((route) => [route.appKey, route])).values()];
  const appEntries = await Promise.all(representatives.map(async (route) => {
    // The leaderboard endpoint itself recalls and merges all three live axes.
    // Calling it once per application avoids multiplying that work 3× here.
    const payload = await invokeJsonHandler(deps.leaderboardHandler, req, {
      source: 'catalog',
      line: route.appKey,
      platform: route.platform,
      accountId: String(route.accountId),
      language: 'EN',
      days: String(rankingDays),
      sort: 'baseReadUnt',
      refresh: '1'
    });
    const generatedAt = new Date(validateFreshRanking(payload, route.appKey, 'multi_axis', deps.now())).toISOString();
    const candidateAxes = Array.isArray(payload?.metrics?.candidateAxes) ? payload.metrics.candidateAxes : [];
    if (!RANKING_AXES.every((axis) => candidateAxes.includes(axis))) {
      throw httpError(`${route.appName} ranking did not include the required three-axis candidate union`, 409);
    }
    return [route.appKey, {
      books: payload.books.map((book) => ({ ...book, p0Receipt: undefined })),
      generatedAt,
      windowDays: Number(payload?.window?.days || rankingDays),
      filters: payload?.metrics?.filters || {},
      snapshotVersion: String(payload?.snapshotVersion || 'p0_multi_axis_v1'),
      axes: Object.fromEntries(RANKING_AXES.map((axis) => [axis, {
        generatedAt,
        candidateCount: Number(payload?.metrics?.axisFetched?.[axis]
          || payload?.metrics?.axisCandidateTotals?.[axis]
          || payload.books.length)
      }]))
    }];
  }));
  const byApp = new Map(appEntries);
  const booksByAccount = new Map();
  for (const route of routes) {
    const snapshot = byApp.get(route.appKey);
    if (!snapshot?.books?.length) throw httpError(`${route.appName} has no fresh verified campaign candidates`, 409);
    const books = snapshot.books.map((book) => ({
      ...book,
      selectionTarget: route,
      p0Receipt: issueP0Receipt(book, {
        target: route,
        source: 'content_dashboard_performance',
        dataQuality: 'verified_metrics',
        sourceHealth: 'healthy',
        stale: false,
        generatedAt: snapshot.generatedAt,
        snapshotVersion: snapshot.snapshotVersion,
        windowDays: snapshot.windowDays,
        filters: snapshot.filters
      })
    }));
    booksByAccount.set(Number(route.accountId), books);
  }
  return {
    booksByAccount,
    meta: Object.fromEntries([...byApp.entries()].map(([appKey, snapshot]) => [appKey, {
      generatedAt: snapshot.generatedAt,
      candidateCount: snapshot.books.length,
      snapshotVersion: snapshot.snapshotVersion,
      axes: snapshot.axes
    }]))
  };
}

function rankingSnapshot(payload, route, requestedDays, spec, now) {
  const generatedAt = new Date(validateFreshRanking(payload, route.appKey, spec.id, now)).toISOString();
  const candidateAxes = Array.isArray(payload?.metrics?.candidateAxes) ? payload.metrics.candidateAxes : [];
  if (!RANKING_AXES.every((axis) => candidateAxes.includes(axis))) {
    throw httpError(`${route.appName} ${spec.id} ranking did not include the required three-axis candidate union`, 409);
  }
  const windowDays = Number(payload?.window?.days || spec.days);
  const filters = { ...(payload?.metrics?.filters || {}), language: 'EN', complete: spec.complete };
  return {
    id: spec.id,
    requestedDays,
    windowDays,
    completionStatus: spec.complete,
    generatedAt,
    filters,
    snapshotVersion: String(payload?.snapshotVersion || 'p0_multi_axis_v1'),
    axes: Object.fromEntries(RANKING_AXES.map((axis) => [axis, {
      generatedAt,
      candidateCount: Number(payload?.metrics?.axisFetched?.[axis]
        || payload?.metrics?.axisCandidateTotals?.[axis]
        || payload.books.length)
    }])),
    books: payload.books.map((book) => ({
      ...book,
      p0Receipt: undefined,
      campaignRanking: {
        bucket: spec.id,
        requestedDays,
        windowDays,
        completionStatus: spec.complete,
        generatedAt,
        filters,
        snapshotVersion: String(payload?.snapshotVersion || 'p0_multi_axis_v1')
      }
    }))
  };
}

function rawQualitySignal(book = {}) {
  const firstRead = Number(book.firstReadUntRate || 0);
  const longRead = Object.prototype.hasOwnProperty.call(book, 'read20wRate')
    ? Number(book.read20wRate || 0)
    : Number(book.read10wRate || 0);
  const normalizedFirst = firstRead > 1 ? firstRead : firstRead * 100;
  const normalizedLong = longRead > 1 ? longRead : longRead * 100;
  return Number(book.baseReadUnt || 0) >= 1000 || normalizedFirst >= 20 || normalizedLong >= 5;
}

function betterSnapshotBook(current, incoming) {
  if (!current) return incoming;
  const currentQuality = Number(current.baseReadUnt || 0) >= MIN_CAMPAIGN_READERS && brandSafeTitle(current) && rawQualitySignal(current);
  const incomingQuality = Number(incoming.baseReadUnt || 0) >= MIN_CAMPAIGN_READERS && brandSafeTitle(incoming) && rawQualitySignal(incoming);
  if (incomingQuality !== currentQuality) return incomingQuality ? incoming : current;
  const currentDays = Number(current.campaignRanking?.windowDays || 999);
  const incomingDays = Number(incoming.campaignRanking?.windowDays || 999);
  if (currentQuality && currentDays !== incomingDays) return incomingDays < currentDays ? incoming : current;
  return Number(incoming.baseReadUnt || 0) > Number(current.baseReadUnt || 0) ? incoming : current;
}

function mergeCampaignSnapshots(snapshots = []) {
  const merged = new Map();
  for (const snapshot of snapshots) {
    for (const book of snapshot.books || []) {
      const identity = bookIdentity(book);
      if (!identity || identity === 'title:') continue;
      merged.set(identity, betterSnapshotBook(merged.get(identity), book));
    }
  }
  return [...merged.values()];
}

function qualityCandidateCount(books = []) {
  const eligible = books.filter((book) => Number(book.baseReadUnt || 0) >= MIN_CAMPAIGN_READERS
    && brandSafeTitle(book) && rawQualitySignal(book));
  return scoreCandidates(eligible).filter((book) => Number(book.campaignScore || 0) >= 45 && hasCoreQualitySignal(book)).length;
}

function fallbackSpecs(requestedDays) {
  const windows = [requestedDays, ...(requestedDays < 7 ? [7] : []), ...(requestedDays < 30 ? [30] : []), 90];
  const specs = [];
  for (const days of [...new Set(windows)]) {
    specs.push({ id: `${days}d_completed`, days, complete: '已完结' });
    if (days <= 30) specs.push({ id: `${days}d_serial`, days, complete: '连载中' });
  }
  return specs;
}

async function loadRealtimeRankingsV2(req, routes, rankingDays, deps) {
  const representatives = [...new Map(routes.map((route) => [route.appKey, route])).values()];
  const appEntries = await Promise.all(representatives.map(async (route) => {
    const required = routes.filter((candidate) => candidate.appKey === route.appKey).length * 3;
    // Shared catalogs make a merely sufficient per-app pool collapse into
    // cross-brand repetition. Recall three candidates for every intended slot
    // before stopping the per-app fallback ladder.
    const desiredUnique = required * 3;
    const snapshots = [];
    const attempts = [];
    for (const spec of fallbackSpecs(rankingDays)) {
      try {
        const payload = await loadFreshCampaignRanking(req, route, spec, deps);
        const snapshot = rankingSnapshot(payload, route, rankingDays, spec, deps.now());
        snapshots.push(snapshot);
        const qualityCount = qualityCandidateCount(mergeCampaignSnapshots(snapshots));
        attempts.push({
          id: spec.id, days: snapshot.windowDays, completionStatus: spec.complete,
          generatedAt: snapshot.generatedAt, candidateCount: snapshot.books.length,
          qualityCandidateCount: qualityCount, status: 'healthy'
        });
        if (qualityCount >= desiredUnique) break;
      } catch (error) {
        attempts.push({ id: spec.id, days: spec.days, completionStatus: spec.complete, status: 'unavailable', reason: safeError(error) });
      }
    }
    const books = mergeCampaignSnapshots(snapshots);
    const qualityCount = qualityCandidateCount(books);
    // Source health means at least one current, verified, statistically
    // defensible book. Portfolio breadth is handled separately by the
    // selector and exact chapter-lane preflight; do not label a truthful
    // one-book storefront as an upstream outage.
    if (!snapshots.length || qualityCount < 1) {
      throw httpError(`${route.appName} could not provide a healthy real-time quality pool after per-app fallback`, 409);
    }
    const generatedAt = new Date(Math.min(...snapshots.map((snapshot) => Date.parse(snapshot.generatedAt)))).toISOString();
    const effectiveDays = [...new Set(snapshots.map((snapshot) => snapshot.windowDays))].sort((left, right) => left - right);
    const fallbackReason = snapshots.length > 1 || attempts.some((attempt) => attempt.status === 'unavailable')
      ? `requested_${rankingDays}d_completed_pool_had_${qualityCandidateCount(snapshots[0]?.books || [])}_of_${desiredUnique}_desired_unique_candidates`
      : '';
    return [route.appKey, {
      books, generatedAt, requestedDays: rankingDays, effectiveDays,
      windowDays: Math.max(...effectiveDays), qualityCandidateCount: qualityCount,
      requiredQualityCandidates: required, desiredUniqueCandidates: desiredUnique,
      fallbackReason, sourceBuckets: attempts,
      snapshotVersion: String(snapshots[0]?.snapshotVersion || 'p0_multi_axis_v1'),
      axes: snapshots[0]?.axes || {}
    }];
  }));
  const byApp = new Map(appEntries);
  const booksByAccount = new Map();
  for (const route of routes) {
    const snapshot = byApp.get(route.appKey);
    if (!snapshot?.books?.length) throw httpError(`${route.appName} has no fresh verified campaign candidates`, 409);
    const books = snapshot.books.map((book) => ({
      ...book,
      selectionTarget: route,
      p0Receipt: issueP0Receipt(book, {
        target: route, source: 'content_dashboard_performance', dataQuality: 'verified_metrics',
        sourceHealth: 'healthy', stale: false,
        generatedAt: book.campaignRanking?.generatedAt || snapshot.generatedAt,
        snapshotVersion: book.campaignRanking?.snapshotVersion || snapshot.snapshotVersion,
        windowDays: book.campaignRanking?.windowDays || snapshot.windowDays,
        filters: book.campaignRanking?.filters || {}
      })
    }));
    booksByAccount.set(Number(route.accountId), books);
  }
  return {
    booksByAccount,
    meta: Object.fromEntries([...byApp.entries()].map(([appKey, snapshot]) => [appKey, {
      generatedAt: snapshot.generatedAt, candidateCount: snapshot.books.length,
      qualityCandidateCount: snapshot.qualityCandidateCount,
      requiredQualityCandidates: snapshot.requiredQualityCandidates,
      desiredUniqueCandidates: snapshot.desiredUniqueCandidates,
      requestedDays: snapshot.requestedDays, effectiveDays: snapshot.effectiveDays,
      fallbackReason: snapshot.fallbackReason, sourceBuckets: snapshot.sourceBuckets,
      snapshotVersion: snapshot.snapshotVersion, axes: snapshot.axes
    }]))
  };
}

function assignmentDigestProjection(assignment) {
  return {
    index: Number(assignment.index),
    slot: Number(assignment.slot),
    accountId: Number(assignment.accountId),
    appKey: String(assignment.appKey || ''),
    platform: String(assignment.platform || ''),
    title: String(assignment.title || ''),
    sku: String(assignment.sku || ''),
    sourceRank: Number(assignment.sourceRank || 0),
    qualityScore: Number(assignment.qualityScore || 0),
    rankingWindowDays: Number(assignment.rankingWindowDays || 0),
    rankingBucket: String(assignment.rankingBucket || ''),
    completionStatus: String(assignment.completionStatus || ''),
    selectionTier: String(assignment.selectionTier || ''),
    creativeProfile: assignment.creativeProfile || {}
  };
}

function selectionDigest(assignments = []) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(assignments.map(assignmentDigestProjection)))
    .digest('hex');
}

function publicAssignment(assignment = {}) {
  const { p0Receipt, runInput, verifiedBook, ...safe } = assignment;
  return safe;
}

function publicPreview(preview, confirmationToken) {
  return {
    previewId: preview.id,
    campaignId: preview.campaignId,
    confirmationToken,
    selectionDigest: preview.selectionDigest,
    createdAt: preview.createdAt,
    expiresAt: preview.expiresAt,
    receiptExpiresAt: preview.receiptExpiresAt,
    snapshotGeneratedAt: preview.snapshotGeneratedAt,
    stale: false,
    dataQuality: 'verified_metrics',
    sourceHealth: 'healthy',
    accountCount: preview.accountCount,
    slotsPerAccount: preview.slotsPerAccount,
    scheduleStartAt: preview.scheduleStartAt || '',
    scheduleDays: Number(preview.scheduleDays || 0),
    total: preview.assignments.length,
    accounts: preview.routes,
    routes: preview.routes,
    assignments: preview.assignments.map(publicAssignment),
    selectionSummary: preview.selectionSummary,
    summary: preview.selectionSummary,
    ranking: preview.ranking,
    capabilities: preview.capabilities,
    videoLimit: preview.videoLimit,
    authorizationRequired: {
      paidAuthorized: true,
      confirmPaid: true,
      autoSubmit: true,
      delivery: preview.scheduleStartAt
        ? 'SocialEcho status:1 scheduled task with required scheduled_at'
        : 'SocialEcho status:0 draft only'
    },
    zeroPaidSubmissions: true
  };
}

function exactPreflightStatus(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '');
  if (code === 'provider_timeout') return 504;
  if (['provider_transport', 'provider_invalid_json', 'provider_protocol'].includes(code)) return 502;
  if (code === 'provider_http') {
    if ([401, 403].includes(status)) return 503;
    if (status === 429) return 429;
    return 502;
  }
  if ([401, 403].includes(status)) return 503;
  if (status === 408 || !status) return 504;
  if (status === 429) return 429;
  if (status >= 500) return status;
  if (status === 404 || status === 409) return 502;
  return 422;
}

function exactAssignmentKey(assignment = {}) {
  return `${String(assignment.applicationId || '').trim()}:${String(assignment.sku || '').trim()}`;
}

function replaceExactCandidate(booksByAccount, routes, key, exact, canonicalizedKeys) {
  let changed = false;
  const routeByAccount = new Map(routes.map((route) => [Number(route.accountId), route]));
  for (const [accountId, books] of booksByAccount.entries()) {
    const delivery = routeByAccount.get(Number(accountId));
    if (!delivery || `${delivery.applicationId}:` !== key.slice(0, String(delivery.applicationId || '').length + 1)) continue;
    booksByAccount.set(Number(accountId), books.map((book) => {
      const candidateKey = `${delivery.applicationId}:${String(book?.bookSkuId || '').trim()}`;
      if (candidateKey !== key) return book;
      const titleChanged = String(book.title || '') !== String(exact.title || '');
      if (titleChanged) {
        changed = true;
        canonicalizedKeys.add(key);
      }
      return {
        ...book,
        title: exact.title,
        bookSkuId: exact.bookSkuId,
        p0Receipt: rebindP0ReceiptBook(book.p0Receipt, {
          delivery,
          title: book.title,
          sku: book.bookSkuId
        }, exact),
        ownershipVerified: true,
        automationReady: true
      };
    }));
  }
  return changed;
}

function removeExactCandidate(booksByAccount, routes, key) {
  const routeByAccount = new Map(routes.map((route) => [Number(route.accountId), route]));
  for (const [accountId, books] of booksByAccount.entries()) {
    const route = routeByAccount.get(Number(accountId));
    if (!route) continue;
    booksByAccount.set(Number(accountId), books.filter((book) => `${route.applicationId}:${String(book?.bookSkuId || '').trim()}` !== key));
  }
}

async function verifyCampaignAssignments({ routes = [], booksByAccount = new Map(), recentRuns = [], itemsPerAccount = 3, avoidDays = 14 }, deps) {
  const workingBooks = new Map([...booksByAccount.entries()].map(([accountId, books]) => [Number(accountId), [...books]]));
  const exactByKey = new Map();
  const canonicalizedKeys = new Set();
  const rejectedKeys = new Set();
  let exactLookupCount = 0;
  let selected;

  for (let pass = 1; pass <= EXACT_SELECTION_MAX_PASSES; pass += 1) {
    try {
      selected = selectCampaignBooks({ routes, booksByAccount: workingBooks, recentRuns, itemsPerAccount, avoidDays });
    } catch (error) {
      throw httpError(safeError(error, 'Verified ranking could not fill every exact-book slot'), 409);
    }
    const unique = new Map();
    for (const assignment of selected.assignments) {
      const sku = String(assignment?.sku || '').trim();
      const applicationId = String(assignment?.applicationId || '').trim();
      if (!sku || !applicationId) throw httpError('Campaign exact-book preflight requires every application ID and SKU', 409);
      const key = exactAssignmentKey(assignment);
      if (!unique.has(key)) unique.set(key, assignment);
    }

    let mustReselect = false;
    const entries = [...unique.entries()].filter(([key]) => !exactByKey.has(key) && !rejectedKeys.has(key));
    for (let index = 0; index < entries.length; index += EXACT_PREFLIGHT_CONCURRENCY) {
      const group = entries.slice(index, index + EXACT_PREFLIGHT_CONCURRENCY);
      exactLookupCount += group.length;
      const settled = await Promise.allSettled(group.map(([, assignment]) => deps.findExactBook(
        assignment.title,
        assignment.sku,
        { applicationId: assignment.applicationId }
      )));
      for (let offset = 0; offset < settled.length; offset += 1) {
        const result = settled[offset];
        const [key, assignment] = group[offset];
        if (result.status === 'rejected') {
          const reason = result.reason;
          if (['exact_not_found', 'exact_mismatch'].includes(String(reason?.code || ''))) {
            rejectedKeys.add(key);
            removeExactCandidate(workingBooks, routes, key);
            mustReselect = true;
            continue;
          }
          throw httpError(
            `${assignment.appName} exact-book preflight is temporarily unavailable for SKU ${assignment.sku}: ${safeError(reason, 'bookstore identity unavailable')}`,
            exactPreflightStatus(reason)
          );
        }
        const exact = result.value || {};
        if (String(exact.bookSkuId || '') !== String(assignment.sku || '') || !titleKey(exact.title)) {
          rejectedKeys.add(key);
          removeExactCandidate(workingBooks, routes, key);
          mustReselect = true;
          continue;
        }
        exactByKey.set(key, exact);
      }
    }

    for (const [key] of unique) {
      const exact = exactByKey.get(key);
      if (!exact) {
        if (!rejectedKeys.has(key)) {
          removeExactCandidate(workingBooks, routes, key);
          mustReselect = true;
        }
        continue;
      }
      if (replaceExactCandidate(workingBooks, routes, key, exact, canonicalizedKeys)) mustReselect = true;
    }
    const repeatedExactGroups = new Map();
    for (const assignment of selected.assignments) {
      const groupKey = `${assignment.accountId}:${exactAssignmentKey(assignment)}`;
      if (!repeatedExactGroups.has(groupKey)) repeatedExactGroups.set(groupKey, []);
      repeatedExactGroups.get(groupKey).push(assignment);
    }
    for (const group of repeatedExactGroups.values()) {
      if (group.length < 2) continue;
      const key = exactAssignmentKey(group[0]);
      const exact = exactByKey.get(key);
      const chapterCount = Number(exact?.chapterCount || 0);
      if (chapterCount > 0 && chapterCount < group.length * 3) {
        rejectedKeys.add(key);
        exactByKey.delete(key);
        removeExactCandidate(workingBooks, routes, key);
        mustReselect = true;
      }
    }
    if (mustReselect) continue;

    const verified = selected.assignments.map((assignment) => {
      const exact = exactByKey.get(exactAssignmentKey(assignment)) || {};
      // Exact preflight already proved this target-application record. Carry a
      // compact canonical identity into the run so P1 does not repeat the same
      // Writer Admin lookup once for every campaign slot.
      const verifiedBook = {
        title: String(exact.title || assignment.title || ''),
        bookSkuId: String(exact.bookSkuId || assignment.sku || ''),
        cityBookId: String(exact.cityBookId || ''),
        cover: String(exact.cover || ''),
        category: String(exact.category || ''),
        tags: Array.isArray(exact.tags) ? exact.tags : [],
        description: String(exact.description || ''),
        chapterCount: Number(exact.chapterCount || 0),
        words: Number(exact.words || 0),
        payPoint: Number(exact.payPoint || 0)
      };
      return {
        ...assignment,
        verifiedBook,
        exactIdentityVerified: exactByKey.has(exactAssignmentKey(assignment)),
        canonicalTitleChanged: canonicalizedKeys.has(exactAssignmentKey(assignment))
      };
    });
    if (verified.some((assignment) => !assignment.exactIdentityVerified)) {
      throw httpError('Campaign exact-book preflight did not reach a complete fixed point', 409);
    }
    return {
      assignments: verified,
      summary: {
        ...selected.summary,
        exactIdentityVerified: verified.length,
        uniqueExactLookups: exactLookupCount,
        rejectedExactCandidates: rejectedKeys.size,
        canonicalTitleCorrections: verified.filter((assignment) => assignment.canonicalTitleChanged).length,
        exactSelectionPasses: pass
      }
    };
  }

  throw httpError('Campaign exact-book preflight could not stabilize after replacing invalid or renamed candidates', 409);
}

function confirmationClaims(preview, now) {
  return {
    v: 1,
    type: 'daily_campaign_preview',
    previewId: preview.id,
    campaignId: preview.campaignId,
    selectionDigest: preview.selectionDigest,
    accountCount: preview.accountCount,
    slotsPerAccount: preview.slotsPerAccount,
    iat: now,
    exp: Date.parse(preview.expiresAt)
  };
}

function readConfirmation(token, deps) {
  const claims = deps.readScopedToken(CAMPAIGN_TOKEN_SCOPE, token);
  if (!claims || claims.v !== 1 || claims.type !== 'daily_campaign_preview'
    || !PREVIEW_ID_PATTERN.test(String(claims.previewId || ''))
    || !CAMPAIGN_ID_PATTERN.test(String(claims.campaignId || ''))
    || !/^[a-f0-9]{64}$/.test(String(claims.selectionDigest || ''))) {
    throw httpError('Campaign confirmation token is invalid; generate a new preview', 409);
  }
  return claims;
}

async function saveCampaign(redis, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await redis.set(campaignKey(manifest.id), JSON.stringify(manifest));
  await redis.zadd(CAMPAIGN_INDEX, { score: Date.parse(manifest.createdAt) || Date.now(), member: manifest.id });
  return manifest;
}

async function acquireCampaignLock(redis, id) {
  const key = campaignLockKey(id);
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, { nx: true, ex: 900 });
  return acquired ? { key, token } : null;
}

async function releaseCampaignLock(redis, lock) {
  if (!lock) return;
  try {
    const current = await redis.get(lock.key);
    if (String(current || '') === lock.token) await redis.del(lock.key);
  } catch {}
}

function makeRunInput(assignment, campaign, deps) {
  const delivery = normalizeDelivery({ accountId: assignment.accountId });
  if (!delivery) throw httpError(`Campaign slot ${assignment.index + 1} has an invalid delivery route`, 409);
  const p0Selection = p0SelectionFromReceipt(assignment.p0Receipt, {
    delivery,
    title: assignment.title,
    sku: assignment.sku
  });
  const campaignSlot = Number(assignment.index) + 1;
  const scheduledAt = typeof campaign.scheduledAtForAssignment === 'function'
    ? campaign.scheduledAtForAssignment(assignment)
    : '';
  const exact = assignment.verifiedBook && typeof assignment.verifiedBook === 'object'
    ? assignment.verifiedBook
    : {};
  return deps.buildRunInput({
    title: String(exact.title || assignment.title || ''),
    bookSkuId: String(exact.bookSkuId || assignment.sku || ''),
    cityBookId: String(exact.cityBookId || ''),
    cover: String(exact.cover || ''),
    category: String(exact.category || ''),
    tags: Array.isArray(exact.tags) ? exact.tags : [],
    description: String(exact.description || ''),
    chapterCount: Number(exact.chapterCount || 0),
    words: Number(exact.words || 0),
    payPoint: Number(exact.payPoint || 0)
  }, {
    source: `daily_campaign_${campaign.day}`,
    delivery,
    accountId: assignment.accountId,
    fullBookEvidence: true,
    paidAuthorized: true,
    paidMediaSubmissionAuthorized: true,
    // This campaign delivers video drafts only. Poster generation is an
    // optional branch and is explicitly disabled so an image-provider pause
    // cannot hold P4-P7.
    posterGenerationRequired: false,
    p0Selection,
    creativeProfile: {
      ...(assignment.creativeProfile || {}),
      campaignId: campaign.id,
      campaignSlot,
      accountSlot: Number(assignment.slot),
      uniquenessRequired: true
    },
    campaign: {
      id: campaign.id,
      itemIndex: Number(assignment.index),
      slot: Number(assignment.slot),
      selectionTier: assignment.selectionTier,
      autoSocialEchoDraft: true,
      paidMediaAuthorized: true,
      deliveryMode: scheduledAt ? 'scheduled' : 'draft',
      ...(scheduledAt ? { scheduledAt } : {})
    }
  });
}

function scheduledAtForAssignment(assignment, startAt) {
  const start = new Date(String(startAt || ''));
  if (!Number.isFinite(start.getTime())) return '';
  const slot = Math.max(1, Number(assignment?.slot || 1));
  const dayOffset = slot >= 3 ? 1 : 0;
  const windowHour = slot % 2 === 1 ? 14 : 20;
  const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(start).reduce((parts, item) => {
    if (item.type !== 'literal') parts[item.type] = Number(item.value);
    return parts;
  }, {});
  // Construct the intended China Standard Time wall clock explicitly. Vercel
  // runs in UTC, so local Date setters would shift a 14:00 slot by eight hours.
  return new Date(Date.UTC(
    shanghaiDate.year,
    shanghaiDate.month - 1,
    shanghaiDate.day + dayOffset,
    windowHour - 8,
    Number(assignment?.accountIndex || 0) * 10,
    0,
    0
  )).toISOString();
}

function initialManifest(preview, claims, deps) {
  const now = new Date(deps.now()).toISOString();
  const scheduledDelivery = Boolean(preview.scheduleStartAt && Number(preview.scheduleDays || 0) > 0);
  const manifest = {
    version: 1,
    id: preview.campaignId,
    previewId: preview.id,
    selectionDigest: preview.selectionDigest,
    day: preview.day,
    snapshotGeneratedAt: preview.snapshotGeneratedAt,
    dataQuality: preview.dataQuality,
    sourceHealth: preview.sourceHealth,
    stale: false,
    createdAt: now,
    updatedAt: now,
    status: 'reserving',
    phase: 'reservation_planned',
    accountCount: preview.accountCount,
    slotsPerAccount: preview.slotsPerAccount,
    scheduleStartAt: preview.scheduleStartAt || '',
    scheduleDays: Number(preview.scheduleDays || 0),
    total: preview.assignments.length,
    routes: preview.routes,
    selectionSummary: preview.selectionSummary,
    ranking: preview.ranking,
    capabilities: preview.capabilities,
    videoLimit: preview.videoLimit,
    authorization: {
      status: 'authorized',
      authorizedAt: now,
      previewIssuedAt: new Date(Number(claims.iat)).toISOString(),
      scope: 'exact_campaign_slots',
      paidAuthorized: true,
      paidMediaSubmissionAuthorized: true,
      autoSocialEchoDraft: true,
      formalPublishing: false,
      socialEchoStatus: scheduledDelivery ? 1 : 0,
      deliveryMode: scheduledDelivery ? 'scheduled' : 'draft'
    },
    slots: preview.assignments.map((assignment) => {
      const input = makeRunInput(assignment, {
        id: preview.campaignId,
        day: preview.day,
        scheduledAtForAssignment: preview.scheduleStartAt
          ? (item) => scheduledAtForAssignment(item, preview.scheduleStartAt)
          : null
      }, deps);
      const run = deps.newRun(input);
      return {
        ...publicAssignment(assignment),
        p0Selection: input.p0Selection,
        runInput: input,
        runId: run.id,
        reservationStatus: 'planned'
      };
    }),
    events: [{ at: now, type: 'campaign_authorized', message: `One exact ${preview.assignments.length}-slot paid campaign and SocialEcho ${scheduledDelivery ? 'status:1 scheduled-task' : 'status:0 draft'} delivery were authorized` }]
  };
  manifest.runIds = manifest.slots.map((slot) => slot.runId);
  return manifest;
}

function runFromSlot(slot, manifest, deps) {
  const run = deps.newRun(slot.runInput);
  run.id = slot.runId;
  run.state = 'reserved';
  run.events = [...(run.events || []), {
    at: new Date().toISOString(),
    type: 'campaign_slot_reserved',
    message: `Campaign ${manifest.id} reserved all run identity and authorization before worker release`
  }].slice(-120);
  return run;
}

function slotFamilyKey(slot = {}) {
  const sku = String(slot?.runInput?.sku || slot?.sku || '').trim().toLowerCase();
  const accountId = Number(slot?.runInput?.delivery?.accountId || slot?.accountId || 0) || 0;
  return `${sku}:${accountId}`;
}

function slotVariantKey(slot = {}) {
  const campaignId = String(slot?.runInput?.campaign?.id || '').trim();
  const itemIndex = Number(slot?.runInput?.campaign?.itemIndex);
  return `${campaignId}:${Number.isInteger(itemIndex) ? itemIndex : 'invalid'}`;
}

function runMatchesCampaignSlot(run, slot, manifest) {
  if (!run || !slot) return false;
  const expectedProfile = slot.runInput?.creativeProfile || {};
  const actualProfile = run.input?.creativeProfile || {};
  return String(run.id || '') === String(slot.runId || '')
    && String(run.input?.campaign?.id || '') === String(manifest.id || '')
    && Number(run.input?.campaign?.itemIndex) === Number(slot.runInput?.campaign?.itemIndex)
    && String(run.input?.sku || '').trim().toLowerCase() === String(slot.runInput?.sku || '').trim().toLowerCase()
    && Number(run.input?.delivery?.accountId || 0) === Number(slot.runInput?.delivery?.accountId || 0)
    && String(actualProfile.sceneVariant || '') === String(expectedProfile.sceneVariant || '')
    && Number(actualProfile.sceneLane ?? -1) === Number(expectedProfile.sceneLane ?? -1)
    && Number(actualProfile.sceneRepeatIndex || 0) === Number(expectedProfile.sceneRepeatIndex || 0)
    && Number(actualProfile.sceneRepeatCount || 0) === Number(expectedProfile.sceneRepeatCount || 0);
}

function campaignSlotGroups(manifest = {}) {
  const slots = Array.isArray(manifest.slots) ? manifest.slots : [];
  if (!slots.length || slots.length !== Number(manifest.total || 0)) {
    throw httpError('Campaign manifest does not contain its complete slot set', 409);
  }
  const runIds = new Set();
  const variants = new Set();
  const groups = new Map();
  for (const slot of slots) {
    const family = slotFamilyKey(slot);
    const variant = slotVariantKey(slot);
    const profile = slot.runInput?.creativeProfile || {};
    if (!String(slot.runInput?.sku || '').trim() || !Number(slot.runInput?.delivery?.accountId || 0)
      || String(slot.runInput?.campaign?.id || '') !== String(manifest.id || '')
      || !Number.isInteger(Number(slot.runInput?.campaign?.itemIndex))
      || !String(profile.sceneVariant || '').trim()) {
      throw httpError(`Campaign slot ${Number(slot.index || 0) + 1} has an incomplete immutable identity`, 409);
    }
    if (runIds.has(String(slot.runId || ''))) throw httpError('Campaign manifest contains a duplicate run ID', 409);
    if (variants.has(variant)) throw httpError('Campaign manifest contains a duplicate campaign variant', 409);
    runIds.add(String(slot.runId || ''));
    variants.add(variant);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(slot);
  }
  for (const [family, familySlots] of groups) {
    if (familySlots.length === 1) continue;
    if (manifest.scheduleDays === 2 && familySlots.length === 4) {
      const lanes = familySlots.map((slot) => Number(slot.runInput?.creativeProfile?.sceneLane)).sort((a, b) => a - b);
      const indexes = familySlots.map((slot) => Number(slot.runInput?.creativeProfile?.sceneRepeatIndex)).sort((a, b) => a - b);
      const repeatCounts = familySlots.map((slot) => Number(slot.runInput?.creativeProfile?.sceneRepeatCount));
      if (lanes.join(',') !== '0,1,2,3' || indexes.join(',') !== '1,2,3,4'
        || repeatCounts.some((value) => value !== 4)
        || familySlots.some((slot) => slot.runInput?.creativeProfile?.uniquenessRequired !== true)) {
        throw httpError(`Campaign family ${family} is missing its four-lane scheduled scene contract`, 409);
      }
      continue;
    }
    if (familySlots.length !== 2) throw httpError(`Campaign family ${family} contains more than two active scene variants`, 409);
    const lanes = familySlots.map((slot) => Number(slot.runInput?.creativeProfile?.sceneLane)).sort((a, b) => a - b);
    const indexes = familySlots.map((slot) => Number(slot.runInput?.creativeProfile?.sceneRepeatIndex)).sort((a, b) => a - b);
    const repeatCounts = familySlots.map((slot) => Number(slot.runInput?.creativeProfile?.sceneRepeatCount));
    const sceneVariants = new Set(familySlots.map((slot) => String(slot.runInput?.creativeProfile?.sceneVariant || '')));
    if (lanes.join(',') !== '0,2' || indexes.join(',') !== '1,2'
      || repeatCounts.some((value) => value !== 2) || sceneVariants.size !== 2
      || familySlots.some((slot) => slot.runInput?.creativeProfile?.uniquenessRequired !== true)) {
      throw httpError(`Campaign family ${family} is missing its reviewed non-overlapping scene contract`, 409);
    }
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

async function acquireSlotLocks(redis, manifest, deps) {
  const locks = [];
  try {
    const groups = campaignSlotGroups(manifest);
    for (const [, familySlots] of groups) {
      for (const slot of familySlots) {
        const existing = await deps.getRun(redis, slot.runId);
        if (existing && !runMatchesCampaignSlot(existing, slot, manifest)) {
          throw httpError(`Reserved run ID collision at campaign slot ${slot.index + 1}`, 409);
        }
      }
      const representative = familySlots[0];
      const lock = await deps.acquireRunCreation(redis, representative.runInput.sku, representative.accountId);
      if (!lock?.acquired) throw httpError(`Campaign slot family at ${representative.index + 1} is being reserved by another request`, 409);
      locks.push(lock);
      const activeRuns = typeof deps.listActiveRuns === 'function'
        ? await deps.listActiveRuns(redis, representative.runInput.sku, representative.accountId)
        : [await deps.findActiveRun(redis, representative.runInput.sku, representative.accountId)].filter(Boolean);
      for (const active of activeRuns) {
        const expectedSlot = familySlots.find((slot) => String(slot.runId) === String(active.id));
        if (!expectedSlot || !runMatchesCampaignSlot(active, expectedSlot, manifest)) {
          throw httpError(`${representative.accountTitle} already has another active run for “${representative.title}”; refresh the campaign preview`, 409);
        }
      }
    }
    return locks;
  } catch (error) {
    await Promise.allSettled(locks.map((lock) => deps.releaseRunCreation(redis, lock)));
    throw error;
  }
}

async function persistAndReleaseCampaign(redis, manifest, deps) {
  const slotLocks = await acquireSlotLocks(redis, manifest, deps);
  try {
    // The complete manifest, including every deterministic run ID and input,
    // is durable before the first run record can become visible to a worker.
    await saveCampaign(redis, manifest);
    for (const slot of manifest.slots) {
      let run = await deps.getRun(redis, slot.runId);
      if (!run) {
        run = runFromSlot(slot, manifest, deps);
        await deps.saveRun(redis, run);
      }
      // `reserved` is an active, non-worker-visible state. Register it now,
      // while its creation lock is still owned, so the legacy single-run API
      // cannot create another paid path during the all-36 persistence phase.
      await deps.registerActiveRun(redis, run);
      slot.reservationStatus = run.state === 'reserved' ? 'persisted' : 'released';
    }
    manifest.phase = 'reservation_complete';
    manifest.status = 'reserved';
    manifest.allRunsPersistedAt = new Date().toISOString();
    manifest.events.push({ at: manifest.allRunsPersistedAt, type: 'all_runs_persisted', message: 'All campaign run IDs and paid authorizations are durable; worker release may begin' });
    await saveCampaign(redis, manifest);

    // Releasing means changing the already-persisted run from the private
    // reservation state to the normal durable cron worker queue.
    for (const slot of manifest.slots) {
      const run = await deps.getRun(redis, slot.runId);
      if (!run) throw httpError(`Reserved run ${slot.runId} disappeared before worker release`, 503);
      if (run.state === 'reserved') {
        run.state = 'queued';
        deps.addEvent(run, 'campaign_worker_released', `Campaign ${manifest.id} released this slot after all ${manifest.total} reservations were durable`);
        await deps.saveRun(redis, run);
      }
      await deps.registerActiveRun(redis, run);
      slot.reservationStatus = 'released';
    }
    manifest.phase = 'released';
    manifest.status = 'active';
    manifest.releasedAt = new Date().toISOString();
    manifest.events.push({ at: manifest.releasedAt, type: 'worker_queue_released', message: 'All 36 slots were released to the durable P0-P7 worker queue' });
    await saveCampaign(redis, manifest);
    return manifest;
  } catch (error) {
    manifest.status = 'reservation_incomplete';
    manifest.lastError = safeError(error);
    manifest.events = [...(manifest.events || []), {
      at: new Date().toISOString(), type: 'campaign_reservation_interrupted', message: manifest.lastError
    }].slice(-80);
    await saveCampaign(redis, manifest).catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled(slotLocks.map((lock) => deps.releaseRunCreation(redis, lock)));
  }
}

function stageProjection(run) {
  return Object.fromEntries(Object.entries(run?.stages || {}).map(([name, stage]) => [name, {
    status: String(stage?.status || 'waiting'),
    phase: String(stage?.phase || ''),
    blockedReason: String(stage?.blockedReason || ''),
    error: String(stage?.error || '').slice(0, 240)
  }]));
}

async function campaignStatus(redis, manifest, deps) {
  const statuses = await Promise.all(manifest.slots.map(async (slot) => {
    const [run, draft] = await Promise.all([
      deps.getRun(redis, slot.runId),
      deps.getDraft(redis, deps.draftIdForRun(slot.runId))
    ]);
    const currentStage = ['P0', 'P1', 'P2', 'P3', 'P3_5', 'P4', 'P5', 'P6', 'P7']
      .find((name) => String(run?.stages?.[name]?.status || 'waiting') !== 'done') || 'P7';
    return {
      ...publicAssignment(slot),
      runId: slot.runId,
      reservationStatus: slot.reservationStatus,
      runState: run?.state || 'missing',
      state: run?.state || 'missing',
      status: draft?.status || run?.state || 'missing',
      currentStage,
      stages: stageProjection(run),
      draftId: draft?.id || '',
      publication: draft ? {
        id: draft.id,
        status: draft.status,
        externalDraftId: String(draft.provider?.externalDraftId || '')
      } : null,
      draft: draft ? {
        id: draft.id,
        status: draft.status,
        externalDraftId: String(draft.provider?.externalDraftId || ''),
        accountId: Number(draft.accountId || 0),
        socialEchoStatus: slot.runInput?.campaign?.deliveryMode === 'scheduled' ? 1 : 0,
        error: String(draft.error || '').slice(0, 240)
      } : null
    };
  }));
  const stageCounts = {};
  for (const stageName of ['P0', 'P1', 'P2', 'P3', 'P3_5', 'P4', 'P5', 'P6', 'P7']) {
    stageCounts[stageName] = {};
    for (const slot of statuses) {
      const value = slot.stages?.[stageName]?.status || 'missing';
      stageCounts[stageName][value] = Number(stageCounts[stageName][value] || 0) + 1;
    }
  }
  const stateCounts = {};
  const draftCounts = {};
  for (const slot of statuses) {
    stateCounts[slot.runState] = Number(stateCounts[slot.runState] || 0) + 1;
    const draftStatus = slot.draft?.status || 'missing';
    draftCounts[draftStatus] = Number(draftCounts[draftStatus] || 0) + 1;
  }
  const outcomeCounts = {
    total: statuses.length,
    created: statuses.filter((slot) => slot.runState !== 'missing').length,
    waiting: statuses.filter((slot) => ['reserved', 'queued'].includes(slot.runState)).length,
    running: statuses.filter((slot) => slot.runState === 'running').length,
    failed: statuses.filter((slot) => ['failed', 'blocked'].includes(slot.runState)
      || ['failed', 'publish_ambiguous'].includes(String(slot.draft?.status || ''))).length,
    draft: statuses.filter((slot) => slot.draft?.status === 'external_draft').length,
    runStates: stateCounts,
    drafts: draftCounts,
    stages: stageCounts
  };
  const publicManifest = {
      id: manifest.id,
      campaignId: manifest.id,
      previewId: manifest.previewId,
      selectionDigest: manifest.selectionDigest,
      day: manifest.day,
      snapshotGeneratedAt: manifest.snapshotGeneratedAt,
      dataQuality: manifest.dataQuality,
      sourceHealth: manifest.sourceHealth,
      stale: manifest.stale === true,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      status: manifest.status,
      phase: manifest.phase,
      accountCount: manifest.accountCount,
      slotsPerAccount: manifest.slotsPerAccount,
      scheduleStartAt: manifest.scheduleStartAt || '',
      scheduleDays: Number(manifest.scheduleDays || 0),
      total: manifest.total,
      routes: manifest.routes,
      selectionSummary: manifest.selectionSummary,
      ranking: manifest.ranking,
      capabilities: manifest.capabilities,
      videoLimit: manifest.videoLimit,
      authorization: manifest.authorization,
      allRunsPersistedAt: manifest.allRunsPersistedAt || '',
      releasedAt: manifest.releasedAt || '',
      lastError: manifest.lastError || '',
      events: (manifest.events || []).slice(-20),
      runIds: manifest.runIds,
      assignments: statuses,
      items: statuses,
      slots: statuses,
      stageCounts,
      counts: outcomeCounts
    };
  return {
    campaign: publicManifest,
    campaignId: manifest.id,
    runIds: manifest.runIds,
    assignments: statuses,
    items: statuses,
    slots: statuses,
    stageCounts,
    counts: outcomeCounts
  };
}

function defaultDependencies(overrides = {}) {
  return {
    getRedis: store.getRedis,
    listRunSummaries: store.listRunSummaries,
    getRun: store.getRun,
    saveRun: store.saveRun,
    newRun: store.newRun,
    addEvent: store.addEvent,
    registerActiveRun: store.registerActiveRun,
    findActiveRun: store.findActiveRun,
    listActiveRuns: store.listActiveRuns,
    acquireRunCreation: store.acquireRunCreation,
    releaseRunCreation: store.releaseRunCreation,
    videoCapacity: store.videoCapacity,
    getDraft,
    draftIdForRun,
    buildRunInput: runsApi.buildRunInput,
    requireSession: auth.requireSession,
    requireOperatorMutation: auth.requireOperatorMutation,
    scopedToken: auth.scopedToken,
    readScopedToken: auth.readScopedToken,
    consumeRateLimit,
    requestIdentity,
    listAccounts: socialecho.listAccounts,
    findExactBook: providers.findExactBook,
    leaderboardHandler,
    now: () => Date.now(),
    randomId: () => crypto.randomUUID().replace(/-/g, ''),
    loadRankings: loadRealtimeRankingsV2,
    capabilities: runtimeCapabilities,
    ...overrides
  };
}

function createHandler(overrides = {}) {
  const deps = defaultDependencies(overrides);
  return async (req, res) => {
    const method = String(req.method || '').toUpperCase();
    const action = String(req.body?.action || '').trim().toLowerCase();
    if (method === 'GET') {
      if (!deps.requireSession(req, res)) return;
    } else if (method === 'POST') {
      if (action === 'create') {
        if (!deps.requireOperatorMutation(req, res)) return;
      } else if (!deps.requireSession(req, res)) return;
    }
    const redis = deps.getRedis();
    if (!redis) return res.status(503).json({ error: 'Social console storage is not configured' });
    try {
      if (method === 'GET') {
        const id = String(req.query?.campaignId || '').trim();
        if (!CAMPAIGN_ID_PATTERN.test(id)) return res.status(400).json({ error: 'A valid campaignId is required' });
        const manifest = parseStored(await redis.get(campaignKey(id)));
        if (!manifest) return res.status(404).json({ error: 'Campaign not found' });
        return res.status(200).json(await campaignStatus(redis, manifest, deps));
      }
      if (method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const rate = await deps.consumeRateLimit(
        redis,
        action === 'create' ? 'daily_campaign_create' : 'daily_campaign_preview',
        deps.requestIdentity(req),
        action === 'create' ? 2 : 6,
        action === 'create' ? 10 * 60 : 5 * 60
      );
      if (!rate.allowed) {
        if (typeof res.setHeader === 'function') res.setHeader('Retry-After', String(rate.retryAfter));
        return res.status(429).json({ error: 'Daily campaign request limit reached; wait before retrying' });
      }

      // One-time repair for a scheduled 44-slot manifest created by an older
      // deployment before schedule fields were persisted into run inputs.
      // This only fills missing schedule metadata; it never resubmits media.
      if (action === 'repair_schedule') {
        const id = String(req.body?.campaignId || '').trim();
        if (!CAMPAIGN_ID_PATTERN.test(id)) return res.status(400).json({ error: 'A valid campaignId is required' });
        const manifest = parseStored(await redis.get(campaignKey(id)));
        if (!manifest) return res.status(404).json({ error: 'Campaign not found' });
        if (Number(manifest.total || 0) !== 44) return res.status(409).json({ error: 'Only the authorized 44-slot campaign can be repaired' });
        const scheduleStartAt = String(req.body?.scheduleStartAt || manifest.scheduleStartAt || '2026-08-27T14:00:00+08:00');
        if (!Number.isFinite(Date.parse(scheduleStartAt))) return res.status(400).json({ error: 'Invalid scheduleStartAt' });
        manifest.scheduleStartAt = scheduleStartAt;
        manifest.scheduleDays = 2;
        for (const slot of manifest.slots || []) {
          const scheduledAt = scheduledAtForAssignment(slot, scheduleStartAt);
          slot.runInput = slot.runInput || {};
          slot.runInput.campaign = { ...(slot.runInput.campaign || {}), deliveryMode: 'scheduled', scheduledAt };
          const run = await deps.getRun(redis, slot.runId);
          if (run && !run.artifacts?.review?.socialEchoDraftId) {
            run.input = run.input || {};
            run.input.campaign = { ...(run.input.campaign || {}), deliveryMode: 'scheduled', scheduledAt };
            // Runs created just before the model-router deployment may carry
            // a stale self-fallback (GLM -> GLM). Clear that marker so the
            // current worker can retry GLM once and then switch correctly to
            // DeepSeek V4 Flash Preview on a definitive model failure.
            const creativeRoute = run.artifacts?.creativeDraft?.modelRoute;
            if (creativeRoute?.fallbackUsed === true
              && String(creativeRoute.activeModel || '') === 'glm-5.3-flash'
              && !run.artifacts?.video?.threadId) {
              creativeRoute.fallbackUsed = false;
              creativeRoute.fallbackModel = '';
              run.artifacts.creativeDraft.modelRoute = creativeRoute;
              if (run.artifacts.modelRoute) {
                run.artifacts.modelRoute.fallbackUsed = false;
                run.artifacts.modelRoute.fallbackModel = '';
              }
              if (run.stages?.P3?.status === 'waiting' && run.stages.P3.phase === 'model_capacity_wait') {
                run.stages.P3.nextAttemptAt = new Date().toISOString();
              }
            }
            await deps.saveRun(redis, run);
          }
        }
        await saveCampaign(redis, manifest);
        return res.status(200).json({ repaired: true, campaignId: id, total: manifest.total, scheduleStartAt, scheduleDays: 2 });
      }

      const scheduledMode = String(req.body?.mode || req.body?.campaignType || '').toLowerCase() === 'scheduled_44'
        || Number(req.body?.scheduleDays || 0) === 2;
      const accountCount = Number(req.body?.accountCount || (scheduledMode ? 11 : 12));
      const slotsPerAccount = Number(req.body?.slotsPerAccount || (scheduledMode ? 4 : 3));
      const itemsPerAccount = req.body?.itemsPerAccount == null ? slotsPerAccount : Number(req.body.itemsPerAccount);
      const totalSlots = req.body?.totalSlots == null ? accountCount * slotsPerAccount : Number(req.body.totalSlots);
      const suppliedAccountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds.map(Number) : null;
      const scheduledAccountIds = ALL_ACCOUNT_ROUTES.filter((route) => route.appKey !== 'novelflow').map((route) => route.accountId);
      const expectedAccountIds = scheduledMode ? scheduledAccountIds : DEFAULT_DAILY_ACCOUNT_IDS;
      const accountIdsMatch = !suppliedAccountIds
        || (scheduledMode
          ? suppliedAccountIds.length === 11
            && suppliedAccountIds.every((accountId) => expectedAccountIds.includes(accountId))
          : suppliedAccountIds.length === expectedAccountIds.length
            && suppliedAccountIds.every((accountId, index) => accountId === expectedAccountIds[index]));
      const contractOk = scheduledMode
        ? accountCount === 11 && slotsPerAccount === 4 && itemsPerAccount === 4 && totalSlots === 44 && accountIdsMatch
        : accountCount === 12 && slotsPerAccount === 3 && itemsPerAccount === 3 && totalSlots === 36 && accountIdsMatch;
      if (!contractOk) {
        return res.status(400).json({ error: scheduledMode
          ? 'Scheduled campaign contract is exactly 11 non-NovelFlow accounts × 4 slots (44 total)'
          : 'Daily campaign contract is exactly 12 accounts × 3 slots' });
      }
      if (action === 'preview') {
        const rankingDays = [1, 7, 30].includes(Number(req.body?.rankingDays)) ? Number(req.body.rankingDays) : 7;
        const avoidDays = Math.max(1, Math.min(Number(req.body?.avoidDays) || 14, 90));
        const [liveAccounts, videoLimit] = await Promise.all([
          deps.listAccounts(),
          deps.videoCapacity(redis)
        ]);
        const capabilities = deps.capabilities();
        const routes = resolveLiveRoutes(liveAccounts, accountCount, { scheduledNonNovelFlow: scheduledMode });
        const ranking = await deps.loadRankings(req, routes, rankingDays, deps);
        const recentRuns = await deps.listRunSummaries(redis, 500);
        const selected = await verifyCampaignAssignments({
          routes,
          booksByAccount: ranking.booksByAccount,
          recentRuns,
          itemsPerAccount: slotsPerAccount,
          avoidDays
        }, deps);
        if (selected.assignments.length !== accountCount * slotsPerAccount) {
          throw httpError(`Verified ranking could not fill all ${totalSlots} quality slots`, 409);
        }
        const now = deps.now();
        const digest = selectionDigest(selected.assignments);
        const day = shanghaiDay(new Date(now));
        const scheduleStartAt = scheduledMode
          ? String(req.body?.scheduleStartAt || '2026-08-27T14:00:00+08:00')
          : '';
        if (scheduledMode) {
          const scheduleMs = Date.parse(scheduleStartAt);
          if (!Number.isFinite(scheduleMs) || scheduleMs < now + 60 * 1000) {
            throw httpError('scheduleStartAt must be a valid future time', 400);
          }
        }
        const id = campaignId(day, { mode: scheduledMode ? 'scheduled_44' : 'daily', accountIds: routes.map((route) => route.accountId), slotsPerAccount, rankingDays, digest, scheduleStartAt });
        const snapshotTimes = Object.values(ranking.meta || {})
          .map((item) => Date.parse(item?.generatedAt || ''))
          .filter(Number.isFinite);
        if (snapshotTimes.length !== new Set(routes.map((route) => route.appKey)).size) {
          throw httpError('Every target application must provide an explicit fresh ranking timestamp', 409);
        }
        const snapshotGeneratedAtMs = Math.min(...snapshotTimes);
        const receiptExpiresAtMs = snapshotGeneratedAtMs + RECEIPT_TTL_MS;
        const confirmationExpiresAtMs = Math.min(now + CONFIRMATION_TTL_MS, receiptExpiresAtMs);
        if (confirmationExpiresAtMs <= now) {
          throw httpError('The oldest application ranking expired while building the campaign; refresh the live preview', 409);
        }
        const preview = {
          version: 1,
          id: `preview_${deps.randomId()}`,
          campaignId: id,
          selectionDigest: digest,
          day,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(confirmationExpiresAtMs).toISOString(),
          receiptExpiresAt: new Date(receiptExpiresAtMs).toISOString(),
          snapshotGeneratedAt: new Date(snapshotGeneratedAtMs).toISOString(),
          stale: false,
          dataQuality: 'verified_metrics',
          sourceHealth: 'healthy',
          accountCount,
          slotsPerAccount,
          scheduleStartAt,
          scheduleDays: scheduledMode ? 2 : 0,
          routes,
          assignments: selected.assignments,
          selectionSummary: selected.summary,
          ranking: { days: rankingDays, avoidDays, apps: ranking.meta },
          capabilities,
          videoLimit
        };
        if (!PREVIEW_ID_PATTERN.test(preview.id)) throw httpError('Unable to allocate a campaign preview ID', 500);
        await redis.set(previewKey(preview.id), JSON.stringify(preview), { ex: PREVIEW_TTL_SECONDS });
        const confirmationToken = deps.scopedToken(CAMPAIGN_TOKEN_SCOPE, confirmationClaims(preview, now));
        return res.status(200).json(publicPreview(preview, confirmationToken));
      }
      if (action === 'retry_failed_creative') {
        const id = String(req.body?.campaignId || '').trim();
        if (!CAMPAIGN_ID_PATTERN.test(id)) return res.status(400).json({ error: 'A valid campaignId is required' });
        const manifest = parseStored(await redis.get(campaignKey(id)));
        if (!manifest) return res.status(404).json({ error: 'Campaign not found' });
        let retried = 0;
        for (const slot of manifest.slots || []) {
          const run = await deps.getRun(redis, slot.runId);
          if (!run || run.stages?.P3?.status !== 'failed') continue;
          const hasPaidTask = Boolean(run.artifacts?.video?.threadId || (run.artifacts?.images || []).some((asset) => asset?.taskId));
          if (hasPaidTask) continue;
          run.input = run.input || {};
          run.input.creativeProfile = { ...(run.input.creativeProfile || {}), modelChoice: 'glm-5.3-flash' };
          run.artifacts = run.artifacts || {};
          run.artifacts.modelRoute = {
            ...(run.artifacts.modelRoute || {}),
            preferredModel: 'glm-5.3-flash',
            activeModel: 'glm-5.3-flash',
            fallbackModel: '',
            fallbackUsed: false,
            fallbackFrom: '',
            switchedAt: '',
            switchReason: ''
          };
          runsApi.resetManualCreativeRetry(run, run.stages.P3);
          run.state = 'running';
          deps.addEvent(run, 'campaign_creative_retry_requested', `Campaign ${id} requeued failed P3 creative without retrying paid media`);
          await deps.saveRun(redis, run);
          retried += 1;
        }
        return res.status(200).json({ ...(await campaignStatus(redis, manifest, deps)), retried });
      }
      if (action !== 'create') return res.status(400).json({ error: 'Unsupported daily campaign action' });
      if (req.body?.paidAuthorized !== true || req.body?.confirmPaid !== true || req.body?.autoSubmit !== true) {
        return res.status(400).json({ error: 'Explicit paid generation and SocialEcho draft authorization are required' });
      }
      if (deps.capabilities().paidMediaAvailable !== true) {
        return res.status(503).json({ error: 'Paid P0-P7 media capability is not currently available' });
      }
      const expectedSocialEchoStatus = scheduledMode ? 1 : 0;
      if (req.body?.publish === true || req.body?.formalPublish === true
        || (req.body?.status !== undefined && Number(req.body.status) !== expectedSocialEchoStatus)) {
        return res.status(400).json({ error: scheduledMode
          ? 'Scheduled campaign delivery is limited to SocialEcho status:1 with its signed future scheduled_at'
          : 'Daily campaign delivery is limited to SocialEcho status:0 drafts' });
      }
      const claims = readConfirmation(String(req.body?.confirmationToken || ''), deps);
      if (req.body?.campaignId && String(req.body.campaignId) !== String(claims.campaignId)) {
        return res.status(409).json({ error: 'Campaign confirmation token does not match the requested campaignId' });
      }
      if (Number(claims.accountCount) !== accountCount || Number(claims.slotsPerAccount) !== slotsPerAccount) {
        return res.status(409).json({ error: 'Campaign confirmation does not match the requested 12 × 3 contract' });
      }
      let manifest = parseStored(await redis.get(campaignKey(claims.campaignId)));
      if (manifest) {
        if (manifest.previewId !== claims.previewId || manifest.selectionDigest !== claims.selectionDigest) {
          return res.status(409).json({ error: 'Campaign ID already belongs to a different signed selection' });
        }
        if (manifest.phase === 'released') {
          return res.status(200).json({ ...(await campaignStatus(redis, manifest, deps)), duplicate: true });
        }
      }
      const lock = await acquireCampaignLock(redis, claims.campaignId);
      if (!lock) {
        manifest = parseStored(await redis.get(campaignKey(claims.campaignId)));
        return res.status(202).json({ campaignId: claims.campaignId, creating: true, ...(manifest ? { phase: manifest.phase, runIds: manifest.runIds || [] } : {}) });
      }
      try {
        manifest = parseStored(await redis.get(campaignKey(claims.campaignId))) || manifest;
        if (!manifest) {
          if (Number(claims.exp || 0) <= deps.now()) throw httpError('Campaign preview expired; refresh live accounts and rankings before authorizing paid generation', 409);
          const preview = parseStored(await redis.get(previewKey(claims.previewId)));
          if (!preview || preview.campaignId !== claims.campaignId || preview.selectionDigest !== claims.selectionDigest) {
            throw httpError('Campaign preview is missing or changed; generate a new live preview', 409);
          }
          if (Date.parse(preview.expiresAt || '') <= deps.now()) throw httpError('Campaign preview expired; generate a new live preview', 409);
          const snapshotAt = Date.parse(preview.snapshotGeneratedAt || '');
          if (preview.stale === true || preview.dataQuality !== 'verified_metrics' || preview.sourceHealth !== 'healthy'
            || !Number.isFinite(snapshotAt) || snapshotAt > deps.now() + 60 * 1000 || deps.now() - snapshotAt > RECEIPT_TTL_MS) {
            throw httpError('Campaign ranking snapshot is stale or unhealthy; generate a new live preview', 409);
          }
          const currentAccounts = await deps.listAccounts();
          const currentLiveIds = new Set(currentAccounts.filter(isOnlineAccount).map((account) => Number(account.id)));
          const newlyOffline = preview.routes.filter((route) => !currentLiveIds.has(Number(route.accountId)));
          if (newlyOffline.length) {
            throw httpError(`Campaign route went offline after preview: ${newlyOffline.map((route) => route.accountId).join(', ')}; refresh the preview`, 409);
          }
          manifest = initialManifest(preview, claims, deps);
        }
        manifest = await persistAndReleaseCampaign(redis, manifest, deps);
        return res.status(202).json(await campaignStatus(redis, manifest, deps));
      } finally {
        await releaseCampaignLock(redis, lock);
      }
    } catch (error) {
      const status = Number(error?.status || 0);
      const safeStatus = status >= 400 && status < 600 ? status : 502;
      console.error('[social/daily-campaign]', safeError(error));
      return res.status(safeStatus).json({ error: safeError(error) });
    }
  };
}

const handler = createHandler();

module.exports = handler;
module.exports.createHandler = createHandler;
module.exports.resolveLiveRoutes = resolveLiveRoutes;
module.exports.mergeRankingPayloads = mergeRankingPayloads;
module.exports.selectionDigest = selectionDigest;
module.exports.campaignStatus = campaignStatus;
module.exports.campaignKey = campaignKey;
module.exports.previewKey = previewKey;
module.exports.CAMPAIGN_INDEX = CAMPAIGN_INDEX;
module.exports.RANKING_AXES = RANKING_AXES;
module.exports.runtimeCapabilities = runtimeCapabilities;
module.exports.campaignSlotGroups = campaignSlotGroups;
module.exports.runMatchesCampaignSlot = runMatchesCampaignSlot;
module.exports.loadRealtimeRankings = loadRealtimeRankingsV2;
module.exports.qualityCandidateCount = qualityCandidateCount;
module.exports.fallbackSpecs = fallbackSpecs;
module.exports.verifyCampaignAssignments = verifyCampaignAssignments;
module.exports.scheduledAtForAssignment = scheduledAtForAssignment;
module.exports.makeRunInput = makeRunInput;
