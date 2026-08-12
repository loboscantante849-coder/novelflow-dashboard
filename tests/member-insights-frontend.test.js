const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('profile exposes cumulative earnings, withdrawable funds, withdrawals, reader users, and platform registrations', () => {
  for (const id of ['totalIncome', 'availableIncome', 'withdrawnIncome', 'readerNewUsers', 'siteInviteTotal']) {
    assert.match(source, new RegExp(`id=["']${id}["']`));
  }
  assert.match(source, /wallet\.total_earned/);
  assert.match(source, /available_balance/);
  assert.match(source, /withdrawn_total/);
  assert.match(source, /stats\.total_new/);
  assert.match(source, /\/api\/member-insights/);
  assert.doesNotMatch(source, /id="bonusProfileCard"|id="profileBonusValue"/);
});

test('recommender badges are server-derived and open an account-scoped detail view', () => {
  assert.match(source, /id="recommenderBadge"[^>]+data-nf-action="open-referral-details"/);
  assert.match(source, /tier === 'premium'/);
  assert.match(source, /data\.referrals/);
  assert.match(source, /member\.commission_accrued/);
  assert.doesNotMatch(source, /fetch\([^)]*member-insights[^)]*username=/);
});

test('activity 2 is an accessible full-card action', () => {
  assert.match(source, /campaign_activity_phase: 'Activity 2 · Phase 2'/);
  assert.match(source, /campaign-card[^']*'[^\n]+data-nf-action="open-activity" role="button" tabindex="0"/);
  assert.match(source, /event\.key !== 'Enter' && event\.key !== ' '/);
});

test('performance errors keep the dashboard surface visible', () => {
  assert.match(source, /failure must not make the entire performance surface disappear/);
  assert.match(source, /if \(!_lastPerfData && perfData\)[\s\S]*dailySection\.style\.display = 'none'/);
  assert.doesNotMatch(source, /if \(!_lastPerfData && perfData\) \{\s*perfData\.querySelectorAll/);
});

test('new member-facing labels include English and Spanish translations', () => {
  for (const key of [
    'profile_promotion_earnings', 'profile_available_withdraw', 'profile_withdrawn',
    'profile_reader_new_users', 'profile_platform_registrations', 'recommender_standard', 'recommender_premium', 'referral_details_title',
  ]) {
    assert.equal((source.match(new RegExp(`${key}:`, 'g')) || []).length, 2, `${key} should exist in EN and ES`);
  }
});
