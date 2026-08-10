// Run: node netlify/selfchecks/_account-store.selfcheck.js
// Mocks @supabase/supabase-js's createClient() with an in-memory Map so this verifies
// _account-store.js's logic (email normalization, profile parsing, list shape) without
// needing a real Supabase project/token.
const assert = require('assert');

const supabasePath = require.resolve('@supabase/supabase-js');
const mem = new Map();
function makeFakeClient(){
  return {
    from(table){
      assert.strictEqual(table, 'accounts');
      return {
        async upsert(row){ mem.set(row.email, row); return { error: null }; },
        select(){
          // Also thenable (like the real supabase-js query builder) so callers that
          // await select(...) directly, with no .eq()/.order() chained, still work
          // (listBrainstormScores reads every row this way).
          return {
            eq(_col, email){
              return { async maybeSingle(){
                const row = mem.get(email);
                return { data: row ? { data: row.data, last_synced_at: row.last_synced_at } : null, error: null };
              } };
            },
            order(){
              const rows = [...mem.values()].sort((a, b) => (b.last_synced_at || '').localeCompare(a.last_synced_at || ''));
              return Promise.resolve({ data: rows, error: null });
            },
            then(resolve){ resolve({ data: [...mem.values()], error: null }); }
          };
        },
        delete(){
          return { eq(_col, email){ mem.delete(email); return Promise.resolve({ error: null }); } };
        }
      };
    }
  };
}
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: { createClient: () => makeFakeClient() }
};
process.env.SUPABASE_URL = 'http://fake.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key';

const { getAccount, setAccount, deleteAccount, listAccounts, listBrainstormScores } = require('../functions/_account-store');

async function run(){
  // 1. New account: getAccount returns null before any write.
  assert.strictEqual(await getAccount('a@x.com'), null);

  // 2. setAccount then getAccount round-trips the data, email lowercased.
  await setAccount('A@X.com', { 'forge-profile': JSON.stringify({ firstName: 'Ada', lastName: 'X', course: 'CS', semester: '3', batch: 'D' }) });
  const rec = await getAccount('a@x.com');
  assert.ok(rec, 'record should exist after setAccount');
  assert.ok(rec.lastSyncedAt, 'lastSyncedAt should be set');
  assert.strictEqual(JSON.parse(rec.data['forge-profile']).firstName, 'Ada');

  // 3. listAccounts summarizes the profile fields, doesn't dump raw data.
  await setAccount('b@x.com', { 'forge-profile': JSON.stringify({ firstName: 'Bo', lastName: 'Y', course: 'DSA', semester: '5', batch: 'A' }) });
  const list = await listAccounts();
  assert.strictEqual(list.length, 2);
  const a = list.find(x => x.email === 'a@x.com');
  assert.strictEqual(a.firstName, 'Ada');
  assert.strictEqual(a.course, 'CS');
  assert.strictEqual(typeof a.data, 'undefined', 'list must not include the raw data blob');

  // 4. deleteAccount removes it — getAccount and listAccounts both reflect that.
  await deleteAccount('a@x.com');
  assert.strictEqual(await getAccount('a@x.com'), null);
  const afterDelete = await listAccounts();
  assert.strictEqual(afterDelete.length, 1);
  assert.strictEqual(afterDelete[0].email, 'b@x.com');

  // 5. listBrainstormScores: only positive scores, sorted desc, isYou flags the caller,
  //    and it never leaks another account's email.
  await setAccount('c@x.com', { 'forge-profile': JSON.stringify({ firstName: 'Cy', lastName: 'Z' }), 'forge-brainstorm-best': '40' });
  await setAccount('b@x.com', { 'forge-profile': JSON.stringify({ firstName: 'Bo', lastName: 'Y' }), 'forge-brainstorm-best': '0' });
  const scores = await listBrainstormScores('c@x.com');
  assert.strictEqual(scores.length, 1, 'zero-score accounts should be excluded');
  assert.strictEqual(scores[0].firstName, 'Cy');
  assert.strictEqual(scores[0].isYou, true);
  assert.strictEqual(typeof scores[0].email, 'undefined', 'must never return another account\'s email');

  console.log('All _account-store self-checks passed.');
}

run().catch(e => { console.error(e); process.exit(1); });
