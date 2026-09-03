const { Redis } = require('@upstash/redis');
const { createPasswordHash } = require('../api/_lib/password');

const username = 'zinnyidk8';
const password = process.env.ZINNY_TEMP_PASSWORD;
if (!password || password.length < 20) throw new Error('ZINNY_TEMP_PASSWORD is required');
if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) throw new Error('Dashboard Redis is not configured');

(async () => {
  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const hash = await createPasswordHash(password);
  const principal = `local:${username}`;
  await redis.set(`nf_identity_owner:${username}`, principal, { nx: true });
  await redis.set(`nf_user_pass_owner:${username}`, principal, { nx: true });
  await redis.set(`nf_user_pass:${username}`, hash);
  const [owner, passOwner, savedHash] = await redis.mget(
    `nf_identity_owner:${username}`,
    `nf_user_pass_owner:${username}`,
    `nf_user_pass:${username}`,
  );
  if (owner !== principal || passOwner !== principal || String(savedHash || '').length < 100) {
    throw new Error('Dashboard account repair verification failed');
  }
  process.stdout.write(JSON.stringify({ username, identityOwner: owner, passwordOwner: passOwner, hashLength: String(savedHash).length }));
})();

