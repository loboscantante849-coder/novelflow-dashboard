const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ad-campaign-ui.css'), 'utf8');

test('advertising workspace is a first-class console view', () => {
  assert.match(html, /data-view="ads"/);
  assert.match(html, /id="adCampaignWorkspace"/);
  assert.match(html, /id="adCampaignSelect"/);
  assert.match(html, /id="deckAdCampaign"/);
  assert.match(html, /ad-campaign-ui\.css/);
});

test('campaign UI groups variants by book and exposes complete copy without a video player', () => {
  assert.match(app, /reduce\(\(map, item\)/);
  assert.match(app, /查看完整正文/);
  assert.match(app, /draft\?\.caption/);
  assert.match(app, /data-ad-query/);
  assert.doesNotMatch(app.slice(app.indexOf('function renderAdCampaignWorkspace'), app.indexOf('async function loadAdCampaign')), /<video/);
});

test('campaign UI loads indexed campaigns and has stable mobile layout', () => {
  assert.match(app, /ad-video-campaign\?action=list/);
  assert.match(app, /campaignId=\$\{encodeURIComponent/);
  assert.match(css, /grid-template-columns:repeat\(5,1fr\)/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /ad-variant-row/);
});
