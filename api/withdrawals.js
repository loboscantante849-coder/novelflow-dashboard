/**
 * GET  /api/withdrawals?username=xxx  — KOC earnings + withdrawal history
 * GET  /api/withdrawals?admin_list=pending[&status=pending|approved|rejected|all] — Admin: list all withdrawal requests
 * POST /api/withdrawals                — Submit a new withdrawal request
 * PATCH /api/withdrawals               — Admin approve/reject a request
 *
 * v2.6.5 — Withdrawal freeze + admin review (2026-07-08)
 *   - available_balance now DEDUCTS pending withdrawals (frozen while under review)
 *   - New PATCH endpoint for admin approve/reject
 *   - New admin_list query param for admin to scan all pending requests via Redis SCAN
 *   - Rejected requests release funds back to available_balance automatically
 *
 * v2.6.1 — Security P0 fixes 2026-07-07
 *   - JWT auth REQUIRED for all operations. Non-admin can only access own account.
 *   - Admin (isAdmin) can view/query any username.
 *   - Critical balance validation is server-side (bonus_balance server-trusted only).
 *
 * Redis layout:
 *   nf_user_data:<username>  (STRING, JSON) contains:
 *     bonus_balance: number (USD, platform cash bonus) — server-managed only
 *     withdrawals:   [{id, amount, fee, net_amount, payment_account, status, created_at, processed_at?, processed_by?, admin_note?}]
 *        status: 'pending' | 'approved' | 'rejected'
 */
const crypto = require('crypto');
const { handlePreflight } = require('./_lib/cors');
const { checkRateLimit, getAuthPayload, getClientIp, isAdminUser, isDisabledUser } = require('./_lib/security');
const { Redis } = require('@upstash/redis');
const { acquireUserDataLock, releaseUserDataLock } = require('./_lib/user-data-lock');
const { getAdIdDetails, getLegacyDataJson, resolvePromoterKey } = require('./_lib/stats-data');
const {
  buildEarningsDetail,
  buildIncomeProfile,
  computeWalletBalances,
} = require('./_lib/commission-policy');

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

async function loadIncomeSources() {
  const [data, adData] = await Promise.all([
    getLegacyDataJson(),
    getAdIdDetails(),
  ]);
  if (!data || !data.users) {
    const error = new Error('Income source is temporarily unavailable');
    error.code = 'INCOME_SOURCE_UNAVAILABLE';
    throw error;
  }
  return { data, adData };
}

function promoterIncomeProfile(sources, username) {
  const resolved = sources.adData ? resolvePromoterKey(username, sources.adData) : username;
  return buildIncomeProfile(sources.data, resolved || username);
}

// ---------- Helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function canonizeUser(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > 50) return null;
  // Allow CJK, Latin letters, digits, underscore, dot, @, hyphen, space
  if (!/^[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9_.@\- ]{1,50}$/.test(s)) return null;
  return s.toLowerCase();
}

async function getIncomeAdjustment(redis, username, { failClosed = false } = {}) {
  if (!redis) return 0;
  try {
    const raw = await redis.get(`nf_admin_income_adjustment:${username}`);
    const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Number(record && record.amount) || 0;
  } catch (cause) {
    if (failClosed) {
      const error = new Error('Income adjustment is temporarily unavailable');
      error.code = 'INCOME_ADJUSTMENT_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    return 0;
  }
}

function validIdempotencyKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{12,120}$/.test(value);
}

