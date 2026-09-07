const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ad-performance-ui.css'), 'utf8');

test('allowlisted ad performance is a separate operator view', () => {
  assert.match(html, /data-view="ad-performance"/);
  assert.match(html, /id="adPerformanceWorkspace"/);
  assert.match(html, /id="adPerformanceFrom"/);
  assert.match(html, /id="adPerformanceTo"/);
  assert.match(html, /id="adRegistryDialog"/);
  assert.match(html, /ad-performance-ui\.css/);
});

test('performance UI calls only the private aggregate endpoint and keeps sources separate', () => {
  const start = app.indexOf('function renderAdPerformance()');
  const end = app.indexOf('async function publishPublication', start);
  const source = app.slice(start, end);
  assert.match(source, /\/api\/ad-performance/);
  assert.match(source, /item\.meta/);
  assert.match(source, /item\.beidou/);
  assert.match(source, /socialSourceForAd\(item\)/);
  assert.doesNotMatch(source, /combinedTotal|meta.*\+.*beidou|beidou.*\+.*social/);
});

test('performance UI defaults the end date to the latest complete day', () => {
  const start = app.indexOf('function renderAdPerformance()');
  const end = app.indexOf('async function publishPublication', start);
  const source = app.slice(start, end);
  assert.match(source, /apiWindow\.to \|\| adPerformanceDate\(1\)/);
  assert.match(source, /const to = \$\('\#adPerformanceTo'\)\.value \|\| adPerformanceDate\(1\)/);
});

test('Meta IDs are not reused as NovelFlow tracking IDs', () => {
  const start = app.indexOf('function renderAdCampaignWorkspace()');
  const end = app.indexOf('async function loadAdCampaign', start);
  const source = app.slice(start, end);
  assert.match(source, /meta\.copywritingId \|\| item\.attribution\?\.linkId \|\| item\.attribution\?\.code/);
  assert.doesNotMatch(source, /meta\.copywritingId \|\| meta\.adId/);
});

test('six navigation destinations remain stable on mobile', () => {
  assert.match(css, /grid-template-columns:repeat\(6,1fr\)/);
  assert.match(css, /min-width:1260px/);
  assert.match(css, /@media\(max-width:460px\)/);
});
