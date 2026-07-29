const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const middlewareSource = fs.readFileSync(path.join(ROOT, 'middleware.js'), 'utf8');

async function loadMiddleware() {
  const encoded = Buffer.from(middlewareSource).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}
const sensitiveFiles = [
  'data.json',
  'link-stats.json',
  'submissions.json',
  'ad_id_details.json',
  'campaign_config.json',
  'beidou-koc-monthly-data.json',
  'users.json',
  'dashboard.html',
  'leaderboard.html',
  'book-submit.html',
  'book-wall.html',
  'discord-activity.html',
  'version-notes.html',
  'anystories-api-info.md',
  'beidou-api-info.md',
  'CPS_PLAYBOOK_V2.md',
  'DESIGN.md',
  'PLATFORM_TECHNICAL_SPEC.md',
  'SECURITY_QUICK_FIX.md',
  '投放报表API对接指南-财务数据实时查询.md',
  'ac-sdk.js',
];

const removedLegacyFiles = [
  'orders.html',
  'admin.html',
  'book-admin.html',
  'migrate.html',
  'nft-platform.html',
];

const protectedRoutes = [
  '/data.json',
  '/data.json.bak',
  '/data.json.bak:rest(\\..+)',
  '/link-stats.json',
  '/link-stats.json.bak',
  '/link-stats.json.bak:rest(\\..+)',
  '/submissions.json',
  '/submissions.json.bak',
  '/submissions.json.bak:rest(\\..+)',
  '/ad_id_details.json',
  '/campaign_config.json',
  '/beidou-koc-monthly-data.json',
  '/users.json',
  '/.code-review-graph',
  '/.code-review-graph/:path*',
  '/tests/:path*',
  '/scripts/:path*',
  '/promo-copy/:path*',
  '/fetch_koc_data.py',
  '/run_fetch.py',
  '/orders',
  '/orders.html',
  '/admin',
  '/admin.html',
  '/book-admin',
  '/book-admin.html',
  '/migrate',
  '/migrate.html',
  '/nft-platform',
  '/nft-platform.html',
  '/dashboard',
  '/dashboard.html',
  '/leaderboard',
  '/leaderboard.html',
  '/book-submit',
  '/book-submit.html',
  '/book-wall',
  '/book-wall.html',
  '/discord-activity',
  '/discord-activity.html',
  '/version-notes',
  '/version-notes.html',
  '/anystories-api-info.md',
  '/beidou-api-info.md',
  '/CPS_PLAYBOOK_V2.md',
  '/DESIGN.md',
  '/PLATFORM_TECHNICAL_SPEC.md',
  '/SECURITY_QUICK_FIX.md',
  '/:document(.+\\.md)',
  '/ac-sdk.js',
];

test('sensitive static routes are matched before Vercel serves files', async () => {
  const middleware = await loadMiddleware();
  const matchers = new Set(middleware.config?.matcher || []);
  for (const route of protectedRoutes) {
    assert.equal(matchers.has(route), true, `${route} must not be publicly served`);
  }
});

test('clean URL aliases for internal HTML pages are protected', async () => {
  assert.equal(vercel.cleanUrls, true);
  const middleware = await loadMiddleware();
  const matchers = new Set(middleware.config?.matcher || []);

  for (const file of sensitiveFiles.filter((name) => name.endsWith('.html'))) {
    assert.equal(matchers.has(`/${file.slice(0, -5)}`), true);
    assert.equal(matchers.has(`/${file}`), true);
  }
});

test('sensitive business files remain available to server-side code', () => {
  for (const file of sensitiveFiles) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, `${file} must not be deleted`);
  }
});

test('excluded legacy sales and static admin pages are absent from the deployment', () => {
  for (const file of removedLegacyFiles) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), false, `${file} must stay removed`);
  }
});

test('development and private-content directories are protected', async () => {
  const middleware = await loadMiddleware();
  const matchers = new Set(middleware.config?.matcher || []);
  for (const route of ['/.code-review-graph/:path*', '/tests/:path*', '/scripts/:path*', '/promo-copy/:path*']) {
    assert.equal(matchers.has(route), true, `${route} must not be publicly served`);
  }
});

test('sensitive-route middleware always returns a non-cacheable 404', async () => {
  const middleware = await loadMiddleware();
  const response = await middleware.default();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(await response.text(), 'Not Found');
});
