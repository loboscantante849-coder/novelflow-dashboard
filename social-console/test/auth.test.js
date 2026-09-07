const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession, requireSession, requireOperatorMutation } = require('../api/_lib/auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('signed session is required and expires server-side', (t) => {
  const previous = process.env.SOCIAL_CONSOLE_SESSION_SECRET;
  process.env.SOCIAL_CONSOLE_SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
  t.after(() => { if (previous === undefined) delete process.env.SOCIAL_CONSOLE_SESSION_SECRET; else process.env.SOCIAL_CONSOLE_SESSION_SECRET = previous; });
  const token = createSession();
  const ok = response();
  assert.equal(requireSession({ method: 'GET', headers: { cookie: `nf_social_session=${encodeURIComponent(token)}` } }, ok), true);

  const denied = response();
  assert.equal(requireSession({ method: 'GET', headers: {} }, denied), false);
  assert.equal(denied.statusCode, 401);
});

test('authenticated mutations reject a foreign origin', (t) => {
  const previous = process.env.SOCIAL_CONSOLE_SESSION_SECRET;
  process.env.SOCIAL_CONSOLE_SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
  t.after(() => { if (previous === undefined) delete process.env.SOCIAL_CONSOLE_SESSION_SECRET; else process.env.SOCIAL_CONSOLE_SESSION_SECRET = previous; });
  const token = createSession();
  const res = response();
  const allowed = requireSession({ method: 'POST', headers: { cookie: `nf_social_session=${encodeURIComponent(token)}`, host: 'social.novelflow.top', origin: 'https://evil.example' } }, res);
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 403);
});

test('explicit private-console mode does not show a password gate', (t) => {
  const previous = process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
  process.env.SOCIAL_CONSOLE_OPEN_ACCESS = 'true';
  t.after(() => { if (previous === undefined) delete process.env.SOCIAL_CONSOLE_OPEN_ACCESS; else process.env.SOCIAL_CONSOLE_OPEN_ACCESS = previous; });
  const res = response();
  assert.equal(requireSession({ method: 'POST', headers: {} }, res), true);
});

test('open-access mutations still require the hidden operator token', (t) => {
  const previousOpen = process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
  const previousToken = process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN;
  process.env.SOCIAL_CONSOLE_OPEN_ACCESS = 'true';
  process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN = 'operator-test-token-with-at-least-32-characters';
  t.after(() => {
    if (previousOpen === undefined) delete process.env.SOCIAL_CONSOLE_OPEN_ACCESS; else process.env.SOCIAL_CONSOLE_OPEN_ACCESS = previousOpen;
    if (previousToken === undefined) delete process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN; else process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN = previousToken;
  });
  const denied = response();
  assert.equal(requireOperatorMutation({ method: 'POST', headers: {} }, denied), false);
  assert.equal(denied.statusCode, 401);
  const allowed = response();
  assert.equal(requireOperatorMutation({ method: 'POST', headers: { 'x-social-operator-token': process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN } }, allowed), true);
});

test('local passwordless mode accepts only same-origin loopback requests', (t) => {
  const previous = process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
  delete process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
  t.after(() => {
    if (previous === undefined) delete process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
    else process.env.SOCIAL_CONSOLE_OPEN_ACCESS = previous;
  });

  const local = response();
  assert.equal(requireSession({ method: 'POST', headers: { host: 'localhost:3010', origin: 'http://localhost:3010' }, socket: { remoteAddress: '127.0.0.1' } }, local), true);

  const remote = response();
  assert.equal(requireSession({ method: 'GET', headers: { host: 'localhost:3010' }, socket: { remoteAddress: '10.0.0.24' } }, remote), false);
  assert.equal(remote.statusCode, 401);

  const crossOrigin = response();
  assert.equal(requireSession({ method: 'POST', headers: { host: 'localhost:3010', origin: 'https://evil.example' }, socket: { remoteAddress: '127.0.0.1' } }, crossOrigin), false);
  assert.equal(crossOrigin.statusCode, 403);
});
