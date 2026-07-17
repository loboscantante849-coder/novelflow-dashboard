(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DailyBookPerformance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function roundMoney(value) {
    return Math.round((number(value) + Number.EPSILON) * 100) / 100;
  }

  function normalizedTitle(value) {
    return String(value || 'Unknown')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function bookKey(link) {
    const bookId = String((link && link.bookId) || '').trim();
    if (bookId) return `id:${bookId}`;
    return `title:${normalizedTitle(link && link.bookName)}`;
  }

  function titleBookIds(links) {
    const titles = new Map();
    for (const link of Array.isArray(links) ? links : []) {
      const bookId = String((link && link.bookId) || '').trim();
      if (!bookId) continue;
      const title = normalizedTitle(link && link.bookName);
      if (!titles.has(title)) titles.set(title, new Set());
      titles.get(title).add(bookId);
    }
    return titles;
  }

  function resolvedBookKey(link, titles) {
    const direct = bookKey(link);
    if (direct.startsWith('id:')) return direct;
    const ids = titles.get(normalizedTitle(link && link.bookName));
    if (ids && ids.size === 1) return `id:${Array.from(ids)[0]}`;
    return direct;
  }

  function availableDates(links) {
    const dates = new Set();
    for (const link of Array.isArray(links) ? links : []) {
      const daily = link && link.daily;
      if (!daily || typeof daily !== 'object' || Array.isArray(daily)) continue;
      for (const date of Object.keys(daily)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
      }
    }
    return Array.from(dates).sort();
  }

  function countBooks(links) {
    const safeLinks = Array.isArray(links) ? links : [];
    const titles = titleBookIds(safeLinks);
    return new Set(safeLinks.map(link => resolvedBookKey(link, titles))).size;
  }

  function aggregateForDate(links, date) {
    const safeLinks = Array.isArray(links) ? links : [];
    const titles = titleBookIds(safeLinks);
    const groups = new Map();
    for (const link of safeLinks) {
      if (!link || typeof link !== 'object') continue;
      const key = resolvedBookKey(link, titles);
      let row = groups.get(key);
      if (!row) {
        const inferredBookId = key.startsWith('id:') ? key.slice(3) : null;
        row = {
          key,
          bookId: link.bookId || inferredBookId,
          bookName: String(link.bookName || 'Unknown').trim() || 'Unknown',
          assets: 0,
          visits: 0,
          unique_users: 0,
          new_users: 0,
          income: 0,
        };
        groups.set(key, row);
      }

      row.assets += 1;
      const day = link.daily && typeof link.daily === 'object' ? link.daily[date] : null;
      if (!day || typeof day !== 'object') continue;
      row.visits += number(day.visits);
      row.unique_users += number(day.unique_users);
      row.new_users += number(day.new_users);
      row.income += number(day.income);
    }

    return Array.from(groups.values()).map(row => ({
      ...row,
      income: roundMoney(row.income),
    }));
  }

  function sortRows(rows, metric) {
    const allowed = new Set(['visits', 'new_users', 'income']);
    const field = allowed.has(metric) ? metric : 'visits';
    return (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
      const difference = number(b && b[field]) - number(a && a[field]);
      if (difference !== 0) return difference;
      return String((a && a.bookName) || '').localeCompare(String((b && b.bookName) || ''));
    });
  }

  function totals(rows) {
    const total = (Array.isArray(rows) ? rows : []).reduce((sum, row) => ({
      visits: sum.visits + number(row && row.visits),
      unique_users: sum.unique_users + number(row && row.unique_users),
      new_users: sum.new_users + number(row && row.new_users),
      income: sum.income + number(row && row.income),
    }), { visits: 0, unique_users: 0, new_users: 0, income: 0 });
    total.income = roundMoney(total.income);
    return total;
  }

  return {
    aggregateForDate,
    availableDates,
    bookKey,
    countBooks,
    sortRows,
    totals,
  };
});
