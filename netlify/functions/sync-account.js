// Netlify serverless function — receives a full forge-* localStorage snapshot from
// the frontend (debounced, sent after any change) and writes it to that email's
// Blob. Best-effort from the frontend's perspective: see index.html's runSync()
// for how failures here are swallowed client-side rather than shown to the student.
const { setAccount } = require('./_account-store');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let email, data;
  try{
    const body = JSON.parse(event.body || '{}');
    email = (body.email || '').trim();
    data = body.data;
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!email || !email.includes('@')){
    return { statusCode: 400, body: JSON.stringify({ error: 'a valid email is required' }) };
  }
  if(!data || typeof data !== 'object' || Array.isArray(data)){
    return { statusCode: 400, body: JSON.stringify({ error: 'data is required and must be an object' }) };
  }

  try{
    await setAccount(email, data);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to write account: ' + e.message }) };
  }
};
