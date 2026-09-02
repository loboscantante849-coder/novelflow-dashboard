'use strict';

const { handlePreflight } = require('./_lib/cors');
const { getRedis, checkAdminKey, validateString, stripHtml } = require('./_lib/security');
const { createPasswordHash } = require('./_lib/password');
const {
  loadLocalLoginCredentials,
  localLoginCredentialCandidates,
} = require('./_lib/login-identity');

/**
 * Administrative password reset for an existing local account.
 *
 * This endpoint is intentionally separate from user self-service password
 * changes. It requires the server-managed ADMIN_KEY and never logs or returns
 * the supplied password.
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { credentials: false })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkAdminKey(req)) return res.status(403).json({ error: 'Admin key required', code: 'ADMIN_KEY_REQUIRED' });

  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const usernameValidation = validateString(body.username, { name: 'username', maxLen: 50, required: true });
    if (!usernameValidation.ok) return res.status(usernameValidation.status).json({ error: usernameValidation.error });
    const passwordValidation = validateString(body.password, { name: 'password', maxLen: 128, minLen: 8, required: true });
    if (!passwordValidation.ok) return res.status(passwordValidation.status).json({ error: passwordValidation.error });
    if (!/[A-Za-z]/.test(passwordValidation.value) || !/[0-9]/.test(passwordValidation.value)) {
      return res.status(400).json({ error: 'Password must contain at least one letter and one digit' });
    }

    const cleanUsername = stripHtml(usernameValidation.value.trim());
    const identity = localLoginCredentialCandidates(cleanUsername);
    const redis = getRedis();
    if (!redis) return res.status(503).json({ error: 'Authentication service unavailable', code: 'AUTH_STORAGE_UNAVAILABLE' });

    const credentials = await loadLocalLoginCredentials(redis, cleanUsername, { scanCaseVariants: true });
    let hasUserData = false;
    for (const username of identity.usernames) {
      if (await redis.get(`nf_user_data:${username}`)) {
        hasUserData = true;
        break;
      }
    }
    if (!credentials.records.length && !hasUserData) {
      return res.status(404).json({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
    }

    const hash = await createPasswordHash(passwordValidation.value);
    const storageUsernames = Array.from(new Set([
      identity.primaryUsername,
      ...credentials.records.map(record => record.storageUsername),
    ].filter(Boolean)));
    await Promise.all(storageUsernames.map(username => redis.set(`nf_user_pass:${username}`, hash)));

    // A successful admin reset must not leave the account stranded by a stale
    // login lock or failure counter, regardless of which client created it.
    await Promise.all([
      redis.del(`nf_login_fail:${identity.primaryUsername}`).catch(() => {}),
      redis.del(`nf_login_lock:${identity.primaryUsername}`).catch(() => {}),
    ]);

    console.warn('[admin-password-reset] password reset completed', {
      username: identity.primaryUsername,
      updatedKeys: storageUsernames.length,
    });
    return res.status(200).json({
      success: true,
      username: identity.primaryUsername,
      updatedKeys: storageUsernames.length,
    });
  } catch (error) {
    console.error('[admin-password-reset] failed', error && error.code || 'unknown_error');
    return res.status(500).json({ error: 'Password reset failed', code: 'PASSWORD_RESET_FAILED' });
  }
};
