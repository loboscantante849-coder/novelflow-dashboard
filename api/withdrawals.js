/**
 * GET  /api/withdrawals?username=xxx  — KOC earnings + withdrawal history
 * POST /api/withdrawals                — Submit a new withdrawal request
 *
 * v2.6.0 — KOC earnings center (2026-07-06)
 *
 * Auth: simplified identity via ?username= / body.username (same as legacy KOC endpoints).
 *       Critical amount validation is ALWAYS done server-side against Redis-canonical balance,
 *       so a tampered client cannot over-withdraw.
 *
 * Redis layout:
 *   nf_user_data:<username>  (STRING, JSON) contains:
 *     bonus_balance: number (USD, platform cash bonus)
 *     withdrawals:   [{id, amount, payment_account, status, created_at, processed_at?}]
 *        status: 'pending' | 'approved' | 'rejected'
 *
 * Earnings (total_dn_income) are read from the deployed data.json bundled with the serverless
 * (same source the dashboard uses for per-promoter dn revenue).
 */
const path = require('path');
const fs = require('fs');
const { handlePreflight } = require('./_lib/cors');

// ---------- Redis (Upstash REST, direct fetch — env or hardcoded fallback) ----------
const UPSTASH_URL = process.env.KV_REST_API_URL || 'https://next-gibbon-79175.upstash.io';
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || 'gQAAAAAAATVHAAIgcDFhMjQ1ZDk0ZDJkNzk0ZjEyYTcwN2Y0MWQ5ZDVjMjQwMw';

async function redisGet(key) {
  const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Redis GET ${key} failed: ${r.status}`);
  const j = await r.json();
  if (j.result == null) return null;
  // Upstash returns the raw string we SET; parse as JSON
  return typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
}

async function redisSet(key, value) {
  // Use SET with raw JSON body (Content-Type text/plain as existing code does)
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  const r = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: payload,
  });
  if (!r.ok) throw new Error(`Redis SET ${key} failed: ${r.status}`);
  return r.json();
}

// ---------- Load data.json (pipeline output bundled on Vercel) ----------
let _dataJsonCache = null;
function getDataJson() {
  if (_dataJsonCache) return _dataJsonCache;
  // Vercel serves from /var/task/... ; __dirname is api/, data.json is at project root
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
  // Direct match
  if (users[username]) return Number(users[username].subscription_revenue_dn || 0);
  // Case-insensitive match
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
  // Basic safety: 3-40 chars, alphanumerics + _-.
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
  // available = bonus + dn_income - approved (pending does NOT reduce available yet; admin approves before deducting)
  const available = Math.max(0, bonus + totalDnIncome - approvedTotal);
  return {
    bonus_balance: Number(bonus.toFixed(2)),
    total_earned: Number((bonus + totalDnIncome).toFixed(2)),
    total_dn_income: Number(totalDnIncome.toFixed(2)),
    approved_total: Number(approvedTotal.toFixed(2)),
    pending_total: Number(pendingTotal.toFixed(2)),
    available_balance: Number(available.toFixed(2)),
    pending_settlement: 0, // cohort settlement not implemented
    withdrawals: withdrawals.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
  };
}

function makeId() {
  return 'wd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;

  // X-OS compatibility
  res.setHeader('X-OS', 'web');

  try {
    if (req.method === 'GET') {
      const username = canonizeUser(req.query.username);
      if (!username) {
        return res.status(400).json({ error: 'username is required' });
      }

      const redisKey = `nf_user_data:${username}`;
      let userData = null;
      try {
        userData = await redisGet(redisKey);
      } catch (e) {
        return res.status(500).json({ error: 'Failed to load user data', detail: e.message });
      }
      if (!userData || typeof userData !== 'object') userData = {};

      const dnIncome = getPromoterDnIncome(username);
      const balances = computeBalances(userData, dnIncome);

      // Build an "earnings detail" lightweight view — per-day dn earnings (top 30 recent days)
      const d = getDataJson();
      const uRaw = (d.users || {})[username] ||
        Object.values(d.users || {}).find(v => String(v.name || '').toLowerCase() === username);
      let daily = [];
      if (uRaw && uRaw.subscription_revenue_dn_daily) {
        daily = Object.entries(uRaw.subscription_revenue_dn_daily)
          .map(([date, val]) => ({ date, amount: Number(val) || 0 }))
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 30);
      }

      return res.status(200).json({
        username,
        ...balances,
        earnings_detail: daily,
        min_withdrawal: 10,
        fee_percent: 0,
        currency: 'USD',
      });
    }

    if (req.method === 'POST') {
      const { username: rawUser, amount, payment_account } = req.body || {};
      const username = canonizeUser(rawUser);
      if (!username) {
        return res.status(400).json({ error: 'username is required' });
      }

      // Validate amount
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt < 10) {
        return res.status(400).json({ error: 'Minimum withdrawal amount is $10' });
      }
      if (amt > 10000) {
        return res.status(400).json({ error: 'Single withdrawal cannot exceed $10,000' });
      }

      // Validate payment account (email)
      const account = String(payment_account || '').trim();
      if (!EMAIL_RE.test(account)) {
        return res.status(400).json({ error: 'Please provide a valid PayPal/Payoneer email address' });
      }

      const redisKey = `nf_user_data:${username}`;

      // ---------- CRITICAL: re-read server-side to prevent client tampering ----------
      let userData = await redisGet(redisKey);
      if (!userData || typeof userData !== 'object') userData = {};
      if (!Array.isArray(userData.withdrawals)) userData.withdrawals = [];

      const dnIncome = getPromoterDnIncome(username);
      const balances = computeBalances(userData, dnIncome);

      if (amt > balances.available_balance + 0.001) { // allow 1c floating slack
        return res.status(400).json({
          error: `Insufficient balance. Available: $${balances.available_balance.toFixed(2)}`,
          available: balances.available_balance,
        });
      }

      // Append new pending withdrawal (NO balance deduction — admin approves before payout)
      const request = {
        id: makeId(),
        amount: Number(amt.toFixed(2)),
        payment_account: account,
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      userData.withdrawals.push(request);

      // SINGLE JSON serialize → SET (avoid double-encoding!)
      await redisSet(redisKey, userData);

      return res.status(200).json({
        success: true,
        request_id: request.id,
        message: 'Withdrawal request submitted. We will process it within 3-5 business days.',
        request,
        available_balance: balances.available_balance, // unchanged; pending doesn't deduct
      });
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[withdrawals] error:', err);
    return res.status(500).json({ error: 'Internal error', detail: String(err && err.message || err) });
  }
};
