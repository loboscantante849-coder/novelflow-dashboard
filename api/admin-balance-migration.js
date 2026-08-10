const { Redis } = require('@upstash/redis');
const { handlePreflight } = require('./_lib/cors');
const { checkRateLimit, getAuthPayload, getClientIp, isAdminUser, isDisabledUser } = require('./_lib/security');
const { getAdIdDetails, getLegacyDataJson, resolvePromoterKey } = require('./_lib/stats-data');
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

function migrationMarker(profile, timestamp) {
  return {
    version: 1,
    status: 'applied',
    effective_date: COMMISSION_EFFECTIVE_DATE,
    commission_rate: COMMISSION_RATE,
    historical_gross_income: historicalGrossBefore(profile, COMMISSION_EFFECTIVE_DATE),
    source_key: profile.sourceKey,
    source_last_updated: timestamp || null,
    applied_at: 'DRY_RUN',
  };
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Dry-run only', code: 'MIGRATION_WRITE_DISABLED' });
  }

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const redis = redisClient();
  if (!redis) return res.status(503).json({ error: 'Wallet storage unavailable', code: 'WALLET_UNAVAILABLE' });

  try {
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
    if (!await isAdminUser(redis, payload.username, { failClosed: true })) {
      return res.status(403).json({ error: 'Admin only', code: 'ADMIN_ONLY' });
    }
    const allowed = await checkRateLimit(
      redis,
      `nf_rate:balance_migration_dry_run:${String(payload.username).toLowerCase()}:${getClientIp(req)}`,
      12,
      3600,
      { failClosed: true },
    );
    if (!allowed) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });

    const [data, adData, userKeys] = await Promise.all([
      getLegacyDataJson(),
      getAdIdDetails(),
      scanKeys(redis, 'nf_user_data:*'),
    ]);
    if (!data || !data.users || !adData || !adData.by_promoter) {
      return res.status(503).json({ error: 'Income source unavailable', code: 'INCOME_SOURCE_UNAVAILABLE' });
    }

    const userValues = userKeys.length ? await redis.mget(...userKeys) : [];
    const usernames = userKeys.map(key => key.replace(/^nf_user_data:/, ''));
    const adjustmentKeys = usernames.map(username => `nf_admin_income_adjustment:${username}`);
    const adjustmentValues = adjustmentKeys.length ? await redis.mget(...adjustmentKeys) : [];
    const details = [];
    const errors = [];
    const sourceOwners = new Map();

    for (let index = 0; index < userKeys.length; index += 1) {
      const username = usernames[index];
      let userData;
      let adjustment = 0;
      try {
        userData = parseRecord(userValues[index]);
        const rawAdjustment = adjustmentValues[index];
        const adjustmentRecord = rawAdjustment == null ? null : parseRecord(rawAdjustment);
        adjustment = Number(adjustmentRecord && adjustmentRecord.amount) || 0;
      } catch (_error) {
        errors.push({ type: 'corrupt_record' });
        continue;
      }

      const sourceKey = resolvePromoterKey(username, adData);
      if (!sourceKey || !adData.by_promoter[sourceKey]) continue;
      const profile = buildIncomeProfile(data, sourceKey);
      if (!profile.found || profile.grossTotal <= 0) continue;

      const owners = sourceOwners.get(profile.sourceKey) || [];
      owners.push(username);
      sourceOwners.set(profile.sourceKey, owners);

      const oldBalances = computeWalletBalances(userData, profile, adjustment);
      const marker = migrationMarker(profile, data.last_updated);
      const bonusBefore = roundMoney(userData.bonus_balance);
      const historicalGross = marker.historical_gross_income;
      const simulated = {
        ...userData,
        bonus_balance: roundMoney(bonusBefore + historicalGross),
        balance_migrations: {
          ...(userData.balance_migrations && typeof userData.balance_migrations === 'object'
            ? userData.balance_migrations
            : {}),
          [COMMISSION_MIGRATION_ID]: marker,
        },
      };
      const newBalances = computeWalletBalances(simulated, profile, adjustment);
      const withdrawals = withdrawalTotals(userData);
      const cutoffBefore = roundMoney(Math.max(
        0,
        bonusBefore + historicalGross + adjustment - withdrawals.approved - withdrawals.pending,
      ));
      const cutoffAfter = roundMoney(Math.max(
        0,
        simulated.bonus_balance + adjustment - withdrawals.approved - withdrawals.pending,
      ));
      const anomalies = [];
      if (withdrawals.unknown.length) anomalies.push('invalid_withdrawal');
      if (userData.balance_migrations && userData.balance_migrations[COMMISSION_MIGRATION_ID]) {
        anomalies.push('already_migrated');
      }
      if (roundMoney(Object.values(profile.daily).reduce((sum, amount) => sum + amount, 0)) !== profile.grossTotal) {
        anomalies.push('income_daily_mismatch');
      }

      details.push({
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
        bonus_after: simulated.bonus_balance,
        available_after: newBalances.available_balance,
        current_balance_change: roundMoney(newBalances.available_balance - oldBalances.available_balance),
        cutoff_balance_before: cutoffBefore,
        cutoff_balance_after: cutoffAfter,
        cutoff_balance_change: roundMoney(cutoffAfter - cutoffBefore),
        anomalies,
      });
    }

    const duplicateSources = Array.from(sourceOwners.values()).filter(owners => owners.length > 1);
    const anomalous = details.filter(detail => detail.anomalies.length > 0);
    const cutoffMismatch = details.filter(detail => detail.cutoff_balance_change !== 0);
    const summary = {
      redis_user_records: userKeys.length,
      migration_candidates: details.length,
      historical_gross_income: roundMoney(details.reduce((sum, detail) => sum + detail.historical_gross_income, 0)),
      bonus_before: roundMoney(details.reduce((sum, detail) => sum + detail.bonus_before, 0)),
      bonus_after: roundMoney(details.reduce((sum, detail) => sum + detail.bonus_after, 0)),
      approved_total: roundMoney(details.reduce((sum, detail) => sum + detail.approved, 0)),
      pending_total: roundMoney(details.reduce((sum, detail) => sum + detail.pending, 0)),
      current_balance_change: roundMoney(details.reduce((sum, detail) => sum + detail.current_balance_change, 0)),
      cutoff_balance_change: roundMoney(details.reduce((sum, detail) => sum + detail.cutoff_balance_change, 0)),
      duplicate_source_mappings: duplicateSources.length,
      anomalous_records: anomalous.length + errors.length,
      corrupt_records: errors.length,
      cutoff_mismatches: cutoffMismatch.length,
    };
    const canApply = summary.cutoff_mismatches === 0 &&
      summary.duplicate_source_mappings === 0 &&
      summary.anomalous_records === 0 &&
      String(data.date_range && data.date_range.to || '') >= '2026-08-09';

    return res.status(200).json({
      success: true,
      dry_run: true,
      apply_supported: false,
      can_apply_after_review: canApply,
      policy: {
        migration_id: COMMISSION_MIGRATION_ID,
        historical_through: '2026-08-09',
        effective_date: COMMISSION_EFFECTIVE_DATE,
        commission_rate: COMMISSION_RATE,
      },
      source: {
        last_updated: data.last_updated || null,
        date_range: data.date_range || null,
      },
      summary,
      users: String(req.query.include_users || '') === '1' ? details : undefined,
    });
  } catch (error) {
    console.error('[admin-balance-migration] dry-run failed:', error);
    return res.status(503).json({
      error: 'Balance migration dry-run unavailable',
      code: error && error.code || 'MIGRATION_DRY_RUN_UNAVAILABLE',
    });
  }
};