function makeId() {
  return 'wd_' + Date.now().toString(36) + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function parseStoredUserData(raw) {
  if (raw == null) return {};
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (cause) {
    const error = new Error('Wallet data is corrupt');
    error.code = 'WALLET_DATA_CORRUPT';
    error.cause = cause;
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const error = new Error('Wallet data is corrupt');
    error.code = 'WALLET_DATA_CORRUPT';
    throw error;
  }
  return data;
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;

  res.setHeader('X-OS', 'web');

  // JWT AUTH (P0 fix: no more anonymous access)
  const payload = getAuthPayload(req);
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  const jwtUsername = String(payload.username).toLowerCase();

  const redis = redisClient();
  const isAdmin = await isAdminUser(redis, jwtUsername);
  try {
    if (await isDisabledUser(redis, payload, { failClosed: true })) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }
  } catch (e) {
    // `isDisabledUser` deliberately fails closed when the account record cannot
    // be parsed. Preserve the more actionable wallet-corruption code for
    // mutating wallet requests, while still treating an actual Redis outage as
    // an account-status outage. No mutation is attempted in either case.
    if (e && e.code === 'ACCOUNT_STATUS_UNAVAILABLE' && (req.method === 'POST' || req.method === 'PATCH') && redis) {
      try {
        const raw = await redis.get(`nf_user_data:${jwtUsername}`);
        parseStoredUserData(raw);
      } catch (walletError) {
        if (walletError && walletError.code === 'WALLET_DATA_CORRUPT') {
          return res.status(503).json({ error: 'Wallet data is temporarily unavailable', code: walletError.code });
        }
      }
    }
    return res.status(503).json({ error: 'Account status unavailable', code: e.code || 'ACCOUNT_STATUS_UNAVAILABLE' });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const userLimit = req.method === 'PATCH' ? 120 : 10;
    const prefix = req.method === 'PATCH' ? 'withdrawal_admin' : 'withdrawal_submit';
    try {
      const allowed = await checkRateLimit(redis, `nf_rate:${prefix}:${jwtUsername}`, userLimit, 3600, { failClosed: true }) &&
        await checkRateLimit(redis, `nf_rate:${prefix}_ip:${getClientIp(req)}`, userLimit * 3, 3600, { failClosed: true });
      if (!allowed) return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
    } catch (_error) {
      return res.status(503).json({ error: 'Wallet service temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
    }
  }

  try {
    if (req.method === 'GET') {
      // ----- ADMIN: list all withdrawals across users -----
      const adminList = req.query.admin_list;
      if (adminList) {
        if (!isAdmin) {
          return res.status(403).json({ error: 'Admin only', code: 'ADMIN_ONLY' });
        }
        const wantStatus = String(req.query.status || 'pending').toLowerCase();
        if (!['pending', 'approved', 'rejected', 'all'].includes(wantStatus)) {
          return res.status(400).json({ error: 'Invalid status filter; use pending|approved|rejected|all' });
        }
        if (!redis) return res.status(500).json({ error: 'Redis not configured' });
        const incomeSources = await loadIncomeSources();

        // SCAN all nf_user_data:* keys
        const all = [];
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, { match: 'nf_user_data:*', count: 200 });
          cursor = next;
          if (keys && keys.length) {
            // Pipeline GET to be fast
            const values = await redis.mget(...keys);
            keys.forEach((k, i) => {
              const v = values[i];
              if (!v) return;
              let ud = v;
              if (typeof v === 'string') { try { ud = JSON.parse(v); } catch(_) { return; } }
              if (!ud || typeof ud !== 'object' || !Array.isArray(ud.withdrawals)) return;
               const uname = k.replace(/^nf_user_data:/, '');
               const incomeProfile = promoterIncomeProfile(incomeSources, uname);
               const walletIncome = computeWalletBalances(ud, incomeProfile, 0).commission_income;
               for (const w of ud.withdrawals) {
                if (!w || !w.id) continue;
                const st = (w.status || 'pending').toLowerCase();
                if (wantStatus !== 'all' && st !== wantStatus) continue;
                all.push({
                  username: uname,
                  ...w,
                  dn_income: Number(walletIncome).toFixed(2),
                });
              }
            });
          }
        } while (cursor !== '0');

        all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

        // Summary stats
        const pendingAmt = all.filter(w => (w.status || 'pending').toLowerCase() === 'pending')
          .reduce((s, w) => s + (Number(w.amount) || 0), 0);
        const pendingCount = all.filter(w => (w.status || 'pending').toLowerCase() === 'pending').length;

        return res.status(200).json({
          success: true,
          filter: wantStatus,
          total: all.length,
          pending_count: pendingCount,
          pending_total_amount: Number(pendingAmt.toFixed(2)),
          withdrawals: all,
        });
      }

      let targetUser = canonizeUser(req.query.username);
      // If no username specified, default to JWT user
      if (!targetUser) targetUser = jwtUsername;
      // Non-admin can only view own data
      if (!isAdmin && targetUser !== jwtUsername) {
        return res.status(403).json({ error: 'Forbidden: can only view your own data', code: 'FORBIDDEN' });
      }

      const redisKey = `nf_user_data:${targetUser}`;
      let userData = null;
      try {
        if (redis) {
          const raw = await redis.get(redisKey);
          userData = parseStoredUserData(raw);
        }
      } catch (e) {
        return res.status(503).json({ error: 'Wallet data is temporarily unavailable', code: e.code || 'WALLET_UNAVAILABLE' });
      }
      if (userData && (typeof userData !== 'object' || Array.isArray(userData))) {
        return res.status(503).json({ error: 'Wallet data is temporarily unavailable', code: 'WALLET_DATA_CORRUPT' });
      }
      if (!userData) userData = {};

      const incomeProfile = promoterIncomeProfile(await loadIncomeSources(), targetUser);
      const balances = computeWalletBalances(
        userData,
        incomeProfile,
        await getIncomeAdjustment(redis, targetUser, { failClosed: true }),
      );
      const daily = buildEarningsDetail(incomeProfile, userData, 30);

      return res.status(200).json({
        success: true,
        username: targetUser,
        ...balances,
        earnings_detail: daily,
        min_withdrawal: 10,
        fee_percent: 5,
        currency: 'USD',
        payment_methods: ['paypal'],
      });
    }

    if (req.method === 'POST') {
      const { username: rawUser, amount, payment_account, idempotency_key: idempotencyKey } = req.body || {};
      let targetUser = canonizeUser(rawUser);
      if (!targetUser) targetUser = jwtUsername;
      // Non-admin can only submit withdrawals for themselves
      if (!isAdmin && targetUser !== jwtUsername) {
        return res.status(403).json({ error: 'Forbidden: can only submit withdrawals for your own account', code: 'FORBIDDEN' });
      }

      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt < 10) {
        return res.status(400).json({ error: 'Minimum withdrawal amount is $10' });
      }
      if (amt > 10000) {
        return res.status(400).json({ error: 'Single withdrawal cannot exceed $10,000' });
      }

      const account = String(payment_account || '').trim().toLowerCase();
      if (!EMAIL_RE.test(account)) {
        return res.status(400).json({ error: 'Please provide a valid PayPal email address' });
      }
      if (!validIdempotencyKey(idempotencyKey)) {
        return res.status(400).json({ error: 'idempotency_key must be 12-120 URL-safe characters', code: 'INVALID_IDEMPOTENCY_KEY' });
      }

      if (!redis) {
        return res.status(503).json({ error: 'Wallet storage unavailable', code: 'WALLET_UNAVAILABLE' });
      }

      let lock;
      try {
        lock = await acquireUserDataLock(redis, targetUser);
      } catch (_error) {
        return res.status(503).json({ error: 'Wallet storage temporarily unavailable', code: 'WALLET_UNAVAILABLE' });
      }
      if (!lock) {
        return res.status(409).json({ error: 'Another withdrawal is being submitted', code: 'WALLET_BUSY' });
      }

      try {

      const redisKey = `nf_user_data:${targetUser}`;

      let userData;
      try {
        const raw = await redis.get(redisKey);
        userData = parseStoredUserData(raw);
      } catch (e) {
        return res.status(503).json({ error: 'Wallet data is temporarily unavailable', code: e.code || 'WALLET_UNAVAILABLE' });
      }
      if (userData && (typeof userData !== 'object' || Array.isArray(userData))) {
        return res.status(503).json({ error: 'Wallet data is temporarily unavailable', code: 'WALLET_DATA_CORRUPT' });
      }
      if (!userData) userData = {};
      if (userData.disabled) {
        return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
      }
      if (!Array.isArray(userData.withdrawals)) userData.withdrawals = [];

      const duplicate = userData.withdrawals.find(item => item && item.idempotency_key === idempotencyKey);
      if (duplicate) {
        if (Number(duplicate.amount) !== Number(amt.toFixed(2)) || String(duplicate.payment_account || '').trim().toLowerCase() !== account) {
          return res.status(409).json({ error: 'Idempotency key was already used for a different withdrawal', code: 'IDEMPOTENCY_CONFLICT' });
        }
        return res.status(200).json({
          success: true,
          idempotent: true,
          request_id: duplicate.id,
          message: 'Withdrawal request already submitted',
          request: duplicate,
          fee_percent: 5,
          net_amount: Number(duplicate.net_amount) || 0,
        });
      }

      const incomeProfile = promoterIncomeProfile(await loadIncomeSources(), targetUser);
      const incomeAdjustment = await getIncomeAdjustment(redis, targetUser, { failClosed: true });
      const balances = computeWalletBalances(userData, incomeProfile, incomeAdjustment);

      if (amt > balances.available_balance + 0.001) {
        return res.status(400).json({
          error: `Insufficient balance. Available: $${balances.available_balance.toFixed(2)}`,
          available: balances.available_balance,
        });
      }

      const FEE_PCT = 0.05;
      const feeAmount = Number((amt * FEE_PCT).toFixed(2));
      const netAmount = Number((amt - feeAmount).toFixed(2));
      const request = {
        id: makeId(),
        amount: Number(amt.toFixed(2)),     // gross requested (deducted from balance)
        fee: feeAmount,                     // 5% platform fee
        net_amount: netAmount,              // actual PayPal payout
        payment_account: account,
        idempotency_key: idempotencyKey,
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      userData.withdrawals.push(request);

      await redis.set(redisKey, JSON.stringify(userData));
      const updatedBalances = computeWalletBalances(userData, incomeProfile, incomeAdjustment);

      return res.status(200).json({
        success: true,
        request_id: request.id,
        message: `Withdrawal request submitted. $${netAmount.toFixed(2)} will be sent to your PayPal after 5% fee within 3-5 business days.`,
        request,
        fee_percent: 5,
        net_amount: netAmount,
        available_balance: updatedBalances.available_balance,
      });
      } finally {
        await releaseUserDataLock(redis, lock);
      }
    }

    // ========== ADMIN APPROVE/REJECT (PATCH) ==========
    if (req.method === 'PATCH') {
      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin only', code: 'ADMIN_ONLY' });
      }
      const { username: targetUserRaw, request_id, action, note } = req.body || {};
      const targetUser = canonizeUser(targetUserRaw);
      if (!targetUser || !request_id || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Required fields: username, request_id, action (approve|reject)' });
      }
      if (!redis) {
        return res.status(503).json({ error: 'Wallet storage unavailable', code: 'WALLET_UNAVAILABLE' });
      }

      let lock;
      try {
        lock = await acquireUserDataLock(redis, targetUser);
      } catch (_error) {
        return res.status(503).json({ error: 'Wallet storage temporarily unavailable', code: 'WALLET_UNAVAILABLE' });
      }
      if (!lock) {
        return res.status(409).json({ error: 'Another wallet update is in progress', code: 'WALLET_BUSY' });
      }

      try {

      const redisKey = `nf_user_data:${targetUser}`;
      let userData;
      try {
        const raw = await redis.get(redisKey);
        userData = parseStoredUserData(raw);
      } catch (e) {
        return res.status(503).json({ error: 'Wallet data is temporarily unavailable', code: e.code || 'WALLET_UNAVAILABLE' });
      }
      if (userData && (typeof userData !== 'object' || Array.isArray(userData))) {
        return res.status(503).json({ error: 'Wallet data is temporarily unavailable', code: 'WALLET_DATA_CORRUPT' });
      }
      if (!userData) userData = {};
      if (!Array.isArray(userData.withdrawals)) userData.withdrawals = [];

      const wIdx = userData.withdrawals.findIndex(w => w && w.id === request_id);
      if (wIdx < 0) {
        return res.status(404).json({ error: 'Withdrawal request not found' });
      }
      const wd = userData.withdrawals[wIdx];
      if (wd.status !== 'pending') {
        return res.status(400).json({ error: `Request already ${wd.status}`, current_status: wd.status });
      }

      wd.status = action === 'approve' ? 'approved' : 'rejected';
      wd.processed_at = new Date().toISOString();
      wd.processed_by = jwtUsername;
      if (note) wd.admin_note = String(note).slice(0, 500);

      // rejected 时钱自动回到 available_balance（因为 pendingTotal 已不再计入）
      // approved 时钱从 pending → approved（available_balance 也会自然下降）
      await redis.set(redisKey, JSON.stringify(userData));

      const incomeProfile = promoterIncomeProfile(await loadIncomeSources(), targetUser);
      const newBalances = computeWalletBalances(
        userData,
        incomeProfile,
        await getIncomeAdjustment(redis, targetUser, { failClosed: true }),
      );

      return res.status(200).json({
        success: true,
        message: `Withdrawal ${wd.status}`,
        request: wd,
        balances: newBalances,
      });
      } finally {
        await releaseUserDataLock(redis, lock);
      }
    }

    res.setHeader('Allow', 'GET, POST, PATCH, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[withdrawals] error:', err);
    if (err && (err.code === 'INCOME_ADJUSTMENT_UNAVAILABLE' || err.code === 'INCOME_SOURCE_UNAVAILABLE')) {
      return res.status(503).json({ error: 'Wallet balance is temporarily unavailable', code: err.code });
    }
    return res.status(503).json({ error: 'Wallet service temporarily unavailable', code: 'WALLET_UNAVAILABLE' });
  }
};
