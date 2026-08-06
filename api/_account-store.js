// Shared Upstash Redis wrapper for the "accounts" namespace. Filename starts with `_`
// so Vercel's file-based routing ignores it under api/ once this file moves there.
// Centralizes the account key naming (account:<lowercased email>) and the shape of
// what gets stored so the 4 thin handler functions (sync/restore/list/delete-account.js)
// don't each reimplement it.
const { Redis } = require('@upstash/redis');

function store(){
  return Redis.fromEnv();
}

function keyFor(email){
  return 'account:' + String(email).trim().toLowerCase();
}

async function getAccount(email){
  const record = await store().get(keyFor(email));
  return record || null;
}

async function setAccount(email, data){
  await store().set(keyFor(email), { data, lastSyncedAt: new Date().toISOString() });
}

async function deleteAccount(email){
  await store().del(keyFor(email));
}

async function listAccounts(){
  const s = store();
  const keys = await s.keys('account:*');
  const accounts = [];
  for(const key of keys){
    const record = await s.get(key);
    if(!record) continue;
    let profile = {};
    try{ profile = record.data && record.data['forge-profile'] ? JSON.parse(record.data['forge-profile']) : {}; }
    catch(e){ /* malformed profile — skip fields, still list the account */ }
    accounts.push({
      email: key.slice('account:'.length),
      firstName: profile.firstName || '',
      lastName: profile.lastName || '',
      course: profile.course || '',
      semester: profile.semester || '',
      batch: profile.batch || '',
      lastSyncedAt: record.lastSyncedAt || null
    });
  }
  accounts.sort((a, b) => (b.lastSyncedAt || '').localeCompare(a.lastSyncedAt || ''));
  return accounts;
}

module.exports = { getAccount, setAccount, deleteAccount, listAccounts, keyFor };
