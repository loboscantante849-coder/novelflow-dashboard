const assert = require('node:assert/strict');
const test = require('node:test');

const snapshot = require('../ad_id_details.json');
const {
  normalizeShortLinkToken,
  verifiesLegacyPromoterProof,
} = require('../api/_lib/legacy-promoter-recovery');

test('legacy recovery accepts a trusted social short URL and its paired code', () => {
  assert.equal(normalizeShortLinkToken('https://social.novelplatform.vip/s/75RNsI'), '75RNsI');
  assert.equal(verifiesLegacyPromoterProof(snapshot, '英语', {
    promotion_code: '4722',
    promotion_link: 'https://social.novelplatform.vip/s/75RNsI',
  }), true);
  assert.equal(verifiesLegacyPromoterProof(snapshot, '英语', {
    promotion_code: '4725',
    promotion_link: 'https://social.novelplatform.vip/s/AuJ48G',
  }), true);
  // 4726 is present in trusted submissions but absent from the latest
  // ad_id_details promoter code list; the submission index fills that gap.
  assert.equal(verifiesLegacyPromoterProof(snapshot, '英语', {
    promotion_code: '4726',
    promotion_link: 'https://social.novelplatform.vip/s/IB8F3M',
  }), true);
});

test('legacy recovery still accepts a trusted internal linkId URL', () => {
  assert.equal(verifiesLegacyPromoterProof(snapshot, '英语', {
    promotion_code: '4722',
    promotion_link: '6a1456503f57d4f16214a64b',
  }), true);
  assert.equal(verifiesLegacyPromoterProof(snapshot, '英语', {
    promotion_code: '4725',
    promotion_link: '6a14fc949023af36257f672a',
  }), true);
  assert.equal(verifiesLegacyPromoterProof(snapshot, '英语', {
    promotion_code: '4726',
    promotion_link: '6a15044c914fbdd8ec890578',
  }), true);
  assert.equal(verifiesLegacyPromoterProof(snapshot, 'Ndidi2000', {
    promotion_code: '5563',
    promotion_link: 'https://novelflow.top/6a33c2b04d4d16951c166334',
  }), true);
});

test('legacy recovery rejects untrusted hosts and mismatched code/link pairs', () => {
  assert.equal(verifiesLegacyPromoterProof(snapshot, '英语', {
    promotion_code: '4722',
    promotion_link: 'https://evil.example/s/75RNsI',
  }), false);
  assert.equal(verifiesLegacyPromoterProof(snapshot, '英语', {
    promotion_code: '4722',
    promotion_link: 'https://social.novelplatform.vip/s/AuJ48G',
  }), false);
  assert.equal(verifiesLegacyPromoterProof(snapshot, '英语', {
    promotion_code: '4722',
    promotion_link: 'https://social.novelplatform.vip/s/75RNsI?ref=4722',
  }), false);
});
