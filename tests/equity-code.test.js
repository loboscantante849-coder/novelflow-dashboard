const assert = require('node:assert/strict');
const test = require('node:test');

const { installFakeUpstash, invoke } = require('./helpers/endpoint');
const FakeRedis = installFakeUpstash();

process.env.JWT_SECRET = 'equity-test-secret-not-used-in-production';
process.env.KV_REST_API_URL = 'https://redis.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';

const oidc = require('../api/_lib/oidc-token');
oidc.getBookstoreToken = async () => 'bookstore-test-token';
const equityCode = require('../api/equity-code');
const { signAccessToken } = require('../api/_lib/auth');
const { VALIDITY_MS, RECREATE_COOLDOWN_MS } = require('../api/_lib/equity-code');

const BOOK_ID = '64b8c91e0123456789abcdef';
const token = signAccessToken({ type: 'local', username: 'Alice' });

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function authenticated(body = {}) {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '192.0.2.50' },
    body,
  };
}

function successFetch(calls) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/novelmanage/book/booklist')) {
      return response({ data: { data: [{ bookId: BOOK_ID, title: 'Verified Book' }] } });
    }
    if (String(url).endsWith('/save')) return response({ code: 0, data: { id: 'remote-1' } });
    return response({ data: { records: [] } });
  };
}

test.beforeEach(() => {
  FakeRedis.reset();
  global.fetch = async () => response({ data: { records: [] } });
});

test.after(() => {
  delete global.fetch;
});

test('requires authentication', async () => {
  const res = await invoke(equityCode, { method: 'GET' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_REQUIRED');
});

test('rejects disabled accounts and arbitrary book ids', async () => {
  FakeRedis.reset({ 'nf_user_data:alice': JSON.stringify({ disabled: true }) });
  const disabled = await invoke(equityCode, authenticated({ bookId: BOOK_ID }));
  assert.equal(disabled.statusCode, 403);

  FakeRedis.reset();
  const invalid = await invoke(equityCode, authenticated({ bookId: 'book title from client' }));
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, 'INVALID_BOOK');
});

test('creates one Facebook 1-Day VIP code for a verified SKU with a seven-day window', async () => {
  const calls = [];
  global.fetch = successFetch(calls);
  const before = Date.now();
  const created = await invoke(equityCode, authenticated({ bookId: BOOK_ID, bookTitle: 'Untrusted title' }));

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.inviteCode.code, '90032');
  assert.equal(created.body.inviteCode.bookTitle, 'Verified Book');
  assert.equal(created.body.inviteCode.channel, 'Facebook');
  assert.equal(created.body.inviteCode.rewardName, '1-Day VIP');
  assert.equal(created.body.inviteCode.endTime - created.body.inviteCode.startTime, VALIDITY_MS);
  assert.ok(created.body.inviteCode.startTime >= before);

  const createCall = calls.find(call => call.url.endsWith('/save'));
  const bookCall = calls.find(call => call.url.includes('/novelmanage/book/booklist'));
  const bookQuery = new URL(bookCall.url).searchParams;
  assert.equal(bookQuery.get('bookIds'), BOOK_ID);
  assert.equal(bookQuery.has('bookId'), false);
  const payload = JSON.parse(createCall.options.body);
  assert.deepEqual({
    channel: payload.channel,
    kolName: payload.kolName,
    code: payload.code,
    relatedSkuId: payload.relatedSkuId,
    rewardType: payload.rewardType,
    rewardName: payload.rewardName,
    rewardValue: payload.rewardValue,
    isEnable: payload.isEnable,
  }, {
    channel: 5,
    kolName: 'alice',
    code: '90032',
    relatedSkuId: BOOK_ID,
    rewardType: 1,
    rewardName: '1-Day VIP',
    rewardValue: 1,
    isEnable: true,
  });
  assert.equal(payload.endTime - payload.startTime, VALIDITY_MS);

  global.fetch = async () => { throw new Error('must not call upstream twice'); };
  const repeated = await invoke(equityCode, authenticated({ bookId: BOOK_ID }));
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.body.existing, true);
  assert.equal(repeated.body.inviteCode.code, '90032');
});

