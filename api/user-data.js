/**
 * GET /api/user-data — Load user data from Redis
 * POST /api/user-data — Save CLIENT-WRITABLE-ONLY user data to Redis
 *
 * Security fix 2026-07-07: Sensitive fields (points, bonus_balance, vip_days,
 * bind_id, checkin, bonus_campaign1_claimed, streak_grand_claimed, disabled,
 * accountType, total_income_override) are SERVER-MANAGED and cannot be written
 * by the client. Client may only write safe UI-state fields.
 * Use /api/rewards for all reward/balance mutations.
 */
const { handlePreflight } = require('./_lib/cors');
const { Redis } = require('@upstash/redis');
const { mergeBookState } = require('./_lib/sync');
const { commitUserDataUnderLock, releaseUserDataLock } = require('./_lib/user-data-lock');
const { assertAccountIdentity, checkRateLimit, getAuthPayload, getClientIp } = require('./_lib/security');
const { splitStoredBonus } = require('./_lib/commission-policy');
const { acquireWalletCreationSourceGuard } = require('./_lib/income-source-owners');
const {
  acquireWalletDataLock,
  resolveUsernameAlias,
  resolveWalletStorageIdentity,
} = require('./_lib/wallet-identity');

const MAX_SYNC_BODY_BYTES = 512 * 1024;
const SYNC_USER_LIMIT_PER_HOUR = 300;
const SYNC_IP_LIMIT_PER_HOUR = 1000;

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

