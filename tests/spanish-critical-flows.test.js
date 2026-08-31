const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const login = fs.readFileSync(path.join(__dirname, '..', 'api', 'auth', 'login.js'), 'utf8');
const register = fs.readFileSync(path.join(__dirname, '..', 'api', 'auth', 'register.js'), 'utf8');

test('English and Spanish login and rewards use the same account endpoints', () => {
  assert.match(html, /fetch\(isRegister \? '\/api\/auth\/register' : '\/api\/auth\/login'/);
  assert.match(html, /buildLoginPayload\(username, password\)/);
  assert.match(html, /authFetch\('\/api\/rewards'/);
  assert.match(html, /RewardsAPI\.call\('checkin'\)/);
  assert.match(html, /RewardsAPI\.call\('confirm_streak_vip'\)/);
  assert.doesNotMatch(html, /api\/(?:es|spanish)\/(?:auth|rewards)/i);
});

test('Spanish critical flows have localized login, check-in, cash, VIP, and recovery messages', () => {
  for (const text of [
    'Usuario o contraseña incorrectos.',
    'No se pudo hacer check-in. Inténtalo de nuevo.',
    '+$0.50 acreditado en tu saldo',
    'Confirmar 2 días VIP',
    'Vincula primero tu ID de NovelFlow para recibir los 2 días VIP.',
    'Un registro antiguo de la cuenta necesita revisión.',
  ]) assert.ok(html.includes(text), text);
  assert.match(html, /localizedAuthError\(result\.code\)/);
  assert.match(html, /localizedRewardError\(e, 'reward_checkin_failed'\)/);
  assert.match(html, /requestError\.code = data\.code/);
});

test('Spanish catalogue, invite-code search, and link creation retain the selected language', () => {
  assert.match(html, /bookLang = AppState\.currentLang \|\| 'en'/);
  assert.match(html, /keyword, lang: AppState\.currentLang \|\| 'en'/);
  assert.match(html, /lang: book\.languageCode \|\| 'en'/);
});

test('login responses expose stable codes needed by both language UIs', () => {
  assert.match(login, /code: 'INVALID_CREDENTIALS'/);
  assert.match(register, /code: 'RATE_LIMITED'/);
  assert.match(register, /code: 'ACCOUNT_RECOVERY_REQUIRED'/);
  assert.match(register, /code: 'ACCOUNT_EXISTS_USE_LOGIN'/);
});
