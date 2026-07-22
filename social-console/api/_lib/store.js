const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const RUN_INDEX = 'nf_social:runs';
const PLAN_INDEX = 'nf_social:creative_plans';
const DISCORD_JOB_INDEX = 'nf_social:discord:jobs';
const DISCORD_HISTORY_INDEX = 'nf_social:discord:history';
const runKey = (id) => `nf_social:run:${id}`;
const planKey = (id) => `nf_social:creative_plan:${id}`;
const runSummaryKey = (id) => `nf_social:run_summary:${id}`;
const planSummaryKey = (id) => `nf_social:creative_plan_summary:${id}`;
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
  zrem(key, member) { return this.call('zrem', { key, member }); }
  incr(key) { return this.call('incr', { key }); }
  incrby(key, amount) { return this.call('incrby', { key, amount }); }
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
function parseStored(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function runSummary(run) {
  const artifacts = run?.artifacts || {};
  const book = artifacts.book || {};
  return {
    id: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    input: run.input,
    state: run.state,
    stages: run.stages,
    artifacts: {
      book: book ? { title: book.title, cover: book.cover, category: book.category, tags: book.tags } : null,
      code: artifacts.code,
      shortUrl: artifacts.shortUrl,
      linkId: artifacts.linkId,
      posts: Array.isArray(artifacts.posts) ? artifacts.posts.map((post) => ({ type: post.type, content: 'ready' })) : [],
      video: artifacts.video ? { threadId: artifacts.video.threadId, status: artifacts.video.status, videoUrls: artifacts.video.videoUrls } : null,
      referenceVideo: artifacts.referenceVideo ? { threadId: artifacts.referenceVideo.threadId, status: artifacts.referenceVideo.status, videoUrls: artifacts.referenceVideo.videoUrls } : null,
      images: Array.isArray(artifacts.images) ? artifacts.images.map((image) => ({ variant: image.variant, status: image.status, url: image.url })) : [],
      analytics: artifacts.analytics ? { summary: artifacts.analytics.summary } : null,
      distribution: artifacts.distribution ? { status: artifacts.distribution.status } : null,
      optimization: artifacts.optimization ? { status: artifacts.optimization.status } : null,
      usage: artifacts.usage || {}
    },
    modelActivity: Array.isArray(artifacts.modelActivity) ? artifacts.modelActivity.slice(-6) : [],
    events: Array.isArray(run.events) ? run.events.slice(-5) : [],
    _summary: true
  };
}
function creativePlanSummary(plan) {
  const artifacts = plan?.artifacts || {};
  return {
    id: plan.id,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    input: plan.input,
    state: plan.state,
    stages: plan.stages,
    artifacts: {
      book: artifacts.book ? { title: artifacts.book.title, cover: artifacts.book.cover, bookSkuId: artifacts.book.bookSkuId, sku: artifacts.book.sku } : null,
      usage: artifacts.usage || null,
      evidenceScope: artifacts.evidenceScope || null
    },
    events: Array.isArray(plan.events) ? plan.events.slice(-4) : [],
    _summary: true
  };
}
async function listRunSummaries(redis, limit = 12) {
  if (!redis) return [];
  const ids = await redis.zrange(RUN_INDEX, 0, limit - 1, { rev: true });
  if (!ids.length) return [];
  const summaries = await Promise.all(ids.map(async (id) => {
    const stored = await redis.get(runSummaryKey(id));
    if (stored) return parseStored(stored);
    // One-time lazy migration for old runs. Subsequent dashboard loads only read the small summary.
    const full = await getRun(redis, id);
    if (!full) return null;
    const summary = runSummary(full);
    await redis.set(runSummaryKey(id), JSON.stringify(summary));
    return summary;
  }));
  return summaries.filter(Boolean);
}
async function getRun(redis, id) {
  if (!redis || !/^[a-z0-9_-]{12,80}$/i.test(String(id || ''))) return null;
  const value = await redis.get(runKey(id));
  return typeof value === 'string' ? JSON.parse(value) : value;
}
async function saveRun(redis, run) {
  run.updatedAt = new Date().toISOString();
  await Promise.all([
    redis.set(runKey(run.id), JSON.stringify(run)),
    redis.set(runSummaryKey(run.id), JSON.stringify(runSummary(run)))
  ]);
  await redis.zadd(RUN_INDEX, { score: Date.now(), member: run.id });
  return run;
}
async function listCreativePlans(redis, limit = 12) {
  if (!redis) return [];
  const ids = await redis.zrange(PLAN_INDEX, 0, limit - 1, { rev: true });
  if (!ids.length) return [];
  const values = await Promise.all(ids.map((id) => redis.get(planKey(id))));
  return values.filter(Boolean).map((value) => typeof value === 'string' ? JSON.parse(value) : value);
}
async function listCreativePlanSummaries(redis, limit = 5) {
  if (!redis) return [];
  const ids = await redis.zrange(PLAN_INDEX, 0, limit - 1, { rev: true });
  if (!ids.length) return [];
  const summaries = await Promise.all(ids.map(async (id) => {
    const stored = await redis.get(planSummaryKey(id));
    if (stored) return parseStored(stored);
    const full = await getCreativePlan(redis, id);
    if (!full) return null;
    const summary = creativePlanSummary(full);
    await redis.set(planSummaryKey(id), JSON.stringify(summary));
    return summary;
  }));
  return summaries.filter(Boolean);
}
async function getCreativePlan(redis, id) {
  if (!redis || !/^plan_[a-z0-9]{12,80}$/i.test(String(id || ''))) return null;
  const value = await redis.get(planKey(id));
  return typeof value === 'string' ? JSON.parse(value) : value;
}
async function saveCreativePlan(redis, plan) {
  plan.updatedAt = new Date().toISOString();
  await Promise.all([
    redis.set(planKey(plan.id), JSON.stringify(plan)),
    redis.set(planSummaryKey(plan.id), JSON.stringify(creativePlanSummary(plan)))
  ]);
  await redis.zadd(PLAN_INDEX, { score: Date.now(), member: plan.id });
  return plan;
}

function discordJobKey(id) { return `nf_social:discord:job:${id}`; }

function discordJobSummary(job) {
  const result = job?.result || {};
  const book = (item) => ({ bookSkuId: String(item?.bookSkuId || ''), title: String(item?.title || ''), confidence: Number(item?.confidence || 0), confidenceLabel: String(item?.confidenceLabel || ''), sources: Array.isArray(item?.sources) ? item.sources.slice(0, 4) : [] });
  return {
    id: job?.id,
    kind: job?.kind,
    state: job?.state,
    phase: job?.phase,
    createdAt: job?.createdAt,
    updatedAt: job?.updatedAt,
    guildId: String(job?.guildId || ''),
    channelId: String(job?.channelId || ''),
    user: { id: String(job?.user?.id || ''), username: String(job?.user?.username || '') },
    input: {
      source: String(job?.input?.source || ''), language: String(job?.input?.language || ''),
      attachmentCount: Array.isArray(job?.input?.attachments) ? job.input.attachments.length : 0,
      ocr: Array.isArray(job?.input?.ocr) ? job.input.ocr.map((item) => ({ filename: String(item?.filename || ''), quality: String(item?.quality || ''), failed: Boolean(item?.error) })) : []
    },
    result: {
      matches: Array.isArray(result.matches) ? result.matches.slice(0, 3).map(book) : [],
      recommendations: Array.isArray(result.recommendations) ? result.recommendations.slice(0, 3).map(book) : [],
      catalogSources: Array.isArray(result.catalog?.sources) ? result.catalog.sources.slice(0, 8) : []
    },
    selectedBook: job?.selectedBook ? { bookSkuId: String(job.selectedBook.bookSkuId || ''), title: String(job.selectedBook.title || '') } : null,
    tracking: job?.tracking ? { status: String(job.tracking.status || ''), code: String(job.tracking.code || ''), linkId: String(job.tracking.linkId || ''), shortUrl: String(job.tracking.shortUrl || '') } : null,
    error: String(job?.error || '').slice(0, 500),
    _summary: true
  };
}

async function getDiscordJob(redis, id) {
  if (!redis || !/^discord_[a-z0-9_-]{12,100}$/i.test(String(id || ''))) return null;
  const value = await redis.get(discordJobKey(id));
  return value ? parseStored(value) : null;
}

async function saveDiscordJob(redis, job, queued = false) {
  job.updatedAt = new Date().toISOString();
  await Promise.all([
    redis.set(discordJobKey(job.id), JSON.stringify(job), { ex: 7 * 24 * 60 * 60 }),
    redis.zadd(DISCORD_HISTORY_INDEX, { score: Date.now(), member: job.id })
  ]);
  if (queued) await redis.zadd(DISCORD_JOB_INDEX, { score: Date.now(), member: job.id });
  return job;
}

async function listDiscordJobs(redis, limit = 10) {
  const ids = await redis.zrange(DISCORD_JOB_INDEX, 0, Math.max(0, limit - 1));
  if (!ids.length) return [];
  const jobs = await Promise.all(ids.map((id) => getDiscordJob(redis, id)));
  return jobs.filter(Boolean);
}

async function removeDiscordJobFromQueue(redis, id) {
  await redis.zrem(DISCORD_JOB_INDEX, id);
}

async function listDiscordJobSummaries(redis, limit = 50, state = '') {
  if (!redis) return [];
  const ids = await redis.zrange(DISCORD_HISTORY_INDEX, 0, Math.max(0, limit - 1), { rev: true });
  if (!ids.length) return [];
  const jobs = await Promise.all(ids.map((id) => getDiscordJob(redis, id)));
  return jobs.filter(Boolean).map(discordJobSummary).filter((job) => !state || job.state === state).slice(0, limit);
}
function newCreativePlan(input) {
  const createdAt = new Date().toISOString();
  return {
    id: `plan_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt,
    updatedAt: createdAt,
    input,
    state: 'queued',
    stages: { identity: { status: 'waiting' }, evidence: { status: 'waiting', cursor: 0 }, analysis: { status: 'waiting', attempt: 0 } },
    artifacts: { book: null, chapterList: [], evidence: [], plan: null, evidenceScope: null, usage: null },
    events: [{ at: createdAt, type: 'queued', message: 'Background AI creative planning queued' }]
  };
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

function videoHourInfo(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  const hour = `${value('year')}${value('month')}${value('day')}${value('hour')}`;
  const remaining = Math.max(60, Math.ceil((3600000 - (at.getTime() % 3600000)) / 1000) + 60);
  return { key: `nf_social:video_hour:${hour}`, limit: 5, expiresIn: remaining, label: `${value('month')}/${value('day')} ${value('hour')}:00` };
}

async function videoCapacity(redis) {
  const info = videoHourInfo();
  const used = Math.max(0, Number(await redis.get(info.key)) || 0);
  return { ...info, used: Math.min(used, info.limit), remaining: Math.max(0, info.limit - used) };
}

async function reserveVideoSlot(redis) {
  const info = videoHourInfo();
  await redis.set(info.key, '0', { nx: true, ex: info.expiresIn });
  const used = Number(await redis.incr(info.key));
  if (used <= info.limit) return { ...info, used, remaining: info.limit - used, granted: true };
  await redis.incrby(info.key, -1);
  return { ...info, used: info.limit, remaining: 0, granted: false };
}

async function releaseVideoSlot(redis, key) {
  if (typeof key === 'string' && key.startsWith('nf_social:video_hour:')) await redis.incrby(key, -1);
}

module.exports = { getRedis, listRuns, listRunSummaries, getRun, saveRun, newRun, addEvent, setStage, listCreativePlans, listCreativePlanSummaries, getCreativePlan, saveCreativePlan, newCreativePlan, getDiscordJob, saveDiscordJob, listDiscordJobs, listDiscordJobSummaries, removeDiscordJobFromQueue, discordJobSummary, RUN_INDEX, PLAN_INDEX, DISCORD_JOB_INDEX, DISCORD_HISTORY_INDEX, videoCapacity, reserveVideoSlot, releaseVideoSlot };
