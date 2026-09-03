const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Missing function: ${signature}`);
  const bodyStart = start + signature.length - 1;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated function: ${signature}`);
}

function applySnapshot(initial, cloud) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const fn = extractFunction('function applyServerRewardState(cloud = {}) {');
  vm.runInNewContext(`${fn}; applyServerRewardState(cloud);`, {
    cloud,
    localStorage,
    getUserKey: key => `novelflow_${key}_zoe`,
  });
  return values;
}

test('server reward snapshot overwrites stale browser values, including decreases', () => {
  const values = applySnapshot({
    novelflow_points_zoe: '9999',
    novelflow_checkin_zoe: JSON.stringify({ streak: 99 }),
    novelflow_claimed_zoe: JSON.stringify({ forged: true }),
    novelflow_vip_days_zoe: '30',
    novelflow_bonus_balance_zoe: '80',
    novelflow_bind_id_zoe: 'stale-id',
    novelflow_bonus_campaign1_claimed_zoe: '1',
    novelflow_streak_grand_claimed_zoe: '2026-07-01',
    novelflow_streak_grand_vip_pending_zoe: JSON.stringify({ sequence: 3 }),
  }, {
    points: 690,
    checkin: { streak: 0, lastCheckin: null, history: [] },
    claimed: {},
    vip_days: 0,
    bonus_balance: 0,
    bind_id: null,
    bonus_campaign1_claimed: null,
    streak_grand_claimed: null,
    streak_grand_vip_pending: null,
  });

  assert.equal(values.get('novelflow_points_zoe'), '690');
  assert.deepEqual(JSON.parse(values.get('novelflow_checkin_zoe')), { streak: 0, lastCheckin: null, history: [] });
  assert.deepEqual(JSON.parse(values.get('novelflow_claimed_zoe')), {});
  assert.equal(values.get('novelflow_vip_days_zoe'), '0');
  assert.equal(values.get('novelflow_bonus_balance_zoe'), '0');
  assert.equal(values.has('novelflow_bind_id_zoe'), false);
  assert.equal(values.has('novelflow_bonus_campaign1_claimed_zoe'), false);
  assert.equal(values.has('novelflow_streak_grand_claimed_zoe'), false);
  assert.equal(values.has('novelflow_streak_grand_vip_pending_zoe'), false);
});

test('server reward snapshot persists a pending VIP delivery for the confirmation flow', () => {
  const values = applySnapshot({}, {
    points: 50,
    checkin: { streak: 7, lastCheckin: '2026-09-01', history: [] },
    claimed: { share1: 1 },
    vip_days: 0,
    bonus_balance: 0.5,
    streak_grand_claimed: '2026-09-01T00:00:00.000Z',
    streak_grand_vip_pending: { sequence: 1, created_at: '2026-09-01T00:00:00.000Z' },
  });

  assert.deepEqual(JSON.parse(values.get('novelflow_streak_grand_vip_pending_zoe')), {
    sequence: 1,
    created_at: '2026-09-01T00:00:00.000Z',
  });
});

test('browser integrity code cannot clear server-managed reward state', () => {
  assert.doesNotMatch(source, /Points integrity check failed - resetting to 0/);
  assert.doesNotMatch(source, /verifyPointsIntegrity|computePointsChecksum|savePointsChecksum/);
  assert.match(source, /applyServerRewardState\(cloud\)/);

  const collectData = source.slice(source.indexOf('collectData() {'), source.indexOf('// Push local data to cloud'));
  assert.doesNotMatch(collectData, /claimed|points|checkin|vip_days|bonus_balance|bind_id/);
  assert.doesNotMatch(source, /async function doCheckinV2\(\) \{\s*if \(isCheckedInToday\(\)\) return;/);
  assert.match(source, /confirm_streak_vip/);
});

test('every successful login and session restore path enables authoritative cloud sync', () => {
  const refresh = source.slice(source.indexOf('async function refreshAuth()'), source.indexOf('async function checkLoginStatus()'));
  assert.match(refresh, /CloudSync\.enable\(\{ pull: false \}\)/);

  const loginStatus = source.slice(source.indexOf('async function checkLoginStatus()'), source.indexOf('// Auth-aware fetch wrapper'));
  assert.match(loginStatus, /await CloudSync\.enable\(\)/);
  assert.ok(loginStatus.indexOf('loadMyBooks();') < loginStatus.indexOf('await CloudSync.enable();'));

  const registration = source.slice(source.indexOf('async function handleLocalRegister()'), source.indexOf('async function handleLogout()'));
  assert.match(registration, /await CloudSync\.enable\(\)/);
  assert.ok(registration.indexOf('loadMyBooks();') < registration.indexOf('await CloudSync.enable();'));

  const splash = source.slice(source.indexOf('async function handleSplashLogin()'), source.indexOf('function skipLogin()'));
  assert.match(splash, /await CloudSync\.enable\(\)/);
  assert.ok(splash.indexOf('loadMyBooks();') < splash.indexOf('await CloudSync.enable();'));
});

test('invite-code copy explains that it complements rather than replaces promotion assets', () => {
  assert.match(source, /It does not replace your promotion link and code/);
  assert.match(source, /No sustituye tu enlace ni tu código de promoción/);
});
