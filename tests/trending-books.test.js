const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'trending-books.js'), 'utf8');

test('Top Promotions resolve measured campaign rankings against the authorised catalogue', () => {
  assert.match(source, /rankBooks\(promotionPerformance, 7\)/);
  assert.match(source, /applicationId=\$\{BOOKSTORE_APP_ID\}/);
  assert.match(source, /cleanTitle\(book\.title\)\.toLowerCase\(\) === expected/);
  assert.match(source, /promotionVisits7d: Number\(promotion\?\.pullUv\) \|\| 0/);
  assert.match(source, /metric: 'campaign_visits_7d'/);
  assert.doesNotMatch(source, /orderBy=uv/);
  assert.doesNotMatch(source, /novelspa-uv/);
});
