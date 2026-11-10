// Test-only adapter: older endpoint fixtures described totals without asset
// rows. The runtime now requires a complete asset report as its sole source.
function incomeSnapshot(users, snapshot = {}) {
  const ad_ids = Object.fromEntries(Object.entries(snapshot.ad_ids || {}).map(([id, row]) => [id, {
    channel: 'link', stats: { dn_income: 0 }, daily: [], ...row,
  }]));
  const by_promoter = structuredClone(snapshot.by_promoter || {});
  for (const [owner, user] of Object.entries(users)) {
    const id = by_promoter[owner]?.links?.[0] || `fixture-${owner}`;
    by_promoter[owner] = { ...(by_promoter[owner] || {}), links: [...new Set([...(by_promoter[owner]?.links || []), id])] };
    ad_ids[id] = { username_canon: owner, channel: 'link',
      stats: { dn_income: user.subscription_revenue_dn, d14_income: user.subscription_revenue || 0 },
      daily: Object.entries(user.subscription_revenue_dn_daily || {}).map(([dt, dn_income]) => ({ dt, dn_income })) };
  }
  return { date_range: { from: '2026-02-01', to: '2026-11-08' }, ...snapshot, ad_ids, by_promoter };
}
module.exports = { incomeSnapshot };
