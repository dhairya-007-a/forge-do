// Run: node netlify/functions/_account-store.selfcheck.js
// Mocks @upstash/redis's Redis.fromEnv() with an in-memory Map so this verifies
// _account-store.js's logic (key naming, list filtering/sorting, profile parsing)
// without needing a real Upstash database.
const assert = require('assert');

const redisPath = require.resolve('@upstash/redis');
const mem = new Map();
function makeFakeRedis(){
  return {
    async get(key){ return mem.has(key) ? mem.get(key) : null; },
    async set(key, value){ mem.set(key, value); },
    async del(key){ mem.delete(key); },
    async keys(pattern){
      const prefix = pattern.replace(/\*$/, '');
      return [...mem.keys()].filter(k => k.startsWith(prefix));
    }
  };
}
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true,
  exports: { Redis: { fromEnv: () => makeFakeRedis() } }
};

const { getAccount, setAccount, deleteAccount, listAccounts, keyFor } = require('./_account-store');

async function run(){
  // 1. keyFor lowercases and prefixes.
  assert.strictEqual(keyFor('Student@Example.com'), 'account:student@example.com');

  // 2. New account: getAccount returns null before any write.
  assert.strictEqual(await getAccount('a@x.com'), null);

  // 3. setAccount then getAccount round-trips the data.
  await setAccount('a@x.com', { 'forge-profile': JSON.stringify({ firstName: 'Ada', lastName: 'X', course: 'CS', semester: '3', batch: 'D' }) });
  const rec = await getAccount('a@x.com');
  assert.ok(rec, 'record should exist after setAccount');
  assert.ok(rec.lastSyncedAt, 'lastSyncedAt should be set');
  assert.strictEqual(JSON.parse(rec.data['forge-profile']).firstName, 'Ada');

  // 4. listAccounts summarizes the profile fields, doesn't dump raw data.
  await setAccount('b@x.com', { 'forge-profile': JSON.stringify({ firstName: 'Bo', lastName: 'Y', course: 'DSA', semester: '5', batch: 'A' }) });
  const list = await listAccounts();
  assert.strictEqual(list.length, 2);
  const a = list.find(x => x.email === 'a@x.com');
  assert.strictEqual(a.firstName, 'Ada');
  assert.strictEqual(a.course, 'CS');
  assert.strictEqual(typeof a.data, 'undefined', 'list must not include the raw data blob');

  // 5. deleteAccount removes it — getAccount and listAccounts both reflect that.
  await deleteAccount('a@x.com');
  assert.strictEqual(await getAccount('a@x.com'), null);
  const afterDelete = await listAccounts();
  assert.strictEqual(afterDelete.length, 1);
  assert.strictEqual(afterDelete[0].email, 'b@x.com');

  console.log('All _account-store self-checks passed.');
}

run().catch(e => { console.error(e); process.exit(1); });
