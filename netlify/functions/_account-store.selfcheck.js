// Run: node netlify/functions/_account-store.selfcheck.js
// Mocks @netlify/blobs's getStore() with an in-memory Map so this verifies
// _account-store.js's logic (key naming, list filtering/sorting, profile parsing)
// without needing a real Netlify site/token.
const assert = require('assert');
const path = require('path');

const blobsPath = require.resolve('@netlify/blobs');
const mem = new Map();
function makeFakeStore(){
  return {
    async get(key, opts){ return mem.has(key) ? mem.get(key) : null; },
    async setJSON(key, value){ mem.set(key, value); },
    async delete(key){ mem.delete(key); },
    async list({ prefix }){
      const keys = [...mem.keys()].filter(k => k.startsWith(prefix));
      return { blobs: keys.map(key => ({ key })) };
    }
  };
}
require.cache[blobsPath] = {
  id: blobsPath, filename: blobsPath, loaded: true,
  exports: { getStore: () => makeFakeStore() }
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
