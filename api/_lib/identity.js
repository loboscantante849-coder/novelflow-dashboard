const { isProtectedPromoterUsername } = require('./promoter-access');

function normalizeIdentityUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return username && username.length <= 50 ? username : null;
}

function principalFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.principal === 'string' && /^(?:local|discord):[^\s]{1,128}$/.test(payload.principal)) {
    return payload.principal;
  }
  if (payload.discordId !== undefined && payload.discordId !== null && String(payload.discordId).trim()) {
    return `discord:${String(payload.discordId).trim()}`;
  }
  const username = normalizeIdentityUsername(payload.username);
  return username ? `local:${username}` : null;
}

async function claimIdentity(redis, usernameValue, principal) {
  const username = normalizeIdentityUsername(usernameValue);
  if (!redis || !username || typeof principal !== 'string') return false;
  const key = `nf_identity_owner:${username}`;
  const existing = await redis.get(key);
  if (existing) return String(existing) === principal;
  const claimed = await redis.set(key, principal, { nx: true });
  if (claimed) return true;
  return String(await redis.get(key) || '') === principal;
}

function accountIdentityUsernames(usernameValue) {
  const username = normalizeIdentityUsername(usernameValue);
  if (!username) return [];
  // Lazy import keeps the identity core independent during module startup.
  const { resolveUsernameAlias } = require('./wallet-identity');
  const primary = normalizeIdentityUsername(resolveUsernameAlias(username));
  return Array.from(new Set([username, primary].filter(Boolean)));
}

async function claimAccountIdentity(redis, usernameValue, principal) {
  const usernames = accountIdentityUsernames(usernameValue);
  if (!redis || !usernames.length || typeof principal !== 'string') return false;
  const owners = await Promise.all(usernames.map(username => redis.get(`nf_identity_owner:${username}`)));
  if (owners.some(owner => owner && String(owner) !== principal)) return false;
  for (const username of usernames) {
    if (!await claimIdentity(redis, username, principal)) return false;
  }
  return true;
}

async function assertAccountIdentity(redis, payload) {
  const username = normalizeIdentityUsername(payload && payload.username);
  const principal = principalFromPayload(payload);
  if (!username || !principal || !await claimAccountIdentity(redis, username, principal)) {
    const error = new Error('Account identity conflict');
    error.code = 'ACCOUNT_IDENTITY_CONFLICT';
    throw error;
  }
  return { username, principal };
}

async function bindPasswordPrincipal(redis, usernameValue, principal) {
  const username = normalizeIdentityUsername(usernameValue);
  if (!redis || !username || typeof principal !== 'string') return false;
  const key = `nf_user_pass_owner:${username}`;
  const existing = await redis.get(key);
  if (existing) return String(existing) === principal;
  const claimed = await redis.set(key, principal, { nx: true });
  if (claimed) return true;
  return String(await redis.get(key) || '') === principal;
}

async function resolvePasswordPrincipal(redis, usernameValue, authenticatedPayload = null) {
  const username = normalizeIdentityUsername(usernameValue);
  if (!username) return null;
  const stored = await redis.get(`nf_user_pass_owner:${username}`);
  if (stored) return String(stored);
  const sessionUsername = normalizeIdentityUsername(authenticatedPayload && authenticatedPayload.username);
  if (sessionUsername === username) return principalFromPayload(authenticatedPayload);
  return `local:${username}`;
}

async function resolveDiscordIdentity(redis, discordIdValue, currentUsernameValue, { adData = null } = {}) {
  const discordId = String(discordIdValue || '').trim();
  const currentUsername = normalizeIdentityUsername(currentUsernameValue);
  if (!redis || !discordId || discordId.length > 128 || !currentUsername) return null;
  const principal = `discord:${discordId}`;
  const mappingKey = `nf_discord_username:${discordId}`;
  let username = normalizeIdentityUsername(await redis.get(mappingKey));
  if (!username) {
    username = currentUsername;
    const [identityOwner, passwordOwner, passwordHash, userData] = await Promise.all([
      redis.get(`nf_identity_owner:${username}`),
      redis.get(`nf_user_pass_owner:${username}`),
      redis.get(`nf_user_pass:${username}`),
      redis.get(`nf_user_data:${username}`),
    ]);
    if (identityOwner) {
      if (String(identityOwner) !== principal) return null;
    } else if (passwordOwner || passwordHash || userData || isProtectedPromoterUsername(username, adData)) {
      return null;
    }
  }
  if (!await claimIdentity(redis, username, principal)) return null;
  if (!await redis.get(mappingKey)) {
    await redis.set(mappingKey, username, { nx: true });
    username = normalizeIdentityUsername(await redis.get(mappingKey)) || username;
    if (!await claimIdentity(redis, username, principal)) return null;
  }
  return { username, principal };
}

module.exports = {
  assertAccountIdentity,
  claimAccountIdentity,
  bindPasswordPrincipal,
  claimIdentity,
  normalizeIdentityUsername,
  principalFromPayload,
  resolveDiscordIdentity,
  resolvePasswordPrincipal,
};
