const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWeeklyReport } = require('../api/_lib/report');

function run(overrides = {}) {
  return {
    id: 'run-1',
    createdAt: '2026-07-20T01:00:00.000Z',
    updatedAt: '2026-07-21T01:00:00.000Z',
    state: 'completed',
    input: { title: 'Verified Romance' },
    stages: {},
    artifacts: {
      code: '50001', shortUrl: 'https://social.example/s/50001',
      posts: [{ type: 'hook' }, { type: 'dialogue' }],
      images: [{ url: 'https://cdn.example/poster.jpg' }],
      video: { videoUrls: ['https://cdn.example/video.mp4'] },
      analytics: { summary: { rowCount: 1, pullUv: 200, activeUv: 80, newUv: 50, d7Income: 18, sampleState: 'reliable' } },
      ...overrides.artifacts
    },
    ...overrides
  };
}

test('weekly report aggregates only real saved assets, tracking, and attribution', () => {
  const report = buildWeeklyReport([run()], { limit: 5, used: 1, remaining: 4 }, 7, new Date('2026-07-22T00:00:00.000Z'));
  assert.equal(report.operations.total, 1);
  assert.equal(report.assets.copy, 2);
  assert.equal(report.assets.posters, 1);
  assert.equal(report.assets.videos, 1);
  assert.equal(report.tracking.verified, 1);
  assert.equal(report.analytics.pullUv, 200);
  assert.equal(report.analytics.activationRate, 40);
  assert.match(report.reportText, /真实归因/);
});

test('weekly report exposes ambiguous paid submissions as decisions without suggesting retries', () => {
  const ambiguous = run({ id: 'run-ambiguous', state: 'running', stages: { P4: { status: 'ambiguous' } } });
  const report = buildWeeklyReport([ambiguous], { limit: 5, used: 0, remaining: 5 }, 7, new Date('2026-07-22T00:00:00.000Z'));
  assert.equal(report.risks.length, 1);
  assert.match(report.risks[0].reason, /未自动重试/);
  assert.match(report.reportText, /需要决策/);
});
