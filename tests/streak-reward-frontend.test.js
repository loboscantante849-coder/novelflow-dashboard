const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('7-day reward UI separates cash credit from explicit VIP confirmation', () => {
  assert.match(source, /RewardsAPI\.call\('claim_streak_grand'\)/);
  assert.match(source, /RewardsAPI\.call\('confirm_streak_vip'\)/);
  assert.match(source, /\+\$0\.50 bonus credited/);
  assert.match(source, /Confirm 2 VIP Days/);
  assert.match(source, /Bind your NovelFlow ID first to receive the 2 VIP days/);
  assert.doesNotMatch(source, /\+2 VIP days &nbsp; \+\$0\.50/);
});
