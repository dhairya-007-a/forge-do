// Netlify serverless function — admin-only (the admin-dashboard.html page it's called
// from already has its own login gate). Returns a summary of every synced student
// account for the Accounts tab table.
const { listAccounts } = require('./_account-store');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try{
    const accounts = await listAccounts();
    return { statusCode: 200, body: JSON.stringify({ accounts }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to list accounts: ' + e.message }) };
  }
};
