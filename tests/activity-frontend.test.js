const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

test('the activity UI uses exact campaign registrations and the generic invite link', () => {
  assert.match(source, /eligibility\.campaignInvites/);
  assert.match(source, /eligibility\.recommenderMeasuredNewUsers/);
  assert.match(source, /data\.invite \|\| \{\}/);
  assert.match(source, /invite\.referral_url/);
  assert.match(source, /fulfillment_events\.invite_vip/);
  assert.doesNotMatch(source, /const verified = .*historicalNewUsers/);
});

test('referral attribution is bounded, persisted briefly, and sent by every local signup form', () => {
  assert.match(source, /REFERRAL_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /\^\[A-Za-z0-9_-\]\{8,80\}\$/);
  assert.match(source, /url\.searchParams\.delete\('ref'\)/);
  // One occurrence is the helper declaration; each form contributes one use.
  assert.equal((source.match(/buildRegistrationPayload\(username, password\)/g) || []).length, 3);
  assert.equal((source.match(/buildLoginPayload\(username, password\)/g) || []).length, 3);
  assert.equal((source.match(/fetch\(isRegister \? '\/api\/auth\/register' : '\/api\/auth\/login'/g) || []).length, 2);
  assert.equal((source.match(/clearStoredReferralCode\(\);/g) || []).length >= 2, true);
  assert.match(source, /id="splashReferralApplied"/);
  assert.match(source, /referral_applied/);
});

test('activity endpoints are deployed while fulfillment remains server-side', () => {
  assert.equal(vercel.functions['api/activity-rewards.js'].maxDuration, 30);
  assert.equal(vercel.functions['api/admin-balance-migration.js'].maxDuration, 30);
  assert.match(source, /Claims are checked before rewards are issued/);
  assert.doesNotMatch(source, /activity[^\n]{0,120}bonus_balance\s*[+]=/i);
});

function activityReminderHarness() {
  class MemoryStorage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
  }
  class FakeDate extends Date {
    constructor(...args) { super(args.length ? args[0] : FakeDate.current); }
  }
  FakeDate.current = '2026-08-11T10:00:00+08:00';
  const classNames = new Set();
  const reminder = {
    classList: {
      add(value) { classNames.add(value); },
      remove(value) { classNames.delete(value); },
      contains(value) { return classNames.has(value); },
    },
    setAttribute() {},
    querySelector() { return { focus() {}, setAttribute() {} }; },
  };
  const modal = { classList: { contains() { return false; } } };
  const opened = [];
  const context = {
    Date: FakeDate,
    AppState: { isLoggedIn: false, user: null },
    ActivityState: { reminderTimer: null, reminderOpener: null },
    AuthSession: { capture: () => ({ username: 'session' }), isCurrent: () => true },
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    normalizeSessionUsername: value => String(value || '').trim().toLowerCase(),
    getText: key => key === 'activity_close' ? 'Close' : key,
    activityWindow: () => ({ active: true }),
    document: {
      activeElement: { focus() {} },
      getElementById: id => id === 'activityReminder' ? reminder : (id === 'activityModal' ? modal : null),
    },
    setTimeout: callback => { callback(); return 1; },
    clearTimeout() {},
    openActivityModal: section => opened.push(section),
    encodeURIComponent,
  };
  vm.createContext(context);
  const start = source.indexOf('const ACTIVITY_SECTIONS');
  const end = source.indexOf('function renderCampaigns()', start);
  assert.ok(start > 0 && end > start, 'activity reminder source block must exist');
  vm.runInContext(source.slice(start, end) + '\n;globalThis.activityReminderApi = { activityReminderDateKey, dismissActivityReminder, showDailyActivityReminder, openActivityFromReminder };', context);
  return { context, api: context.activityReminderApi, classNames, opened, FakeDate };
}

test('the daily activity reminder is authenticated, once-per-day, and isolated by account', () => {
  const { context, api, classNames, FakeDate } = activityReminderHarness();
  assert.equal(api.showDailyActivityReminder(), false);
  assert.equal(classNames.has('show'), false);

  context.AppState.isLoggedIn = true;
  context.AppState.user = { username: 'Alice' };
  assert.equal(api.showDailyActivityReminder(), true);
  assert.equal(classNames.has('show'), true);
  api.dismissActivityReminder(false);
  assert.equal(api.showDailyActivityReminder(), false, 'closing must not repeat on the same day');

  context.AppState.user = { username: 'Bob' };
  assert.equal(api.showDailyActivityReminder(), true, 'another account has its own daily reminder state');
  api.dismissActivityReminder(true);
  assert.equal(api.showDailyActivityReminder(), false, 'do-not-remind remains effective for that account and date');

  context.AppState.user = { username: 'Alice' };
  FakeDate.current = '2026-08-12T10:00:00+08:00';
  assert.equal(api.showDailyActivityReminder(), true, 'the reminder returns on the next local date');
});

test('the compact activity reminder jumps directly to recommender and all UI copy is English or Spanish', () => {
  const { context, api, opened } = activityReminderHarness();
  context.AppState.isLoggedIn = true;
  context.AppState.user = { username: 'Alice' };
  api.openActivityFromReminder('recommender');
  assert.deepEqual(opened, ['recommender']);
  assert.match(source, /ACTIVITY_SECTIONS = \['vip', 'facebook', 'invites', 'recommender'\]/);
  assert.match(source, /openActivityFromReminder\('recommender'\)/);
  const reminderLines = source.split(/\r?\n/).filter(line => line.includes('activity_reminder_')).join('\n');
  assert.doesNotMatch(reminderLines, /[\u4e00-\u9fff]/);
});

test('activity 2 accepts public social posts and keeps the official Facebook group optional', () => {
  assert.match(source, /submitActivityReward\(\\'submit_social\\'\)/);
  assert.match(source, /payload\.social_url = socialUrl/);
  assert.match(source, /facebook\.com\/groups\/620866104235159/);
  assert.match(source, /target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /Other public platforms/);
  assert.doesNotMatch(source, /Recommend one novel in the official NovelFlow Facebook group/);
});

test('limited subsidy has a poster hero and a home floating entry', () => {
  assert.match(source, /id="activityFab"/);
  assert.match(source, /activity-hero-poster/);
  assert.match(source, /activity-hero-poster[^}]*aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(source, /activity-hero-poster img[^}]*object-fit:\s*contain/);
  assert.match(source, /activity-hero-poster"><img src="\/activity-limited-subsidy\.webp"/);
  assert.match(source, /activity-reminder-poster" src="\/novelflow-promo-poster\.png"/);
});

test('all VIP forms require the real 24-character NovelFlow App user ID', () => {
  assert.match(source, /function normalizeActivityNovelFlowId[\s\S]*\^\[a-f0-9\]\{24\}\$/i);
  assert.match(source, /id="activityNovelFlowId"[^>]+maxlength="24"[^>]+pattern="\[A-Fa-f0-9\]\{24\}"/);
  assert.match(source, /id="novelflowIdInput"[^>]+maxlength="24"[^>]+pattern="\[A-Fa-f0-9\]\{24\}"/);
  assert.match(source, /ID de usuario de 24 caracteres/);
});
