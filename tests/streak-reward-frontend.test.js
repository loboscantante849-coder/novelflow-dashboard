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

test('daily check-in copy discloses the separate 7-day bonus requirements', () => {
  assert.match(source, /50 pts automatically\. Claim \$0\.50 \+ 2 VIP after 1 link \+ 1 task\./);
  assert.match(source, /Complete 7 check-ins \+ 1 link \+ 1 task to unlock/);
});

test('streak claim relies on server eligibility instead of stale local link state', () => {
  assert.match(source, /if \(CheckinData\.streak >= 7\) \{\s*btn\.disabled = false;/);
  assert.match(source, /NO_LINK: 'reward_no_link'/);
  assert.match(source, /NO_MISSION: 'reward_no_mission'/);
});
