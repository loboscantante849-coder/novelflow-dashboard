const { Redis } = require('@upstash/redis');
const { handlePreflight } = require('./_lib/cors');
const {
  checkAdminKey,
  checkRateLimit,
  getAuthPayload,
  getClientIp,
  isAdminUser,
  isDisabledUser,
} = require('./_lib/security');
const { getAdIdDetails, getLegacyDataJson, resolvePromoterKey } = require('./_lib/stats-data');
const { acquireUserDataLock, releaseUserDataLock } = require('./_lib/user-data-lock');
const {
  COMMISSION_EFFECTIVE_DATE,
  COMMISSION_MIGRATION_ID,
  COMMISSION_RATE,
  buildIncomeProfile,
  computeWalletBalances,
  historicalGrossBefore,
  roundMoney,
  withdrawalTotals,
} = require('./_lib/commission-policy');

const APPLY_CONFIRMATION = 'APPLY_COMMISSION_80_V1';
const HISTORICAL_THROUGH = new Date(
  Date.parse(`${COMMISSION_EFFECTIVE_DATE}T00:00:00.000Z`) - 24 * 60 * 60 * 1000
).toISOString().slice(0, 10);
const APPLY_CONCURRENCY = 8;

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function parseRecord(value) {
  if (value == null) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_USER_RECORD');
  return parsed;
}

function parseRequestBody(body) {
  if (body == null || body === '') return {};
  if (typeof body === 'string') return parseRecord(body);
  if (typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_REQUEST_BODY');
  return body;
}

async function scanKeys(redis, match) {
  const keys = [];
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, { match, count: 200 });
    cursor = String(result && result[0] || '0');
    if (Array.isArray(result && result[1])) keys.push(...result[1].map(String));
  } while (cursor !== '0');
  return keys;
}

function migrationMarker(profile, timestamp, appliedAt) {
  return {
    version: 1,
    status: 'applied',
    effective_date: COMMISSION_EFFECTIVE_DATE,
    commission_rate: COMMISSION_RATE,
    historical_gross_income: historicalGrossBefore(profile, COMMISSION_EFFECTIVE_DATE),
    source_key: profile.sourceKey,
    source_last_updated: timestamp || null,
    applied_at: appliedAt,
  };
}

function existingMigration(userData) {
  const migrations = userData && userData.balance_migrations;
  if (!migrations || typeof migrations !== 'object' || Array.isArray(migrations)) return null;
  const marker = migrations[COMMISSION_MIGRATION_ID];
  return marker && typeof marker === 'object' && !Array.isArray(marker) ? marker : null;
}

function prepareDetail({ username, userData, adjustment, data, adData }) {
  const sourceKey = resolvePromoterKey(username, adData);
  if (!sourceKey || !adData.by_promoter[sourceKey]) return null;
  const profile = buildIncomeProfile(data, sourceKey);
  if (!profile.found || profile.grossTotal <= 0) return null;

  const anomalies = [];
  if (userData.bonus_balance !== undefined && !Number.isFinite(Number(userData.bonus_balance))) {
    anomalies.push('invalid_bonus_balance');
  }
  if (userData.withdrawals !== undefined && !Array.isArray(userData.withdrawals)) {
    anomalies.push('invalid_withdrawals_record');
  }
  if (userData.balance_migrations !== undefined && (
    !userData.balance_migrations || typeof userData.balance_migrations !== 'object' ||
    Array.isArray(userData.balance_migrations)
  )) {
    anomalies.push('invalid_migration_record');
  }

  const marker = existingMigration(userData);
  const markerValue = userData.balance_migrations && userData.balance_migrations[COMMISSION_MIGRATION_ID];
  const alreadyMigrated = Boolean(marker && marker.status === 'applied');
  if (markerValue !== undefined && !alreadyMigrated) anomalies.push('invalid_migration_marker');

  const oldBalances = computeWalletBalances(userData, profile, adjustment);
  const dryRunMarker = migrationMarker(profile, data.last_updated, 'DRY_RUN');
  const bonusBefore = roundMoney(userData.bonus_balance);
  const historicalGross = dryRunMarker.historical_gross_income;
  const simulated = alreadyMigrated ? userData : {
    ...userData,
    bonus_balance: roundMoney(bonusBefore + historicalGross),
    balance_migrations: {
      ...(userData.balance_migrations && typeof userData.balance_migrations === 'object'
        ? userData.balance_migrations
        : {}),
      [COMMISSION_MIGRATION_ID]: dryRunMarker,
    },
  };
  const newBalances = computeWalletBalances(simulated, profile, adjustment);
  const withdrawals = withdrawalTotals(userData);
  if (withdrawals.unknown.length) anomalies.push('invalid_withdrawal');

  const dailyTotal = roundMoney(Object.values(profile.daily).reduce((sum, amount) => sum + amount, 0));
  if (dailyTotal !== profile.grossTotal) anomalies.push('income_daily_mismatch');

  const cutoffBefore = roundMoney(Math.max(
    0,
    bonusBefore + historicalGross + adjustment - withdrawals.approved - withdrawals.pending,
  ));
  const cutoffAfter = roundMoney(Math.max(
    0,
    roundMoney(simulated.bonus_balance) + adjustment - withdrawals.approved - withdrawals.pending,
  ));
  if (!alreadyMigrated && roundMoney(cutoffAfter - cutoffBefore) !== 0) anomalies.push('cutoff_mismatch');

  return {
    username,
    source_key: profile.sourceKey,
    bonus_before: bonusBefore,
    historical_gross_income: historicalGross,
    current_gross_income: profile.grossTotal,
    adjustment: roundMoney(adjustment),
    approved: withdrawals.approved,
    pending: withdrawals.pending,
    rejected: withdrawals.rejected,
    available_before: oldBalances.available_balance,
    bonus_after: roundMoney(simulated.bonus_balance),
    available_after: newBalances.available_balance,
    current_balance_change: roundMoney(newBalances.available_balance - oldBalances.available_balance),
    cutoff_balance_before: cutoffBefore,
    cutoff_balance_after: cutoffAfter,
    cutoff_balance_change: roundMoney(cutoffAfter - cutoffBefore),
    already_migrated: alreadyMigrated,
    anomalies: Array.from(new Set(anomalies)),
    profile,
  };
}

