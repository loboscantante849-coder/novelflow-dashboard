const test = require('node:test');
const assert = require('node:assert/strict');
const videoRevision = require('../api/video-revision');
const { completeRevision } = videoRevision;
const referenceVideo = require('../api/reference-video');

function response() {
  const state = { statusCode: 200, body: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; return this; }
  };
}

test('open-access rejects a paid video revision without the operator token', { concurrency: false }, async (t) => {
  const previousOpenAccess = process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
  const previousToken = process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN;
  process.env.SOCIAL_CONSOLE_OPEN_ACCESS = 'true';
  process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN = 'unit-test-operator-token-0123456789';
  t.after(() => {
    if (previousOpenAccess === undefined) delete process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
    else process.env.SOCIAL_CONSOLE_OPEN_ACCESS = previousOpenAccess;
    if (previousToken === undefined) delete process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN;
    else process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN = previousToken;
  });

  const res = response();
  await videoRevision({ method: 'POST', headers: {}, body: { runId: 'run_not_reached' } }, res);
  assert.equal(res.state.statusCode, 401);
  assert.match(res.state.body.error, /operator mutation/i);
});

test('open-access rejects a paid reference video without the operator token', { concurrency: false }, async (t) => {
  const previousOpenAccess = process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
  const previousToken = process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN;
  process.env.SOCIAL_CONSOLE_OPEN_ACCESS = 'true';
  process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN = 'unit-test-operator-token-0123456789';
  t.after(() => {
    if (previousOpenAccess === undefined) delete process.env.SOCIAL_CONSOLE_OPEN_ACCESS;
    else process.env.SOCIAL_CONSOLE_OPEN_ACCESS = previousOpenAccess;
    if (previousToken === undefined) delete process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN;
    else process.env.SOCIAL_CONSOLE_OPERATOR_TOKEN = previousToken;
  });

  const res = response();
  await referenceVideo({ method: 'POST', headers: {}, body: { runId: 'run_not_reached' } }, res);
  assert.equal(res.state.statusCode, 401);
  assert.match(res.state.body.error, /operator mutation/i);
});

test('a completed revision replaces failed P4 and resumes P6 packaging', () => {
  const run = {
    state: 'failed',
    stages: { P4: { status: 'failed', error: 'AC video ended with failed' }, P6: { status: 'waiting' } },
    events: []
  };
  const video = { status: 'running', threadId: 'revision-thread', videoUrls: ['https://cdn.example/revision.mp4'] };
  completeRevision(run, video, { contentType: 'video/mp4', contentLength: 1234 });
  assert.equal(video.status, 'completed');
  assert.equal(run.state, 'running');
  assert.equal(run.stages.P4.status, 'done');
  assert.equal(run.stages.P4.threadId, 'revision-thread');
  assert.equal(run.stages.P6.status, 'waiting');
  assert.match(run.events.map((event) => event.type).join(' '), /video_revision_ready/);
});
