const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const config = require('../api/_lib/ac-config');
const { fetchAcWithTokenFallback } = require('../api/_lib/ac-request');

const ENV_KEYS = ['AC_API_BASE_URL', 'AC_BASE_URL', 'AC_PROJECT_ID'];

function withEnv(values, callback) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        if (values[key] === undefined) delete process.env[key];
        else process.env[key] = values[key];
      }
    }
    return callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('AC defaults point at Tianji API and video list URL carries type=video', () => {
  withEnv({ AC_API_BASE_URL: undefined, AC_BASE_URL: undefined, AC_PROJECT_ID: undefined }, () => {
    assert.equal(config.getAcBaseUrl(), 'https://ac.anynovel.app/api/v1');
    assert.equal(config.getAcProjectId(), '1006');
    const url = new URL(config.getAcPagedListUrl(100, 3, 'video'));
    assert.equal(url.origin, 'https://ac.anynovel.app');
    assert.equal(url.pathname, '/api/v1/creative/paged-list');
    assert.equal(url.searchParams.get('PageSize'), '100');
    assert.equal(url.searchParams.get('PageIndex'), '3');
    assert.equal(url.searchParams.get('type'), 'video');
  });
});

test('AC_API_BASE_URL takes precedence and AC_BASE_URL remains a compatible alias', () => {
  withEnv({ AC_API_BASE_URL: '  "https://tianji.example.test/api/v1/"  ', AC_BASE_URL: 'https://legacy.example.test/api/v1' }, () => {
    assert.equal(config.getAcBaseUrl(), 'https://tianji.example.test/api/v1');
  });
  withEnv({ AC_API_BASE_URL: undefined, AC_BASE_URL: 'https://legacy.example.test/api/v1/' }, () => {
    assert.equal(config.getAcBaseUrl(), 'https://legacy.example.test/api/v1');
  });
});

test('unsafe or malformed AC base overrides fall back to the Tianji default', () => {
  for (const value of [
    'http://evil.example.test/api/v1',
    'https://user:pass@evil.example.test/api/v1',
    'https://evil.example.test:8443/api/v1',
    'https://evil.example.test/api/v1?redirect=1',
    'https://localhost/api/v1',
    'https://ac.beidou.win/api/v1',
    'https://127.0.0.1/api/v1',
    'https://[::ffff:127.0.0.1]/api/v1',
    'https://evil.example.test/not-api-v1',
  ]) {
    withEnv({ AC_API_BASE_URL: value, AC_BASE_URL: undefined }, () => {
      assert.equal(config.getAcBaseUrl(), 'https://ac.anynovel.app/api/v1', value);
    });
  }
});

test('project and token values are normalized before entering AC headers', () => {
  withEnv({ AC_PROJECT_ID: '  "project-1006"  ' }, () => {
    assert.equal(config.getAcProjectId(), 'project-1006');
  });
  withEnv({ AC_PROJECT_ID: 'bad project' }, () => {
    assert.equal(config.getAcProjectId(), '1006');
  });
  assert.equal(config.normalizeAcToken('  "jwt-value"  '), 'jwt-value');
  assert.equal(config.normalizeAcToken(' Bearer jwt-value '), 'jwt-value');
  assert.equal(config.normalizeAcToken('Bearer "jwt-value"'), 'jwt-value');
  assert.equal(config.normalizeAcToken({ token: 'jwt-value' }), null);
  assert.equal(config.normalizeAcToken('jwt-value\u0000'), null);
  assert.deepEqual(config.getAcHeaders('  "jwt-value"  ', {
    'Content-Type': 'application/json',
    authorization: 'attacker-token',
    'x-project-id': 'attacker-project',
  }), {
    Authorization: 'Bearer jwt-value',
    'x-client': 'beidou-web',
    'X-Project-Id': '1006',
    'Content-Type': 'application/json',
  });
});

test('all AC handlers use shared config and contain no retired upstream host', () => {
  const handlers = ['ac-create.js', 'ac-list.js', 'ac-result.js', 'ac-retry.js', 'ac-interrupt.js', 'ac-refresh.js'];
  for (const filename of handlers) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'api', filename), 'utf8');
    assert.equal(source.includes('ac.beidou.win'), false, filename);
    assert.match(source, /getAc(?:BaseUrl|PagedListUrl|Headers)/, filename);
  }
});

test('rotated access tokens are trimmed and persisted server-side', async () => {
  const writes = [];
  const redis = { async set(key, value) { writes.push([key, value]); } };
  const response = { headers: { get(name) { return name === 'accesstoken' ? '  "rotated-jwt"  ' : null; } } };
  const token = await config.rotateAcToken(redis, response);
  assert.equal(token, 'rotated-jwt');
  assert.deepEqual(writes, [['ac_token', 'rotated-jwt']]);
});

test('browser-serialized Tianji tokens are normalized before use', () => {
  assert.equal(config.normalizeAcToken('"eyJhbGciOiJIUzI1NiJ9.payload.sig"'), 'eyJhbGciOiJIUzI1NiJ9.payload.sig');
  assert.equal(config.normalizeAcToken('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'), 'eyJhbGciOiJIUzI1NiJ9.payload.sig');
  assert.equal(config.normalizeAcToken('Bearer Bearer token'), 'Bearer token');
});

test('video payload keeps image generation enabled for slideshow/video templates', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'ac-create.js'), 'utf8');
  assert.match(source, /is_generate_img:\s*'true'/);
});

test('a rejected Redis token falls back once to AC_TOKEN and repairs Redis', async () => {
  const previousToken = process.env.AC_TOKEN;
  const previousBase = process.env.AC_API_BASE_URL;
  const originalFetch = global.fetch;
  const calls = [];
  const writes = [];
  process.env.AC_TOKEN = 'new-env-token';
  delete process.env.AC_API_BASE_URL;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    return {
      status: calls.length === 1 ? 401 : 200,
      headers: { get: () => null },
    };
  };
  try {
    const response = await fetchAcWithTokenFallback(
      { async set(key, value) { writes.push([key, value]); } },
      'old-redis-token',
      'https://ac.anynovel.app/api/v1/creative/paged-list?PageSize=5&PageIndex=1&type=video',
      { headers: { Authorization: 'ignored', 'x-client': 'ignored' } },
      1000,
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.Authorization, 'Bearer old-redis-token');
    assert.equal(calls[1].headers.Authorization, 'Bearer new-env-token');
    assert.equal(calls[1].headers['x-client'], 'beidou-web');
    assert.deepEqual(writes, [['ac_token', 'new-env-token']]);
  } finally {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.AC_TOKEN;
    else process.env.AC_TOKEN = previousToken;
    if (previousBase === undefined) delete process.env.AC_API_BASE_URL;
    else process.env.AC_API_BASE_URL = previousBase;
  }
});
