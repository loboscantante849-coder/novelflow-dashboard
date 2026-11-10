'use strict';
// Run against an isolated checkout of the admin deployment. These modules are
// copied byte-for-byte so the two deployments cannot drift in money arithmetic.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const target = process.argv[2];
if (!target || !fs.existsSync(path.join(target, 'api/_lib/stats-data.js'))) throw new Error('Pass an admin checkout path');
const modules = ['income-ledger.js', 'commission-policy.js', 'promoter-resolution.js', 'promoter-access.js',
  'income-source-aliases.js', 'recovered-income.js', 'reviewed-attribution.js', 'reviewed-attribution.json',
  'wallet-identity.js', 'identity.js', 'user-data-lock.js', 'income-source-owners.js'];
const dest = path.join(target, 'api/_lib/dashboard-shared');
fs.mkdirSync(dest, { recursive: true });
const manifest = {};
for (const name of modules) {
  const bytes = fs.readFileSync(path.join(__dirname, '../api/_lib', name));
  fs.writeFileSync(path.join(dest, name), bytes);
  manifest[name] = crypto.createHash('sha256').update(bytes).digest('hex');
}
fs.writeFileSync(path.join(dest, 'stats-data.js'), "module.exports = { ...require('./promoter-resolution'), getAdIdDetails: (...args) => require('../stats-data').getAdIdDetails(...args) };\n");
fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Synced ${modules.length} shared modules`);
