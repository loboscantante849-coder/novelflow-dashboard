const test = require('node:test');
const assert = require('node:assert/strict');
const ac = require('../api/_lib/ac-request');
const config = require('../api/_lib/ac-config');

test('Tianji AC defaults and fixed server headers are used', () => {
  const previous = process.env.AC_API_BASE_URL;
  delete process.env.AC_API_BASE_URL;
  try {
    assert.equal(config.getAcBaseUrl(), 'https://ac.anynovel.app/api/v1');
    assert.equal(config.getAcHeaders('abc', { Authorization: 'Bearer client', 'x-client': 'bad', 'X-Project-Id': 'bad', Accept: 'application/json' }).Authorization, 'Bearer abc');
    const headers = config.getAcHeaders('abc');
    assert.equal(headers['x-client'], 'beidou-web');
    assert.equal(headers['X-Project-Id'], '1006');
  } finally {
    if (previous === undefined) delete process.env.AC_API_BASE_URL; else process.env.AC_API_BASE_URL = previous;
  }
});

test('retired AC host is rejected and type=video is fixed in paged lists', () => {
  process.env.AC_API_BASE_URL = 'https://ac.beidou.win/api/v1';
  assert.equal(config.getAcBaseUrl(), 'https://ac.anynovel.app/api/v1');
  const url = new URL(config.getAcPagedListUrl(100, 2, 'video'));
  assert.equal(url.hostname, 'ac.anynovel.app');
  assert.equal(url.searchParams.get('type'), 'video');
  delete process.env.AC_API_BASE_URL;
});

test('Redis token gets one explicit 401 fallback and is repaired', async (t) => {
  const previous = { token: process.env.AC_TOKEN, old: process.env.NOVELFLOW_AC_TOKEN };
  process.env.AC_TOKEN = 'env-token';
  delete process.env.NOVELFLOW_AC_TOKEN;
  const redis = { value: 'redis-token', writes: [], async get() { return this.value; }, async set(key, value) { this.writes.push([key, value]); this.value = value; } };
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options) => {
    calls.push(options.headers.Authorization);
    if (calls.length === 1) return new Response('{}', { status: 401 });
    return new Response('{"ok":true}', { status: 200, headers: { accesstoken: 'rotated-token' } });
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (previous.token === undefined) delete process.env.AC_TOKEN; else process.env.AC_TOKEN = previous.token;
    if (previous.old === undefined) delete process.env.NOVELFLOW_AC_TOKEN; else process.env.NOVELFLOW_AC_TOKEN = previous.old;
  });
  const response = await ac.fetchAcWithTokenFallback(redis, 'redis-token', 'https://ac.anynovel.app/api/v1/creative/paged-list?type=video', {}, 1000);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['Bearer redis-token', 'Bearer env-token']);
  assert.deepEqual(redis.writes, [['ac_token', 'env-token']]);
});

test('fallback does not loop after a second 401 and proxy maps 401 to 502', () => {
  assert.equal(ac.getAcProxyStatus(401), 502);
  assert.equal(ac.getAcProxyStatus(500), 500);
  assert.equal(ac.parseThreadId('thread-1'), 'thread-1');
  assert.equal(ac.parseThreadId('bad space'), null);
});

test('AC proxy releases budget only for definitive pre-submit responses', () => {
  const proxy = require('../api/_lib/ac-proxy');
  assert.equal(proxy.definitiveAcResponse({ status: 422 }), true);
  assert.equal(proxy.definitiveAcResponse({ status: 429 }), true);
  assert.equal(proxy.definitiveAcResponse({ status: 500 }), false);
  assert.equal(proxy.definitiveAcError(Object.assign(new Error('rejected'), { status: 422 })), true);
  assert.equal(proxy.definitiveAcError(Object.assign(new Error('timeout'), { status: 504, ambiguous: true })), false);
});

test('provider result normalizes Tianji task IDs and video result wrappers', { concurrency: false }, async (t) => {
  const providers = require('../api/_lib/providers');
  const previous = { token: process.env.AC_TOKEN, base: process.env.AC_API_BASE_URL };
  process.env.AC_TOKEN = 'result-token';
  delete process.env.AC_API_BASE_URL;
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    if (previous.token === undefined) delete process.env.AC_TOKEN; else process.env.AC_TOKEN = previous.token;
    if (previous.base === undefined) delete process.env.AC_API_BASE_URL; else process.env.AC_API_BASE_URL = previous.base;
  });
  const fixtures = [
    { threadId: 't-thread', body: { status: 'completed', final_result: [{ video_url: 'https://cdn.example/a.mp4', cover_image_url: 'https://cdn.example/a.jpg' }] } },
    { threadId: 't-json', body: { run_status: 'done', resultJson: JSON.stringify({ video_result: { videos: [{ video_url: 'https://cdn.example/b.mp4' }] } }) } },
    { threadId: 't-final', body: { base_info: { status: '2' }, final_video_result: [{ final_video_url: 'https://cdn.example/c.mp4' }] } },
    { threadId: 't-processed', body: { status: 'success', data: { processed_video_url: 'https://cdn.example/d.mp4' } } },
    { threadId: 't-nested', body: { data: { result_json: JSON.stringify({ status: 'completed', video_result: { videos: [{ video_url: 'https://cdn.example/e.mp4' }] } }) } } }
  ];
  for (const fixture of fixtures) {
    global.fetch = async () => new Response(JSON.stringify(fixture.body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const result = await providers.acResult(fixture.threadId);
    assert.equal(result.status, 'completed');
    assert.match(result.videoUrls[0], /^https:\/\/cdn\.example\//);
  }
  assert.equal(providers.taskIdOf({ data: { creative: { task_id: 'nested-1' } } }), 'nested-1');
});
