// Netlify serverless function — public (no admin key), read-only. Returns the top
// Brainstorm scores across all registered accounts so the in-app leaderboard shows
// real classmates instead of just the current student. Only ever returns first/last
// name + score + an isYou flag for the caller's own email -- never another student's
// email or any of their other synced data.
const { listBrainstormScores } = require('./_account-store');
const { checkRateLimit } = require('./_rate-limit');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const rl = await checkRateLimit(event);
  if(!rl.allowed){
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };
  }

  let email;
  try{
    const body = JSON.parse(event.body || '{}');
    email = (body.email || '').trim();
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  try{
    const leaderboard = await listBrainstormScores(email);
    return { statusCode: 200, body: JSON.stringify({ leaderboard }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to load leaderboard: ' + e.message }) };
  }
};
