const crypto = require('crypto');
const { getAdIdDetails, resolvePromoterKey } = require('./stats-data');
const { isSystemStatsBucket } = require('./promoter-access');
const { getCampaignReferralCount } = require('./referrals');
const { ACTIVITY_END_AT, ACTIVITY_START_AT, ACTIVITY_VERSION } = require('./activity-config');
const STATS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function normalizeNovelFlowId(value) {
  const display = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(display)) return null;
  return { display, key: display.toLowerCase() };
}

function normalizeFacebookUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (!(host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com' || host.endsWith('.fb.com'))) return null;
    const match = url.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/(?:posts|permalink)\/([A-Za-z0-9._-]+)\/?$/i);
    if (!match) return null;
    const group = match[1].toLowerCase();
    const post = match[2];
    return `https://www.facebook.com/groups/${group}/posts/${post}`;
  } catch (_error) {
    return null;
  }
}

function isPrivateIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224;
}

function isPrivateIpv6(host) {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '::' || normalized === '::1' ||
    normalized.startsWith('fc') || normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.') || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized);
}

function normalizePublicSocialUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || !host) return null;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
    if (isPrivateIpv4(host) || (host.includes(':') && isPrivateIpv6(host))) return null;

    // Preserve the canonical form used by existing Facebook claims while also
    // accepting public posts from every other social platform.
    const canonicalFacebook = normalizeFacebookUrl(raw);
    if (canonicalFacebook) return canonicalFacebook;
    url.hash = '';
    return url.toString();
  } catch (_error) {
    return null;
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function rewardEntitlement(totalNew) {
  const count = Math.max(0, Math.floor(Number(totalNew) || 0));
  // Four 2-reader tiers (2/4/6/8) plus the 10-reader milestone.
  const pairDays = Math.min(Math.floor(count / 2), 4) * 3;
  const milestoneDays = count >= 10 ? 20 : 0;
  return {
    verifiedNewUsers: count,
    pairDays,
    milestoneDays,
    totalDays: pairDays + milestoneDays,
  };
}

function statsAgeMs(lastUpdated) {
  const timestamp = Date.parse(String(lastUpdated || ''));
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Infinity;
}

function eligibilityFromAdData(adData, username, campaignInvites = 0) {
  const campaignReward = rewardEntitlement(campaignInvites);
  const base = {
    username: String(username || '').trim().toLowerCase(),
    promoterKey: null,
    verifiedNewUsers: campaignReward.verifiedNewUsers,
    campaignInvites: campaignReward.verifiedNewUsers,
    pairDays: campaignReward.pairDays,
    milestoneDays: campaignReward.milestoneDays,
    totalDays: campaignReward.totalDays,
    historicalNewUsers: 0,
    statsLastUpdated: adData && adData.last_updated || null,
    statsDateRange: adData && adData.date_range || null,
    statsStale: statsAgeMs(adData && adData.last_updated) > STATS_MAX_AGE_MS,
    statsAvailable: Boolean(adData && adData.by_promoter),
    recommenderMeasuredNewUsers: 0,
    recommenderEligible: false,
  };
  if (!adData || !adData.by_promoter || isSystemStatsBucket(username)) return base;
  const key = resolvePromoterKey(username, adData);
  if (!key || isSystemStatsBucket(key)) return base;
  const entry = adData.by_promoter[key];
  if (!entry) return base;
  const historicalNewUsers = Math.max(0, Math.floor(Number(entry.total_new) || 0));
  const recommenderMeasuredNewUsers = Math.max(historicalNewUsers, campaignReward.verifiedNewUsers);
  return {
    ...base,
    promoterKey: key,
    historicalNewUsers,
    recommenderMeasuredNewUsers,
    recommenderEligible: recommenderMeasuredNewUsers >= 5,
  };
}

async function loadEligibility(username, { redis = null, requireFresh = false, adData: suppliedAdData } = {}) {
  const [campaignInvites, fetchedAdData] = await Promise.all([
    getCampaignReferralCount(redis, username),
    suppliedAdData === undefined ? getAdIdDetails() : Promise.resolve(suppliedAdData),
  ]);
  const adData = fetchedAdData;
  if (!adData || !adData.by_promoter) {
    if (requireFresh) {
      const error = new Error('Promotion stats are unavailable for this account');
      error.code = 'PROMOTION_STATS_UNAVAILABLE';
      throw error;
    }
    return eligibilityFromAdData(null, username, campaignInvites);
  }
  const result = eligibilityFromAdData(adData, username, campaignInvites);
  if (requireFresh && result.statsStale) {
    const error = new Error('Promotion stats are temporarily stale');
    error.code = 'STATS_STALE';
    error.statsLastUpdated = result.statsLastUpdated;
    throw error;
  }
  return result;
}

function activityWindow() {
  const now = Date.now();
  const start = Date.parse(ACTIVITY_START_AT);
  const end = Date.parse(ACTIVITY_END_AT);
  return {
    version: ACTIVITY_VERSION,
    startsAt: ACTIVITY_START_AT,
    endsAt: ACTIVITY_END_AT,
    active: now >= start && now <= end,
    ended: now > end,
    upcoming: now < start,
  };
}

module.exports = {
  ACTIVITY_END_AT,
  ACTIVITY_START_AT,
  ACTIVITY_VERSION,
  activityWindow,
  eligibilityFromAdData,
  hashValue,
  loadEligibility,
  normalizeFacebookUrl,
  normalizeNovelFlowId,
  normalizePublicSocialUrl,
  rewardEntitlement,
  statsAgeMs,
};
