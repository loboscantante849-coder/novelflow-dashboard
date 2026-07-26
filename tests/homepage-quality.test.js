const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

test('homepage rankings use real reader data instead of random numbers', () => {
  assert.doesNotMatch(source, /Math\.floor\(Math\.random\(\) \* 500\)/);
  assert.doesNotMatch(source, /commissionRates/);
  assert.doesNotMatch(source, /\borders:\s*Math\.floor\(Math\.random/);
  assert.doesNotMatch(source, /leaderboardList/);
  assert.doesNotMatch(source, /1,200\+ promoters|1,200\+ promotores/);
  assert.doesNotMatch(source, /\[40,55,70,80\]/);
  assert.doesNotMatch(source, /earnBadgeTexts/);
  assert.match(source, /uv: Number\(book\.uv \|\| book\.bookUv \|\| book\.readCount/);
  assert.match(source, /sort\(\(a, b\) => Number\(b\.uv\) - Number\(a\.uv\)\)/);
  assert.match(source, /promote_earn_badge: 'Promote & Earn'/);
  assert.doesNotMatch(source, /hideLoadingAndShowContent\(\)[\s\S]{0,400}rankHeader'\)\.style\.display = 'flex'/);
});

test('language switching updates page metadata and translated discovery labels', () => {
  assert.match(source, /document\.documentElement\.lang = lang/);
  assert.match(source, /document\.title = pageTitle/);
  assert.match(source, /find_next_read: 'Encuentra tu próxima lectura favorita'/);
  assert.match(source, /genre_werewolf: 'Hombre lobo'/);
  assert.match(source, /top_promotions: 'Libros en tendencia'/);
  assert.match(source, /password_placeholder: 'Contraseña'/);
  assert.match(source, /perf_tab_new: 'Nuevos usuarios'/);
  assert.match(source, /toLocaleDateString\(AppState\.currentLang === 'es' \? 'es-ES' : 'en-US'/);
});

test('transient auth failures preserve the local session', () => {
  assert.match(source, /if \(!response\.ok\) throw new Error\('Login status unavailable'\)/);
  assert.match(source, /if \(refreshed === null\) return response/);
  const refreshSource = fs.readFileSync(path.join(ROOT, 'api/auth/refresh.js'), 'utf8');
  const catchBlock = refreshSource.slice(refreshSource.lastIndexOf('} catch (error)'));
  assert.doesNotMatch(catchBlock, /clearAuthCookies\(res\)/);
  assert.match(source, /response\.status === 403 && data && data\.code === 'ACCOUNT_DISABLED'/);
  assert.match(source, /function equityApiMessage\(data, fallbackKey\)/);
});

test('book grids mark generated cover images for lazy async decoding', () => {
  assert.match(source, /replace\(\/<img \/g, '<img loading="lazy" decoding="async" '/);
  assert.doesNotMatch(source, /id="modalBookCover" src=""/);
});

test('retired diagnostic and duplicate admin endpoints are not deployed', () => {
  const retired = [
    'api/admin-bulk-assign.js',
    'api/admin-kv-dump.js',
    'api/debug-env.js',
    'api/diag.js',
    'api/init-oidc.js',
    'api/setup-env.js',
    'api/test-register.js',
    'api/book-covers.js',
  ];
  for (const relativePath of retired) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, `${relativePath} should be removed`);
    assert.equal(Object.hasOwn(vercel.functions || {}, relativePath), false, `${relativePath} should not be in vercel.json`);
  }
});

test('legacy data fallbacks and bookstore search use bounded recovery paths', () => {
  const statsSource = fs.readFileSync(path.join(ROOT, 'api/_lib/stats-data.js'), 'utf8');
  const submitSource = fs.readFileSync(path.join(ROOT, 'api/submit.js'), 'utf8');
  assert.match(statsSource, /DATA_JSON_CACHE = \{ data: null, expires: 0, fetchedAt: 0 \}/);
  assert.match(statsSource, /now - DATA_JSON_CACHE\.fetchedAt <= MAX_STALE_CACHE_MS/);
  assert.match(statsSource, /now - LINK_STATS_CACHE\.fetchedAt <= MAX_STALE_CACHE_MS/);
  assert.match(submitSource, /bookstoreFetch\(url/);
  assert.doesNotMatch(submitSource, /await fetch\(url/);
  assert.match(submitSource, /Promise\.allSettled/);
  assert.match(submitSource, /SUBMIT_DEADLINE_MS = 24000/);
  assert.match(submitSource, /withDeadline\(/);
  assert.match(submitSource, /timeoutMs: 3500/);
  assert.match(submitSource, /authTimeoutMs: 4500/);
  assert.match(submitSource, /UPSTREAM_AUTH_UNAVAILABLE/);
  assert.equal(vercel.functions['api/submit.js'].maxDuration, 30);
});

test('all user-data writers use the shared distributed lock', () => {
  for (const file of ['api/user-data.js', 'api/rewards.js', 'api/confirm.js', 'api/withdrawals.js']) {
    const fileSource = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(fileSource, /_lib\/user-data-lock/);
    assert.match(fileSource, /acquireUserDataLock/);
  }
});

test('AC operations require an active account and verified task ownership', () => {
  for (const file of ['api/ac-create.js', 'api/ac-upload.js', 'api/ac-list.js', 'api/ac-retry.js', 'api/ac-interrupt.js', 'api/ac-result.js', 'api/ac-refresh.js']) {
    const fileSource = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(fileSource, /isDisabledUser/);
    assert.match(fileSource, /ACCOUNT_STATUS_UNAVAILABLE/);
    assert.match(fileSource, /ACCOUNT_DISABLED/);
  }
  for (const file of ['api/ac-retry.js', 'api/ac-interrupt.js', 'api/ac-result.js']) {
    const fileSource = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(fileSource, /!owner \|\| String\(owner\)\.toLowerCase\(\)/);
    assert.match(fileSource, /TASK_OWNER_UNAVAILABLE/);
    assert.match(fileSource, /AC_TOKEN_UNAVAILABLE/);
  }
  const meSource = fs.readFileSync(path.join(ROOT, 'api/auth/me.js'), 'utf8');
  assert.match(meSource, /isDisabledUser\(getRedis\(\), payload\.username\)/);
  const withdrawalSource = fs.readFileSync(path.join(ROOT, 'api/withdrawals.js'), 'utf8');
  assert.match(withdrawalSource, /payment_account \|\| ''\)\.trim\(\)\.toLowerCase\(\)/);
});

test('CloudSync keeps USER_DATA_BUSY writes pending with a capped backoff', () => {
  assert.match(source, /_maxBusyRetryDelayMs: 60000/);
  assert.match(source, /Math\.min\(this\._busyRetryCount, 7\)/);
  assert.match(source, /this\._busyRetryCount \+= 1/);
  assert.match(source, /this\._maxBusyRetryDelayMs/);
  assert.match(source, /schedulePush\(delayMs, \{ busyRetry: true \}\)/);
});

test('Spanish book fallbacks keep the language filter', () => {
  assert.match(source, /if \(!booksLoaded && bookLang !== 'es'\)/);
  assert.match(source, /localizedBooks = allBooks\.filter/);
  const searchSource = fs.readFileSync(path.join(ROOT, 'api/books/search.js'), 'utf8');
  assert.match(searchSource, /function filterFeaturedByLanguage/);
  assert.match(searchSource, /bookLanguage !== String\(lang \|\| 'en'\)/);
  const trendingSource = fs.readFileSync(path.join(ROOT, 'api/trending-books.js'), 'utf8');
  assert.match(trendingSource, /rawBooks\.length === 0 && lang === 'en'/);
  assert.match(source, /invite_code_cancel: 'Cancelar'/);
  assert.match(source, /invite_code_confirm: 'Confirmar'/);
  assert.match(source, /cancel\.textContent = getText\('invite_code_cancel'\)/);
  assert.match(source, /function equityApiMessage\(data, fallbackKey\)/);
  assert.doesNotMatch(source, /throw new Error\(data\.error \|\| getText\('invite_code_(?:load|create|unbind)_failed'\)\)/);
});
