// Manually reviewed mappings between wallet/login spellings and reporting
// source keys. Keep this module dependency-free so registration protection and
// financial source authorization consume the exact same alias registry.
const VERIFIED_SOURCE_OWNER_ALIASES = new Map([
  ['eliza_stellar', new Set([
    'eliza_star',
    'eliza_stellar',
    'eliza-stellar',
    'eliza.stellar',
    'eliza stellar',
    '@eliza.stellar',
  ])],
]);

function verifiedSourceOwnerAliasValues() {
  return Array.from(VERIFIED_SOURCE_OWNER_ALIASES.values())
    .flatMap(aliases => Array.from(aliases));
}

module.exports = {
  VERIFIED_SOURCE_OWNER_ALIASES,
  verifiedSourceOwnerAliasValues,
};
