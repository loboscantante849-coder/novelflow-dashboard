const { resolveUsernameAlias } = require('./wallet-identity');
const { verifiedSourceOwnerAliasValues } = require('./income-source-aliases');

// Login aliases are an authentication namespace, not wallet storage keys.
// Cons has historically been entered in several UI spellings while the local
// account/password principal remains `cons_espher`.
const LOCAL_LOGIN_PRIMARY_BY_EXPLICIT_ALIAS = new Map([
  ['cons_espher', 'cons_espher'],
  ['@cons_espher', 'cons_espher'],
  ['cons espher', 'cons_espher'],
  ['@cons espher', 'cons_espher'],
]);
const CONS_VERIFIED_CREDENTIAL = '@cons espher';
const ELIZA_VERIFIED_CREDENTIALS = Array.from(new Set([
  'eliza_star',
  ...verifiedSourceOwnerAliasValues().map(value => String(value).trim().toLowerCase()),
]));

function resolveLocalLoginUsername(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return LOCAL_LOGIN_PRIMARY_BY_EXPLICIT_ALIAS.get(raw) || resolveUsernameAlias(raw);
}

function canonicalizeLocalSessionPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'local') return payload;
  const username = resolveLocalLoginUsername(payload.username);
  if (!username) return payload;
  const principal = String(payload.principal || '');
  let canonicalPrincipal = principal;
  if (!principal) canonicalPrincipal = `local:${username}`;
  else if (principal.startsWith('local:') && resolveLocalLoginUsername(principal.slice(6)) === username) {
    canonicalPrincipal = `local:${username}`;
  }
  return { ...payload, username, principal: canonicalPrincipal };
}

function localLoginCredentialCandidates(value) {
  const exact = String(value || '').trim();
  const raw = exact.toLowerCase();
  const primaryUsername = resolveLocalLoginUsername(raw);
  if (primaryUsername !== 'cons_espher') {
    if (primaryUsername === 'eliza_star') {
      return {
        primaryUsername,
        usernames: Array.from(new Set([
          ELIZA_VERIFIED_CREDENTIALS.includes(raw) ? raw : null,
          ...ELIZA_VERIFIED_CREDENTIALS,
        ].filter(Boolean))),
      };
    }
    return {
      primaryUsername,
      usernames: Array.from(new Set([
        primaryUsername,
        exact && exact !== primaryUsername ? exact : null,
      ].filter(Boolean))),
    };
  }
  // `@cons espher` is both present in production credential storage and a
  // trusted raw username in the attribution pipeline. `constance.espher` is a
  // separate credential identity and is deliberately not auto-merged.
  const exactIsCredential = raw === CONS_VERIFIED_CREDENTIAL;
  return {
    primaryUsername,
    usernames: exactIsCredential
      ? [CONS_VERIFIED_CREDENTIAL, primaryUsername]
      : [primaryUsername, CONS_VERIFIED_CREDENTIAL],
  };
}

async function resolveLocalLoginPrincipal(redis, primaryUsername, credentialUsername, authenticatedPayload, resolvePasswordPrincipal) {
  const ownerKeys = Array.from(new Set([
    `nf_identity_owner:${primaryUsername}`,
    `nf_identity_owner:${credentialUsername}`,
    `nf_user_pass_owner:${credentialUsername}`,
  ]));
  const owners = (typeof redis.mget === 'function'
    ? await redis.mget(...ownerKeys)
    : await Promise.all(ownerKeys.map(key => redis.get(key))))
    .filter(Boolean)
    .map(String);
  if (new Set(owners).size > 1) return null;
  // The password may live under a historical spelling that contains spaces,
  // but session principals must stay in the canonical login namespace. The
  // credential key is still bound to this principal below, so a second local
  // identity cannot claim the historical password record.
  return owners[0] || resolvePasswordPrincipal(redis, primaryUsername, authenticatedPayload);
}

async function loadLocalLoginCredentials(redis, value) {
  const identity = localLoginCredentialCandidates(value);
  const records = await Promise.all(identity.usernames.map(async storageUsername => ({
    storageUsername,
    hash: await redis.get(`nf_user_pass:${storageUsername}`),
  })));
  return {
    ...identity,
    records: records.filter(record => record.hash),
  };
}

module.exports = {
  canonicalizeLocalSessionPayload,
  localLoginCredentialCandidates,
  loadLocalLoginCredentials,
  resolveLocalLoginPrincipal,
  resolveLocalLoginUsername,
};
