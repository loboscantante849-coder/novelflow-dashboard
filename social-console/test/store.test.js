const test = require('node:test');
const assert = require('node:assert/strict');
const { newRun, runSummary } = require('../api/_lib/store');

test('dashboard run summaries retain operational state without transferring full planning and model payloads', () => {
  const run = newRun({
    title: 'Summary Romance',
    sku: 'summary-sku',
    creativeProfile: { modelChoice: 'hy3' },
    planning: {
      planId: 'plan_summary',
      preferredModel: 'deepseek',
      actualModel: 'hy3',
      fallbackUsed: true,
      strategy: { editorialThesis: 'x'.repeat(5000), evidence: Array.from({ length: 12 }, () => ({ quote: 'y'.repeat(500) })) }
    }
  });
  run.stages.P3 = { status: 'running', label: 'Creating source-grounded copy', error: 'z'.repeat(1000), providerPayload: { trace: 'q'.repeat(5000) } };
  run.artifacts.book = { title: run.input.title, bookSkuId: run.input.sku, cover: 'https://example.com/cover.jpg', description: 'd'.repeat(10000), tags: Array(30).fill('romance') };
  run.artifacts.usage = { creative: { model: 'hy3', totalTokens: 1234, responseId: 'r'.repeat(5000) } };
  run.artifacts.modelActivity = Array.from({ length: 8 }, () => ({ section: 'posts', model: 'hy3', requestedModel: 'deepseek', totalTokens: 1234, providerPayload: 'p'.repeat(5000) }));
  run.events = Array.from({ length: 8 }, (_, index) => ({ at: new Date().toISOString(), type: 'event', message: `event-${index}-${'m'.repeat(500)}` }));

  const summary = runSummary(run);
  const bytes = Buffer.byteLength(JSON.stringify(summary));

  assert.equal(summary.input.planning.strategy, undefined);
  assert.equal(summary.stages.P3.providerPayload, undefined);
  assert.equal(summary.stages.P3.error.length, 300);
  assert.equal(summary.artifacts.book.description, undefined);
  assert.deepEqual(summary.artifacts.usage.creative, { model: 'hy3', totalTokens: 1234 });
  assert.equal(summary.modelActivity.length, 4);
  assert.equal(summary.events.length, 1);
  assert.equal(summary._summaryVersion, 2);
  assert.ok(bytes < 7000, `summary should be compact, received ${bytes} bytes`);
});
