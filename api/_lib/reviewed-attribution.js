'use strict';

// Server-reviewed ownership, not amounts. Reapply it to each new report so a
// legacy Redis mapping cannot erase verified assets on the next pipeline run.
// Never infer ownership from client CloudSync or from a similar-looking name.
const reviews = require('./reviewed-attribution.json');
const { roundMoney } = require('./commission-policy');
const normalized = value => String(value || '').trim().toLowerCase();

function applyReviewedAttribution(snapshot) {
  if (!snapshot?.ad_ids || !snapshot?.by_promoter) return snapshot;
  const adIds = { ...snapshot.ad_ids };
  const promoters = { ...snapshot.by_promoter };
  const issues = {};
  const history = {};
  for (const [owner, review] of Object.entries(reviews)) {
    const conflicts = [];
    for (const asset of review.assets) {
      for (const [id, channel] of [[asset.linkId, 'link'], [asset.code, 'code']]) {
        const row = adIds[id];
        if (!row) continue; // No activity in this report; never invent zero rows.
        const foreignIndex = Object.entries(snapshot.by_promoter).some(([key, p]) =>
          key !== owner && [...(p.links || []), ...(p.codes || [])].map(String).includes(id));
        if ((row.username_canon && normalized(row.username_canon) !== owner) ||
            (row.username && normalized(row.username) !== owner) || foreignIndex ||
            (row.book_id && row.book_id !== asset.bookId) ||
            (row.media_source && row.media_source !== channel) ||
            (row.channel && row.channel !== channel)) {
          conflicts.push(id);
          continue;
        }
        adIds[id] = { ...row, username: review.display_name, username_canon: owner,
          book_id: asset.bookId, book_name: asset.bookName };
      }
    }
    const owned = Object.entries(adIds).filter(([, row]) => row.username_canon === owner);
    const entry = { ...(promoters[owner] || {}), display_name: review.display_name,
      links: [], codes: [], invites: [], books: [], total_uv: 0, total_new: 0, total_dn: 0 };
    const books = new Map();
    for (const [id, row] of owned) {
      const channel = row.media_source || row.channel;
      const field = { link: 'links', code: 'codes', invite: 'invites' }[channel];
      if (!field) continue;
      entry[field].push(channel === 'invite' ? id.replace(/^invite:/, '') : id);
      const stats = row.stats || {};
      entry.total_uv += Number(stats.pull_uv) || 0;
      entry.total_new += Number(stats.new_uv) || 0;
      entry.total_dn += Number(stats.dn_income) || 0;
      const key = row.book_id || row.book_name || id;
      if (!books.has(key)) books.set(key, { name: row.book_name || 'Unknown', ad_ids: [], uv: 0, new: 0, dn: 0 });
      const book = books.get(key);
      book.ad_ids.push(id);
      book.uv += Number(stats.pull_uv) || 0;
      book.new += Number(stats.new_uv) || 0;
      book.dn += Number(stats.dn_income) || 0;
    }
    if (owned.length) {
      entry.total_dn = roundMoney(entry.total_dn);
      entry.books = [...books.values()].map(book => ({ ...book, dn: roundMoney(book.dn) }));
      entry.link_count = entry.links.length;
      entry.code_count = entry.codes.length;
      entry.invite_count = entry.invites.length;
      promoters[owner] = entry;
    }
    issues[owner] = conflicts;
    history[owner] = review.history_from;
  }
  const mapped = Object.values(adIds).filter(row => row.username_canon).length;
  return { ...snapshot, ad_ids: adIds, by_promoter: promoters,
    mapped_ad_ids: mapped, unmapped_ad_ids: Object.keys(adIds).length - mapped,
    reviewed_attribution_issues: issues, attribution_history_from: history };
}

module.exports = { applyReviewedAttribution };
