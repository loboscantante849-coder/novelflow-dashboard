const ACTIVITY_VERSION = 'launch-2026-08-v1';
const ACTIVITY_START_AT = '2026-08-09T16:00:00.000Z';
const ACTIVITY_END_AT = '2026-08-17T15:59:59.999Z';

function isWithinActivity(value = Date.now()) {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(timestamp) &&
    timestamp >= Date.parse(ACTIVITY_START_AT) &&
    timestamp <= Date.parse(ACTIVITY_END_AT);
}

module.exports = {
  ACTIVITY_END_AT,
  ACTIVITY_START_AT,
  ACTIVITY_VERSION,
  isWithinActivity,
};