function publicDetail(detail) {
  const { profile: _profile, ...safe } = detail;
  return safe;
}

function buildSummary({ userKeys, details, corruptRecords, duplicateSources, excludedAliases, sourceReady }) {
  const pending = details.filter(detail => !detail.already_migrated);
  const anomalous = details.filter(detail => detail.anomalies.length > 0);
  const cutoffMismatch = details.filter(detail => detail.anomalies.includes('cutoff_mismatch'));
  return {
    redis_user_records: userKeys.length,
    migration_candidates: pending.length,
    already_migrated: details.length - pending.length,
    historical_gross_income: roundMoney(pending.reduce((sum, detail) => sum + detail.historical_gross_income, 0)),
    bonus_before: roundMoney(pending.reduce((sum, detail) => sum + detail.bonus_before, 0)),
    bonus_after: roundMoney(pending.reduce((sum, detail) => sum + detail.bonus_after, 0)),
    approved_total: roundMoney(pending.reduce((sum, detail) => sum + detail.approved, 0)),
    pending_total: roundMoney(pending.reduce((sum, detail) => sum + detail.pending, 0)),
    current_balance_change: roundMoney(pending.reduce((sum, detail) => sum + detail.current_balance_change, 0)),
    cutoff_balance_change: roundMoney(pending.reduce((sum, detail) => sum + detail.cutoff_balance_change, 0)),
    duplicate_source_mappings: duplicateSources.length,
    excluded_legacy_aliases: excludedAliases.length,
    anomalous_records: anomalous.length + corruptRecords,
    corrupt_records: corruptRecords,
    cutoff_mismatches: cutoffMismatch.length,
    source_covers_cutoff: sourceReady,
  };
}

function selectSourceOwner(sourceKey, owners) {
  if (owners.includes(sourceKey)) return sourceKey;
  const canonicalOwners = owners.filter(owner => owner === owner.toLowerCase());
  return canonicalOwners.length === 1 ? canonicalOwners[0] : null;
}

