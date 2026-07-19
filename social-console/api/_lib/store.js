const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const RUN_INDEX = 'nf_social:runs';
const runKey = (id) => `nf_social:run:${id}`;
class RemoteRedis {
  constructor(url, secret) { this.url = url.replace(/\/$/, ''); this.secret = secret; }
  async call(op, args) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, args })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Social storage HTTP ${response.status}`);
    return body.result;
  }
  get(key) { return this.call('get', { key }); }
  set(key, value, options) { return this.call('set', { key, value, options }); }
  zrange(key, start, end, options) { return this.call('zrange', { key, start, end, options }); }
  zadd(key, entry) { return this.call('zadd', { key, entry }); }
  incr(key) { return this.call('incr', { key }); }
  del(key) { return this.call('del', { key }); }
}
function getRedis() {
  const bridgeUrl = process.env.SOCIAL_STORE_URL;
  const bridgeSecret = process.env.SOCIAL_STORE_SECRET;
  if (bridgeUrl && bridgeSecret) return new RemoteRedis(bridgeUrl, bridgeSecret);
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return url && token && /^https:\/\//i.test(url) ? new Redis({ url, token }) : null;
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
function stageMap() {
  return Object.fromEntries(['P1', 'P2', 'P3', 'P3_5', 'P4', 'P5', 'P6'].map((stage) => [stage, { status: 'waiting' }]));
}
function newRun(input) {
  const now = new Date().toISOString();
  return {
    id: `run_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt: now,
    updatedAt: now,
    input,
    state: 'queued',
    stages: stageMap(),
    artifacts: { book: null, evidence: null, code: null, shortUrl: null, linkId: null, posts: [], translations: null, videoPrompt: null, posterPrompts: [], video: null, images: [], review: null, analytics: null, usage: {} },
    events: [{ at: now, type: 'queued', message: 'Full production run queued' }]
  };
}
function addEvent(run, type, message, data = undefined) {
  run.events = Array.isArray(run.events) ? run.events : [];
  run.events.push({ at: new Date().toISOString(), type, message, ...(data ? { data } : {}) });
  run.events = run.events.slice(-120);
}
function setStage(run, name, status, extra = {}) {
  const previous = run.stages[name] || {};
  run.stages[name] = { ...previous, ...extra, status, updatedAt: new Date().toISOString() };
  if (status === 'running' && !run.stages[name].startedAt) run.stages[name].startedAt = new Date().toISOString();
  if (status === 'done' && !run.stages[name].completedAt) run.stages[name].completedAt = new Date().toISOString();
  return run.stages[name];
}
module.exports = { getRedis, listRuns, getRun, saveRun, newRun, addEvent, setStage, RUN_INDEX };
