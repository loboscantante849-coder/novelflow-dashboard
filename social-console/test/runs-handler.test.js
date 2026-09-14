const test = require('node:test');
const assert = require('node:assert/strict');

test('POST rejects existing-run update payloads before storage, providers, or creation', async () => {
  const store = require('../api/_lib/store');
  const auth = require('../api/_lib/auth');
  const providers = require('../api/_lib/providers');
  const snapshots = [store, auth, providers].map((module) => [module, { ...module }]);
  const handlerPath = require.resolve('../api/runs');
  const previousHandler = require.cache[handlerPath];
  const calls = { auth: 0, storage: 0, lookup: 0, create: 0, save: 0 };
  try {
    auth.requireOperatorMutation = () => { calls.auth += 1; return true; };
    store.getRedis = () => { calls.storage += 1; return null; };
    store.newRun = () => { calls.create += 1; throw new Error('Creation must not run'); };
    store.saveRun = async () => { calls.save += 1; throw new Error('Writes must not run'); };
    providers.findExactBook = async () => { calls.lookup += 1; throw new Error('Provider reads must not run'); };
    delete require.cache[handlerPath];
    const handler = require('../api/runs');
    const invoke = async (method, body) => {
      const result = {};
      const res = {
        status(value) { result.status = value; return this; },
        json(value) { result.body = value; return value; }
      };
      await handler({ method, headers: {}, query: {}, body }, res);
      return result;
    };
    // A fully authorized-looking creation payload must still be rejected
    // when it carries update intent. This reproduces the duplicate-run bug.
    const creation = { title: 'Verified Romance', sku: 'sku-1', accountId: 13751295, paidAuthorized: true, paidMediaSubmissionAuthorized: true };
    for (const update of [
      { action: 'set_creative_model', id: 'run_existing', modelChoice: 'deepseek' },
      { action: 'set_creative_model' },
      { id: 'run_existing' },
      { action: '' },
      { id: null }
    ]) {
      const result = await invoke('POST', { ...creation, ...update });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'run_update_requires_patch');
      assert.match(result.body.error, /Use PATCH/);
    }
    assert.deepEqual(calls, { auth: 5, storage: 0, lookup: 0, create: 0, save: 0 });
    // Normal creation and correctly addressed updates pass this guard and
    // reach the existing storage check (no real storage is configured here).
    assert.equal((await invoke('POST', creation)).status, 503);
    assert.equal((await invoke('PATCH', { action: 'set_creative_model', id: 'run_existing' })).status, 503);
    assert.equal(calls.storage, 2);
  } finally {
    delete require.cache[handlerPath];
    if (previousHandler) require.cache[handlerPath] = previousHandler;
    for (const [module, snapshot] of snapshots) Object.assign(module, snapshot);
  }
});
