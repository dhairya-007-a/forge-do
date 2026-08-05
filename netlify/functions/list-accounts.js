// Netlify serverless function — admin-only. admin-dashboard.html's login gate is
// client-side only (obscurity, not real security — see its own comment), so this
// function enforces its own server-side check via a shared secret header, closing
// the "anyone who finds this URL can list every student" hole a client-only gate
// can't prevent. Fails closed if ADMIN_API_KEY isn't configured.
const { listAccounts } = require('./_account-store');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminKey = process.env.ADMIN_API_KEY;
  if(!adminKey || (event.headers || {})['x-admin-key'] !== adminKey){
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try{
    const accounts = await listAccounts();
    return { statusCode: 200, body: JSON.stringify({ accounts }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to list accounts: ' + e.message }) };
  }
};
