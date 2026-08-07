// Shared Netlify Blobs wrapper for the "accounts" store. Filename starts with `_` so
// Netlify's function router ignores it (no exports.handler here). Centralizes the
// account key naming (account:<lowercased email>) and the shape of what gets stored
// so the 4 thin handler functions (sync/restore/list/delete-account.js) don't each
// reimplement it.
const { getStore } = require('@netlify/blobs');

function store(){
  return getStore('accounts');
}

function keyFor(email){
  return 'account:' + String(email).trim().toLowerCase();
}

async function getAccount(email){
  const record = await store().get(keyFor(email), { type: 'json' });
  return record || null;
}

async function setAccount(email, data){
  await store().setJSON(keyFor(email), { data, lastSyncedAt: new Date().toISOString() });
}

async function deleteAccount(email){
  await store().delete(keyFor(email));
}

async function listAccounts(){
  const { blobs } = await store().list({ prefix: 'account:' });
  const accounts = [];
  for(const b of blobs){
    const record = await store().get(b.key, { type: 'json' });
    if(!record) continue;
    let profile = {};
    try{ profile = record.data && record.data['forge-profile'] ? JSON.parse(record.data['forge-profile']) : {}; }
    catch(e){ /* malformed profile — skip fields, still list the account */ }
    accounts.push({
      email: b.key.slice('account:'.length),
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
