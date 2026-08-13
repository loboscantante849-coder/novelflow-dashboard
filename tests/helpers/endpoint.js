const assert = require('node:assert/strict');

class FakeRedis {
  static values = new Map();
  static expiries = new Map();
  static error = null;
  static errorsByKey = new Map();

  static reset(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.expiries = new Map();
    this.error = null;
    this.errorsByKey = new Map();
  }

  _checkError() {
    if (FakeRedis.error) throw FakeRedis.error;
  }

  async get(key) {
    this._checkError();
    if (FakeRedis.errorsByKey.has(key)) throw FakeRedis.errorsByKey.get(key);
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

  async hget(key, field) {
    this._checkError();
    if (FakeRedis.errorsByKey.has(key)) throw FakeRedis.errorsByKey.get(key);
    const hash = FakeRedis.values.get(key);
    if (!hash || typeof hash !== 'object') return null;
    return hash instanceof Map ? (hash.get(field) ?? null) : (hash[field] ?? null);
  }

  async hgetall(key) {
    this._checkError();
    if (FakeRedis.errorsByKey.has(key)) throw FakeRedis.errorsByKey.get(key);
    const hash = FakeRedis.values.get(key);
    if (!hash || typeof hash !== 'object') return null;
    return hash instanceof Map ? Object.fromEntries(hash) : { ...hash };
  }

  async smembers(key) {
    this._checkError();
    if (FakeRedis.errorsByKey.has(key)) throw FakeRedis.errorsByKey.get(key);
    const value = FakeRedis.values.get(key);
    if (value instanceof Set) return Array.from(value);
    return Array.isArray(value) ? [...value] : [];
  }

  async sadd(key, ...members) {
    this._checkError();
    if (FakeRedis.errorsByKey.has(key)) throw FakeRedis.errorsByKey.get(key);
    const existing = FakeRedis.values.get(key);
    const set = existing instanceof Set ? existing : new Set(Array.isArray(existing) ? existing : []);
    let added = 0;
    for (const member of members.flat()) {
      const size = set.size;
      set.add(member);
      if (set.size > size) added += 1;
    }
    FakeRedis.values.set(key, set);
    return added;
  }

  async scard(key) {
    this._checkError();
    if (FakeRedis.errorsByKey.has(key)) throw FakeRedis.errorsByKey.get(key);
    const value = FakeRedis.values.get(key);
    if (value instanceof Set) return value.size;
    return Array.isArray(value) ? new Set(value).size : 0;
  }

  async mget(...keys) {
    this._checkError();
    const list = keys.length === 1 && Array.isArray(keys[0]) ? keys[0] : keys;
    return Promise.all(list.map(key => this.get(key)));
  }

  async scan(_cursor, options = {}) {
    this._checkError();
    const match = String(options.match || '*');
    const pattern = match
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    const keys = Array.from(FakeRedis.values.keys()).filter(key => regex.test(String(key)));
    return ['0', keys];
  }

  async incrby(key, amount) {
    this._checkError();
    const value = Number(FakeRedis.values.get(key) || 0) + Number(amount);
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

  async eval(_script, keys, args) {
    this._checkError();
    if (String(_script).includes('NF_VIP_MEMBER_BIND_V1')) {
      const [userKey, memberKey] = keys;
      const [username, memberId, bindingJson] = args;
      const existingJson = FakeRedis.values.get(userKey);
      if (existingJson) {
        let existing;
        try { existing = JSON.parse(existingJson); } catch (_error) { return -2; }
        if (!existing || existing.user_id !== memberId) return -2;
        const owner = FakeRedis.values.get(memberKey);
        if (owner && owner !== username) return -1;
        if (!owner) FakeRedis.values.set(memberKey, username);
        return 2;
      }
      const owner = FakeRedis.values.get(memberKey);
      if (owner && owner !== username) return -1;
      FakeRedis.values.set(memberKey, username);
      FakeRedis.values.set(userKey, bindingJson);
      return 1;
    }
    if (String(_script).includes('NF_VIP_USER_DATA_COMMIT_V1')) {
      const [userDataKey, eventKey, lockKey] = keys;
      const [userDataJson, eventJson, lockToken] = args;
      if (FakeRedis.values.get(lockKey) !== lockToken) return -2;
      if (FakeRedis.values.has(eventKey)) return -1;
      FakeRedis.values.set(userDataKey, userDataJson);
      FakeRedis.values.set(eventKey, eventJson);
      return 1;
    }
    if (String(_script).includes('NF_SIGNUP_ACCOUNT_CREATE_V1')) {
      const [passwordKey, eventKey] = keys;
      const [passwordHash, eventJson] = args;
      if (FakeRedis.values.has(passwordKey)) return 0;
      FakeRedis.values.set(passwordKey, passwordHash);
      if (!FakeRedis.values.has(eventKey)) FakeRedis.values.set(eventKey, eventJson);
      return 1;
    }
    if (String(_script).includes('NF_MEMBER_ID_ALLOCATE_V1')) {
      const [userKey, counterKey] = keys;
      const [username, startValue, reversePrefix] = args;
      const existing = FakeRedis.values.get(userKey);
      if (existing) {
        const reverseKey = reversePrefix + existing;
        if (!FakeRedis.values.has(reverseKey)) FakeRedis.values.set(reverseKey, username);
        return FakeRedis.values.get(reverseKey) === username ? existing : '';
      }
      let counter = Number(FakeRedis.values.get(counterKey) || 0);
      if (counter < Number(startValue) - 1) counter = Number(startValue) - 1;
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        counter += 1;
        FakeRedis.values.set(counterKey, counter);
        const reverseKey = reversePrefix + counter;
        if (FakeRedis.values.has(reverseKey)) continue;
        FakeRedis.values.set(reverseKey, username);
        FakeRedis.values.set(userKey, String(counter));
        return String(counter);
      }
      return '';
    }
    if (String(_script).includes('NF_REFERRAL_ALLOCATE_V1')) {
      const [userKey, ownerKey] = keys;
      const [username, candidate] = args;
      const assigned = FakeRedis.values.get(userKey);
      if (assigned) return assigned;
      const owner = FakeRedis.values.get(ownerKey);
      if (owner && owner !== username) return '';
      FakeRedis.values.set(ownerKey, username);
      FakeRedis.values.set(userKey, candidate);
      return candidate;
    }
    const key = Array.isArray(keys) ? keys[0] : keys;
    const token = Array.isArray(args) ? args[0] : args;
    if (FakeRedis.values.get(key) !== token) return 0;
    FakeRedis.values.delete(key);
    FakeRedis.expiries.delete(key);
    return 1;
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
    end(body) {
      if (body !== undefined) this.body = body;
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
