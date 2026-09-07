const test = require('node:test');
const assert = require('node:assert/strict');
const budget = require('../api/_lib/ac-budget');

class MemoryRedis {
  constructor() { this.values = new Map(); this.zsets = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value, options = {}) { if (options.nx && this.values.has(key)) return null; this.values.set(key, value); return 'OK'; }
  async incrby(key, amount) { const next = (Number(this.values.get(key)) || 0) + Number(amount); this.values.set(key, String(next)); return next; }
  async zadd(key, entry) { const values = this.zsets.get(key) || []; values.push(entry); this.zsets.set(key, values); return 1; }
}

test('AC daily budget defaults to 1000 and never accepts a larger configured cap', () => {
  assert.equal(budget.dailyPointsLimit({}), 1000);
  assert.equal(budget.dailyPointsLimit({ AC_DAILY_POINTS_LIMIT: '250' }), 250);
  assert.equal(budget.dailyPointsLimit({ AC_DAILY_POINTS_LIMIT: '5000' }), 1000);
});

test('AC budget reserves one estimated point and blocks the next request at the configured cap', async () => {
  const redis = new MemoryRedis();
  const environment = { AC_DAILY_POINTS_LIMIT: '2', AC_VIDEO_COST_POINTS: '1' };
  const first = await budget.reserve(redis, 'video_create', { environment });
  const second = await budget.reserve(redis, 'video_create', { environment });
  const third = await budget.reserve(redis, 'video_create', { environment });
  assert.equal(first.granted, true);
  assert.equal(second.granted, true);
  assert.equal(third.granted, false);
  assert.equal(third.used, 2);
  assert.equal(third.remaining, 0);
  assert.equal(await redis.get('nf_social:ac_points:' + budget.shanghaiDay()), '2');
});

test('preflight release returns an unused reservation without releasing ambiguous submissions', async () => {
  const redis = new MemoryRedis();
  const reservation = await budget.reserve(redis, 'video_create', { environment: { AC_DAILY_POINTS_LIMIT: '2' } });
  await budget.release(redis, reservation, 'video_daily_limit');
  assert.equal((await budget.status(redis, new Date(), { AC_DAILY_POINTS_LIMIT: '2' })).used, 0);
  const retry = await budget.reserve(redis, 'video_retry', { environment: { AC_DAILY_POINTS_LIMIT: '2' } });
  await budget.outcome(redis, retry, { status: 'submitted_or_unknown' });
  assert.equal((await budget.status(redis, new Date(), { AC_DAILY_POINTS_LIMIT: '2' })).used, 1);
});

test('reconciliation reads are explicitly non-billable and do not require storage', async () => {
  assert.equal(budget.operationCost('ac_read', {}), 0);
  assert.equal(budget.operationCost('ac_result', {}), 0);
  assert.equal(budget.operationCost('socialecho_upload', {}), 0);
  const reservation = await budget.reserve(null, 'ac_result');
  assert.equal(reservation.granted, true);
  assert.equal(reservation.billable, false);
  assert.equal(reservation.cost, 0);
  assert.equal(budget.isBillableOperation('video_create'), true);
  assert.equal(budget.isBillableOperation('ac_read'), false);
});

test('concurrent paid reservations never authorize more than the daily cap', async () => {
  const redis = new MemoryRedis();
  const environment = { AC_DAILY_POINTS_LIMIT: '25', AC_VIDEO_COST_POINTS: '1' };
  const results = await Promise.all(Array.from({ length: 100 }, () => budget.reserve(redis, 'video_create', { environment })));
  assert.equal(results.filter((item) => item.granted).length, 25);
  assert.equal(results.filter((item) => !item.granted).length, 75);
  assert.equal((await budget.status(redis, new Date(), environment)).used, 25);
});

test('reservation settlement is idempotent and keeps the original accounting day', async () => {
  const redis = new MemoryRedis();
  const at = new Date('2026-09-04T15:59:30.000Z'); // 23:59:30 Asia/Shanghai
  const reservation = await budget.reserve(redis, 'video_create', {
    at,
    environment: { AC_DAILY_POINTS_LIMIT: '2' }
  });
  assert.equal(reservation.day, '20260904');
  assert.equal(await budget.release(redis, reservation, 'preflight'), true);
  assert.equal(await budget.release(redis, reservation, 'duplicate'), false);
  assert.equal((await budget.status(redis, at, { AC_DAILY_POINTS_LIMIT: '2' })).used, 0);
  const next = new Date('2026-09-04T16:01:00.000Z'); // 00:01:00 Asia/Shanghai
  assert.equal((await budget.status(redis, next, { AC_DAILY_POINTS_LIMIT: '2' })).used, 0);
  const retry = await budget.reserve(redis, 'video_retry', { at: next, environment: { AC_DAILY_POINTS_LIMIT: '2' } });
  assert.equal(await budget.outcome(redis, retry, { status: 'submitted_or_unknown' }), true);
  assert.equal(await budget.outcome(redis, retry, { status: 'duplicate' }), false);
  assert.equal((await budget.status(redis, next, { AC_DAILY_POINTS_LIMIT: '2' })).used, 1);
});

test('AC result reads and SocialEcho media/draft operations are non-billable while article reads remain guarded', async () => {
  const redis = new MemoryRedis();
  const environment = { AC_DAILY_POINTS_LIMIT: '2' };
  const acRead = await budget.reserve(redis, 'ac_read', { environment });
  const socialRead = await budget.reserve(redis, 'socialecho_read', { environment });
  assert.equal(acRead.granted, true);
  assert.equal(acRead.billable, false);
  assert.equal(acRead.cost, 0);
  assert.equal(socialRead.granted, true);
  assert.equal(socialRead.billable, true);
  assert.equal(socialRead.cost, 1);
  assert.equal((await budget.status(redis, new Date(), environment)).used, 1);
  const paid = await budget.reserve(redis, 'video_create', { environment });
  assert.equal(paid.granted, true);
  assert.equal((await budget.status(redis, new Date(), environment)).used, 2);
});

test('paid reservation release is idempotent', async () => {
  const redis = new MemoryRedis();
  const reservation = await budget.reserve(redis, 'video_create', { environment: { AC_DAILY_POINTS_LIMIT: '2' } });
  assert.equal(await budget.release(redis, reservation, 'test'), true);
  assert.equal(await budget.release(redis, reservation, 'duplicate'), false);
  assert.equal((await budget.status(redis, new Date(), { AC_DAILY_POINTS_LIMIT: '2' })).used, 0);
});

test('only a complete server-issued reservation can be reused by a paid submitter', async () => {
  const redis = new MemoryRedis();
  const reservation = await budget.reserve(redis, 'video_create', { environment: { AC_DAILY_POINTS_LIMIT: '2' } });
  assert.equal(budget.isValidReservation(reservation), true);
  assert.equal(budget.isValidReservation({ granted: true }), false);
  assert.equal(budget.isValidReservation({ ...reservation, cost: 0 }), false);
  assert.equal(budget.isValidReservation({ ...reservation, settlementKey: 'nf_social:ac_points_settlement:forged' }), false);
  assert.equal(budget.isValidReservation({ ...reservation, key: 'nf_social:ac_points:20990101' }), false);
});
