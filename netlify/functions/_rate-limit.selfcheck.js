// Run: node netlify/functions/_rate-limit.selfcheck.js
// Mocks @netlify/blobs the same way _account-store.selfcheck.js does.
const assert = require('assert');

const blobsPath = require.resolve('@netlify/blobs');
const mem = new Map();
function makeFakeStore(){
  return {
    async get(key){ return mem.has(key) ? mem.get(key) : null; },
    async setJSON(key, value){ mem.set(key, value); },
    async delete(key){ mem.delete(key); },
    async list(){ return { blobs: [] }; }
  };
}
require.cache[blobsPath] = {
  id: blobsPath, filename: blobsPath, loaded: true,
  exports: { getStore: () => makeFakeStore() }
};

const { checkRateLimit, clientIp, LIMIT, WINDOW_MS } = require('./_rate-limit');

async function run(){
  const ipA = { headers: { 'x-nf-client-connection-ip': '1.1.1.1' } };

  // 1. Exactly LIMIT requests from the same IP are all allowed.
  let lastResult;
  for(let i = 0; i < LIMIT; i++){ lastResult = await checkRateLimit(ipA); }
  assert.strictEqual(lastResult.allowed, true, 'the LIMIT-th request should still be allowed');

  // 2. The (LIMIT+1)-th request from that same IP is blocked.
  const blocked = await checkRateLimit(ipA);
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.remaining, 0);

  // 3. A different IP has its own independent bucket.
  const ipB = { headers: { 'x-nf-client-connection-ip': '2.2.2.2' } };
  const rB = await checkRateLimit(ipB);
  assert.strictEqual(rB.allowed, true);

  // 4. x-forwarded-for fallback works when the Netlify-specific header is absent.
  const ipC = { headers: { 'x-forwarded-for': '3.3.3.3, 9.9.9.9' } };
  const rC = await checkRateLimit(ipC);
  assert.strictEqual(rC.allowed, true);
  assert.strictEqual(clientIp(ipC), '3.3.3.3');

  // 5. An expired window resets the counter, even for a previously-blocked IP.
  const key = 'ip:' + clientIp(ipA);
  const store = makeFakeStoreRef();
  const record = await store.get(key);
  await store.setJSON(key, { count: record.count, windowStart: record.windowStart - (WINDOW_MS + 1000) });
  const afterExpiry = await checkRateLimit(ipA);
  assert.strictEqual(afterExpiry.allowed, true, 'window should have reset');

  console.log('All _rate-limit self-checks passed.');
}

function makeFakeStoreRef(){
  // Same mem map the mocked getStore() above uses -- reuse it directly for setup in step 5.
  return {
    async get(key){ return mem.has(key) ? mem.get(key) : null; },
    async setJSON(key, value){ mem.set(key, value); }
  };
}

run().catch(e => { console.error(e); process.exit(1); });
