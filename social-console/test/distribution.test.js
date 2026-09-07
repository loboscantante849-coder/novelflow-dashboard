const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNT_ROUTES, configuredSocialEchoAccount, configuredSocialEchoAccounts, normalizeDelivery, sanitizeP0Selection, appByKey } = require('../api/_lib/distribution');

test('all fourteen SocialEcho accounts have one explicit route', () => {
  assert.equal(ACCOUNT_ROUTES.length, 14);
  assert.equal(new Set(ACCOUNT_ROUTES.map((route) => route.accountId)).size, 14);
});

test('configured SocialEcho accounts are available without a billable account-list request', () => {
  const accounts = configuredSocialEchoAccounts();
  assert.equal(accounts.length, 14);
  assert.deepEqual(configuredSocialEchoAccount(13943914), {
    id: 13943914,
    title: 'Storyca',
    account: 'Storyca',
    platform: 'instagram',
    status: 1,
    publishType: 'reels',
    supported: true,
    source: 'configured_route'
  });
  assert.equal(configuredSocialEchoAccount(0), null);
});

test('only NovelFlow and AstraNovel Facebook routes include links', () => {
  const linked = ACCOUNT_ROUTES.map((route) => normalizeDelivery(route)).filter((route) => route.includeLink);
  assert.deepEqual(linked.map((route) => [route.appKey, route.platform]), [
    ['novelflow', 'facebook'],
    ['astranovel', 'facebook']
  ]);
});

test('code pools are disjoint and match the requested Max and Astra ranges', () => {
  const apps = ['novelflow', 'maxnovel', 'astranovel', 'storyca', 'novelvio'].map(appByKey);
  for (let index = 1; index < apps.length; index += 1) assert.ok(apps[index - 1].codeMax < apps[index].codeMin);
  assert.deepEqual([appByKey('maxnovel').codeMin, appByKey('maxnovel').codeMax], [50000, 59999]);
  assert.deepEqual([appByKey('astranovel').codeMin, appByKey('astranovel').codeMax], [60000, 69999]);
});

test('Novelvio Facebook routes without creating a short link', () => {
  const delivery = normalizeDelivery({ accountId: 13943485 });
  assert.equal(delivery.appKey, 'novelvio');
  assert.equal(delivery.appName, 'Novelvio');
  assert.equal(delivery.includeLink, false);
});

test('P0 ignores client-controlled application identity and keeps only bounded fields', () => {
  const delivery = normalizeDelivery({ accountId: 13943482 });
  const selection = sanitizeP0Selection({
    source: 'x'.repeat(1000),
    readerBase: 1e20,
    target: { appKey: 'novelflow', applicationId: 'client-controlled' },
    unknown: { secret: 'must-not-persist' }
  }, delivery);
  assert.equal(selection.source, 'manual');
  assert.equal(selection.readerBase, 1e12);
  assert.equal(selection.target.appKey, 'maxnovel');
  assert.equal(selection.target.applicationId, delivery.applicationId);
  assert.equal(selection.unknown, undefined);
});

test('P0 preserves the verified Portuguese language filter', () => {
  const selection = sanitizeP0Selection({ filters: { language: 'PT' } }, normalizeDelivery({ accountId: 13943483 }));
  assert.equal(selection.filters.language, 'PT');
});
