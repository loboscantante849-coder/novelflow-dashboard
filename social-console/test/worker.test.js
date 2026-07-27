const test = require('node:test');
const assert = require('node:assert/strict');

class MemoryRedis {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
}

function response() {
  const result = { statusCode: 200, body: null };
  return {
    result,
    status(statusCode) { result.statusCode = statusCode; return this; },
    json(body) { result.body = body; return body; }
  };
}

function run(id = 'run_1234567890abcdef') {
  return {
    id,
    state: 'running',
    updatedAt: new Date().toISOString(),
    stages: { P1: { status: 'done' }, P2: { status: 'done' }, P3: { status: 'waiting' }, P3_5: { status: 'waiting' }, P4: { status: 'waiting' }, P5: { status: 'done' }, P6: { status: 'waiting' } },
    artifacts: {},
    events: []
  };
}

function plan(id = 'plan_1234567890abcdef') {
  return {
    id,
    state: 'running',
    updatedAt: new Date().toISOString(),
    input: { modelChoice: 'hy3' },
    stages: { identity: { status: 'done' }, evidence: { status: 'done' }, analysis: { status: 'running' } },
    artifacts: {},
    events: []
  };
}

function restore(target, snapshot) {
  for (const key of Object.keys(target)) if (!(key in snapshot)) delete target[key];
  Object.assign(target, snapshot);
}

async function invoke(t, { redis = new MemoryRedis(), body = {}, store = {}, pipeline = {}, plans = {}, discord = {} } = {}) {
  const storeModule = require('../api/_lib/store');
  const authModule = require('../api/_lib/auth');
  const pipelineModule = require('../api/_lib/pipeline');
  const planModule = require('../api/_lib/creative-plans');
  const discordModule = require('../api/_lib/discord');
  const snapshots = [
    [storeModule, { ...storeModule }],
    [authModule, { ...authModule }],
    [pipelineModule, { ...pipelineModule }],
    [planModule, { ...planModule }],
    [discordModule, { ...discordModule }]
  ];
  const workerPath = require.resolve('../api/worker');

  Object.assign(storeModule, {
    getRedis: () => redis,
    getRun: async () => null,
    listRunSummaries: async () => [],
    saveRun: async (_redis, item) => item,
    addEvent: (item, type, message) => item.events.push({ type, message }),
    getCreativePlan: async () => null,
    listCreativePlanSummaries: async () => [],
    listDiscordJobs: async () => [],
    saveCreativePlan: async (_redis, item) => item,
    ...store
  });
  Object.assign(authModule, { requireSession: () => true });
  Object.assign(pipelineModule, { processRun: async (_redis, item) => item, p3: async (_redis, item) => item, ...pipeline });
  Object.assign(planModule, { processCreativePlan: async (_redis, item) => item, ...plans });
  Object.assign(discordModule, { processDiscordJob: async (_redis, item) => item, ...discord });
  delete require.cache[workerPath];
  t.after(() => {
    delete require.cache[workerPath];
    for (const [target, snapshot] of snapshots) restore(target, snapshot);
  });

  const worker = require('../api/worker');
  const res = response();
  await worker({ headers: {}, body, query: {} }, res);
  return { redis, result: res.result };
}

