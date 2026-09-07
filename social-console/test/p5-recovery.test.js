const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../api/_lib/providers');
const { processRun } = require('../api/_lib/pipeline');
const { newRun } = require('../api/_lib/store');
const { normalizeDelivery } = require('../api/_lib/distribution');

class MemoryRedis {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }
  async incr(key) {
    const value = Number(this.values.get(key) || 0) + 1;
    this.values.set(key, value);
    return value;
  }
  async zadd() { return 1; }
  async zrange() { return []; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
}

function preparedRun() {
  const run = newRun({
    title: 'Attribution Recovery', sku: 'attribution-recovery', paidAuthorized: true,
    // Instagram is a code-only route, so the test can stop after attribution
    // without invoking the short-link branch.
    delivery: normalizeDelivery({ accountId: 13943450 })
  });
  run.state = 'running';
  run.stages.P1.status = 'done';
  run.stages.P2.status = 'done';
  return run;
}

test('P5 transient provider errors wait and preserve the assigned Code', async (t) => {
  const originals = { keywordRecord: providers.keywordRecord, createKeyword: providers.createKeyword };
  t.after(() => Object.assign(providers, originals));
  let lookups = 0;
  let creates = 0;
  providers.keywordRecord = async () => {
    lookups += 1;
    if (lookups === 1) throw new providers.ProviderError('Promotion code lookup failed with HTTP 503', { status: 503 });
    return creates ? { id: 'keyword-1', keyword: '44444', bookId: 'attribution-recovery', channel: 'FB', isEnable: true } : null;
  };
  providers.createKeyword = async () => { creates += 1; };
  const redis = new MemoryRedis();
  const run = preparedRun();

  await processRun(redis, run); // allocate the first candidate
  assert.equal(run.artifacts.code, '44444');
  await processRun(redis, run); // transient lookup failure
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P5.status, 'waiting');
  assert.equal(run.stages.P5.phase, 'code');
  assert.equal(run.artifacts.code, '44444');
  assert.ok(run.stages.P5.nextAttemptAt);

  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run); // wake the same Code, never allocate 44445
  assert.equal(run.stages.P5.status, 'running');
  assert.equal(run.artifacts.code, '44444');
  await processRun(redis, run); // verify/create the preserved Code
  assert.equal(creates, 1);
  assert.equal(run.artifacts.code, '44444');
  assert.equal(run.stages.P5.phase, 'code_only');
});

test('P5 backoff is honored by a direct worker call', async (t) => {
  const original = providers.keywordRecord;
  t.after(() => { providers.keywordRecord = original; });
  let calls = 0;
  providers.keywordRecord = async () => { calls += 1; return null; };
  const redis = new MemoryRedis();
  const run = preparedRun();
  run.artifacts.code = '44444';
  run.stages.P5 = { status: 'waiting', phase: 'code', nextAttemptAt: new Date(Date.now() + 60_000).toISOString() };
  await processRun(redis, run);
  assert.equal(calls, 0);
  assert.equal(run.artifacts.code, '44444');
  assert.equal(run.stages.P5.status, 'waiting');
});

test('ambiguous Code creation switches to read-only reconciliation and never posts twice', async (t) => {
  const originals = { keywordRecord: providers.keywordRecord, createKeyword: providers.createKeyword };
  t.after(() => Object.assign(providers, originals));
  let lookups = 0;
  let creates = 0;
  providers.keywordRecord = async () => {
    lookups += 1;
    return lookups >= 3 ? { id: 'keyword-ambiguous', keyword: '44444', bookId: 'attribution-recovery', channel: 'FB', isEnable: true } : null;
  };
  providers.createKeyword = async () => {
    creates += 1;
    throw new providers.ProviderError('Promotion code write timed out', { status: 504, code: 'provider_timeout', ambiguous: true });
  };
  const redis = new MemoryRedis();
  const run = preparedRun();
  await processRun(redis, run); // allocate
  await processRun(redis, run); // one uncertain POST
  assert.equal(creates, 1);
  assert.equal(run.stages.P5.phase, 'code_reconcile');
  assert.equal(run.stages.P5.status, 'waiting');
  assert.equal(run.artifacts.code, '44444');

  // Wake and perform read-only checks. The third check observes the
  // eventually-consistent remote Code and advances to the normal code phase.
  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run);
  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run);
  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run);
  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run);
  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run);
  assert.equal(creates, 1);
  assert.equal(run.artifacts.code, '44444');
  assert.equal(run.artifacts.keywordId, 'keyword-ambiguous');
});

test('ambiguous short-link creation switches to lookup-only reconciliation', async (t) => {
  const originals = { findLink: providers.findLink, createLink: providers.createLink };
  t.after(() => Object.assign(providers, originals));
  let finds = 0;
  let creates = 0;
  providers.findLink = async () => {
    finds += 1;
    return finds >= 3 ? { id: 'link-ambiguous', shortUrl: 'https://social.example/s/ambiguous' } : null;
  };
  providers.createLink = async () => {
    creates += 1;
    throw new providers.ProviderError('Short-link write timed out', { status: 504, code: 'provider_timeout', ambiguous: true });
  };
  const redis = new MemoryRedis();
  const run = preparedRun();
  run.artifacts.book = { title: 'Attribution Recovery', bookSkuId: run.input.sku };
  run.artifacts.code = '44444';
  run.stages.P5 = { status: 'running', phase: 'link' };
  await processRun(redis, run); // initial lookup + uncertain POST
  assert.equal(creates, 1);
  assert.equal(run.stages.P5.phase, 'link_reconcile');
  assert.equal(run.stages.P5.status, 'waiting');
  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run); // wake
  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run); // lookup-only, no second POST
  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run); // observe the eventually-consistent link
  run.stages.P5.nextAttemptAt = '';
  await processRun(redis, run); // complete the lookup-only reconciliation
  assert.equal(creates, 1);
  assert.equal(run.artifacts.linkId, 'link-ambiguous');
  assert.equal(run.artifacts.shortUrl, 'https://social.example/s/ambiguous');
  assert.equal(run.stages.P5.status, 'done');
});
