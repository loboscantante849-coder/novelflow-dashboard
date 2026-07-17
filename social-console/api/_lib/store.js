const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const RUN_INDEX = 'nf_social:runs';
const runKey = (id) => `nf_social:run:${id}`;
function getRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}
async function listRuns(redis, limit = 50) {
  if (!redis) return [];
  const ids = await redis.zrange(RUN_INDEX, 0, limit - 1, { rev: true });
  if (!ids.length) return [];
  const values = await Promise.all(ids.map((id) => redis.get(`nf_social:run:${id}`)));
  return values.filter(Boolean).map((value) => typeof value === 'string' ? JSON.parse(value) : value);
}
async function getRun(redis, id) {
  if (!redis || !/^[a-z0-9_-]{12,80}$/i.test(String(id || ''))) return null;
  const value = await redis.get(runKey(id));
  return typeof value === 'string' ? JSON.parse(value) : value;
}
async function saveRun(redis, run) {
  run.updatedAt = new Date().toISOString();
  await redis.set(runKey(run.id), JSON.stringify(run));
  await redis.zadd(RUN_INDEX, { score: Date.now(), member: run.id });
  return run;
}
function newRun(input) {
  const now = new Date().toISOString();
  return {
    id: `run_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt: now,
    updatedAt: now,
    input,
    state: 'queued',
    stages: Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((stage) => [stage, { status: 'waiting' }])),
    artifacts: { code: null, shortUrl: null, posts: [], video: null, images: [], analytics: null },
    events: [{ at: now, type: 'queued', message: 'Full production run queued' }]
  };
}
module.exports = { getRedis, listRuns, getRun, saveRun, newRun, RUN_INDEX };
