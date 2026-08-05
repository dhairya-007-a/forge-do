// Netlify serverless function — called once at onboarding submit to check whether
// the entered email already has a Blob (returning student, new device) and if so
// return its data so the frontend can restore it instead of starting fresh.
const { getAccount } = require('./_account-store');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let email;
  try{
    const body = JSON.parse(event.body || '{}');
    email = (body.email || '').trim();
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!email || !email.includes('@')){
    return { statusCode: 400, body: JSON.stringify({ error: 'a valid email is required' }) };
  }

  try{
    const record = await getAccount(email);
    if(!record){
      return { statusCode: 200, body: JSON.stringify({ found: false }) };
    }
    return { statusCode: 200, body: JSON.stringify({ found: true, data: record.data }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to read account: ' + e.message }) };
  }
};
