const assert = require('node:assert/strict');

class FakeRedis {
  static values = new Map();
  static expiries = new Map();
  static error = null;

  static reset(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.expiries = new Map();
    this.error = null;
  }

  _checkError() {
    if (FakeRedis.error) throw FakeRedis.error;
  }

  async get(key) {
    this._checkError();
    return FakeRedis.values.get(key) ?? null;
  }

  async set(key, value, options) {
    this._checkError();
    if (options && options.nx && FakeRedis.values.has(key)) return null;
    if (options && options.xx && !FakeRedis.values.has(key)) return null;
    FakeRedis.values.set(key, value);
    if (options && options.ex) FakeRedis.expiries.set(key, Number(options.ex));
    return 'OK';
  }

  async del(key) {
    this._checkError();
    FakeRedis.expiries.delete(key);
    return FakeRedis.values.delete(key) ? 1 : 0;
  }

  async incr(key) {
    this._checkError();
    const value = Number(FakeRedis.values.get(key) || 0) + 1;
    FakeRedis.values.set(key, value);
    return value;
  }

  async expire(key, seconds) {
    this._checkError();
    FakeRedis.expiries.set(key, Number(seconds));
    return 1;
  }

  async ttl(key) {
    this._checkError();
    return FakeRedis.expiries.get(key) ?? -1;
  }
}

function installFakeUpstash() {
  const modulePath = require.resolve('@upstash/redis');
  require(modulePath);
  require.cache[modulePath].exports = { Redis: FakeRedis };
  return FakeRedis;
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

async function invoke(handler, request = {}) {
  const req = {
    method: 'POST',
    headers: {},
    query: {},
    body: {},
    ...request,
  };
  req.headers = request.headers || {};
  const res = createResponse();
  await handler(req, res);
  assert.ok(Number.isInteger(res.statusCode));
  return res;
}

module.exports = { FakeRedis, installFakeUpstash, invoke };
