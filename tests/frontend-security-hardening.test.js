const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function section(start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('account-scoped loaders reject stale responses after every account transition', () => {
  const authSession = section('const AuthSession = {', 'function clearServerDerivedState()');
  assert.match(authSession, /epoch:\s*0/);
  assert.match(authSession, /this\._controller\.abort\(\)/);
  assert.match(authSession, /clearServerDerivedState\(\)/);

  const cloudPull = section('async pull() {', '// Refresh auth token via /api/auth/refresh');
  const userStats = section('async function loadUserStats(username)', 'function updateStatsOverview(data)');
  const equityCode = section('async function loadEquityCode(force)', 'function queueEquityBookSearch(value)');
  const performance = section('async function loadPerformanceDashboard()', '// Resize chart on window resize');

  for (const loader of [cloudPull, userStats, equityCode, performance]) {
    assert.match(loader, /AuthSession\.capture/);
    assert.match(loader, /AuthSession\.isCurrent/);
  }
  assert.match(source, /function clearAuthenticatedUser\(\)[\s\S]*AuthSession\.transition\(''\)/);
  assert.match(source, /async function handleLogout\(\)[\s\S]*AuthSession\.transition\(''\)/);
});

test('an account transition aborts the previous session signal', () => {
  const sessionSource = section('function normalizeSessionUsername(value)', 'function clearServerDerivedState()');
  const context = {
    AbortController,
    AbortSignal,
    DOMException,
    URL,
    AppState: { isLoggedIn: false, user: null },
    clearCount: 0,
    clearServerDerivedState() { this.clearCount += 1; },
    window: { location: { origin: 'https://novelflow.top' } },
  };
  vm.runInNewContext(`${sessionSource}\nthis.AuthSessionForTest = AuthSession;`, context);

  context.AuthSessionForTest.transition('Alice');
  context.AppState.isLoggedIn = true;
  context.AppState.user = { username: 'Alice' };
  const alice = context.AuthSessionForTest.capture('Alice');
  assert.equal(alice.signal.aborted, false);

  context.AuthSessionForTest.transition('Bob');
  assert.equal(alice.signal.aborted, true);
  assert.equal(context.AuthSessionForTest.epoch, 2);
});

test('a stale stats response cannot mutate the next account state', async () => {
  const loaderSource = section('async function loadUserStats(username)', 'function updateStatsOverview(data)');
  let resolveResponse;
  let current = true;
  const responsePromise = new Promise(resolve => { resolveResponse = resolve; });
  const context = {
    AppState: { isLoggedIn: true, user: { username: 'Alice' }, myBooks: [] },
    AuthSession: {
      capture: () => ({ epoch: 1, username: 'alice' }),
      isCurrent: () => current,
    },
    UserStats: { data: null, loading: false, loadingUser: null, requestId: 0 },
    authFetch: () => responsePromise,
    document: { getElementById: () => null },
    isAbortError: () => false,
    console: { error() {} },
    saveMyBooks() { throw new Error('stale response wrote books'); },
    updateStats() { throw new Error('stale response updated stats'); },
    updateStatsOverview() { throw new Error('stale response updated the overview'); },
    renderMyBooks() { throw new Error('stale response rendered books'); },
  };
  vm.runInNewContext(`${loaderSource}\nthis.loadUserStatsForTest = loadUserStats;`, context);

  const load = context.loadUserStatsForTest('Alice');
  current = false;
  resolveResponse({ ok: true, json: async () => ({ books: [{ code: 'A-1' }] }) });
  assert.equal(await load, false);
  assert.equal(context.UserStats.data, null);
  assert.deepEqual(context.AppState.myBooks, []);
});

test('browser authentication is cookie-only and removes legacy local tokens', () => {
  assert.match(source, /localStorage\.removeItem\('novelflow_ac_token'\)/);
  assert.match(source, /localStorage\.removeItem\('nf_token'\)/);

  const withoutCleanup = source
    .replace(/localStorage\.removeItem\('novelflow_ac_token'\);/, '')
    .replace(/localStorage\.removeItem\('nf_token'\);/, '');
  assert.doesNotMatch(withoutCleanup, /novelflow_ac_token|nf_token|x-ac-token|saveACToken/);
  assert.match(source, /async function authFetch[\s\S]*credentials:\s*'include'/);
});

test('password UI reads account status only from the authenticated session endpoint', () => {
  assert.doesNotMatch(source, /fetch\('\/api\/auth\/check-password'/);
  const passwordUi = section('function showSetPasswordModal()', '</script>');
  assert.match(passwordUi, /fetch\('\/api\/auth\/me', \{ credentials: 'include' \}\)/);
  assert.match(passwordUi, /result\.hasPassword/);
});

test('logged-out bootstrap cannot read the previous account local namespace', () => {
  const storage = section('function getMyBooksKey()', 'const BOOK_TOMBSTONE_TTL_MS');
  assert.match(storage, /AppState\.isLoggedIn/);
  assert.match(storage, /return username \? 'novelflow_mybooks_' \+ username : null/);
  assert.doesNotMatch(storage, /novelflow_last_user|claimAnonymousLinks|localStorage\.removeItem\('novelflow_mybooks'\)/);

  const bootstrap = section('// ========== Init ==========', '// ========== Render Leaderboard Mini');
  assert.doesNotMatch(bootstrap, /loadMyBooks\(\)/);
  assert.match(bootstrap, /AppState\.myBooks = \[\]/);

  const earningsUser = section('function getUsername() {', 'window.openEarningsModal');
  assert.match(earningsUser, /AppState\.isLoggedIn/);
  assert.doesNotMatch(earningsUser, /localStorage/);
});

test('account transitions clear private in-memory caches as well as visible UI', () => {
  const reset = section('function clearServerDerivedState()', 'function setAuthenticatedUser(user)');
  assert.match(reset, /_xmpCache = \{\}/);
  assert.match(reset, /_refImgUrls = \[\]/);
  assert.match(reset, /reelSelectedBook = null/);
  assert.match(reset, /xmpSelectedBook = null/);
  assert.match(reset, /window\.resetEarningsState/);

  const earningsReset = section('window.resetEarningsState = function()', 'window.openEarningsModal');
  assert.match(earningsReset, /_earnData = null/);
  assert.match(earningsReset, /clearWithdrawalIdempotencyKey\(\)/);
  assert.match(earningsReset, /\$0\.00 available/);
});

test('external data is not interpolated into JavaScript event handlers', () => {
  assert.doesNotMatch(source, /onclick=['"]openRecommendModal\(\$\{/);
  assert.doesNotMatch(source, /onclick=['"]copyBookLink\(\$\{/);
  assert.doesNotMatch(source, /onclick=['"]recreateLink\(\$\{/);
  assert.doesNotMatch(source, /onclick=['"]playReelVideo\(/);
  assert.doesNotMatch(source, /onclick=['"]window\.open\(/);
  assert.doesNotMatch(source, /navigator\.clipboard\.writeText\(\\'/);
  assert.match(source, /data-nf-action="select-candidate"/);
  assert.match(source, /data-nf-action="download-reel"/);
  assert.match(source, /data-nf-action="open-external"/);
  assert.match(source, /candidate-title">\$\{escapeHtml\(book\.title\)\}/);
  assert.match(source, /safeClientUrl\(book\.cover, \{ allowBlob: true \}\)/);
});

test('dynamic media URLs use an explicit protocol allowlist', () => {
  const safeUrl = section('function safeClientUrl(value', 'const AuthSession = {');
  assert.match(safeUrl, /if \(!rawValue\) return ''/);
  assert.match(safeUrl, /url\.protocol === 'http:'/);
  assert.match(safeUrl, /url\.protocol === 'https:'/);
  assert.match(safeUrl, /allowBlob && url\.protocol === 'blob:'/);
  assert.doesNotMatch(safeUrl, /data:|javascript:/);
  assert.match(source, /function playReelVideo[\s\S]*safeClientUrl\(videoUrl, \{ allowBlob: true \}\)/);
  assert.match(source, /function stripHtml[\s\S]*new DOMParser\(\)\.parseFromString/);
});

test('book catalogue requests are single-owner, abortable, and language scoped', () => {
  const languageSwitch = section('function switchLang(lang', 'function applyTranslations()');
  const initialLanguage = section('// Apply saved language on load', '// ========== Update Share Tasks Progress');
  const loader = section('// ========== Load Books from Backend API ==========', 'function hideLoadingAndShowContent()');

  assert.match(languageSwitch, /reloadBooks = true/);
  assert.match(languageSwitch, /if \(reloadBooks\) loadBooks\(\)/);
  assert.match(initialLanguage, /switchLang\(AppState\.currentLang, false\)/);
  assert.match(loader, /let _bookLoadRequestId = 0/);
  assert.match(loader, /_bookLoadController\.abort\(\)/);
  assert.match(loader, /bookLang === AppState\.currentLang/);
  assert.match(loader, /fetchBookSource\([\s\S]*14000/);
  assert.doesNotMatch(loader, /Promise\.race/);
  assert.match(loader, /function uniqueCatalogBooks\(books\)/);
  assert.match(loader, /AppState\.books = uniqueCatalogBooks\(result\.data\.map\(mapBook\)\)/);
});

test('reel cards retain local pending work and emit a valid video preview element', () => {
  const reels = section('function renderReelCardHtml(item)', 'function copyReelText(btn)');
  assert.match(reels, /<video preload="metadata"[\s\S]*<\/video>/);
  assert.match(reels, /onloadedmetadata=/);
  assert.doesNotMatch(reels, /onloadeddata=/);
  assert.match(reels, /const pendingLocal = buildLocalPendingReels\(knownIds\)/);
  assert.match(reels, /const allCards = enrichedItems\.slice\(\)/);
});

test('reel result loading is bounded, cached, and cleared on account changes', () => {
  assert.match(source, /const REEL_RESULT_CONCURRENCY = 4/);
  assert.match(source, /async function mapWithConcurrency\(/);
  assert.match(source, /async function loadReelResultMedia\(/);
  assert.match(source, /ReelResultCache\.set\(/);
  assert.match(source, /ReelResultCache\.clear\(\)/);
  assert.doesNotMatch(source, /Promise\.all\(filteredItems\.map\(async \(item\) => \{[\s\S]{0,400}\/api\/ac-result/);
});

test('promotion result offers a server-owned QR card download', () => {
  assert.match(source, /id="downloadQrCardBtn"/);
  assert.match(source, /async function downloadQrPromotionCard\(\)/);
  assert.match(source, /authFetch\('\/api\/qr-promotion'/);
  assert.match(source, /SCAN TO READ FREE/);
});