// CLIENT_WRITABLE_FIELDS: Only UI-state fields the client may sync.
// All financial/balance/auth fields are SERVER-ONLY and must be changed via
// admin tools or the /api/rewards endpoint with server-side validation.
const CLIENT_WRITABLE_FIELDS = ['myBooks', 'deletedBooks', 'lastSyncAt'];

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: true })) return;

  

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Cloud sync not available' });
  }

  const payload = getAuthPayload(req);
  const username = payload && payload.username;
  if (!username) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    await assertAccountIdentity(redis, payload);
  } catch (error) {
    return res.status(error && error.code === 'ACCOUNT_IDENTITY_CONFLICT' ? 409 : 503).json({
      error: 'Account identity recovery required',
      code: error && error.code || 'ACCOUNT_STATUS_UNAVAILABLE',
    });
  }

  const primaryUsername = resolveUsernameAlias(username);

  try {
    if (req.method === 'GET') {
      const identity = await resolveWalletStorageIdentity(redis, primaryUsername);
      if (identity.conflict) {
        return res.status(409).json({
          error: 'Account identity recovery required',
          code: 'WALLET_IDENTITY_CONFLICT',
        });
      }
      const redisKey = `nf_user_data:${identity.storageUsername}`;
      const data = await redis.get(redisKey);
      if (!data) {
        return res.status(200).json({ exists: false, data: null });
      }
      // Parse if string
      let parsed = data;
      if (typeof data === 'string') {
        try { parsed = JSON.parse(data); } catch {
          return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_CORRUPT' });
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_CORRUPT' });
      }
      return res.status(200).json({
        exists: true,
        data: { ...parsed, ...splitStoredBonus(parsed) },
      });
    }

    if (req.method === 'POST') {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Invalid request body' });
      }
      let bodySize = 0;
      try {
        bodySize = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
      } catch (_error) {
        return res.status(400).json({ error: 'Invalid request body' });
      }
      if (bodySize > MAX_SYNC_BODY_BYTES) {
        return res.status(413).json({ error: 'Sync payload too large', code: 'SYNC_PAYLOAD_TOO_LARGE' });
      }
      const { data } = req.body;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ error: 'No data provided' });
      }

      try {
        const normalizedIp = String(getClientIp(req)).slice(0, 128);
        const [userAllowed, ipAllowed] = await Promise.all([
          checkRateLimit(redis, `nf_rate:user_sync:${primaryUsername}`, SYNC_USER_LIMIT_PER_HOUR, 3600, { failClosed: true }),
          checkRateLimit(redis, `nf_rate:user_sync_ip:${normalizedIp}`, SYNC_IP_LIMIT_PER_HOUR, 3600, { failClosed: true }),
        ]);
        if (!userAllowed || !ipAllowed) {
          return res.status(429).json({ error: 'Too many sync requests', code: 'RATE_LIMITED' });
        }
      } catch (_error) {
        return res.status(503).json({ error: 'Cloud sync temporarily unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
      }

      let walletLock;
      try {
        walletLock = await acquireWalletDataLock(redis, primaryUsername);
      } catch (error) {
        if (error && error.code === 'WALLET_IDENTITY_CONFLICT') {
          return res.status(409).json({
            error: 'Account identity recovery required',
            code: error.code,
          });
        }
        return res.status(503).json({ error: 'User data storage is temporarily unavailable', code: 'USER_DATA_UNAVAILABLE' });
      }
      const { lock, identity } = walletLock;
      if (!lock) {
        return res.status(409).json({ error: 'User data is being updated', code: 'USER_DATA_BUSY' });
      }

      let sourceGuard = null;
      try {
        try {
          sourceGuard = await acquireWalletCreationSourceGuard(redis, primaryUsername, identity);
        } catch (error) {
          if (error && ['INCOME_SOURCE_OWNER_UNVERIFIED', 'INCOME_SOURCE_OWNER_CONFLICT', 'INCOME_SOURCE_BUSY'].includes(error.code)) {
            return res.status(409).json({ error: error.message, code: error.code });
          }
          return res.status(503).json({ error: 'User data storage is temporarily unavailable', code: error && error.code || 'USER_DATA_UNAVAILABLE' });
        }
        const redisKey = `nf_user_data:${identity.storageUsername}`;
        // Fetch existing server data first (merge strategy: client cannot overwrite server-managed fields)
        let existing = await redis.get(redisKey);
        if (existing) {
          if (typeof existing === 'string') {
            try { existing = JSON.parse(existing); } catch {
              return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_CORRUPT' });
            }
          }
          if (existing && (typeof existing !== 'object' || Array.isArray(existing))) {
            return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_CORRUPT' });
          }
        }
        if (!existing || typeof existing !== 'object') existing = {};
        if (existing.disabled) {
          return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        }
        if (existing.wallet_merged_into) {
          return res.status(409).json({ error: 'Wallet merged into a primary account', code: 'WALLET_MERGED' });
        }

        // Build cleanData by copying ONLY client-writable fields from the request.
        const cleanData = { ...existing };
        const bookState = mergeBookState(existing, data);
        cleanData.myBooks = bookState.myBooks;
        cleanData.deletedBooks = bookState.deletedBooks;
        for (const key of CLIENT_WRITABLE_FIELDS) {
          if (data[key] !== undefined) {
            if (key === 'myBooks' || key === 'deletedBooks') {
              continue;
            } else if (key === 'claimed' && typeof data[key] === 'object' && existing.claimed) {
              cleanData.claimed = { ...existing.claimed, ...data[key] };
            }
            else {
              cleanData[key] = data[key];
            }
          }
        }
        cleanData.lastSyncAt = Date.now();

        // Ensure server-managed fields are preserved and cannot be tampered with
        const SERVER_MANAGED = ['points', 'bonus_balance', 'vip_days', 'bind_id', 'checkin', 'claimed', 'reward_history',
          'bonus_campaign1_claimed', 'streak_grand_claimed', 'streak_grand_sequence', 'disabled', 'accountType',
          'total_income_override', 'withdrawals', 'balance_migrations'];
        for (const sf of SERVER_MANAGED) {
          if (existing[sf] !== undefined) {
            cleanData[sf] = existing[sf];
          }
        }

        await commitUserDataUnderLock(redis, redisKey, cleanData, [lock, sourceGuard]);

        return res.status(200).json({
          success: true,
          lastSyncAt: cleanData.lastSyncAt,
          deletedBooks: cleanData.deletedBooks,
        });
      } finally {
        await releaseUserDataLock(redis, sourceGuard);
        await releaseUserDataLock(redis, lock);
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('User data sync error:', error);
    return res.status(503).json({ error: 'User data is temporarily unavailable', code: 'USER_DATA_UNAVAILABLE' });
  }
};