test('returns a conflict while the per-user creation lock is held', async () => {
  FakeRedis.reset({ 'nf_equity_code_lock:alice': 'another-request' });
  const res = await invoke(equityCode, authenticated({ bookId: BOOK_ID }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'CREATION_IN_PROGRESS');
});

test('adopts an existing upstream code before allocating a new one', async () => {
  global.fetch = async url => {
    assert.match(String(url), /kolName=alice/);
    return response({ data: { records: [{
      id: 'existing-remote', kolName: 'Alice', code: '77777', relatedSkuId: BOOK_ID,
      startTime: Date.now(), endTime: Date.now() + VALIDITY_MS,
    }] } });
  };

  const res = await invoke(equityCode, authenticated({ bookId: BOOK_ID }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.existing, true);
  assert.equal(res.body.inviteCode.code, '77777');
  assert.equal(FakeRedis.values.has('nf_equity_code_counter'), false);
});

test('reconciles an upstream success after the create response fails', async () => {
  let created = false;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('/novelmanage/book/booklist')) {
      return response({ data: { data: [{ bookId: BOOK_ID, title: 'Verified Book' }] } });
    }
    if (value.endsWith('/save')) {
      created = true;
      throw new Error('connection closed after submit');
    }
    if (value.includes('code=90032')) return response({ data: { records: [] } });
    if (created) {
      return response({ data: { records: [{
        id: 'remote-after-timeout', kolName: 'alice', code: '90032', relatedSkuId: BOOK_ID,
        startTime: Date.now(), endTime: Date.now() + VALIDITY_MS,
      }] } });
    }
    return response({ data: { records: [] } });
  };

  const res = await invoke(equityCode, authenticated({ bookId: BOOK_ID }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reconciled, true);
  assert.equal(res.body.inviteCode.status, 'active');
  assert.equal(res.body.inviteCode.code, '90032');
});

test('keeps the same candidate code after an upstream failure', async () => {
  let failCreate = true;
  const submittedCodes = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('/novelmanage/book/booklist')) {
      return response({ data: { data: [{ bookId: BOOK_ID, title: 'Verified Book' }] } });
    }
    if (value.endsWith('/save')) {
      submittedCodes.push(JSON.parse(options.body).code);
      if (failCreate) return response({ code: 500, message: 'temporary failure' }, 500);
      return response({ code: 0, data: { id: 'remote-retry' } });
    }
    return response({ data: { records: [] } });
  };

  const failed = await invoke(equityCode, authenticated({ bookId: BOOK_ID }));
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.inviteCode.status, 'failed');
  failCreate = false;
  const retried = await invoke(equityCode, authenticated({ bookId: BOOK_ID }));
  assert.equal(retried.statusCode, 201);
  assert.deepEqual(submittedCodes, ['90032', '90032']);
});

test('GET preserves an expired code instead of removing it', async () => {
  FakeRedis.reset({
    'nf_equity_code:alice': JSON.stringify({
      status: 'active', username: 'alice', code: '90032', bookId: BOOK_ID,
      endTime: Date.now() - 1000,
    }),
  });
  const res = await invoke(equityCode, { ...authenticated(), method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.inviteCode.status, 'expired');
  assert.equal(res.body.inviteCode.code, '90032');
});

test('unbind disables the remote code and starts a seven-day cooldown', async () => {
  const now = Date.now();
  FakeRedis.reset({
    'nf_equity_code:alice': JSON.stringify({
      status: 'active', username: 'alice', code: '90032', bookId: BOOK_ID,
      bookTitle: 'Verified Book', rewardName: '1-Day VIP', rewardDays: 1,
      startTime: now - 1000, endTime: now + VALIDITY_MS,
    }),
  });
  let savedPayload = null;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/save')) {
      savedPayload = JSON.parse(options.body);
      return response({ code: 200, data: { id: 'remote-1' } });
    }
    return response({ data: { records: [{
      id: 'remote-1', applicationId: '642fc1ace309494378a774a6', channel: 5,
      kolName: 'alice', code: '90032', relatedSkuId: BOOK_ID,
      rewardType: 1, rewardName: '1-Day VIP', rewardValue: 1,
      startTime: now - 1000, endTime: now + VALIDITY_MS, isEnable: true,
    }] } });
  };

  const before = Date.now();
  const res = await invoke(equityCode, authenticated({ action: 'unbind' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.inviteCode.status, 'unbound');
  assert.ok(res.body.inviteCode.cooldownUntil >= before + RECREATE_COOLDOWN_MS);
  assert.equal(savedPayload.id, 'remote-1');
  assert.equal(savedPayload.code, '90032');
  assert.equal(savedPayload.isEnable, false);

  const stored = JSON.parse(FakeRedis.values.get('nf_equity_code:alice'));
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].code, '90032');
  assert.equal(res.body.inviteCode.history, undefined);
});

test('blocks recreation during cooldown without calling upstream', async () => {
  FakeRedis.reset({
    'nf_equity_code:alice': JSON.stringify({
      status: 'unbound', username: 'alice', code: '90032', bookId: BOOK_ID,
      cooldownUntil: Date.now() + RECREATE_COOLDOWN_MS,
    }),
  });
  global.fetch = async () => { throw new Error('upstream must not be called during cooldown'); };

  const res = await invoke(equityCode, authenticated({ action: 'create', bookId: BOOK_ID }));
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'RECREATE_COOLDOWN');
});

test('allocates a new code after the cooldown instead of reusing the disabled code', async () => {
  FakeRedis.reset({
    'nf_equity_code:alice': JSON.stringify({
      status: 'unbound', username: 'alice', code: '81234', bookId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      bookTitle: 'Previous Book', cooldownUntil: Date.now() - 1000,
      history: [{ code: '81234', bookId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }],
    }),
  });
  const calls = [];
  global.fetch = successFetch(calls);

  const res = await invoke(equityCode, authenticated({ action: 'create', bookId: BOOK_ID }));
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.inviteCode.code, '90032');
  assert.notEqual(res.body.inviteCode.code, '81234');
  const stored = JSON.parse(FakeRedis.values.get('nf_equity_code:alice'));
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].code, '81234');
});
