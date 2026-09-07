const APPS = Object.freeze({
  novelflow: Object.freeze({
    key: 'novelflow',
    name: 'NovelFlow',
    productLine: 'novelflow',
    applicationId: '642fc1ace309494378a774a6',
    codeMin: 40000,
    codeMax: 49999,
    counterStart: 44443,
    counterKey: 'nf_social:next_code',
    attributedLinks: true
  }),
  maxnovel: Object.freeze({
    key: 'maxnovel',
    name: 'MaxNovel',
    productLine: 'maxnovel',
    applicationId: '69a172040a2d5813dec3bff7',
    codeMin: 50000,
    codeMax: 59999,
    counterKey: 'nf_social:next_code:maxnovel',
    attributedLinks: false
  }),
  astranovel: Object.freeze({
    key: 'astranovel',
    name: 'AstraNovel',
    productLine: 'astranovel',
    applicationId: '678dfef75344a83d71e56932',
    codeMin: 60000,
    codeMax: 69999,
    counterKey: 'nf_social:next_code:astranovel',
    attributedLinks: true,
    facebookLink: Object.freeze({
      channelCode: 'FB',
      channelSource: 'FB',
      channelNameId: '6a2021a4554323f68cac4096',
      redirectConfigId: '6901804c0b64dbd6ad0e85e1',
      landingTemplateId: '6a20224383724a9e0204ac2f',
      landingTemplateName: 'as书详',
      operatorName: '徐敬涛',
      promoter: 'xujt'
    })
  }),
  storyca: Object.freeze({
    key: 'storyca',
    name: 'Storyca',
    productLine: 'storyca',
    applicationId: '6a1fda28d424787812989ca1',
    codeMin: 70000,
    codeMax: 79999,
    counterKey: 'nf_social:next_code:storyca',
    attributedLinks: false
  }),
  novelvio: Object.freeze({
    key: 'novelvio',
    name: 'Novelvio',
    productLine: 'novelvio',
    applicationId: '6a39fc99722159391b665786',
    codeMin: 80000,
    codeMax: 89999,
    counterKey: 'nf_social:next_code:novelvio',
    attributedLinks: false
  })
});

const ACCOUNT_ROUTES = Object.freeze([
  { accountId: 13751295, accountTitle: 'NovelFlow', appKey: 'novelflow', platform: 'facebook', publishType: 'reels' },
  { accountId: 13943450, accountTitle: 'NovelFlow', appKey: 'novelflow', platform: 'instagram', publishType: 'reels' },
  { accountId: 13943940, accountTitle: 'NovelFlow', appKey: 'novelflow', platform: 'tiktok', publishType: 'video' },
  { accountId: 13943483, accountTitle: 'AstraNovel', appKey: 'astranovel', platform: 'facebook', publishType: 'reels' },
  { accountId: 15401748, accountTitle: 'AstraNovel', appKey: 'astranovel', platform: 'instagram', publishType: 'reels' },
  { accountId: 13944009, accountTitle: 'astranovel_freenovels', appKey: 'astranovel', platform: 'tiktok', publishType: 'video' },
  { accountId: 13943482, accountTitle: 'MaxNovel', appKey: 'maxnovel', platform: 'facebook', publishType: 'reels' },
  { accountId: 15590770, accountTitle: 'MaxNovel', appKey: 'maxnovel', platform: 'instagram', publishType: 'reels' },
  { accountId: 13943764, accountTitle: 'maxnovel.app', appKey: 'maxnovel', platform: 'tiktok', publishType: 'video' },
  { accountId: 13943484, accountTitle: 'Storyca', appKey: 'storyca', platform: 'facebook', publishType: 'reels' },
  { accountId: 13943914, accountTitle: 'Storyca', appKey: 'storyca', platform: 'instagram', publishType: 'reels' },
  { accountId: 13943918, accountTitle: 'storyca.app', appKey: 'storyca', platform: 'tiktok', publishType: 'video' },
  { accountId: 13943485, accountTitle: 'Novelvio', appKey: 'novelvio', platform: 'facebook', publishType: 'reels' },
  { accountId: 18185914, accountTitle: 'novelvio', appKey: 'novelvio', platform: 'tiktok', publishType: 'video' }
].map((route) => Object.freeze(route)));

// No unreviewed extra routes: the formal contract is the live, operator-approved
// fourteen-account set above. Historical drafts keep their original account ID
// but cannot create new work against an account removed from this contract.
const EXTRA_ACCOUNT_ROUTES = Object.freeze([]);
const ALL_ACCOUNT_ROUTES = Object.freeze([...ACCOUNT_ROUTES, ...EXTRA_ACCOUNT_ROUTES]);

function appByKey(key) {
  return APPS[String(key || '').trim().toLowerCase()] || null;
}

function appByProductLine(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.values(APPS).find((app) => app.productLine === normalized) || null;
}

function accountRoute(accountId) {
  return ALL_ACCOUNT_ROUTES.find((route) => route.accountId === Number(accountId)) || null;
}

