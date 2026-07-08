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
const path = require('path');
const fs = require('fs');
const { handlePreflight } = require('./_lib/cors');
const { getAuthPayload, getRedis, isAdminUser } = require('./_lib/security');
const { Redis } = require('@upstash/redis');

function redisClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

// ---------- Load data.json (pipeline output bundled on Vercel) ----------
let _dataJsonCache = null;
function getDataJson() {
  if (_dataJsonCache) return _dataJsonCache;
  const candidates = [
    path.join(__dirname, '..', 'data.json'),
    path.join(process.cwd(), 'data.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        _dataJsonCache = JSON.parse(fs.readFileSync(p, 'utf8'));
        return _dataJsonCache;
      }
    } catch (_e) { /* try next */ }
  }
  return { users: {} };
}

function getPromoterDnIncome(username) {
  const d = getDataJson();
  const users = d.users || {};
  if (users[username]) return Number(users[username].subscription_revenue_dn || 0);
  const lower = String(username).toLowerCase();
  for (const key of Object.keys(users)) {
    if (key.toLowerCase() === lower) return Number(users[key].subscription_revenue_dn || 0);
  }
  return 0;
}

// ---------- Helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function canonizeUser(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z0-9_.\-]{1,40}$/.test(s)) return null;
  return s;
}

function computeBalances(userData, totalDnIncome) {
  const bonus = Number(userData && userData.bonus_balance) || 0;
  const withdrawals = Array.isArray(userData && userData.withdrawals) ? userData.withdrawals : [];
  const approvedTotal = withdrawals
    .filter(w => w && w.status === 'approved')
    .reduce((s, w) => s + (Number(w.amount) || 0), 0);
  const pendingTotal = withdrawals
    .filter(w => w && w.status === 'pending')
    .reduce((s, w) => s + (Number(w.amount) || 0), 0);
  const rejectedTotal = withdrawals
    .filter(w => w && w.status === 'rejected')
    .reduce((s, w) => s + (Number(w.amount) || 0), 0);
  // Frozen = pending (申请审核中，已从可用余额扣除)
  // Available = total earned - approved(已打款) - pending(冻结中)
  // rejected 不计入扣减（被拒绝后钱回到可用余额）
  const available = Math.max(0, bonus + totalDnIncome - approvedTotal - pendingTotal);
  return {
    bonus_balance: Number(bonus.toFixed(2)),
    total_earned: Number((bonus + totalDnIncome).toFixed(2)),
    total_dn_income: Number(totalDnIncome.toFixed(2)),
    approved_total: Number(approvedTotal.toFixed(2)),
    pending_total: Number(pendingTotal.toFixed(2)),
    frozen_total: Number(pendingTotal.toFixed(2)),
    rejected_total: Number(rejectedTotal.toFixed(2)),
    available_balance: Number(available.toFixed(2)),
    pending_settlement: Number(pendingTotal.toFixed(2)),
    withdrawals: withdrawals.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
  };
}

function makeId() {
  return 'wd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
              for (const w of ud.withdrawals) {
                if (!w || !w.id) continue;
                const st = (w.status || 'pending').toLowerCase();
                if (wantStatus !== 'all' && st !== wantStatus) continue;
                all.push({
                  username: uname,
                  ...w,
                  dn_income: Number(getPromoterDnIncome(uname)).toFixed(2),
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
          userData = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        }
      } catch (e) {
        return res.status(500).json({ error: 'Failed to load user data', detail: e.message });
      }
      if (!userData || typeof userData !== 'object') userData = {};

      const dnIncome = getPromoterDnIncome(targetUser);
      const balances = computeBalances(userData, dnIncome);

      const d = getDataJson();
      const uRaw = (d.users || {})[targetUser] ||
        Object.values(d.users || {}).find(v => String(v.name || '').toLowerCase() === targetUser);
      let daily = [];
      if (uRaw && uRaw.subscription_revenue_dn_daily) {
        daily = Object.entries(uRaw.subscription_revenue_dn_daily)
          .map(([date, val]) => ({ date, amount: Number(val) || 0 }))
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 30);
      }

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
      const { username: rawUser, amount, payment_account } = req.body || {};
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

      const account = String(payment_account || '').trim();
      if (!EMAIL_RE.test(account)) {
        return res.status(400).json({ error: 'Please provide a valid PayPal email address' });
      }

      const redisKey = `nf_user_data:${targetUser}`;

      let userData;
      try {
        if (redis) {
          const raw = await redis.get(redisKey);
          userData = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        } else {
          userData = {};
        }
      } catch (e) {
        return res.status(500).json({ error: 'Failed to load user data', detail: e.message });
      }
      if (!userData || typeof userData !== 'object') userData = {};
      if (!Array.isArray(userData.withdrawals)) userData.withdrawals = [];

      const dnIncome = getPromoterDnIncome(targetUser);
      const balances = computeBalances(userData, dnIncome);

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
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      userData.withdrawals.push(request);

      if (redis) {
        await redis.set(redisKey, JSON.stringify(userData));
      }

      return res.status(200).json({
        success: true,
        request_id: request.id,
        message: `Withdrawal request submitted. $${netAmount.toFixed(2)} will be sent to your PayPal after 5% fee within 3-5 business days.`,
        request,
        fee_percent: 5,
        net_amount: netAmount,
        available_balance: balances.available_balance,
      });
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

      const redisKey = `nf_user_data:${targetUser}`;
      let userData;
      try {
        const raw = await redis.get(redisKey);
        userData = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      } catch (e) {
        return res.status(500).json({ error: 'Failed to load user data', detail: e.message });
      }
      if (!userData || typeof userData !== 'object') userData = {};
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

      const dnIncome = getPromoterDnIncome(targetUser);
      const newBalances = computeBalances(userData, dnIncome);

      return res.status(200).json({
        success: true,
        message: `Withdrawal ${wd.status}`,
        request: wd,
        balances: newBalances,
      });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[withdrawals] error:', err);
    return res.status(500).json({ error: 'Internal error', detail: String(err && err.message || err) });
  }
};