test('manual run requests take priority over queued Discord work', async (t) => {
  const target = run();
  let runCalls = 0;
  let discordCalls = 0;
  const { result } = await invoke(t, {
    body: { id: target.id },
    store: {
      getRun: async (_redis, id) => id === target.id ? target : null,
      listDiscordJobs: async () => [{ id: 'discord_1234567890abcdef', state: 'queued' }]
    },
    pipeline: { processRun: async () => { runCalls += 1; return target; } },
    discord: { processDiscordJob: async () => { discordCalls += 1; return { id: 'discord_1234567890abcdef', state: 'done', phase: 'done' }; } }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.run.id, target.id);
  assert.equal(runCalls, 1);
  assert.equal(discordCalls, 0);
});

test('detail hydration rebuilds a compact snapshot without advancing providers or pipeline', async (t) => {
  const target = run();
  target.artifacts.evidence = { chapters: [{ order: 1, content: 'x'.repeat(50000) }] };
  let saves = 0;
  let runCalls = 0;
  const { result } = await invoke(t, {
    body: { id: target.id, detailOnly: true },
    store: {
      getRun: async () => target,
      saveRun: async (_redis, item) => { saves += 1; return item; }
    },
    pipeline: { processRun: async () => { runCalls += 1; return target; } }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.detailReady, true);
  assert.equal(target.artifacts.evidence.chapters[0].content.length, 16000);
  assert.equal(saves, 1);
  assert.equal(runCalls, 0);
});

test('explicit creative recovery schedules exactly one reserve without advancing paid stages', async (t) => {
  const target = run();
  target.input = { creativeProfile: { modelChoice: 'deepseek' } };
  target.stages.P3 = { status: 'running', startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() };
  target.artifacts.creativeDraft = { parts: {}, usage: [], inFlight: { posts: new Date().toISOString() } };
  let saves = 0;
  let runCalls = 0;
  const { result } = await invoke(t, {
    body: { id: target.id, recoverCreative: true },
    store: { getRun: async () => target, saveRun: async (_redis, item) => { saves += 1; return item; } },
    pipeline: { processRun: async () => { runCalls += 1; return target; } }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.recoveryScheduled, true);
  assert.equal(target.input.creativeProfile.modelChoice, 'hy3');
  assert.equal(target.artifacts.creativeDraft.modelRoute.fallbackUsed, true);
  assert.equal(target.stages.P3.phase, 'fallback_scheduled');
  assert.equal(saves, 1);
  assert.equal(runCalls, 0);
});

test('an unknown explicit run id never falls through to an unrelated runnable run', async (t) => {
  const fallback = run('run_abcdef1234567890');
  let runCalls = 0;
  const { result } = await invoke(t, {
    body: { id: 'run_missing1234567890' },
    store: {
      getRun: async (_redis, id) => id === fallback.id ? fallback : null,
      listRunSummaries: async () => [fallback]
    },
    pipeline: { processRun: async () => { runCalls += 1; return fallback; } }
  });

  assert.equal(result.statusCode, 404);
  assert.equal(result.body.error, 'Run not found');
  assert.equal(runCalls, 0);
});

test('cron never restarts a creative task that explicitly waits for an operator', async (t) => {
  const target = run();
  target.state = 'failed';
  target.stages.P3 = { status: 'failed', phase: 'waiting_for_operator', recoverable: false };
  let fullReads = 0;
  let runCalls = 0;
  const { result } = await invoke(t, {
    store: { listRunSummaries: async () => [target], getRun: async () => { fullReads += 1; return target; } },
    pipeline: { processRun: async () => { runCalls += 1; return target; } }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.worked, false);
  assert.equal(fullReads, 0);
  assert.equal(runCalls, 0);
});

test('an unknown explicit plan id never falls through to an unrelated runnable run', async (t) => {
  const fallback = run('run_abcdef1234567890');
  let runCalls = 0;
  const { result } = await invoke(t, {
    body: { planId: 'plan_missing1234567890' },
    store: {
      getCreativePlan: async () => null,
      getRun: async (_redis, id) => id === fallback.id ? fallback : null,
      listRunSummaries: async () => [fallback]
    },
    pipeline: { processRun: async () => { runCalls += 1; return fallback; } }
  });

  assert.equal(result.statusCode, 404);
  assert.equal(result.body.error, 'Creative plan not found');
  assert.equal(runCalls, 0);
});

test('an owned worker lease does not delete a replacement lease', async (t) => {
  const target = run();
  const replacement = `v1|${Date.now()}|replacement-owner`;
  const { redis, result } = await invoke(t, {
    body: { id: target.id },
    store: { getRun: async () => target },
    pipeline: {
      processRun: async (store) => {
        await store.set(`nf_social:lock:${target.id}`, replacement);
        return target;
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(await redis.get(`nf_social:lock:${target.id}`), replacement);
});

test('a stale worker lease is recovered from the latest saved run state', async (t) => {
  const target = run();
  const redis = new MemoryRedis();
  await redis.set(`nf_social:lock:${target.id}`, `v1|${Date.now() - 900000}|11111111-1111-1111-1111-111111111111`);
  let saves = 0;
  const { result } = await invoke(t, {
    redis,
    body: { id: target.id },
    store: {
      getRun: async () => target,
      saveRun: async (_redis, item) => { saves += 1; return item; }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.ok(target.events.some((item) => item.type === 'stale_worker_lock_recovered'));
  assert.ok(saves >= 1);
  assert.equal(await redis.get(`nf_social:lock:${target.id}`), null);
});

test('creative planning work is bounded to six resumable steps per invocation', async (t) => {
  const target = plan();
  let calls = 0;
  const { result } = await invoke(t, {
    body: { planId: target.id },
    store: { getCreativePlan: async () => target },
    plans: {
      processCreativePlan: async () => {
        calls += 1;
        return target;
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.steps, 6);
  assert.equal(calls, 6);
  assert.deepEqual(Object.keys(result.body.job).sort(), ['id', 'input', 'stages', 'state', 'updatedAt']);
});
