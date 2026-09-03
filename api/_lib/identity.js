const { isProtectedPromoterUsername } = require('./promoter-access');

function normalizeIdentityUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return username && username.length <= 50 ? username : null;
}

function canonicalizeLocalPrincipal(value, usernameHint = '') {
  const raw = String(value || '').trim();
  if (!/^local:[^\r\n]{1,128}$/.test(raw)) return raw;
  const handle = raw.slice(6).trim();
  if (!handle || handle.length > 50) return raw;
  let resolveUsernameAlias;
  try { ({ resolveUsernameAlias } = require('./wallet-identity')); } catch (_error) { return raw; }
  const canonicalHandle = normalizeIdentityUsername(resolveUsernameAlias(handle));
  const hinted = normalizeIdentityUsername(usernameHint);
  if (!canonicalHandle || (hinted && normalizeIdentityUsername(resolveUsernameAlias(hinted)) !== canonicalHandle)) return raw;
  return `local:${canonicalHandle}`;
}

function principalFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.principal === 'string' && /^(?:local|discord):[^\s]{1,128}$/.test(payload.principal)) {
    return payload.principal.startsWith('local:') ? canonicalizeLocalPrincipal(payload.principal, payload.username) : payload.principal;
  }
  if (payload.discordId !== undefined && payload.discordId !== null && String(payload.discordId).trim()) {
    return `discord:${String(payload.discordId).trim()}`;
  }
  const username = normalizeIdentityUsername(payload.username);
  return username ? canonicalizeLocalPrincipal(`local:${username}`, username) : null;
}

async function claimIdentity(redis, usernameValue, principal) {
  const username = normalizeIdentityUsername(usernameValue);
  if (!redis || !username || typeof principal !== 'string') return false;
  const canonicalPrincipal = canonicalizeLocalPrincipal(principal, username);
  if (!canonicalPrincipal) return false;
  const key = `nf_identity_owner:${username}`;
  const existing = await redis.get(key);
  if (existing) return canonicalizeLocalPrincipal(existing, username) === canonicalPrincipal;
  const claimed = await redis.set(key, canonicalPrincipal, { nx: true });
  if (claimed) return true;
  return canonicalizeLocalPrincipal(await redis.get(key) || '', username) === canonicalPrincipal;
}

function accountIdentityUsernames(usernameValue) {
  const username = normalizeIdentityUsername(usernameValue);
  if (!username) return [];
  const { resolveUsernameAlias } = require('./wallet-identity');
  return Array.from(new Set([username, normalizeIdentityUsername(resolveUsernameAlias(username))].filter(Boolean)));
}

async function claimAccountIdentity(redis, usernameValue, principal) {
  const usernames = accountIdentityUsernames(usernameValue);
  if (!redis || !usernames.length || typeof principal !== 'string') return false;
  const canonicalPrincipal = canonicalizeLocalPrincipal(principal, usernames[0]);
  const owners = await Promise.all(usernames.map(username => redis.get(`nf_identity_owner:${username}`)));
  if (owners.some(owner => owner && canonicalizeLocalPrincipal(owner, usernames[0]) !== canonicalPrincipal)) return false;
  for (const username of usernames) if (!await claimIdentity(redis, username, canonicalPrincipal)) return false;
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
  if (await claimIdentity(redis, username, principal)) return { username, principal };

  // A local password session is minted only after the password was verified by
  // the server. If its durable password-owner record agrees with this session
  // but an older identity index disagrees, repair that stale index. This is
  // deliberately unavailable to Discord sessions and never accepts a client
  // supplied owner, so it cannot be used to claim another person's account.
  const localPrincipal = `local:${username}`;
  if (principal === localPrincipal) {
    const [passwordOwner, passwordHash] = await Promise.all([
      redis.get(`nf_user_pass_owner:${username}`),
      redis.get(`nf_user_pass:${username}`),
    ]);
    if (String(passwordOwner || '') === localPrincipal && passwordHash) {
      await redis.set(`nf_identity_owner:${username}`, localPrincipal);
      if (await claimIdentity(redis, username, localPrincipal)) return { username, principal };
    }
  }
  {
    const error = new Error('Account identity conflict');
    error.code = 'ACCOUNT_IDENTITY_CONFLICT';
    throw error;
  }
}

async function bindPasswordPrincipal(redis, usernameValue, principal) {
  const username = normalizeIdentityUsername(usernameValue);
  if (!redis || !username || typeof principal !== 'string') return false;
  const key = `nf_user_pass_owner:${username}`;
  const existing = await redis.get(key);
  const canonicalPrincipal = canonicalizeLocalPrincipal(principal, username);
  if (!canonicalPrincipal) return false;
  if (existing) return canonicalizeLocalPrincipal(existing, username) === canonicalPrincipal;
  const claimed = await redis.set(key, canonicalPrincipal, { nx: true });
  if (claimed) return true;
  return canonicalizeLocalPrincipal(await redis.get(key) || '', username) === canonicalPrincipal;
}

async function resolvePasswordPrincipal(redis, usernameValue, authenticatedPayload = null) {
  const username = normalizeIdentityUsername(usernameValue);
  if (!username) return null;
  const stored = await redis.get(`nf_user_pass_owner:${username}`);
  if (stored) return canonicalizeLocalPrincipal(stored, username);
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
    const [identityOwner, passwordOwner, passwordHash, userData] = await Promise.all([redis.get(`nf_identity_owner:${username}`), redis.get(`nf_user_pass_owner:${username}`), redis.get(`nf_user_pass:${username}`), redis.get(`nf_user_data:${username}`)]);
    if (identityOwner) { if (String(identityOwner) !== principal) return null; }
    else if (passwordOwner || passwordHash || userData || isProtectedPromoterUsername(username, adData)) return null;
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
  canonicalizeLocalPrincipal,
  normalizeIdentityUsername,
  principalFromPayload,
  resolveDiscordIdentity,
  resolvePasswordPrincipal,
};