// The fourteen production accounts are a reviewed delivery contract, not a
// discovery result. Reuse it for every P7 draft so a billable provider account
// listing is never required merely to re-confirm an already locked route.
function configuredSocialEchoAccount(accountId) {
  const route = accountRoute(accountId);
  if (!route) return null;
  return {
    id: route.accountId,
    title: route.accountTitle,
    account: route.accountTitle,
    platform: route.platform,
    status: 1,
    publishType: route.publishType,
    supported: true,
    source: 'configured_route'
  };
}

function configuredSocialEchoAccounts() {
  return ACCOUNT_ROUTES.map((route) => configuredSocialEchoAccount(route.accountId));
}

function normalizeDelivery(value = {}) {
  const route = accountRoute(value.accountId);
  if (!route) return null;
  const app = appByKey(route.appKey);
  if (!app) return null;
  return {
    accountId: route.accountId,
    accountTitle: route.accountTitle,
    platform: route.platform,
    publishType: route.publishType,
    appKey: app.key,
    appName: app.name,
    productLine: app.productLine,
    applicationId: app.applicationId,
    includeLink: route.platform === 'facebook' && app.attributedLinks === true
  };
}

function sanitizeP0Selection(value, delivery) {
  const source = value && typeof value === 'object' ? value : {};
  const text = (input, max) => typeof input === 'string' && input.trim().length <= max ? input.trim() : '';
  const number = (input, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : 0;
  };
  return {
    selectedAt: new Date().toISOString(),
    source: text(source.source, 80) || 'manual',
    windowDays: [1, 7, 30, 90].includes(Number(source.windowDays)) ? Number(source.windowDays) : 0,
    sourceRank: number(source.sourceRank, 0, 100000),
    recommendationRank: number(source.recommendationRank, 0, 100000),
    selectionRank: number(source.selectionRank, 0, 100000),
    selectionScore: number(source.selectionScore, 0, 100),
    readerBase: number(source.readerBase, 0, 1e12),
    firstReadRate: number(source.firstReadRate, 0, 100),
    longReadRate: number(source.longReadRate, 0, 100),
    trend7v30: source.trend7v30 === null || source.trend7v30 === undefined || source.trend7v30 === '' ? null : number(source.trend7v30, -10, 10),
    dataQuality: source.dataQuality === 'verified_metrics' ? 'verified_metrics' : '',
    sourceHealth: source.sourceHealth === 'healthy' ? 'healthy' : '',
    generatedAt: text(source.generatedAt, 80),
    receiptVersion: Number(source.receiptVersion) === 1 ? 1 : 0,
    receiptIssuedAt: text(source.receiptIssuedAt, 80),
    receiptExpiresAt: text(source.receiptExpiresAt, 80),
    receiptFingerprint: /^[a-f0-9]{64}$/.test(String(source.receiptFingerprint || '')) ? String(source.receiptFingerprint) : '',
    snapshotVersion: text(source.snapshotVersion, 100),
    rankedTitle: text(source.rankedTitle, 300),
    canonicalTitle: text(source.canonicalTitle, 300),
    canonicalVerifiedAt: text(source.canonicalVerifiedAt, 80),
    canonicalCityBookId: text(source.canonicalCityBookId, 160),
    filters: {
      language: ['EN', 'PT', 'ES'].includes(String(source.filters?.language)) ? String(source.filters.language) : '',
      complete: text(source.filters?.complete, 20),
      length: ['all', 'short', 'long'].includes(String(source.filters?.length)) ? String(source.filters.length) : 'all',
      genre: text(source.filters?.genre, 40),
      readBaseMin: number(source.filters?.readBaseMin, 0, 1e12),
      firstReadMin: number(source.filters?.firstReadMin, 0, 1),
      longReadMin: number(source.filters?.longReadMin, 0, 1)
    },
    target: delivery ? {
      accountId: delivery.accountId,
      accountTitle: delivery.accountTitle,
      appKey: delivery.appKey,
      appName: delivery.appName,
      applicationId: delivery.applicationId,
      productLine: delivery.productLine,
      platform: delivery.platform,
      publishType: delivery.publishType,
      includeLink: delivery.includeLink
    } : null
  };
}

function deliveryForRun(run) {
  return normalizeDelivery(run?.input?.delivery || {});
}

function appForRun(run) {
  const delivery = deliveryForRun(run);
  return appByKey(delivery?.appKey) || APPS.novelflow;
}

function codePoolForRun(run) {
  return appForRun(run);
}

module.exports = {
  APPS,
  ACCOUNT_ROUTES,
  EXTRA_ACCOUNT_ROUTES,
  ALL_ACCOUNT_ROUTES,
  appByKey,
  appByProductLine,
  accountRoute,
  configuredSocialEchoAccount,
  configuredSocialEchoAccounts,
  normalizeDelivery,
  sanitizeP0Selection,
  deliveryForRun,
  appForRun,
  codePoolForRun
};
