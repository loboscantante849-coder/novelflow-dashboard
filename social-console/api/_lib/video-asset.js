const crypto = require('crypto');

function httpsUrl(value) {
  const url = String(value || '').trim();
  return /^https:\/\//i.test(url) ? url : '';
}

function effectiveVideoForRun(run = {}) {
  const revision = run?.artifacts?.videoRevision;
  if (revision?.status === 'completed' && httpsUrl(revision?.videoUrls?.[0])) {
    return { kind: 'revision', asset: revision, url: httpsUrl(revision.videoUrls[0]) };
  }
  const original = run?.artifacts?.video;
  if (original && httpsUrl(original?.videoUrls?.[0])) {
    return { kind: 'original', asset: original, url: httpsUrl(original.videoUrls[0]) };
  }
  return { kind: '', asset: null, url: '' };
}

function videoAssetFingerprint(asset = {}) {
  const payload = JSON.stringify({
    threadId: String(asset.threadId || ''),
    url: httpsUrl(asset?.videoUrls?.[0]),
    payloadFingerprint: String(asset.payloadFingerprint || '')
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function approvedExecutionQaForRun(run = {}) {
  const effective = effectiveVideoForRun(run);
  const qa = effective.asset?.executionQa;
  const fingerprint = effective.asset ? videoAssetFingerprint(effective.asset) : '';
  return qa?.status === 'approved' && String(qa.assetFingerprint || '') === fingerprint
    ? { ...effective, qa, fingerprint }
    : null;
}

module.exports = { effectiveVideoForRun, videoAssetFingerprint, approvedExecutionQaForRun };
