// Run: node netlify/functions/_rate-limit.selfcheck.js
// Mocks @upstash/redis the same way _account-store.selfcheck.js does.
const assert = require('assert');

const redisPath = require.resolve('@upstash/redis');
const mem = new Map();
function makeFakeRedis(){
  return {
    async get(key){ return mem.has(key) ? mem.get(key) : null; },
    async set(key, value){ mem.set(key, value); },
    async del(key){ mem.delete(key); }
  };
}
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true,
  exports: { Redis: { fromEnv: () => makeFakeRedis() } }
};

const { checkRateLimit, clientIp, LIMIT, WINDOW_MS } = require('./_rate-limit');

async function run(){
  const ipA = { headers: { 'x-forwarded-for': '1.1.1.1' } };

  // 1. Exactly LIMIT requests from the same IP are all allowed.
  let lastResult;
  for(let i = 0; i < LIMIT; i++){ lastResult = await checkRateLimit(ipA); }
  assert.strictEqual(lastResult.allowed, true, 'the LIMIT-th request should still be allowed');

  // 2. The (LIMIT+1)-th request from that same IP is blocked.
  const blocked = await checkRateLimit(ipA);
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.remaining, 0);

  // 3. A different IP has its own independent bucket.
  const ipB = { headers: { 'x-forwarded-for': '2.2.2.2' } };
  const rB = await checkRateLimit(ipB);
  assert.strictEqual(rB.allowed, true);

  // 4. Comma-separated x-forwarded-for takes the first address.
  const ipC = { headers: { 'x-forwarded-for': '3.3.3.3, 9.9.9.9' } };
  assert.strictEqual(clientIp(ipC), '3.3.3.3');

  // 5. An expired window resets the counter, even for a previously-blocked IP.
  const key = 'ip:' + clientIp(ipA);
  const record = await mem.get(key);
  mem.set(key, { count: record.count, windowStart: record.windowStart - (WINDOW_MS + 1000) });
  const afterExpiry = await checkRateLimit(ipA);
  assert.strictEqual(afterExpiry.allowed, true, 'window should have reset');

  // 6. If the store itself is unreachable, checkRateLimit fails OPEN rather than throwing.
  require.cache[redisPath].exports.Redis.fromEnv = () => ({
    async get(){ throw new Error('simulated Upstash connection error'); },
    async set(){ throw new Error('should not be reachable'); }
  });
  delete require.cache[require.resolve('./_rate-limit')];
  const { checkRateLimit: checkRateLimitBroken } = require('./_rate-limit');
  const failOpen = await checkRateLimitBroken({ headers: { 'x-forwarded-for': '4.4.4.4' } });
  assert.strictEqual(failOpen.allowed, true, 'must fail open when the store is unreachable');

  console.log('All _rate-limit self-checks passed.');
}

run().catch(e => { console.error(e); process.exit(1); });
