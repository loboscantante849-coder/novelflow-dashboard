/**
 * Runtime feature switches.
 *
 * The switch lives in Redis so an operator can pause or resume a feature
 * without shipping code. `VIDEO_GENERATION_ENABLED=false` in the environment
 * is a hard override for the case where Redis itself is the problem.
 */
const VIDEO_GENERATION_KEY = 'nf_feature:video_generation';

const DISABLED_VALUES = new Set(['off', 'false', '0', 'no', 'paused', 'disabled']);

function envVideoGeneration() {
  const raw = String(process.env.VIDEO_GENERATION_ENABLED ?? '').trim().toLowerCase();
  if (!raw) return null;
  return !DISABLED_VALUES.has(raw);
}

/**
 * Video generation is ON unless it was explicitly paused. A Redis read failure
 * keeps the previous default instead of silently blocking the feature.
 */
async function isVideoGenerationEnabled(redis) {
  const env = envVideoGeneration();
  if (env === false) return false;
  let raw = null;
  try {
    raw = redis && typeof redis.get === 'function' ? await redis.get(VIDEO_GENERATION_KEY) : null;
  } catch (_error) {
    return env === null ? true : env;
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return env === null ? true : env;
  }
  return !DISABLED_VALUES.has(String(raw).trim().toLowerCase());
}

function parseFeatureFlagValue(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null; // not set
  return !DISABLED_VALUES.has(raw);
}

module.exports = {
  VIDEO_GENERATION_KEY,
  isVideoGenerationEnabled,
  parseFeatureFlagValue,
};
