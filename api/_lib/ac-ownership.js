'use strict';

/**
 * Historical AC tasks use nf_<username>_<numeric timestamp>. Parse the owner
 * from the complete format so users such as "ann" cannot match "ann_x".
 */
function isLegacyAcRemarkOwnedBy(remark, username) {
  const expectedOwner = String(username || '').toLowerCase();
  if (!expectedOwner) return false;

  const match = /^nf_(.+)_([0-9]+)$/.exec(String(remark || ''));
  return Boolean(match && match[1].toLowerCase() === expectedOwner);
}

module.exports = { isLegacyAcRemarkOwnedBy };
