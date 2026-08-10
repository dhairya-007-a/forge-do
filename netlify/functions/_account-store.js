// Shared Supabase wrapper for student accounts. Filename starts with `_` so
// Netlify's function router ignores it (no exports.handler here). Centralizes
// table access so the 4 thin handler functions (sync/restore/list/delete-account.js)
// don't each reimplement it. Uses the service_role key -- server-side only, never
// sent to the browser -- so RLS on the `accounts` table can stay fully locked down.
const { createClient } = require('@supabase/supabase-js');

let client = null;
function db(){
  if(!client){
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
  }
  return client;
}

function emailKey(email){
  return String(email).trim().toLowerCase();
}

async function getAccount(email){
  const { data, error } = await db()
    .from('accounts')
    .select('data, last_synced_at')
    .eq('email', emailKey(email))
    .maybeSingle();
  if(error) throw new Error(error.message);
  if(!data) return null;
  return { data: data.data, lastSyncedAt: data.last_synced_at };
}

async function setAccount(email, payload){
  let profile = {};
  try{ profile = payload && payload['forge-profile'] ? JSON.parse(payload['forge-profile']) : {}; }
  catch(e){ /* malformed profile -- still store the raw data */ }

  const { error } = await db().from('accounts').upsert({
    email: emailKey(email),
    first_name: profile.firstName || '',
    last_name: profile.lastName || '',
    course: profile.course || '',
    semester: profile.semester || '',
    batch: profile.batch || '',
    data: payload,
    last_synced_at: new Date().toISOString()
  });
  if(error) throw new Error(error.message);
}

async function deleteAccount(email){
  const { error } = await db().from('accounts').delete().eq('email', emailKey(email));
  if(error) throw new Error(error.message);
}

async function listAccounts(){
  const { data, error } = await db()
    .from('accounts')
    .select('email, first_name, last_name, course, semester, batch, last_synced_at')
    .order('last_synced_at', { ascending: false });
  if(error) throw new Error(error.message);
  return data.map(a => ({
    email: a.email,
    firstName: a.first_name || '',
    lastName: a.last_name || '',
    course: a.course || '',
    semester: a.semester || '',
    batch: a.batch || '',
    lastSyncedAt: a.last_synced_at
  }));
}

async function listBrainstormScores(viewerEmail){
  const { data, error } = await db().from('accounts').select('email, first_name, last_name, data');
  if(error) throw new Error(error.message);
  const viewer = emailKey(viewerEmail || '');
  return data
    .map(a => ({
      firstName: a.first_name || '',
      lastName: a.last_name || '',
      score: parseInt((a.data && a.data['forge-brainstorm-best']) || '0', 10),
      isYou: a.email === viewer
    }))
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

module.exports = { getAccount, setAccount, deleteAccount, listAccounts, listBrainstormScores };
