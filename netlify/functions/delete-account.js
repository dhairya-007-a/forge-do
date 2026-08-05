// Netlify serverless function — admin-only. Permanently deletes a student's account
// Blob. No soft-delete, no undo (see design spec's "Delete: hard delete" decision) —
// admin-dashboard.html's confirm() dialog is the only safety net for the user, and
// this function's own admin-key check (see list-accounts.js for why) is the only
// safety net against unauthenticated callers.
const { deleteAccount } = require('./_account-store');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminKey = process.env.ADMIN_API_KEY;
  if(!adminKey || (event.headers || {})['x-admin-key'] !== adminKey){
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let email;
  try{
    const body = JSON.parse(event.body || '{}');
    email = (body.email || '').trim();
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!email){
    return { statusCode: 400, body: JSON.stringify({ error: 'email is required' }) };
  }

  try{
    await deleteAccount(email);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to delete account: ' + e.message }) };
  }
};
