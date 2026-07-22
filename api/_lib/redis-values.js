function normalizeRedisKey(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object') return null;

  for (const field of ['key', 'member', 'value', 'id', 'code']) {
    const candidate = value[field];
    if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate);
  }
  return null;
}

function normalizeRedisKeys(values) {
  if (!Array.isArray(values)) return [];
  return values.map(normalizeRedisKey).filter(Boolean);
}

module.exports = { normalizeRedisKey, normalizeRedisKeys };
