const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('profile exposes cumulative earnings, withdrawable funds, withdrawals, reader users, and separate website/app registrations', () => {
  for (const id of ['totalIncome', 'availableIncome', 'withdrawnIncome', 'readerNewUsers', 'siteInviteTotal', 'appInviteTotal']) {
    assert.match(source, new RegExp(`id=["']${id}["']`));
  }
  assert.match(source, /wallet\.total_earned/);
  assert.match(source, /available_balance/);
  assert.match(source, /withdrawn_total/);
  assert.match(source, /stats\.total_new/);
  assert.match(source, /\/api\/member-insights/);
  assert.match(source, /authFetchWithTransientRetry\('\/api\/withdrawals/);
  assert.match(source, /data\.referrals\.website_registrations/);
  assert.match(source, /data\.referrals\.app_registrations/);
  assert.doesNotMatch(source, /id="bonusProfileCard"|id="profileBonusValue"/);
});

test('money and performance requests retry transient API failures before showing unavailable state', () => {
  assert.match(source, /async function authFetchWithTransientRetry/);
  assert.match(source, /new Set\(\[429, 502, 503, 504\]\)/);
  assert.match(source, /authFetchWithTransientRetry\(`\/api\/my-stats/);
  assert.match(source, /authFetchWithTransientRetry\('\/api\/per-link-stats'/);
});

test('recommender badges are server-derived and open an account-scoped detail view', () => {
  assert.match(source, /id="recommenderBadge"[^>]+data-nf-action="open-referral-details"/);
  assert.match(source, /tier === 'premium'/);
  assert.match(source, /data\.referrals/);
  assert.match(source, /member\.commission_accrued/);
  assert.match(source, /copyMemberReferralLink/);
  assert.match(source, /recommender\.referral_url/);
  assert.match(source, /referrals\.reader_new_users/);
  assert.match(source, /member-detail-hero/);
  assert.doesNotMatch(source, /fetch\([^)]*member-insights[^)]*username=/);
});

test('profile metrics use a readable funds and growth grid instead of five compressed columns', () => {
  assert.match(source, /grid-template-columns: repeat\(6, minmax\(0,1fr\)\)/);
  assert.match(source, /stats-overview-card:nth-child\(-n\+3\) \{ grid-column: span 2; \}/);
  assert.match(source, /stats-overview-card:nth-child\(n\+4\) \{ grid-column: span 3;/);
  assert.match(source, /text-overflow: ellipsis/);
});

test('activity 2 is an accessible full-card action', () => {
  assert.match(source, /campaign_activity_phase: 'Activity 2 · Phase 2'/);
  assert.match(source, /campaign-card[^']*'[^\n]+data-nf-action="open-activity" role="button" tabindex="0"/);
  assert.match(source, /campaign-poster[^>]+src="\/novelflow-promo-poster\.png"/);
  assert.match(source, /event\.key !== 'Enter' && event\.key !== ' '/);
});

test('book list can be filtered without losing the current sort', () => {
  assert.match(source, /id="myBooksSearch"/);
  assert.match(source, /function filterMyBooks\(value\)/);
  assert.match(source, /book\.title, book\.bookName, book\.code, book\.link, book\.linkId, book\.bookId/);
  assert.match(source, /my_books_search_empty/);
});

test('rewards retry a transient user-data lock instead of failing a check-in immediately', () => {
  assert.match(source, /const busyRetryDelays = \[300, 600, 1200, 2500, 5000, 8000\]/);
  assert.match(source, /data\.code === 'USER_DATA_BUSY' && attempt < busyRetryDelays\.length/);
});

test('performance errors keep the dashboard surface visible', () => {
  assert.match(source, /failure must not make the entire performance surface disappear/);
  assert.match(source, /if \(!_lastPerfData && perfData\)[\s\S]*dailySection\.style\.display = 'none'/);
  assert.doesNotMatch(source, /if \(!_lastPerfData && perfData\) \{\s*perfData\.querySelectorAll/);
});

test('new member-facing labels include English and Spanish translations', () => {
  for (const key of [
    'profile_promotion_earnings', 'profile_available_withdraw', 'profile_withdrawn',
    'profile_reader_new_users', 'profile_platform_registrations', 'profile_app_registrations', 'recommender_standard', 'recommender_premium', 'recommender_identity_eyebrow',
    'referral_details_title', 'referral_details_kicker', 'referral_details_premium_copy', 'referral_details_standard_copy',
    'referral_link_label', 'referral_copy_link', 'referral_link_copied', 'referral_network_members', 'referral_network_reader_users',
    'referral_network_promotion', 'referral_network_slot', 'referral_network_rate', 'referral_network_commission', 'referral_network_list', 'referral_network_list_hint',
    'referral_network_list_progress', 'referral_network_scope_limited',
  ]) {
    assert.equal((source.match(new RegExp(`${key}:`, 'g')) || []).length, 2, `${key} should exist in EN and ES`);
  }
});