async function analyzeMigration(redis) {
  const [data, adData, userKeys] = await Promise.all([
    getLegacyDataJson(),
    getAdIdDetails(),
    scanKeys(redis, 'nf_user_data:*'),
  ]);
  if (!data || !data.users || !adData || !adData.by_promoter) {
    const error = new Error('Income source unavailable');
    error.code = 'INCOME_SOURCE_UNAVAILABLE';
    throw error;
  }

  const userValues = userKeys.length ? await redis.mget(...userKeys) : [];
  const usernames = userKeys.map(key => key.replace(/^nf_user_data:/, ''));
  const adjustmentKeys = usernames.map(username => `nf_admin_income_adjustment:${username}`);
  const adjustmentValues = adjustmentKeys.length ? await redis.mget(...adjustmentKeys) : [];
  const details = [];
  let corruptRecords = 0;
  const sourceOwners = new Map();

  for (let index = 0; index < userKeys.length; index += 1) {
    const username = usernames[index];
    let userData;
    let adjustment = 0;
    try {
      userData = parseRecord(userValues[index]);
      const rawAdjustment = adjustmentValues[index];
      const adjustmentRecord = rawAdjustment == null ? null : parseRecord(rawAdjustment);
      if (adjustmentRecord && !Number.isFinite(Number(adjustmentRecord.amount))) {
        throw new Error('INVALID_ADJUSTMENT_RECORD');
      }
      adjustment = Number(adjustmentRecord && adjustmentRecord.amount) || 0;
    } catch (_error) {
      corruptRecords += 1;
      continue;
    }

    const detail = prepareDetail({ username, userData, adjustment, data, adData });
    if (!detail) continue;
    details.push(detail);
    const owners = sourceOwners.get(detail.source_key) || [];
    owners.push(username);
    sourceOwners.set(detail.source_key, owners);
  }

  const duplicateSources = [];
  const excludedAliases = [];
  const selectedOwners = new Map();
  for (const [sourceKey, owners] of sourceOwners.entries()) {
    if (owners.length === 1) {
      selectedOwners.set(sourceKey, owners[0]);
      continue;
    }
    const selected = selectSourceOwner(sourceKey, owners);
    if (!selected) {
      duplicateSources.push({ source_key: sourceKey, owners });
      continue;
    }
    selectedOwners.set(sourceKey, selected);
    excludedAliases.push(...owners
      .filter(owner => owner !== selected)
      .map(owner => ({ source_key: sourceKey, username: owner, selected_username: selected })));
  }
  const selectedDetails = details.filter(detail => selectedOwners.get(detail.source_key) === detail.username);
  const sourceReady = String(data.date_range && data.date_range.to || '') >= HISTORICAL_THROUGH;
  const summary = buildSummary({
    userKeys,
    details: selectedDetails,
    corruptRecords,
    duplicateSources,
    excludedAliases,
    sourceReady,
  });
  const canApply = summary.cutoff_mismatches === 0 &&
    summary.duplicate_source_mappings === 0 &&
    summary.anomalous_records === 0 &&
    sourceReady;
  return { data, adData, userKeys, details: selectedDetails, duplicateSources, excludedAliases, summary, canApply };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function applyDetail(redis, detail, analysis) {
  const lock = await acquireUserDataLock(redis, detail.username);
  if (!lock) return { status: 'busy', historicalGross: 0 };
  try {
    const key = `nf_user_data:${detail.username}`;
    const currentRaw = await redis.get(key);
    if (currentRaw == null) {
      return { status: 'error', historicalGross: 0, code: 'USER_RECORD_MISSING' };
    }
    const current = parseRecord(currentRaw);
    if (existingMigration(current)?.status === 'applied') {
      return { status: 'skipped', historicalGross: 0 };
    }
    const adjustmentRaw = await redis.get(`nf_admin_income_adjustment:${detail.username}`);
    const adjustmentRecord = adjustmentRaw == null ? null : parseRecord(adjustmentRaw);
    if (adjustmentRecord && !Number.isFinite(Number(adjustmentRecord.amount))) {
      return { status: 'error', historicalGross: 0, code: 'INVALID_ADJUSTMENT_RECORD' };
    }
    const currentDetail = prepareDetail({
      username: detail.username,
      userData: current,
      adjustment: Number(adjustmentRecord && adjustmentRecord.amount) || 0,
      data: analysis.data,
      adData: analysis.adData,
    });
    if (!currentDetail || currentDetail.already_migrated) {
      return { status: currentDetail ? 'skipped' : 'error', historicalGross: 0, code: 'SOURCE_MAPPING_CHANGED' };
    }
    if (currentDetail.source_key !== detail.source_key || currentDetail.anomalies.length) {
      return { status: 'error', historicalGross: 0, code: 'REVALIDATION_FAILED' };
    }

    const appliedAt = new Date().toISOString();
    const marker = migrationMarker(currentDetail.profile, analysis.data.last_updated, appliedAt);
    const updated = {
      ...current,
      bonus_balance: roundMoney(currentDetail.bonus_before + marker.historical_gross_income),
      balance_migrations: {
        ...(current.balance_migrations || {}),
        [COMMISSION_MIGRATION_ID]: marker,
      },
    };
    await redis.set(key, JSON.stringify(updated));
    return { status: 'applied', historicalGross: marker.historical_gross_income };
  } catch (error) {
    return { status: 'error', historicalGross: 0, code: error && error.message || 'WRITE_FAILED' };
  } finally {
    await releaseUserDataLock(redis, lock);
  }
}

function baseResponse(analysis) {
  return {
    policy: {
      migration_id: COMMISSION_MIGRATION_ID,
      historical_through: HISTORICAL_THROUGH,
      effective_date: COMMISSION_EFFECTIVE_DATE,
      commission_rate: COMMISSION_RATE,
    },
    source: {
      last_updated: analysis.data.last_updated || null,
      date_range: analysis.data.date_range || null,
    },
    summary: analysis.summary,
  };
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const hasAdminKey = checkAdminKey(req);
  const payload = hasAdminKey ? null : getAuthPayload(req);
  if (!hasAdminKey && !payload) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  const redis = redisClient();
  if (!redis) return res.status(503).json({ error: 'Wallet storage unavailable', code: 'WALLET_UNAVAILABLE' });

  try {
    if (!hasAdminKey) {
      if (await isDisabledUser(redis, payload, { failClosed: true })) {
        return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
      }
      if (!await isAdminUser(redis, payload.username, { failClosed: true })) {
        return res.status(403).json({ error: 'Admin only', code: 'ADMIN_ONLY' });
      }
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = parseRequestBody(req.body);
      } catch (_error) {
        return res.status(400).json({ error: 'Invalid request body', code: 'INVALID_REQUEST_BODY' });
      }
      if (body.action !== 'apply' || body.confirm !== APPLY_CONFIRMATION) {
        return res.status(400).json({ error: 'Explicit migration confirmation required', code: 'CONFIRMATION_REQUIRED' });
      }
    }

    const operation = req.method === 'POST' ? 'apply' : 'dry_run';
    const limit = req.method === 'POST' ? 3 : 12;
    const allowed = await checkRateLimit(
      redis,
      `nf_rate:balance_migration_${operation}:${hasAdminKey ? 'admin_key' : String(payload.username).toLowerCase()}:${getClientIp(req)}`,
      limit,
      3600,
      { failClosed: true },
    );
    if (!allowed) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });

    const analysis = await analyzeMigration(redis);
    if (req.method === 'GET') {
      return res.status(200).json({
        success: true,
        dry_run: true,
        apply_supported: true,
        can_apply_after_review: analysis.canApply,
        ...baseResponse(analysis),
        users: String(req.query.include_users || '') === '1'
          ? analysis.details.map(publicDetail)
          : undefined,
      });
    }

    if (!analysis.canApply) {
      return res.status(409).json({
        error: 'Migration safety checks failed; no balances were changed',
        code: 'MIGRATION_SAFETY_CHECK_FAILED',
        success: false,
        applied: false,
        ...baseResponse(analysis),
      });
    }

    const pending = analysis.details.filter(detail => !detail.already_migrated);
    const results = await mapWithConcurrency(pending, APPLY_CONCURRENCY, detail => applyDetail(redis, detail, analysis));
    const counts = {
      applied: results.filter(result => result.status === 'applied').length,
      skipped: analysis.summary.already_migrated + results.filter(result => result.status === 'skipped').length,
      busy: results.filter(result => result.status === 'busy').length,
      errors: results.filter(result => result.status === 'error').length,
    };
    const complete = counts.errors === 0 && counts.busy === 0;
    return res.status(complete ? 200 : 409).json({
      success: complete,
      dry_run: false,
      applied: complete,
      complete,
      partially_applied: !complete && counts.applied > 0,
      retry_required: counts.busy > 0,
      ...baseResponse(analysis),
      result: {
        ...counts,
        historical_gross_income_added: roundMoney(results.reduce((sum, result) => sum + result.historicalGross, 0)),
        error_codes: Array.from(new Set(results.map(result => result.code).filter(Boolean))),
      },
    });
  } catch (error) {
    console.error(`[admin-balance-migration] ${req.method === 'POST' ? 'apply' : 'dry-run'} failed:`, error);
    return res.status(503).json({
      error: 'Balance migration unavailable',
      code: error && error.code || 'MIGRATION_UNAVAILABLE',
    });
  }
};

module.exports.APPLY_CONFIRMATION = APPLY_CONFIRMATION;
module.exports._test = { analyzeMigration, prepareDetail };
