const assert = require('node:assert/strict');
const test = require('node:test');

const { publicBook } = require('../api/social-performance-rankings');

test('public performance rankings omit exact commercial income fields', () => {
  const result = publicBook({
    title: 'Book', d14Income: 12.34, dnIncome: 15.67, incomePerUv: 0.42,
    pullUv: 10, newUv: 2, score: 50,
  });
  assert.deepEqual(result, { title: 'Book', pullUv: 10, newUv: 2, score: 50 });
  assert.equal('d14Income' in result, false);
  assert.equal('dnIncome' in result, false);
  assert.equal('incomePerUv' in result, false);
});
