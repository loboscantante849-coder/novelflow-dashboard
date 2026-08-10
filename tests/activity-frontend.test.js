const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

test('the activity UI uses exact campaign registrations and the generic invite link', () => {
  assert.match(source, /eligibility\.campaignInvites/);
  assert.match(source, /eligibility\.recommenderMeasuredNewUsers/);
  assert.match(source, /data\.invite \|\| \{\}/);
  assert.match(source, /invite\.referral_url/);
  assert.match(source, /fulfillment_events\.invite_vip/);
  assert.doesNotMatch(source, /const verified = .*historicalNewUsers/);
});

test('referral attribution is bounded, persisted briefly, and sent by every local signup form', () => {
  assert.match(source, /REFERRAL_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /\^\[A-Za-z0-9_-\]\{8,80\}\$/);
  assert.match(source, /url\.searchParams\.delete\('ref'\)/);
  assert.equal((source.match(/JSON\.stringify\(buildRegistrationPayload\(username, password\)\)/g) || []).length, 2);
  assert.equal((source.match(/clearStoredReferralCode\(\);/g) || []).length >= 2, true);
});

test('activity endpoints are deployed while fulfillment remains server-side', () => {
  assert.equal(vercel.functions['api/activity-rewards.js'].maxDuration, 30);
  assert.equal(vercel.functions['api/admin-balance-migration.js'].maxDuration, 30);
  assert.match(source, /Rewards are reviewed and fulfilled in batches/);
  assert.doesNotMatch(source, /activity[^\n]{0,120}bonus_balance\s*[+]=/i);
});
